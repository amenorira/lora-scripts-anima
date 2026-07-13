"""Estimate training steps with the same dataset batching rules as sd-scripts."""
from __future__ import annotations

import math
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any

from backend.constants import SD_SCRIPTS_DIR


class StepEstimateError(ValueError):
    """Raised when an exact step estimate cannot be produced."""

    def __init__(self, message: str, *, code: str = "failed", **params: Any):
        super().__init__(message)
        self.code = code
        self.params = params


@lru_cache(maxsize=1)
def _sd_dataset_helpers():
    sd_scripts_path = str(SD_SCRIPTS_DIR)
    if sd_scripts_path not in sys.path:
        sys.path.insert(0, sd_scripts_path)

    from library.dataset import BaseDataset, BucketManager, glob_images

    return BucketManager, glob_images, BaseDataset.get_image_size


def _positive_int(config: dict[str, Any], key: str, default: int) -> int:
    value = config.get(key, default)
    if isinstance(value, bool):
        raise StepEstimateError(
            f"{key} must be a positive integer / {key} 必须是正整数",
            code="positiveInteger",
            field=key,
        )
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise StepEstimateError(
            f"{key} must be a positive integer / {key} 必须是正整数",
            code="positiveInteger",
            field=key,
        ) from exc
    if numeric < 1 or not math.isfinite(numeric) or not numeric.is_integer():
        raise StepEstimateError(
            f"{key} must be a positive integer / {key} 必须是正整数",
            code="positiveInteger",
            field=key,
        )
    return int(numeric)


def _parse_resolution(value: Any) -> tuple[int, int]:
    if isinstance(value, (tuple, list)):
        parts = list(value)
    else:
        parts = str(value or "").split(",")
    try:
        resolution = tuple(int(str(part).strip()) for part in parts)
    except (TypeError, ValueError) as exc:
        raise StepEstimateError(
            "resolution must be one or two positive integers / 分辨率必须是一到两个正整数",
            code="invalidResolution",
        ) from exc
    if len(resolution) == 1:
        resolution = (resolution[0], resolution[0])
    if len(resolution) != 2 or min(resolution) < 1:
        raise StepEstimateError(
            "resolution must be one or two positive integers / 分辨率必须是一到两个正整数",
            code="invalidResolution",
        )
    return resolution


def _gpu_processes(gpu_ids: Any) -> int:
    if not gpu_ids:
        return 1
    if not isinstance(gpu_ids, (list, tuple)):
        raise StepEstimateError(
            "gpu_ids must be a list / gpu_ids 必须是列表",
            code="gpuIdsMustBeList",
        )
    try:
        normalized = [int(gpu_id) for gpu_id in gpu_ids]
    except (TypeError, ValueError) as exc:
        raise StepEstimateError(
            "gpu_ids contains an invalid value / gpu_ids 包含无效值",
            code="invalidGpuId",
        ) from exc
    if len(normalized) != len(set(normalized)):
        raise StepEstimateError(
            "gpu_ids contains duplicates / gpu_ids 不能包含重复项",
            code="duplicateGpuIds",
        )
    return max(1, len(normalized))


@lru_cache(maxsize=16384)
def _cached_image_size(image_path: str, _size: int, _modified_ns: int) -> tuple[int, int]:
    _, _, get_image_size = _sd_dataset_helpers()
    try:
        width, height = get_image_size(None, image_path)
    except Exception as exc:
        raise StepEstimateError(
            f"Unable to read image size: {image_path} / 无法读取图片尺寸: {image_path}",
            code="imageSizeUnreadable",
            path=image_path,
        ) from exc
    if width < 1 or height < 1:
        raise StepEstimateError(
            f"Invalid image size: {image_path} / 图片尺寸无效: {image_path}",
            code="invalidImageSize",
            path=image_path,
        )
    return width, height


def _read_image_size(image_path: str) -> tuple[int, int]:
    try:
        stat = Path(image_path).stat()
    except OSError as exc:
        raise StepEstimateError(
            f"Unable to read image: {image_path} / 无法读取图片: {image_path}",
            code="imageUnreadable",
            path=image_path,
        ) from exc
    return _cached_image_size(image_path, stat.st_size, stat.st_mtime_ns)


def _dataset_subsets(train_data_dir: Path, glob_images) -> list[dict[str, Any]]:
    subsets: list[dict[str, Any]] = []
    for subdir in sorted(train_data_dir.iterdir(), key=lambda path: path.name):
        if not subdir.is_dir():
            continue
        try:
            repeats = int(subdir.name.split("_")[0])
        except ValueError:
            continue
        if repeats < 1:
            continue
        image_paths = glob_images(str(subdir), "*")
        if not image_paths:
            continue
        subsets.append(
            {
                "name": subdir.name,
                "image_count": len(image_paths),
                "repeats": repeats,
                "sample_count": len(image_paths) * repeats,
                "image_paths": image_paths,
            }
        )
    return subsets


def _adjust_bucket_range(
    resolution: tuple[int, int], min_bucket_reso: int, max_bucket_reso: int, bucket_reso_steps: int
) -> tuple[int, int]:
    min_bucket_reso -= min_bucket_reso % bucket_reso_steps
    if max_bucket_reso % bucket_reso_steps:
        max_bucket_reso += bucket_reso_steps - max_bucket_reso % bucket_reso_steps
    if min(resolution) < min_bucket_reso:
        raise StepEstimateError(
            "min_bucket_reso must not exceed the training resolution / 最小桶分辨率不能大于训练分辨率",
            code="minBucketTooLarge",
        )
    if max(resolution) > max_bucket_reso:
        raise StepEstimateError(
            "max_bucket_reso must cover the training resolution / 最大桶分辨率必须覆盖训练分辨率",
            code="maxBucketTooSmall",
        )
    return min_bucket_reso, max_bucket_reso


def estimate_training_steps(config: dict[str, Any]) -> dict[str, Any]:
    """Return an exact pre-training step estimate for the current DreamBooth directory UI."""
    if not isinstance(config, dict):
        raise StepEstimateError(
            "Training configuration must be an object / 训练参数必须是对象",
            code="invalidConfig",
        )

    train_data_value = config.get("train_data_dir")
    if not train_data_value:
        raise StepEstimateError(
            "Select a training dataset directory / 请选择训练数据集目录",
            code="datasetRequired",
        )
    train_data_dir = Path(str(train_data_value))
    if not train_data_dir.is_dir():
        raise StepEstimateError(
            f"Dataset directory not found: {train_data_dir} / 数据集目录不存在: {train_data_dir}",
            code="datasetNotFound",
            path=str(train_data_dir),
        )

    BucketManager, glob_images, _ = _sd_dataset_helpers()
    subsets = _dataset_subsets(train_data_dir, glob_images)
    if not subsets:
        raise StepEstimateError(
            "No valid image folder found (example: 5_character) / 未找到有效图片目录（例如 5_character）",
            code="noValidImageFolder",
        )

    resolution = _parse_resolution(config.get("resolution", "1024,1024"))
    batch_size = _positive_int(config, "train_batch_size", 1)
    epochs = _positive_int(config, "max_train_epochs", 1)
    gradient_accumulation = _positive_int(config, "gradient_accumulation_steps", 1)
    gpu_processes = _gpu_processes(config.get("gpu_ids"))
    enable_bucket = bool(config.get("enable_bucket", False))
    bucket_no_upscale = bool(config.get("bucket_no_upscale", False))

    if enable_bucket:
        bucket_reso_steps = _positive_int(config, "bucket_reso_steps", 64)
        min_bucket_reso = _positive_int(config, "min_bucket_reso", 256)
        max_bucket_reso = _positive_int(config, "max_bucket_reso", 1024)
        min_bucket_reso, max_bucket_reso = _adjust_bucket_range(
            resolution, min_bucket_reso, max_bucket_reso, bucket_reso_steps
        )
        try:
            bucket_manager = BucketManager(
                bucket_no_upscale,
                resolution,
                min_bucket_reso,
                max_bucket_reso,
                bucket_reso_steps,
            )
            if not bucket_no_upscale:
                bucket_manager.make_buckets()
        except (AssertionError, ValueError) as exc:
            raise StepEstimateError(
                f"Invalid bucket settings / 分桶参数无效: {exc}",
                code="invalidBucketSettings",
                detail=str(exc),
            ) from exc
    else:
        bucket_reso_steps = None
        min_bucket_reso = None
        max_bucket_reso = None
        bucket_manager = BucketManager(False, resolution, None, None, None)
        bucket_manager.set_predefined_resos([resolution])

    bucket_samples: Counter[tuple[int, int]] = Counter()
    original_images = 0
    repeated_samples = 0
    public_subsets = []
    for subset in subsets:
        original_images += subset["image_count"]
        repeated_samples += subset["sample_count"]
        public_subsets.append({key: subset[key] for key in ("name", "image_count", "repeats", "sample_count")})
        for image_path in subset["image_paths"]:
            width, height = _read_image_size(image_path)
            try:
                bucket_resolution, _, _ = bucket_manager.select_bucket(width, height)
            except (AssertionError, ValueError, ZeroDivisionError) as exc:
                raise StepEstimateError(
                    f"Unable to assign image to a bucket: {image_path} / 图片无法分桶: {image_path}",
                    code="bucketAssignmentFailed",
                    path=image_path,
                ) from exc
            bucket_samples[bucket_resolution] += subset["repeats"]

    batches_per_epoch = sum(math.ceil(count / batch_size) for count in bucket_samples.values())
    if enable_bucket:
        bucket_details = [
            {
                "resolution": [resolution[0], resolution[1]],
                "sample_count": count,
                "batch_count": math.ceil(count / batch_size),
            }
            for resolution, count in sorted(bucket_samples.items())
        ]
    else:
        bucket_details = []

    steps_per_epoch = math.ceil(batches_per_epoch / gpu_processes / gradient_accumulation)
    total_steps = epochs * steps_per_epoch

    return {
        "total_steps": total_steps,
        "steps_per_epoch": steps_per_epoch,
        "batches_per_epoch": batches_per_epoch,
        "original_images": original_images,
        "repeated_samples": repeated_samples,
        "subsets": public_subsets,
        "batch_size": batch_size,
        "epochs": epochs,
        "gradient_accumulation_steps": gradient_accumulation,
        "gpu_processes": gpu_processes,
        "enable_bucket": enable_bucket,
        "bucket_count": len(bucket_details),
        "buckets": bucket_details,
        "resolution": list(resolution),
        "bucket_no_upscale": bucket_no_upscale if enable_bucket else False,
        "min_bucket_reso": min_bucket_reso,
        "max_bucket_reso": max_bucket_reso,
        "bucket_reso_steps": bucket_reso_steps,
    }
