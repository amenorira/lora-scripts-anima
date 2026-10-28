"""Atomic writes and readers that can coexist with replacement on Windows."""
from __future__ import annotations

import io
import os
from pathlib import Path
import threading
import time
import uuid

if os.name == "nt":
    from backend.utils import _windows_file_io as _windows
else:
    _windows = None


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
            os.fsync(handle.fileno())
        check_cancelled()
        atomic_replace(temporary, path, cancel_event=cancel_event)
    finally:
        temporary.unlink(missing_ok=True)
