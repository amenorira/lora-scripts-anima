"""Krea model metadata, runtime dependencies and disk/cache readiness checks."""
from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path
from typing import Any

from backend.training.core_registry import MUSUBI_TUNER_DIR
from backend.training.krea2_cache import get_krea2_cache_status
from backend.training.krea2_options import OPTIONAL_OPTIMIZER_PACKAGES, is_empty
from backend.training.musubi_runtime import shared_runtime_status


def _selected_optional_optimizer_package(optimizer_type: Any) -> str | None:
    value = str(optimizer_type or "")
    return next((package for prefix, package in OPTIONAL_OPTIMIZER_PACKAGES.items() if value.startswith(prefix)), None)


def _read_krea2_checkpoint_tensors(path: Path) -> dict[str, dict]:
    """Read only bounded safetensors metadata, never multi-GB tensor payloads."""
    try:
        with path.open("rb") as stream:
            header_size = int.from_bytes(stream.read(8), "little")
            if not 2 <= header_size <= 16 * 1024 * 1024:
                return {}
            header = json.loads(stream.read(header_size))
        return {name: tensor for name, tensor in header.items()
                if name != "__metadata__" and isinstance(tensor, dict)}
    except (OSError, ValueError, AttributeError):
        return {}


def inspect_krea2_checkpoint_format(path: Path) -> dict[str, str]:
    tensors = _read_krea2_checkpoint_tensors(path)
    int8_weights = any(name.endswith(".weight") and tensor.get("dtype") == "I8"
                       for name, tensor in tensors.items())
    if int8_weights and any(name.endswith(".comfy_quant") for name in tensors):
        kind = "convrot_int8"
    elif int8_weights:
        kind = "unknown"
    elif any(str(tensor.get("dtype")).startswith("F8") for tensor in tensors.values()):
        kind = "fp8"
    elif tensors:
        kind = "unquantized"
    else:
        kind = "unknown"
    return {"format": kind}


def _krea2_checkpoint_format_errors(path: Path, key: str, config: dict) -> list[str]:
    tensors = _read_krea2_checkpoint_tensors(path)
    dtypes = {tensor.get("dtype") for tensor in tensors.values()}
    if any(str(dtype).startswith("F8") for dtype in dtypes) and (
        key == "text_encoder" or any(name.endswith((".scale_weight", ".weight_scale", ".comfy_quant")) for name in tensors)
    ):
        return [f"{key}: this Krea 2 loader cannot read pre-scaled FP8 checkpoints; select BF16 weights"
                " (DiT FP8 quantization can be enabled in the form) / 当前 Krea 2 加载器不支持预量化 scaled FP8 文件，"
                "请选择 BF16 权重；DiT 可在界面启用训练时 FP8 量化"]
    if "I8" in dtypes and (key != "dit" or not config.get("convrot_int8")):
        return [f"{key}: INT8 weights require the DiT ConvRot INT8 path; use BF16 for other components / "
                "INT8 权重需要 DiT 的 ConvRot INT8 路径，其他组件请使用 BF16"]
    return []


def krea2_preflight(config: dict[str, Any], require_cache: bool = True) -> dict[str, Any]:
    """Check installed source, dependencies, model files and cache readiness."""
    errors: list[str] = []
    script = MUSUBI_TUNER_DIR / "krea2_train_network.py"
    package_dir = MUSUBI_TUNER_DIR / "src" / "musubi_tuner"
    if not script.is_file() or not package_dir.is_dir():
        errors.append(f"musubi-tuner source is not installed / musubi-tuner 源码未安装: {MUSUBI_TUNER_DIR}")
    runtime = shared_runtime_status()
    errors.extend(runtime["errors"])
    if config.get("krea_attention_backend") == "flash_attn":
        from backend.training.supervisor import detect_attention_backend
        actual, warning = detect_attention_backend("flash")
        if actual != "flash":
            errors.append(warning)
    optional_optimizer_package = _selected_optional_optimizer_package(config.get("optimizer_type"))
    if optional_optimizer_package:
        try:
            importlib.metadata.version(optional_optimizer_package)
        except importlib.metadata.PackageNotFoundError:
            errors.append(
                f"Selected optimizer requires {optional_optimizer_package}, but it is not installed in the shared "
                f"training environment / 所选优化器需要 {optional_optimizer_package}，但共享训练环境未安装"
            )
    for key, label in (("dit", "Krea 2 RAW DiT"), ("vae", "Qwen-Image VAE"), ("text_encoder", "Qwen3-VL text encoder")):
        path = Path(str(config.get(key) or ""))
        if not path.is_file():
            errors.append(f"{label} not found / 模型文件不存在: {path}")
        elif key != "vae":
            errors.extend(_krea2_checkpoint_format_errors(path, key, config))
    if require_cache and bool(config.get("enable_krea_samples", False)) and not is_empty(config.get("turbo_dit")):
        turbo_path = Path(str(config["turbo_dit"]))
        if not turbo_path.is_file():
            errors.append(f"Krea 2 Turbo DiT not found / Turbo 模型文件不存在: {turbo_path}")
        else:
            errors.extend(_krea2_checkpoint_format_errors(turbo_path, "turbo_dit", config))
    for key in ("network_weights", "turbo_lora"):
        if key == "turbo_lora" and not config.get("enable_krea_samples"):
            continue
        if not is_empty(config.get(key)) and not Path(str(config[key])).is_file():
            errors.append(f"{key}: weights not found / 权重文件不存在: {config[key]}")
    cache_status = get_krea2_cache_status(config)
    if not cache_status["image_count"]:
        errors.append("Dataset has no supported images with matching captions / 数据集目录没有带同名标注的可用图片，请检查图片格式和标注扩展名")
    errors.extend(cache_status["conflicts"])
    if require_cache and not cache_status["ready"]:
        errors.append(
            "Krea 2 latent/text caches are missing or stale; prepare both caches before training / "
            "Krea 2 latent 与文本缓存缺失或已失效，请先生成缓存"
        )
    return {"ok": not errors, "errors": errors, "cache": cache_status, "runtime": runtime}
