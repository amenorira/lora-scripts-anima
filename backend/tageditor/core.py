"""
Tag Editor 核心 — 文件操作、标签读写、图片扫描
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

from backend.constants import REPO_ROOT
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
CAPTION_EXTENSIONS = (".txt", ".caption")
_dataset_locks: dict[str, threading.RLock] = {}
_dataset_locks_guard = threading.Lock()
_cache_lock = threading.RLock()


def resolve_dir(dir_path: str) -> Path:
    """解析目录路径，支持相对路径；resolve 处理 .. 穿越"""
    p = Path(dir_path)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p.resolve()


def find_caption(img_path: Path) -> Path | None:
    """查找图片对应的标签文件 (.txt / .caption)"""
    for ext in CAPTION_EXTENSIONS:
        cap = img_path.with_suffix(ext)
        if cap.exists():
            return cap
    return None


def caption_candidates(img_path: Path) -> list[Path]:
    """Return existing caption files in deterministic priority order."""
    return [img_path.with_suffix(ext) for ext in CAPTION_EXTENSIONS if img_path.with_suffix(ext).exists()]


def caption_revision(cap_path: Path) -> str:
    """Return a stable optimistic-concurrency token for a caption file."""
    try:
        data = cap_path.read_bytes()
        stat = cap_path.stat()
    except FileNotFoundError:
        return "missing"
    digest = hashlib.sha1(data).hexdigest()
    return f"{stat.st_mtime_ns}:{stat.st_size}:{digest}"


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="replace", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def restore_caption_state(cap_path: Path, existed: bool, text: str) -> None:
    """Restore a previously captured caption state for transaction rollback."""
    if existed:
        _atomic_write_text(cap_path, text)
    else:
        cap_path.unlink(missing_ok=True)


@contextmanager
def dataset_lock(dir_path: Path):
    """Serialize writes and restores for a canonical dataset directory."""
    key = str(dir_path.resolve())
    with _dataset_locks_guard:
        lock = _dataset_locks.setdefault(key, threading.RLock())
    with lock:
        yield


def read_tags(cap_path: Path) -> str:
    """读取标签文件内容"""
    try:
        return cap_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def write_tags(cap_path: Path, tags: str, create_backup: bool = False) -> bool:
    """Atomically write a caption. Legacy .bak creation is opt-in only."""
    try:
        if create_backup and cap_path.exists():
            bak_path = cap_path.with_suffix(cap_path.suffix + ".bak")
            if not bak_path.exists():
                try:
                    shutil.copy2(cap_path, bak_path)
                except Exception:
                    pass
        _atomic_write_text(cap_path, tags.strip())
        return True
    except Exception:
        return False


def _build_image_entry(p: Path, base_dir: Path) -> dict:
    """构建单张图片的条目字典（scan_dataset / scan_selected_images 共用）。"""
    candidates = caption_candidates(p)
    cap = candidates[0] if candidates else None
    tags = read_tags(cap) if cap else ""
    try:
        rel = str(p.relative_to(base_dir)).replace("\\", "/")
    except ValueError:
        rel = p.name
    return {
        "name": p.name,
        "path": str(p),
        "rel_path": rel,
        "tags": tags,
        "has_caption": cap is not None,
        "caption_path": str(cap) if cap else str(p.with_suffix(CAPTION_EXTENSIONS[0])),
        "caption_revision": caption_revision(cap) if cap else "missing",
        "caption_conflict": len(candidates) > 1,
        "modified_ns": max(p.stat().st_mtime_ns, cap.stat().st_mtime_ns if cap else 0),
    }


def scan_dataset(dir_path: Path, recursive: bool = True) -> tuple[list[dict], list[dict]]:
    """单次扫描图片、标签文本与标签频率，避免同一目录重复遍历。"""
    images = []
    counter: Counter = Counter()
    glob_method = dir_path.rglob if recursive else dir_path.glob
    img_exts = set(IMAGE_EXTENSIONS)
    for p in glob_method("*"):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in img_exts:
            continue
        entry = _build_image_entry(p, dir_path)
        counter.update(tag_list(entry["tags"]))
        images.append(entry)
    images.sort(key=lambda x: x["name"])
    tags_data = [{"tag": tag, "count": count} for tag, count in counter.most_common()]
    return images, tags_data


def scan_selected_images(dir_path: Path, selected_paths: set[str]) -> list[dict]:
    """Only scan and read tags for selected images, instead of full directory scan."""
    dir_resolved = dir_path.resolve()
    images = []
    img_exts = set(IMAGE_EXTENSIONS)
    for spath in selected_paths:
        p = Path(spath).resolve()
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in img_exts:
            continue
        try:
            p.relative_to(dir_resolved)
        except ValueError:
            continue
        images.append(_build_image_entry(p, dir_resolved))
    images.sort(key=lambda x: x["name"])
    return images


def tag_list(tags_str: str) -> list[str]:
    """逗号分隔字符串 → 去空格的标签列表"""
    return [t.strip() for t in tags_str.split(",") if t.strip()]


def tag_str(tag_list: list[str]) -> str:
    """标签列表 → 逗号分隔字符串"""
    return ", ".join(tag_list)


# ── 缓存 ────────────────────────────────────────────────────────
_scan_dataset_cache: dict[str, tuple[float, tuple[list[dict], list[dict]]]] = {}
_CACHE_TTL = 300  # seconds


def _get_cached_tags(dir_path: Path, recursive: bool = True) -> list[dict]:
    _, tags_data = get_cached_scan_dataset(dir_path, recursive=recursive)
    return tags_data


def get_cached_scan_dataset(dir_path: Path, recursive: bool = True) -> tuple[list[dict], list[dict]]:
    """返回缓存的图片与标签统计；两者始终来自同一次目录扫描。"""
    import time
    cache_key = f"{dir_path.resolve()}:{recursive}"
    now = time.time()
    with _cache_lock:
        if cache_key in _scan_dataset_cache:
            ts, data = _scan_dataset_cache[cache_key]
            if now - ts < _CACHE_TTL:
                return data
    data = scan_dataset(dir_path, recursive=recursive)
    with _cache_lock:
        _scan_dataset_cache[cache_key] = (now, data)
    return data


def get_cached_scan_images(dir_path: Path, recursive: bool = True) -> list[dict]:
    """兼容旧调用：返回缓存数据集中的图片列表。"""
    images, _ = get_cached_scan_dataset(dir_path, recursive=recursive)
    return images


def _invalidate_cache(dir_path: Path, recursive: bool | None = None) -> None:
    """Invalidate caches for the given directory.
    If recursive is None, clear both recursive=True and recursive=False variants."""
    if recursive is None:
        for r in (True, False):
            cache_key = f"{dir_path.resolve()}:{r}"
            with _cache_lock:
                _scan_dataset_cache.pop(cache_key, None)
    else:
        cache_key = f"{dir_path.resolve()}:{recursive}"
        with _cache_lock:
            _scan_dataset_cache.pop(cache_key, None)


def get_autocomplete(dir_path: Path, prefix: str, limit: int = 20, recursive: bool = True) -> list[str]:
    """标签自动补全：返回以 prefix 开头的标签（按频率排序）"""
    tags_data = _get_cached_tags(dir_path, recursive=recursive)
    prefix_lower = prefix.lower()
    results = [t["tag"] for t in tags_data if t["tag"].lower().startswith(prefix_lower)]
    return results[:limit]
