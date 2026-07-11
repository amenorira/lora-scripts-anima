"""
Tag Editor 核心 — 文件操作、标签读写、图片扫描
"""
from __future__ import annotations

import hashlib
import shutil
from collections import Counter
from pathlib import Path

from backend.constants import CACHE_DIR, REPO_ROOT
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
CAPTION_EXTENSIONS = {".txt", ".caption"}
THUMBNAIL_CACHE_DIR = CACHE_DIR / "tageditor-thumbnails"
_THUMBNAIL_CACHE_MAX_FILES = 12000
_THUMBNAIL_CACHE_RETAIN_FILES = 10000
_THUMBNAIL_PRUNE_INTERVAL = 128
_thumbnail_writes_since_prune = _THUMBNAIL_PRUNE_INTERVAL - 1


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


def read_tags(cap_path: Path) -> str:
    """读取标签文件内容"""
    try:
        return cap_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def write_tags(cap_path: Path, tags: str) -> bool:
    """写入标签文件（自动 .bak 备份，仅在首次修改时创建）
    返回 True 表示成功，False 表示写入失败"""
    try:
        if cap_path.exists():
            bak_path = cap_path.with_suffix(cap_path.suffix + ".bak")
            if not bak_path.exists():
                try:
                    shutil.copy2(cap_path, bak_path)
                except Exception:
                    pass
        cap_path.parent.mkdir(parents=True, exist_ok=True)
        cap_path.write_text(tags.strip(), encoding="utf-8", errors="replace")
        return True
    except Exception:
        return False


def thumbnail_url(img_path: Path, size: int = 320) -> str:
    """图片缩略图 API URL"""
    import urllib.parse
    try:
        rel = str(img_path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        rel = str(img_path).replace("\\", "/")
    return f"/api/tageditor/thumbnail?path={urllib.parse.quote(rel, safe='')}&size={size}"


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
        cap = find_caption(p)
        tags = read_tags(cap) if cap else ""
        counter.update(tag_list(tags))
        try:
            rel = str(p.relative_to(dir_path)).replace("\\", "/")
        except ValueError:
            rel = p.name
        images.append({
            "name": p.name,
            "path": str(p),
            "rel_path": rel,
            "tags": tags,
            "has_caption": cap is not None,
            "thumbnail": thumbnail_url(p, 320),
            "preview": thumbnail_url(p, 960),
        })
    images.sort(key=lambda x: x["name"])
    tags_data = [{"tag": tag, "count": count} for tag, count in counter.most_common()]
    return images, tags_data


def scan_images(dir_path: Path, recursive: bool = True) -> list[dict]:
    """扫描目录下所有图片及对应标签。"""
    images, _ = scan_dataset(dir_path, recursive=recursive)
    return images


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
        cap = find_caption(p)
        tags = read_tags(cap) if cap else ""
        try:
            rel = str(p.relative_to(dir_resolved)).replace("\\", "/")
        except ValueError:
            rel = p.name
        images.append({
            "name": p.name,
            "path": str(p),
            "rel_path": rel,
            "tags": tags,
            "has_caption": cap is not None,
            "thumbnail": thumbnail_url(p, 320),
            "preview": thumbnail_url(p, 960),
        })
    images.sort(key=lambda x: x["name"])
    return images


def tag_list(tags_str: str) -> list[str]:
    """逗号分隔字符串 → 去空格的标签列表"""
    return [t.strip() for t in tags_str.split(",") if t.strip()]


def tag_str(tag_list: list[str]) -> str:
    """标签列表 → 逗号分隔字符串"""
    return ", ".join(tag_list)


def count_tags(dir_path: Path, recursive: bool = True) -> tuple[list[dict], int]:
    """统计所有标签出现频率"""
    images, tags_data = scan_dataset(dir_path, recursive=recursive)
    return tags_data, len(images)


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
    if cache_key in _scan_dataset_cache:
        ts, data = _scan_dataset_cache[cache_key]
        if now - ts < _CACHE_TTL:
            return data
    data = scan_dataset(dir_path, recursive=recursive)
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
            _scan_dataset_cache.pop(cache_key, None)
    else:
        cache_key = f"{dir_path.resolve()}:{recursive}"
        _scan_dataset_cache.pop(cache_key, None)


def _invalidate_caches_for_path(file_path: Path) -> None:
    """失效所有包含指定文件的已缓存数据集，包括递归扫描的上层根目录。"""
    resolved = file_path.resolve()
    for cache_key in list(_scan_dataset_cache):
        root_text, _, _recursive = cache_key.rpartition(":")
        if not root_text:
            continue
        try:
            resolved.relative_to(Path(root_text))
        except ValueError:
            continue
        _scan_dataset_cache.pop(cache_key, None)


def _prune_thumbnail_cache(
    cache_dir: Path = THUMBNAIL_CACHE_DIR,
    max_files: int = _THUMBNAIL_CACHE_MAX_FILES,
    retain_files: int = _THUMBNAIL_CACHE_RETAIN_FILES,
) -> int:
    """按生成时间清理旧缩略图，避免缓存目录无限增长。"""
    try:
        files = [path for path in cache_dir.glob("*.jpg") if path.is_file()]
    except OSError:
        return 0
    if len(files) <= max_files:
        return 0

    retain_files = max(0, min(retain_files, max_files))
    try:
        files.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    except OSError:
        files.sort(key=lambda path: path.name)

    removed = 0
    for old_path in files[retain_files:]:
        try:
            old_path.unlink(missing_ok=True)
            removed += 1
        except OSError:
            continue
    return removed


def get_thumbnail_path(img_path: Path, size: int = 320) -> Path:
    """生成带内容版本键的磁盘缩略图，并返回缓存文件路径。"""
    from PIL import Image, ImageOps

    size = max(128, min(int(size), 1600))
    stat = img_path.stat()
    key_src = f"{img_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{size}"
    key = hashlib.sha1(key_src.encode("utf-8", errors="ignore")).hexdigest()
    thumb_path = THUMBNAIL_CACHE_DIR / f"{key}.jpg"
    if thumb_path.exists():
        return thumb_path

    THUMBNAIL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(img_path) as source:
        image = ImageOps.exif_transpose(source)
        image.thumbnail((size, size))
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.save(thumb_path, format="JPEG", quality=84, optimize=True)

    global _thumbnail_writes_since_prune
    _thumbnail_writes_since_prune += 1
    if _thumbnail_writes_since_prune >= _THUMBNAIL_PRUNE_INTERVAL:
        _thumbnail_writes_since_prune = 0
        _prune_thumbnail_cache()
    return thumb_path


def get_autocomplete(dir_path: Path, prefix: str, limit: int = 20, recursive: bool = True) -> list[str]:
    """标签自动补全：返回以 prefix 开头的标签（按频率排序）"""
    tags_data = _get_cached_tags(dir_path, recursive=recursive)
    prefix_lower = prefix.lower()
    results = [t["tag"] for t in tags_data if t["tag"].lower().startswith(prefix_lower)]
    return results[:limit]
