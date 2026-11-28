"""Atomic writes, FUSE-aware fsync, and readers that can coexist with replacement on Windows."""
from __future__ import annotations

import errno
import io
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any
import uuid

if os.name == "nt":
    from backend.utils import _windows_file_io as _windows
else:
    _windows = None

_PROC_MOUNTS_PATH = Path("/proc/mounts")
_MOUNT_TABLE_TTL = 60.0
_FUSE_OR_NETWORK_FSTYPES = frozenset({
    "fuse", "nfs", "nfs4", "cifs", "smb3", "smbfs", "9p",
    "ceph", "lustre", "glusterfs", "gpfs", "afs", "davfs", "sshfs",
})
_OCTAL_ESCAPE_RE = re.compile(r"\\([0-7]{3})")
_mount_cache_lock = threading.Lock()
_mount_table_cache: tuple[float, list[tuple[str, str]]] | None = None
_fs_detect_cache: dict[str, tuple[float, bool]] = {}
_FS_DETECT_CACHE_MAX = 256


def _unescape_mount_field(text: str) -> str:
    return _OCTAL_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 8)), text)


def _is_fuse_or_network_fstype(fstype: str) -> bool:
    ft = fstype.lower()
    return ft in _FUSE_OR_NETWORK_FSTYPES or ft.startswith("fuse.")


def _parse_proc_mounts(content: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for line in content.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        mount_point = _unescape_mount_field(parts[1]).rstrip("/") or "/"
        fstype = parts[2]
        entries.append((mount_point, fstype))
    # Sort longest mount point first; for identical mount points keep later mount (stacked mounts).
    # Reverse first so Python's stable sort preserves later mounts ahead of earlier ones at equal length.
    entries.reverse()
    entries.sort(key=lambda item: len(item[0]), reverse=True)
    return entries


def _read_mount_table() -> list[tuple[str, str]]:
    global _mount_table_cache
    now = time.monotonic()
    with _mount_cache_lock:
        if _mount_table_cache is not None and now - _mount_table_cache[0] < _MOUNT_TABLE_TTL:
            return _mount_table_cache[1]
    try:
        content = _PROC_MOUNTS_PATH.read_text(encoding="utf-8", errors="replace")
    except OSError:
        entries: list[tuple[str, str]] = []
    else:
        entries = _parse_proc_mounts(content)
    with _mount_cache_lock:
        _mount_table_cache = (now, entries)
    return entries


def clear_fs_cache() -> None:
    """Clear cached mount table and path filesystem-type lookups (used in tests)."""
    global _mount_table_cache
    with _mount_cache_lock:
        _mount_table_cache = None
        _fs_detect_cache.clear()


def _resolve_existing_ancestor(path: Path) -> str:
    """Resolve symlinks on the nearest existing ancestor without failing on missing files."""
    current = path
    tail: list[str] = []
    while True:
        try:
            if current.exists() or current.is_symlink():
                base = current.resolve()
                resolved = base.joinpath(*reversed(tail)) if tail else base
                return str(resolved).replace("\\", "/")
        except OSError:
            pass
        parent = current.parent
        if parent == current:
            return str(path).replace("\\", "/")
        tail.append(current.name)
        current = parent


def is_fuse_or_network_fs(path: str | Path) -> bool:
    """Return True if path resides on a FUSE or network mount (Linux /proc/mounts)."""
    mounts = _read_mount_table()
    if not mounts:
        return False
    target = Path(path)
    cache_key = str(target.parent if not target.is_dir() else target)
    now = time.monotonic()
    with _mount_cache_lock:
        cached = _fs_detect_cache.get(cache_key)
        if cached is not None and now - cached[0] < _MOUNT_TABLE_TTL:
            return cached[1]
    resolved_str = _resolve_existing_ancestor(target)
    result = False
    for mount_point, fstype in mounts:
        if mount_point == "/" or resolved_str == mount_point or resolved_str.startswith(mount_point + "/"):
            result = _is_fuse_or_network_fstype(fstype)
            break
    with _mount_cache_lock:
        if len(_fs_detect_cache) >= _FS_DETECT_CACHE_MAX:
            _fs_detect_cache.clear()
        _fs_detect_cache[cache_key] = (now, result)
    return result


def should_fsync(path: str | Path) -> bool:
    """Return False when ANIMA_NO_FSYNC is enabled or path is on a FUSE/network mount."""
    flag = os.environ.get("ANIMA_NO_FSYNC", "").strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        return False
    return not is_fuse_or_network_fs(path)


def _maybe_fsync(fd: int, path: Path) -> None:
    if not should_fsync(path):
        return
    try:
        os.fsync(fd)
    except OSError as exc:
        if exc.errno not in (errno.EINVAL, errno.EOPNOTSUPP, errno.ENOSYS):
            raise


def open_read(path: Path):
    """Open a binary reader that does not pin a replaceable Windows filename."""
    if _windows is None:
        return path.open("rb")
    descriptor = _windows.open_read_fd(path)
    try:
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def read_bytes(path: Path) -> bytes:
    with open_read(path) as handle:
        return handle.read()


def read_text(path: Path, *, encoding: str = "utf-8", errors: str = "strict") -> str:
    with open_read(path) as handle:
        with io.TextIOWrapper(handle, encoding=encoding, errors=errors) as text:
            return text.read()


def atomic_replace(
    source: Path, target: Path, *, cancel_event: threading.Event | None = None,
) -> None:
    """Publish atomically, retaining bounded retries for incompatible readers/FS."""
    for attempt in range(5):
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")
        legacy = _windows is None
        try:
            if _windows is not None:
                if _windows.try_atomic_replace(source, target):
                    return
                legacy = True  # Older Windows or a filesystem without rename-ex.
            os.replace(source, target)
            return
        except PermissionError as exc:
            retry_codes = {5, 32, 33} if legacy else {32, 33}
            if getattr(exc, "winerror", None) not in retry_codes or attempt == 4:
                raise
            delay = .02 * (2 ** attempt)
            if cancel_event is None:
                time.sleep(delay)
            elif cancel_event.wait(delay):
                raise InterruptedError("cancelled") from exc


def atomic_write_bytes(
    path: Path, data: bytes, *, cancel_event: threading.Event | None = None,
) -> None:
    """Atomically write raw bytes, skipping fsync on FUSE/network mounts."""
    def check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    check_cancelled()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{uuid.uuid4().hex}.tmp")
    handle = temporary.open("xb")
    try:
        with handle:
            check_cancelled()
            handle.write(data)
            handle.flush()
            _maybe_fsync(handle.fileno(), path)
        check_cancelled()
        atomic_replace(temporary, path, cancel_event=cancel_event)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_text(
    path: Path, text: str, *, cancel_event: threading.Event | None = None, errors: str = "strict",
) -> None:
    def check_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    check_cancelled()
    temporary = path.with_name(f".{uuid.uuid4().hex}.tmp")
    # Open outside the cleanup block: if creation fails, we do not own the path.
    # In particular, never retry PermissionError or remove a colliding file.
    handle = temporary.open("x", encoding="utf-8", errors=errors, newline="\n")
    try:
        with handle:
            check_cancelled()
            handle.write(text)
            handle.flush()
            _maybe_fsync(handle.fileno(), path)
        check_cancelled()
        atomic_replace(temporary, path, cancel_event=cancel_event)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(
    path: Path,
    data: Any,
    *,
    indent: int | None = 2,
    ensure_ascii: bool = False,
    cancel_event: threading.Event | None = None,
) -> None:
    """Atomically write UTF-8 JSON, creating parent directories if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=indent, ensure_ascii=ensure_ascii)
    atomic_write_text(path, text, cancel_event=cancel_event)
