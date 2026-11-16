"""Read-only caption frequencies for the preview-prompt workbench."""
from __future__ import annotations

from collections import Counter
from functools import lru_cache
import json
from pathlib import Path


@lru_cache(maxsize=4096)
def _caption_tags(filename: str, modified_ns: int, size: int) -> tuple[str, ...] | None:
    with Path(filename).open("rb") as handle:
        data = handle.read(512 * 1024 + 1)
    if len(data) > 512 * 1024:
        raise ValueError("Caption is too large")
    text = data.decode("utf-8-sig").strip()
    # Structured MOSS captions must not become comma-separated fragments.
    if text.startswith(("{", "[")):
        try:
            if isinstance(json.loads(text), (dict, list)):
                return None
        except json.JSONDecodeError:
            pass
    return tuple(dict.fromkeys(tag.strip() for tag in text.split(",") if tag.strip()))


def _frequencies(counter: Counter) -> list[dict]:
    # Stable ties keep the first occurrence in the deterministically scanned captions.
    return [{"tag": tag, "count": count} for tag, count in
            sorted(counter.items(), key=lambda item: -item[1])]


def inspect_prompt_tags(config: dict) -> dict:
    directory = str(config.get("train_data_dir") or "").strip()
    root = Path(directory)
    if not directory or not root.is_dir():
        raise ValueError("Select a valid training dataset directory / 请选择有效的训练数据集目录")
    extension = str(config.get("caption_extension") or ".txt").strip()
    if not extension.startswith(".") or extension == "." or any(c in extension for c in "/\\\r\n"):
        raise ValueError("Invalid caption extension / 标注扩展名无效")
    if config.get("model_train_type") == "krea2-lora":
        from backend.training.datasets.krea2_dataset import dataset_groups

        groups = [(path, images) for path, _, images in dataset_groups(config)]
    else:
        from backend.training.datasets.step_estimator import _registered_dataset_subsets, _sd_dataset_helpers

        _, glob_images, _ = _sd_dataset_helpers()
        payload = dict(config, train_data_dir=directory, enable_reg_data=False, reg_data_dir="")
        groups = [(root / subset["name"], [Path(image) for image in subset["image_paths"]])
                  for subset in _registered_dataset_subsets(payload, glob_images)]
    combined: Counter = Counter()
    combined_leading: Counter = Counter()
    subsets = []
    totals = dict(image_count=0, caption_count=0, missing_count=0, unreadable_count=0, structured_count=0)
    for folder, images in sorted(groups, key=lambda item: str(item[0])):
        counts: Counter = Counter()
        leading: Counter = Counter()
        caption_count = 0
        for image in sorted(images, key=str):
            totals["image_count"] += 1
            caption = image.with_suffix(extension)
            try:
                stat = caption.stat()
                tags = _caption_tags(str(caption.resolve()), stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:
                totals["missing_count"] += 1
                continue
            except (OSError, UnicodeError, ValueError):
                totals["unreadable_count"] += 1
                continue
            if tags is None:
                totals["structured_count"] += 1
                continue
            if tags:
                caption_count += 1
                counts.update(tags)
                leading.update(tags[:1])
        relative = folder.relative_to(root).as_posix()
        subsets.append(dict(id=relative, name=relative if relative != "." else root.name,
                            image_count=len(images), caption_count=caption_count, tags=_frequencies(counts), leading_tags=_frequencies(leading)))
        totals["caption_count"] += caption_count
        combined.update(counts)
        combined_leading.update(leading)
    return dict(**totals, dataset_id=str(root.resolve()), subsets=subsets, tags=_frequencies(combined), leading_tags=_frequencies(combined_leading))
