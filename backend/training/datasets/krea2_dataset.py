"""Krea 2 dataset discovery and resolution parsing, independent of UI metadata."""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
from typing import Any

_IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".webp", ".avif"}


class Krea2ResolutionError(ValueError):
    """Resolution validation with a stable code for the step-estimate UI."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def parse_krea2_resolution(value: Any) -> tuple[int, int]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        parts = value
    else:
        parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 2:
        raise Krea2ResolutionError(
            "resolution must be width,height / 分辨率必须为 宽,高", "krea2ResolutionFormat"
        )
    try:
        width, height = (int(parts[0]), int(parts[1]))
    except (TypeError, ValueError) as exc:
        raise Krea2ResolutionError(
            "resolution must contain two integers / 分辨率必须为两个整数", "krea2ResolutionIntegers"
        ) from exc
    if width < 16 or height < 16 or width % 16 or height % 16:
        raise Krea2ResolutionError(
            "resolution must be positive multiples of 16 / 分辨率必须为 16 的正整数倍", "krea2ResolutionMultiple16"
        )
    return width, height


def image_files(
    directory: str | Path,
    cache_dir: str | Path | None = None,
    caption_extension: str = ".txt",
) -> list[Path]:
    """Find captioned images, matching musubi's supported image formats."""
    if not str(directory):
        return []
    root = Path(directory)
    if not root.is_dir():
        return []
    excluded = Path(cache_dir).resolve() if cache_dir else None
    extensions = set(_IMAGE_EXTENSIONS)
    if any(importlib.util.find_spec(name) is not None for name in ("jxlpy", "pillow_jxl")):
        extensions.add(".jxl")
    patterns = {f"*{ext}" for ext in extensions | {ext.upper() for ext in extensions}}
    paths: list[Path] = []
    if excluded is not None and root.resolve().is_relative_to(excluded):
        return []
    for directory, subdirs, filenames in os.walk(root):
        parent = Path(directory)
        if excluded is not None:
            subdirs[:] = [name for name in subdirs if not (parent / name).resolve().is_relative_to(excluded)]
        captions = {Path(name).stem for name in filenames
                    if Path(name).match(f"*{caption_extension}") and (parent / name).is_file()}
        for name in filenames:
            path = parent / name
            # Match musubi's case-sensitive stems even on Windows.
            if path.stem in captions and any(path.match(pattern) for pattern in patterns) and path.is_file():
                if excluded is None or not path.resolve().is_relative_to(excluded):
                    paths.append(path)
    return sorted(paths)


def dataset_groups(config: dict[str, Any]) -> list[tuple[Path, Path, list[Path]]]:
    """Give each source directory its own cache namespace for musubi's flat reader."""
    if not config.get("train_data_dir"):
        return []
    root = Path(str(config.get("train_data_dir") or ""))
    cache = Path(str(config.get("dataset_cache_dir") or ""))
    groups: dict[Path, list[Path]] = {}
    for image in image_files(root, cache, str(config.get("caption_extension") or ".txt")):
        groups.setdefault(image.parent, []).append(image)
    result = []
    for directory, images in sorted(groups.items()):
        relative = directory.relative_to(root).as_posix()
        # Retain the existing flat-dataset cache location. Subdirectories need
        # separate namespaces: musubi names cache files using only image stems.
        target = (
            cache if directory == root
            else cache / "subsets" / hashlib.sha256(relative.encode("utf-8")).hexdigest()
        )
        result.append((directory, target, images))
    return result
