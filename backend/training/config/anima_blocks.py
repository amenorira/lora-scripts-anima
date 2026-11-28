"""Inspect Anima checkpoint depth without reading tensor data."""
import re
from pathlib import Path

from safetensors import SafetensorError, safe_open

from backend.training.config.storage_paths import resolve_training_path


_BLOCK_KEY = re.compile(r"(?:net\.|model\.diffusion_model\.)?blocks\.(\d+)\.")


class AnimaCheckpointError(ValueError):
    """Checkpoint depth inspection error carrying a structured localization code."""

    def __init__(self, code: str, message: str, **params):
        super().__init__(message)
        self.code = code
        self.params = params


def anima_block_count(checkpoint: str | Path) -> int:
    path = resolve_training_path(checkpoint)
    shard = re.fullmatch(r"(.*?)\d+-of-(\d+)\.safetensors", path.name)
    paths = (path,)
    if shard:
        prefix, total = shard.groups()
        count = int(total)
        paths = (path.with_name(f"{prefix}{i:05d}-of-{count:05d}.safetensors") for i in range(1, count + 1))
    indices = set()
    for part in paths:
        try:
            with safe_open(str(part), framework="numpy") as weights:
                indices.update(int(match[1]) for key in weights.keys() if (match := _BLOCK_KEY.match(key)))
        except (OSError, SafetensorError) as exc:
            raise AnimaCheckpointError(
                "shapePreviewAnimaCheckpointReadFailed",
                f"Cannot read Anima checkpoint / 无法读取 Anima 权重: {part} ({exc})",
                path=str(part),
                detail=str(exc),
            ) from exc
    if not indices or max(indices) + 1 != len(indices):
        raise AnimaCheckpointError(
            "shapePreviewAnimaCheckpointMissingBlocks",
            f"Missing Anima DiT blocks / Anima 权重缺少 DiT 块: {path}",
            path=str(path),
        )
    return len(indices)


def validate_anima_block_limits(checkpoint: str | Path, swapped: int, skipped: int = 0) -> None:
    if not (swapped or skipped):
        return
    count = anima_block_count(checkpoint)
    for key, value, limit in (("blocks_to_swap", swapped, max(0, count - 2)),
                              ("gradient_checkpointing_skip_blocks", skipped, count)):
        if value > limit:
            raise ValueError(f"{key}: maximum {limit} for a {count}-block model / 当前模型有 {count} 个块，最多可设为 {limit}")
