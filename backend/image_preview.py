"""Shared local-image preview rendering and URL helpers."""
from __future__ import annotations

import hashlib
import math
import os
import threading
import urllib.parse
from functools import lru_cache
from importlib.util import find_spec
from pathlib import Path

from PIL import Image, ImageOps

from backend.constants import CACHE_DIR

IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif", ".jxl",
}
IMAGE_PREVIEW_CACHE_DIR = CACHE_DIR / "image-previews"
PREVIEW_RENDER_VERSION = "webp-v2"
_CACHE_MAX_FILES = 14000
_CACHE_RETAIN_FILES = 12000
_PRUNE_INTERVAL = 128
_writes_since_prune = _PRUNE_INTERVAL - 1
# A fixed set of locks bounds memory while still deduplicating same-key renders.
_render_locks = tuple(threading.Lock() for _ in range(256))
# Bound concurrent cold decode/resize/encode workers to cap memory spikes on 4K PNG/WebP.
_decode_semaphore = threading.Semaphore(3)

_VARIANT_DEFAULTS = {
    "thumb": {"size": 320, "quality": 90},
    "preview": {"size": 960, "quality": 95},
    "inspect": {"size": None, "quality": 95},
}


@lru_cache(maxsize=1)
def _register_jpeg_xl_decoders() -> None:
    # Match the optional Pillow plugins used by the Krea trainer.
    if find_spec("jxlpy") is not None:
        from jxlpy import JXLImagePlugin  # noqa: F401
    if find_spec("pillow_jxl") is not None:
        import pillow_jxl  # noqa: F401


def open_preview_source(source: Path) -> Image.Image:
    if source.suffix.lower() == ".jxl":
        _register_jpeg_xl_decoders()
    return Image.open(source)


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


def preview_etag(source: Path, variant: str, size: int | None = None, *, orient: bool = True) -> str:
    stat = source.stat()
    key = (
        f"{source.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|"
        f"{normalize_variant(variant)}|{size or ''}|{PREVIEW_RENDER_VERSION}"
        f"{'' if orient else '|raw-v1'}"
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


def _thumbnail_target_size(src_size: tuple[int, int], max_size: int) -> tuple[int, int] | None:
    """Match Pillow thumbnail() aspect-ratio rounding for a square target box."""
    width, height = src_size
    if width <= 0 or height <= 0 or (max_size >= width and max_size >= height):
        return None
    aspect = width / height
    if 1.0 >= aspect:
        x = max(
            min(
                math.floor(max_size * aspect),
                math.ceil(max_size * aspect),
                key=lambda n: abs(aspect - n / max_size),
            ),
            1,
        )
        return x, max_size
    y = max(
        min(
            math.floor(max_size / aspect),
            math.ceil(max_size / aspect),
            key=lambda n: 0 if n == 0 else abs(aspect - max_size / n),
        ),
        1,
    )
    return max_size, y


def _apply_preview_orientation(image: Image.Image, orient: bool) -> None:
    if orient:
        ImageOps.exif_transpose(image, in_place=True)
    else:
        image.load()
        image.info.pop("exif", None)


def get_cached_preview_path(
    source: Path,
    variant: str = "preview",
    size: int | None = None,
    *,
    cache_dir: Path = IMAGE_PREVIEW_CACHE_DIR,
    orient: bool = True,
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
    # Faster local previews; retain exhaustive compression for full-size inspection.
    method = 6 if variant == "inspect" else 2
    stat = source.stat()
    key_src = (
        f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{variant}|{target_size or ''}|"
        f"q{quality}|m{method}|alpha100|{PREVIEW_RENDER_VERSION}"
        f"{'' if orient else '|raw-v1'}"
    )
    key = hashlib.sha1(key_src.encode("utf-8", errors="ignore")).hexdigest()
    target = cache_dir / f"{key}.webp"
    if target.exists():
        return target

    render_lock = _render_locks[int(key[:8], 16) % len(_render_locks)]
    with render_lock:
        if target.exists():
            return target
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = cache_dir / f".{key}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with _decode_semaphore, open_preview_source(source) as opened:
                if target_size is not None and opened.format in {"JPEG", "MPO"}:
                    exif_orient = opened.getexif().get(274) if orient else None
                    if orient and exif_orient in {5, 6, 7, 8}:
                        transposed = _thumbnail_target_size((opened.height, opened.width), target_size)
                        final_size = (transposed[1], transposed[0]) if transposed is not None else None
                    else:
                        final_size = _thumbnail_target_size(opened.size, target_size)
                    if final_size is not None:
                        # Draft JPEG decoders at >=2x final dimensions before exif_transpose()/load()
                        # forces a full-resolution decode; preserve the exact draft crop box.
                        draft_res = opened.draft(None, (final_size[0] * 2, final_size[1] * 2))
                        box = draft_res[1] if draft_res is not None else None
                        if opened.size != final_size:
                            resized = opened.resize(final_size, Image.Resampling.LANCZOS, box=box, reducing_gap=2.0)
                            opened.im = resized.im
                            opened._size = resized.size
                            opened._mode = resized.mode
                            opened.readonly = 0
                    _apply_preview_orientation(opened, orient)
                else:
                    _apply_preview_orientation(opened, orient)
                    if target_size is not None:
                        opened.thumbnail((target_size, target_size), Image.Resampling.LANCZOS)
                image, lossless = _render_mode(opened)
                save_options = {
                    "format": "WEBP",
                    "lossless": lossless,
                    "quality": 100 if lossless else quality,
                    "alpha_quality": 100,
                    "method": method,
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
