"""Shared local-image preview rendering and URL helpers."""
from __future__ import annotations

import hashlib
import os
import threading
import urllib.parse
from pathlib import Path

from PIL import Image, ImageOps

from backend.constants import CACHE_DIR

IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif",
}
IMAGE_PREVIEW_CACHE_DIR = CACHE_DIR / "image-previews"
PREVIEW_RENDER_VERSION = "webp-v1"
_CACHE_MAX_FILES = 14000
_CACHE_RETAIN_FILES = 12000
_PRUNE_INTERVAL = 128
_writes_since_prune = _PRUNE_INTERVAL - 1
_render_locks: dict[str, threading.Lock] = {}
_render_locks_guard = threading.Lock()

_VARIANT_DEFAULTS = {
    "thumb": {"size": 320, "quality": 90},
    "preview": {"size": 960, "quality": 95},
    "inspect": {"size": None, "quality": 95},
}


def normalize_variant(variant: str) -> str:
    value = (variant or "preview").lower()
    if value == "original":
        return value
    if value not in _VARIANT_DEFAULTS:
        raise ValueError("Invalid image preview variant")
    return value


def build_image_preview_url(
    *,
    scope: str,
    variant: str,
    path: str = "",
    run_dir: str = "",
    session_id: str = "",
    source_token: str = "",
    index: int | None = None,
    size: int | None = None,
    version: str = "",
) -> str:
    params: dict[str, str] = {"scope": scope, "variant": variant}
    if path:
        params["path"] = path
    if run_dir:
        params["run_dir"] = run_dir
    if session_id:
        params["session_id"] = session_id
    if source_token:
        params["source_token"] = source_token
    if index is not None:
        params["index"] = str(index)
    if size is not None:
        params["size"] = str(size)
    if version:
        params["v"] = version
    return "/api/image-preview?" + urllib.parse.urlencode(params)


def preview_etag(source: Path, variant: str, size: int | None = None) -> str:
    stat = source.stat()
    key = (
        f"{source.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|"
        f"{normalize_variant(variant)}|{size or ''}|{PREVIEW_RENDER_VERSION}"
    )
    return hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest()


def prune_preview_cache(
    cache_dir: Path = IMAGE_PREVIEW_CACHE_DIR,
    max_files: int = _CACHE_MAX_FILES,
    retain_files: int = _CACHE_RETAIN_FILES,
) -> int:
    """Prune generated WebP previews by newest mtime."""
    try:
        files = [path for path in cache_dir.glob("*.webp") if path.is_file()]
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
    for path in files[retain_files:]:
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError:
            continue
    return removed


def _render_mode(image: Image.Image) -> tuple[Image.Image, bool]:
    """Keep alpha, and use lossless WebP for mask-like grayscale images."""
    if image.mode in {"1", "L"}:
        return image, True
    if image.mode == "P":
        return image.convert("RGBA" if "transparency" in image.info else "RGB"), False
    if image.mode not in {"RGB", "RGBA"}:
        return image.convert("RGB"), False
    return image, False


def get_cached_preview_path(
    source: Path,
    variant: str = "preview",
    size: int | None = None,
    *,
    cache_dir: Path = IMAGE_PREVIEW_CACHE_DIR,
) -> Path:
    """Return an EXIF-corrected, version-keyed WebP preview cache file."""
    source = source.resolve()
    if not source.is_file() or source.suffix.lower() not in IMAGE_EXTENSIONS:
        raise FileNotFoundError(source)
    variant = normalize_variant(variant)
    if variant == "original":
        return source

    defaults = _VARIANT_DEFAULTS[variant]
    target_size = defaults["size"] if size is None else max(64, min(int(size), 4096))
    quality = int(defaults["quality"])
    stat = source.stat()
    key_src = (
        f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{variant}|{target_size or ''}|"
        f"q{quality}|m6|alpha100|{PREVIEW_RENDER_VERSION}"
    )
    key = hashlib.sha1(key_src.encode("utf-8", errors="ignore")).hexdigest()
    target = cache_dir / f"{key}.webp"
    if target.exists():
        return target

    with _render_locks_guard:
        render_lock = _render_locks.setdefault(key, threading.Lock())
    with render_lock:
        if target.exists():
            return target
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = cache_dir / f".{key}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with Image.open(source) as opened:
                image = ImageOps.exif_transpose(opened)
                if target_size is not None:
                    image.thumbnail((target_size, target_size), Image.Resampling.LANCZOS)
                image, lossless = _render_mode(image)
                save_options = {
                    "format": "WEBP",
                    "lossless": lossless,
                    "quality": 100 if lossless else quality,
                    "alpha_quality": 100,
                    "method": 6,
                }
                icc_profile = opened.info.get("icc_profile")
                if icc_profile:
                    save_options["icc_profile"] = icc_profile
                image.save(temporary, **save_options)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    global _writes_since_prune
    _writes_since_prune += 1
    if _writes_since_prune >= _PRUNE_INTERVAL:
        _writes_since_prune = 0
        prune_preview_cache(cache_dir)
    return target
