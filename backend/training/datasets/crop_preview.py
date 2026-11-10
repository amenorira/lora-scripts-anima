"""Read-only training-image geometry, using the installed trainers' bucket selectors."""
from __future__ import annotations

from collections import OrderedDict
from functools import lru_cache, partial
from pathlib import Path
import secrets
import sys
import threading
import time

from PIL import Image

from backend.image_preview import build_image_preview_url, open_preview_source
from backend.training.datasets.step_estimator import (
    StepEstimateError, _registered_dataset_subsets, _parse_resolution,
    _positive_int, _sd_bucket_manager, _sd_dataset_helpers,
)

_sessions: OrderedDict[str, tuple[float, dict[str, Path]]] = OrderedDict()
_lock = threading.Lock()


def resolve_preview_image(token: str, image_id: str) -> Path | None:
    with _lock:
        entry = _sessions.get(token)
        if entry is None or time.monotonic() - entry[0] > 86400:
            _sessions.pop(token, None)
            return None
        return entry[1].get(image_id)


@lru_cache(maxsize=1)
def _krea_selector_class():
    from backend.training.core_registry import MUSUBI_TUNER_DIR

    source = str(MUSUBI_TUNER_DIR / "src")
    if source not in sys.path:
        sys.path.insert(0, source)
    from musubi_tuner.dataset.bucket import BucketSelector
    from musubi_tuner.dataset.architectures import ARCHITECTURE_KREA2
    return partial(BucketSelector, architecture=ARCHITECTURE_KREA2)


def crop_geometry(original, bucket, resized):
    """Integer crop offsets match both trainers; normalized values drive the overlay."""
    width, height = original
    rw, rh = resized
    bw, bh = bucket
    if min(width, height, rw, rh, bw, bh) <= 0 or bw > rw or bh > rh:
        raise ValueError("Invalid crop dimensions / 图片尺寸无法用于当前分桶")
    left, top = (rw - bw) // 2, (rh - bh) // 2
    return {
        "original": [width, height], "bucket": [bw, bh], "resized": [rw, rh],
        "crop": [left / rw, top / rh, bw / rw, bh / rh],
        "crop_percent": 100 * (1 - bw * bh / (rw * rh)),
        "scale": max(rw / width, rh / height),
    }


def inspect_crops(config: dict) -> dict:
    root = Path(str(config.get("train_data_dir") or ""))
    if not config.get("train_data_dir") or not root.is_dir():
        raise StepEstimateError("Select a valid training dataset directory / 请选择有效的训练数据集目录")
    krea = config.get("model_train_type") == "krea2-lora"
    enabled = bool(config.get("enable_bucket", krea))
    random_crop = bool(config.get("random_crop", False)) and not krea
    resize_to_bucket = enabled or bool(config.get("cache_latents") or config.get("cache_latents_to_disk"))
    resolution_value = config.get("resolution", "1024,1024")
    if krea:
        from backend.training.datasets.krea2_dataset import dataset_groups, parse_krea2_resolution

        resolution = parse_krea2_resolution(resolution_value)
        repeats = _positive_int(config, "krea_num_repeats", 1)
        records = [(p, repeats, False) for _, _, images in dataset_groups(config) for p in images]
        selector = _krea_selector_class()(resolution, enabled, bool(config.get("bucket_no_upscale", True)))
    else:
        resolution = _parse_resolution(resolution_value)
        _, glob_images, _ = _sd_dataset_helpers()
        records = []
        for subset in _registered_dataset_subsets(config, glob_images):
            counts = subset.get("per_image_repeats")
            for index, path in enumerate(subset["image_paths"]):
                repeats = subset["repeats"] if counts is None else counts[index]
                records.append((Path(path), repeats, subset["is_reg"]))
        if resize_to_bucket:
            selector = _sd_bucket_manager(config, resolution)

    items, capability, versions = [], {}, {}
    for path, repeats, is_reg in sorted(records, key=lambda record: (record[2], str(record[0]))):
        image_id = str(len(items))
        name = path.absolute().as_posix() if is_reg else path.relative_to(root).as_posix()
        item = {"id": image_id, "name": name, "sample_count": repeats, "is_reg": is_reg}
        try:
            # Authorize only the discovered image, retaining its logical name for grouping.
            source = path.resolve(strict=True)
            # Trainers read raw pixel orientation, without EXIF auto-rotation.
            with open_preview_source(source) as image:
                original = image.size
                # Catch broken image containers without decoding every image's pixels.
                try:
                    image.verify()
                except IndexError as exc:
                    # Pillow's PNG verifier can index an empty tile list when IDAT is missing.
                    raise OSError("Missing or invalid image data / 图片数据缺失或无效") from exc
            if krea:
                bucket = selector.get_bucket_resolution(original)
                scale = max(bucket[0] / original[0], bucket[1] / original[1])
                resized = tuple(int(side * scale + 0.5) for side in original)
            elif resize_to_bucket:
                bucket, resized, _ = selector.select_bucket(*original)
            else:
                bucket, resized = resolution, original
                if config.get("face_crop_aug_range"):
                    raise ValueError("Face-aware crop preview is unavailable / 暂不支持人脸增强裁剪预览")
                if min(original[0] - bucket[0], original[1] - bucket[1]) < 0:
                    raise ValueError("Image is smaller than the training resolution / 图片小于训练尺寸，请启用分桶或调整分辨率")
                if original != bucket and not random_crop:
                    raise ValueError("Enable bucketing or random crop for this image / 此图片需要启用分桶或随机裁剪")
            item.update(crop_geometry(original, bucket, resized))
            stat = source.stat()
            versions[image_id] = f"{stat.st_mtime_ns}-{stat.st_size}"
            capability[image_id] = source
        except (OSError, SyntaxError, Image.DecompressionBombError, ValueError, AssertionError, ZeroDivisionError) as exc:
            item["error"] = str(exc)
        items.append(item)
    if not items:
        raise StepEstimateError(
            "No supported training images found / 未找到可用训练图片" +
            ("（Krea 2 需要同名标注文件）" if krea else "（请检查子目录的重复次数前缀）")
        )
    with _lock:
        now = time.monotonic()
        # Reopening the same authorized file set keeps browser cache URLs stable.
        # Changed files still get a new version query from mtime and size.
        token = next((key for key, (created, paths) in _sessions.items()
                      if now - created <= 86400 and paths == capability), None)
        if token is None:
            token = secrets.token_urlsafe(24)
        _sessions[token] = (now, capability)
        _sessions.move_to_end(token)
        while len(_sessions) > 8:
            _sessions.popitem(last=False)
    for item in items:
        if item['id'] not in capability:
            continue
        for variant in ("thumb", "preview"):
            item[variant] = build_image_preview_url(
                scope="crop", variant=variant, session_id=token, path=item['id'], version=versions[item['id']],
            )
    return {"items": items, "random_crop": random_crop, "session_id": token}
