"""Estimate training steps with the same dataset batching rules as sd-scripts."""
from __future__ import annotations

import math
import sys
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any

from backend.constants import SD_SCRIPTS_DIR
from backend.log import log
from backend.training.datasets.sd_dataset_config import _dreambooth_subsets


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


def warm_up() -> None:
    """预热 sd-scripts 的 dataset 模块。

    该模块首次导入会连带引入 torch / bitsandbytes / transformers / diffusers，实测约
    5～8 秒，而真正的数据集扫描只要 10 毫秒量级（59 张图 9.7 ms，单张读尺寸 0.05 ms）。
    放在启动阶段后台预热，用户第一次打开训练页就不必干等这笔一次性开销。
    """
    try:
        _sd_dataset_helpers()
    except Exception:
        # 预热失败不影响主流程：首次估算时会重新走这条路径并正常报错。
        log.warning("Step estimator warm-up failed / 步数估算预热失败", exc_info=True)


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


def _registered_dataset_subsets(config: dict[str, Any], glob_images) -> list[dict[str, Any]]:
    """Shared discovery and actual DreamBooth regularization registration counts."""
    discovered = _dreambooth_subsets(str(config["train_data_dir"]), is_reg=False)
    if config.get("enable_reg_data", True) and config.get("reg_data_dir"):
        discovered += _dreambooth_subsets(str(config["reg_data_dir"]), is_reg=True)
    subsets: list[dict[str, Any]] = []
    seen = set()
    for subset in discovered:
        image_dir = subset["image_dir"]
        # DreamBooth keeps the first nonempty subset with this image_dir.
        if image_dir in seen:
            continue
        repeats = subset["num_repeats"]
        image_paths = glob_images(image_dir, "*")
        if not image_paths:
            continue
        seen.add(image_dir)
        subsets.append(
            {
                "name": Path(image_dir).name,
                "image_count": len(image_paths),
                "repeats": repeats,
                "sample_count": len(image_paths) * repeats,
                "is_reg": subset["is_reg"],
                "image_paths": image_paths,
            }
        )
    reg_subsets = [s for s in subsets if s.get("is_reg")]
    if reg_subsets:
        target = sum(s["sample_count"] for s in subsets if not s.get("is_reg"))
        repeats = [s["repeats"] for s in reg_subsets for _ in s["image_paths"]]
        counts = [0] * len(repeats)
        total = 0
        # The first pass registers whole repeat groups, so the last one may
        # exceed the target. Later passes add one repeat to each registered image.
        for index, count in enumerate(repeats):
            if total >= target:
                break
            counts[index] = count
            total += count
        if total < target:
            rounds, remainder = divmod(target - total, len(counts))
            counts = [count + rounds + (index < remainder) for index, count in enumerate(counts)]
        offset = 0
        for subset in reg_subsets:
            sub_counts = counts[offset:offset + subset["image_count"]]
            offset += subset["image_count"]
            subset["image_paths"] = [p for p, c in zip(subset["image_paths"], sub_counts) if c > 0]
            subset["per_image_repeats"] = [c for c in sub_counts if c > 0]
            subset["unused_images"] = len(sub_counts) - len(subset["image_paths"])
            subset["image_count"] = len(subset["image_paths"])
            subset["sample_count"] = sum(sub_counts)
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


def _sd_bucket_manager(config: dict[str, Any], resolution: tuple[int, int]):
    BucketManager, _, _ = _sd_dataset_helpers()
    if not config.get("enable_bucket"):
        manager = BucketManager(False, resolution, None, None, None)
        manager.set_predefined_resos([resolution])
        return manager

    step = _positive_int(config, "bucket_reso_steps", 64)
    minimum, maximum = _adjust_bucket_range(
        resolution, _positive_int(config, "min_bucket_reso", 256),
        _positive_int(config, "max_bucket_reso", 1024), step,
    )
    no_upscale = bool(config.get("bucket_no_upscale"))
    try:
        manager = BucketManager(no_upscale, resolution, minimum, maximum, step)
        if not no_upscale:
            manager.make_buckets()
    except (AssertionError, ValueError) as exc:
        raise StepEstimateError(
            f"Invalid bucket settings / 分桶参数无效: {exc}",
            code="invalidBucketSettings",
            detail=str(exc),
        ) from exc
    return manager


def estimate_training_steps(config: dict[str, Any]) -> dict[str, Any]:
    """Return an exact pre-training step estimate for the current DreamBooth directory UI."""
    if not isinstance(config, dict):
        raise StepEstimateError(
            "Training configuration must be an object / 训练参数必须是对象",
            code="invalidConfig",
        )

    if str(config.get("model_train_type") or "") == "krea2-lora":
        from backend.training.config.musubi_krea2 import estimate_krea2_steps

        try:
            return estimate_krea2_steps(dict(config))
        except StepEstimateError:
            raise
        except ValueError as exc:
            raise StepEstimateError(
                str(exc),
                code="krea2EstimateInvalid",
                detail=str(exc),
            ) from exc

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

    _, glob_images, _ = _sd_dataset_helpers()
    subsets = _registered_dataset_subsets(config, glob_images)
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
    bucket_manager = _sd_bucket_manager(config, resolution)

    bucket_samples: Counter[tuple[int, int]] = Counter()
    original_images = 0
    repeated_samples = 0
    public_subsets = []
    for subset in subsets:
        original_images += subset["image_count"]
        repeated_samples += subset["sample_count"]
        per_image_repeats = subset.get("per_image_repeats")
        if per_image_repeats is not None:
            # 正则子集：每张图的实际重复次数由注册循环分配（可能不同），按次数聚合供公式展示
            repeat_dist = sorted((repeats, count) for repeats, count in Counter(per_image_repeats).items())
            unused_images = subset.get("unused_images", 0)
        else:
            repeat_dist = [(subset["repeats"], subset["image_count"])]
            unused_images = 0
        public_subsets.append(
            {
                "name": subset["name"],
                "image_count": subset["image_count"],
                "repeats": subset["repeats"],
                "sample_count": subset["sample_count"],
                "is_reg": subset["is_reg"],
                "repeat_dist": repeat_dist,
                "unused_images": unused_images,
            }
        )
        per_image_repeats = subset.get("per_image_repeats")
        for j, image_path in enumerate(subset["image_paths"]):
            width, height = _read_image_size(image_path)
            try:
                bucket_resolution, _, _ = bucket_manager.select_bucket(width, height)
            except (AssertionError, ValueError, ZeroDivisionError) as exc:
                raise StepEstimateError(
                    f"Unable to assign image to a bucket: {image_path} / 图片无法分桶: {image_path}",
                    code="bucketAssignmentFailed",
                    path=image_path,
                ) from exc
            bucket_samples[bucket_resolution] += (
                per_image_repeats[j] if per_image_repeats is not None else subset["repeats"]
            )

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
        "bucket_no_upscale": bucket_manager.no_upscale,
        "min_bucket_reso": bucket_manager.min_size,
        "max_bucket_reso": bucket_manager.max_size,
        "bucket_reso_steps": bucket_manager.reso_steps,
    }
