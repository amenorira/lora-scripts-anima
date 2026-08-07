"""Dataset TOML helpers for sd-scripts DreamBooth directory training."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any


SUBSET_TIMESTEP_OFFSETS_KEY = "subset_timestep_offsets"


def normalize_subset_timestep_offsets(value: Any) -> dict[str, float]:
    """Return finite, non-zero per-subset offsets keyed by folder name."""
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("subset_timestep_offsets must be an object / 子集时间步偏移必须是对象")

    offsets: dict[str, float] = {}
    for raw_name, raw_offset in value.items():
        name = str(raw_name).strip()
        if not name or "/" in name or "\\" in name or name in {".", ".."}:
            raise ValueError(f"Invalid dataset subset name / 数据集子集名称无效: {raw_name}")
        if raw_offset in (None, ""):
            continue
        try:
            offset = float(raw_offset)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"Invalid timestep sampling offset for subset '{name}' / 子集“{name}”的时间步偏移无效"
            ) from exc
        if not math.isfinite(offset):
            raise ValueError(
                f"Timestep sampling offset must be finite for subset '{name}' / 子集“{name}”的时间步偏移必须是有限数字"
            )
        if offset != 0.0:
            offsets[name] = offset
    return offsets


def _dreambooth_subsets(base_dir: str | None, *, is_reg: bool) -> list[dict[str, Any]]:
    if not base_dir:
        return []
    root = Path(base_dir)
    if not root.is_dir():
        return []

    subsets: list[dict[str, Any]] = []
    for subdir in sorted(root.iterdir(), key=lambda path: path.name):
        if not subdir.is_dir():
            continue
        tokens = subdir.name.split("_")
        try:
            repeats = int(tokens[0])
        except ValueError:
            continue
        if repeats < 1:
            continue
        subsets.append(
            {
                "image_dir": str(subdir),
                "num_repeats": repeats,
                "is_reg": is_reg,
                "class_tokens": "_".join(tokens[1:]),
            }
        )
    return subsets


def build_sd_scripts_dataset_config(
    config: dict[str, Any], subset_timestep_offsets: dict[str, float]
) -> dict[str, Any]:
    """Reproduce sd-scripts' directory subsets and attach per-subset offsets."""
    train_subsets = _dreambooth_subsets(str(config.get("train_data_dir") or ""), is_reg=False)
    reg_subsets = _dreambooth_subsets(str(config.get("reg_data_dir") or ""), is_reg=True)
    available = {Path(subset["image_dir"]).name for subset in train_subsets}
    unknown = sorted(set(subset_timestep_offsets) - available)
    if unknown:
        names = ", ".join(unknown)
        raise ValueError(f"Dataset subsets no longer exist: {names} / 数据集子集已不存在: {names}")

    for subset in train_subsets:
        offset = subset_timestep_offsets.get(Path(subset["image_dir"]).name)
        if offset is not None:
            subset["custom_attributes"] = {"timestep_sampling": {"offset": offset}}

    return {"datasets": [{"subsets": train_subsets + reg_subsets}]}
