"""Krea 2 profile codec, cache contract, and runtime preflight.

Krea 2 is intentionally kept outside the sd-scripts adapter. Its dataset TOML,
two-stage cache, model arguments, and attention flags are musubi-tuner
semantics and must never inherit sd-scripts-only values.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from packaging.version import InvalidVersion, Version

from backend.training.core_registry import MUSUBI_TUNER_DIR, get_engine


KREA2_TRAINER_FILE = "./vendor/musubi-tuner/krea2_train_network.py"
KREA2_CACHE_RUNNER_FILE = "./backend/training/krea2_cache_runner.py"
KREA2_PROFILE_ID = "krea2-lora"
KREA2_NETWORK_MODULE = "networks.lora_krea2"
KREA2_CACHE_MANIFEST_NAME = ".anima-krea2-cache.json"

_IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
_ATTENTION_FLAGS = {
    "sdpa": "sdpa",
    "flash_attn": "flash_attn",
    "sage_attn": "sage_attn",
    "xformers": "xformers",
}
_MUSUBI_RUNTIME_PACKAGES: dict[str, str | None] = {
    "accelerate": "1.6.0",
    "av": "14.0.1",
    "bitsandbytes": None,
    "diffusers": "0.32.1",
    "einops": "0.7.0",
    "huggingface-hub": "0.34.3",
    "opencv-python": "4.10.0.84",
    "pillow": ">=11.3.0",
    "safetensors": "0.4.5",
    "toml": "0.10.2",
    "easydict": "1.13",
    "tqdm": "4.67.1",
    "transformers": "4.57.6",
    "voluptuous": "0.15.2",
    "ftfy": "6.3.1",
    "sentencepiece": "0.2.1",
}


# Kept separate from the legacy FIELDS registry. field_registry.get_fields_json
# merges these definitions for the frontend, while the sd-scripts adapter only
# sees legacy fields.
KREA2_FIELDS: list[dict[str, Any]] = [
    {
        "key": "dit",
        "type": "text",
        "default": "",
        "section": "model",
        "desc_key": "field.krea_dit",
        "hint_key": "field.krea_ditHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "vae",
        "type": "text",
        "default": "",
        "section": "model",
        "desc_key": "field.krea_vae",
        "hint_key": "field.krea_vaeHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "text_encoder",
        "type": "text",
        "default": "",
        "section": "model",
        "desc_key": "field.krea_text_encoder",
        "hint_key": "field.krea_text_encoderHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "train_data_dir",
        "type": "text",
        "default": "./train",
        "section": "model",
        "desc_key": "field.train_data_dir",
        "role": "file-folder",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "dataset_cache_dir",
        "type": "text",
        "default": "./cache/krea2",
        "section": "model",
        "desc_key": "field.krea_dataset_cache_dir",
        "hint_key": "field.krea_dataset_cache_dirHint",
        "role": "file-folder",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "caption_extension",
        "type": "text",
        "default": ".txt",
        "section": "model",
        "desc_key": "field.krea_caption_extension",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "resolution",
        "type": "text",
        "default": "1024,1024",
        "section": "model",
        "desc_key": "field.resolution",
        "hint_key": "field.krea_resolutionHint",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "enable_bucket",
        "type": "toggle",
        "default": True,
        "section": "model",
        "desc_key": "field.enable_bucket",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "bucket_no_upscale",
        "type": "toggle",
        "default": True,
        "section": "model",
        "desc_key": "field.bucket_no_upscale",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_num_repeats",
        "type": "number",
        "default": 1,
        "section": "model",
        "desc_key": "field.krea_num_repeats",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_module",
        "type": "select",
        "default": KREA2_NETWORK_MODULE,
        "section": "network",
        "desc_key": "field.network_module",
        "options": [{"v": KREA2_NETWORK_MODULE, "l": KREA2_NETWORK_MODULE}],
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_dim",
        "type": "number",
        "default": 32,
        "section": "network",
        "desc_key": "field.network_dim",
        "min": 1,
        "max": 256,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_alpha",
        "type": "number",
        "default": 32,
        "section": "network",
        "desc_key": "field.network_alpha",
        "min": 1,
        "max": 256,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_dropout",
        "type": "number",
        "default": 0,
        "section": "network",
        "desc_key": "field.network_dropout",
        "min": 0,
        "max": 0.5,
        "step": 0.01,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_args_custom",
        "type": "textarea",
        "default": "",
        "section": "network",
        "desc_key": "field.krea_network_args",
        "hint_key": "field.krea_network_argsHint",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_train_epochs",
        "type": "number",
        "default": 16,
        "section": "training",
        "desc_key": "field.max_train_epochs",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "train_batch_size",
        "type": "number",
        "default": 1,
        "section": "training",
        "desc_key": "field.train_batch_size",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "gradient_accumulation_steps",
        "type": "number",
        "default": 1,
        "section": "training",
        "desc_key": "field.gradient_accumulation_steps",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "gradient_checkpointing",
        "type": "toggle",
        "default": True,
        "section": "training",
        "desc_key": "field.gradient_checkpointing",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "learning_rate",
        "type": "text",
        "default": "1e-4",
        "section": "training",
        "desc_key": "field.learning_rate",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "seed",
        "type": "number",
        "default": 42,
        "section": "training",
        "desc_key": "field.seed",
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "mixed_precision",
        "type": "select",
        "default": "bf16",
        "section": "training",
        "desc_key": "field.mixed_precision",
        "options": [
            {"v": "bf16", "l": "bf16"},
            {"v": "fp16", "l": "fp16"},
            {"v": "no", "l": "no"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "timestep_sampling",
        "type": "select",
        "default": "shift",
        "section": "training",
        "desc_key": "field.krea_timestep_sampling",
        "options": [
            {"v": "shift", "l": "shift"},
            {"v": "krea2_shift", "l": "krea2_shift"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "discrete_flow_shift",
        "type": "number",
        "default": 2.5,
        "section": "training",
        "desc_key": "field.discrete_flow_shift",
        "min": 0.01,
        "step": 0.01,
        "show_if": {"key": "timestep_sampling", "eq": "shift"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "weighting_scheme",
        "type": "select",
        "default": "none",
        "section": "training",
        "desc_key": "field.weighting_scheme",
        "options": [{"v": "none", "l": "none"}],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "optimizer_type",
        "type": "select",
        "default": "adamw8bit",
        "section": "optimizer",
        "desc_key": "field.optimizer_type",
        "options": [
            {"v": "adamw8bit", "l": "adamw8bit"},
            {"v": "AdamW", "l": "AdamW"},
            {"v": "AdaFactor", "l": "AdaFactor"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_optimizer_args",
        "type": "textarea",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_optimizer_args",
        "hint_key": "field.krea_optimizer_argsHint",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_attention_backend",
        "type": "select",
        "default": "sdpa",
        "section": "performance",
        "desc_key": "field.krea_attention_backend",
        "options": [
            {"v": "sdpa", "l": "SDPA"},
            {"v": "flash_attn", "l": "FlashAttention"},
            {"v": "sage_attn", "l": "SageAttention"},
            {"v": "xformers", "l": "xFormers"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "blocks_to_swap",
        "type": "number",
        "default": 0,
        "section": "performance",
        "desc_key": "field.krea_blocks_to_swap",
        "min": 0,
        "max": 26,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "fp8_base",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_fp8_base",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "fp8_scaled",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_fp8_scaled",
        "show_if": {"key": "fp8_base", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.compile",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "persistent_data_loader_workers",
        "type": "toggle",
        "default": True,
        "section": "performance",
        "desc_key": "field.persistent_data_loader_workers",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_data_loader_n_workers",
        "type": "number",
        "default": 2,
        "section": "performance",
        "desc_key": "field.max_data_loader_n_workers",
        "min": 0,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "text_cache_batch_size",
        "type": "number",
        "default": 1,
        "section": "performance",
        "desc_key": "field.krea_text_cache_batch_size",
        "min": 1,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "output_name",
        "type": "text",
        "default": "krea2_lora",
        "section": "save",
        "desc_key": "field.output_name",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "output_dir",
        "type": "text",
        "default": "./output",
        "section": "save",
        "desc_key": "field.output_dir",
        "role": "file-folder",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_model_as",
        "type": "select",
        "default": "safetensors",
        "section": "save",
        "desc_key": "field.save_model_as",
        "options": [{"v": "safetensors", "l": "safetensors"}],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_precision",
        "type": "select",
        "default": "bf16",
        "section": "save",
        "desc_key": "field.save_precision",
        "options": [
            {"v": "bf16", "l": "bf16"},
            {"v": "fp16", "l": "fp16"},
            {"v": "float", "l": "float"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_every_n_epochs",
        "type": "number",
        "default": 1,
        "section": "save",
        "desc_key": "field.save_every_n_epochs",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_state",
        "type": "toggle",
        "default": False,
        "section": "save",
        "desc_key": "field.save_state",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "resume",
        "type": "text",
        "default": "",
        "section": "save",
        "desc_key": "field.resume",
        "role": "file-folder",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
]


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _as_int(config: dict[str, Any], key: str, errors: list[str], minimum: int = 0) -> int | None:
    value = config.get(key)
    try:
        number = int(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be an integer / 必须是整数")
        return None
    if isinstance(value, bool) or number < minimum:
        errors.append(f"{key}: must be >= {minimum} / 不能小于 {minimum}")
        return None
    config[key] = number
    return number


def _as_float(
    config: dict[str, Any], key: str, errors: list[str], minimum: float | None = None
) -> float | None:
    value = config.get(key)
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be a number / 必须是数字")
        return None
    if not math.isfinite(number) or (minimum is not None and number < minimum):
        suffix = f" >= {minimum}" if minimum is not None else " finite"
        errors.append(f"{key}: must be{suffix} / 数值无效")
        return None
    config[key] = number
    return number


def parse_krea2_resolution(value: Any) -> tuple[int, int]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        parts = value
    else:
        parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 2:
        raise ValueError("resolution must be width,height / 分辨率必须为 宽,高")
    try:
        width, height = (int(parts[0]), int(parts[1]))
    except (TypeError, ValueError) as exc:
        raise ValueError("resolution must contain two integers / 分辨率必须为两个整数") from exc
    if width < 16 or height < 16 or width % 16 or height % 16:
        raise ValueError("resolution must be positive multiples of 16 / 分辨率必须为 16 的正整数倍")
    return width, height


def _split_args(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, str):
        return []
    return [line.strip() for line in value.splitlines() if line.strip()]


def image_files(directory: str | Path, cache_dir: str | Path | None = None) -> list[Path]:
    root = Path(directory)
    if not root.is_dir():
        return []
    excluded = Path(cache_dir).resolve() if cache_dir else None
    paths: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in _IMAGE_EXTENSIONS:
            continue
        try:
            if excluded is not None and path.resolve().is_relative_to(excluded):
                continue
        except OSError:
            continue
        paths.append(path)
    return sorted(paths)


def _path_identity(path_value: Any) -> dict[str, Any]:
    path = Path(str(path_value or ""))
    try:
        stat = path.stat()
    except OSError:
        return {"path": str(path), "missing": True}
    return {"path": str(path.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def krea2_cache_fingerprint(config: dict[str, Any]) -> str:
    """Fingerprint inputs that make Krea latent or text caches stale."""

    cache_dir = config.get("dataset_cache_dir")
    root = Path(str(config.get("train_data_dir") or ""))
    entries: list[dict[str, Any]] = []
    for image in image_files(root, cache_dir):
        try:
            stat = image.stat()
        except OSError:
            continue
        caption = image.with_suffix(str(config.get("caption_extension") or ".txt"))
        item: dict[str, Any] = {
            "image": str(image.relative_to(root)).replace("\\", "/"),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
        try:
            caption_stat = caption.stat()
            item["caption"] = {
                "exists": True,
                "size": caption_stat.st_size,
                "mtime_ns": caption_stat.st_mtime_ns,
            }
        except OSError:
            item["caption"] = {"exists": False}
        entries.append(item)

    width, height = parse_krea2_resolution(config.get("resolution", "1024,1024"))
    payload = {
        "schema": 1,
        "dataset": entries,
        "resolution": [width, height],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_no_upscale": bool(config.get("bucket_no_upscale", True)),
        "caption_extension": str(config.get("caption_extension") or ".txt"),
        "vae": _path_identity(config.get("vae")),
        "text_encoder": _path_identity(config.get("text_encoder")),
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cache_manifest_path(cache_dir: str | Path) -> Path:
    return Path(cache_dir) / KREA2_CACHE_MANIFEST_NAME


def prepare_cache_manifest(config: dict[str, Any]) -> dict[str, Any]:
    """Persist a pending cache request before the worker process starts."""

    cache_dir = Path(str(config["dataset_cache_dir"]))
    cache_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": 1,
        "profile": KREA2_PROFILE_ID,
        "fingerprint": krea2_cache_fingerprint(config),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "stages": {"latents": "pending", "text_encoder": "pending"},
    }
    cache_manifest_path(cache_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def mark_cache_manifest(config: dict[str, Any], status: str) -> None:
    """Mark a full two-stage cache pipeline completed or failed."""

    path = cache_manifest_path(config["dataset_cache_dir"])
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = prepare_cache_manifest(config)
    stage_state = "completed" if status == "completed" else "failed"
    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    manifest["stages"] = {"latents": stage_state, "text_encoder": stage_state}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def get_krea2_cache_status(config: dict[str, Any]) -> dict[str, Any]:
    """Inspect cache files and their fingerprint without importing musubi."""

    cache_dir = Path(str(config.get("dataset_cache_dir") or ""))
    images = image_files(config.get("train_data_dir") or "", cache_dir)
    latent_files = []
    text_files = []
    if cache_dir.is_dir():
        latent_files = [
            path
            for path in cache_dir.glob("*_krea2.safetensors")
            if not path.name.endswith("_krea2_te.safetensors")
        ]
        text_files = list(cache_dir.glob("*_krea2_te.safetensors"))

    manifest: dict[str, Any] = {}
    try:
        manifest = json.loads(cache_manifest_path(cache_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    try:
        fingerprint = krea2_cache_fingerprint(config)
    except (TypeError, ValueError):
        fingerprint = ""
    matches = bool(fingerprint and manifest.get("fingerprint") == fingerprint)
    stages = manifest.get("stages") if isinstance(manifest.get("stages"), dict) else {}
    expected = len(images)
    ready = (
        expected > 0
        and matches
        and stages.get("latents") == "completed"
        and stages.get("text_encoder") == "completed"
        and len(latent_files) >= expected
        and len(text_files) >= expected
    )
    return {
        "cache_dir": str(cache_dir),
        "image_count": expected,
        "latent_count": len(latent_files),
        "text_encoder_count": len(text_files),
        "fingerprint_matches": matches,
        "stages": stages,
        "ready": ready,
    }


def validate_krea2_config(config: dict[str, Any]) -> list[str]:
    """Validate and normalize the strict Krea 2 UI payload."""

    errors: list[str] = []
    for key in (
        "dit",
        "vae",
        "text_encoder",
        "train_data_dir",
        "dataset_cache_dir",
        "caption_extension",
        "output_name",
        "output_dir",
    ):
        if _is_empty(config.get(key)):
            errors.append(f"{key}: required / 必填")

    if config.get("network_module", KREA2_NETWORK_MODULE) != KREA2_NETWORK_MODULE:
        errors.append(
            f"network_module: Krea 2 requires {KREA2_NETWORK_MODULE} / Krea 2 必须使用指定 LoRA 模块"
        )
    else:
        config["network_module"] = KREA2_NETWORK_MODULE

    try:
        width, height = parse_krea2_resolution(config.get("resolution", ""))
        config["resolution"] = f"{width},{height}"
    except ValueError as exc:
        errors.append(f"resolution: {exc}")

    caption_extension = str(config.get("caption_extension") or "")
    if caption_extension and not caption_extension.startswith("."):
        errors.append("caption_extension: must start with '.' / 必须以 '.' 开头")

    for key, minimum in (
        ("network_dim", 1),
        ("network_alpha", 1),
        ("max_train_epochs", 1),
        ("train_batch_size", 1),
        ("gradient_accumulation_steps", 1),
        ("krea_num_repeats", 1),
        ("blocks_to_swap", 0),
        ("max_data_loader_n_workers", 0),
        ("text_cache_batch_size", 1),
    ):
        _as_int(config, key, errors, minimum)
    if isinstance(config.get("blocks_to_swap"), int) and config["blocks_to_swap"] > 26:
        errors.append("blocks_to_swap: Krea 2 maximum is 26 / Krea 2 最大值为 26")

    for key, minimum in (("network_dropout", 0.0), ("discrete_flow_shift", 0.01), ("learning_rate", 0.0)):
        if key == "discrete_flow_shift" and config.get("timestep_sampling", "shift") != "shift":
            continue
        number = _as_float(config, key, errors, minimum)
        if key == "network_dropout" and number is not None and number > 0.5:
            errors.append("network_dropout: must be <= 0.5 / 不能大于 0.5")
        if key == "learning_rate" and number is not None and number <= 0:
            errors.append("learning_rate: must be > 0 / 必须大于 0")

    if str(config.get("mixed_precision", "bf16")) not in {"bf16", "fp16", "no"}:
        errors.append("mixed_precision: unsupported value / 不支持的选项")
    if str(config.get("timestep_sampling", "shift")) not in {"shift", "krea2_shift"}:
        errors.append("timestep_sampling: unsupported value / 不支持的选项")
    if str(config.get("weighting_scheme", "none")) != "none":
        errors.append("weighting_scheme: Krea 2 profile currently supports none only / 当前仅支持 none")
    if str(config.get("krea_attention_backend", "sdpa")) not in _ATTENTION_FLAGS:
        errors.append("krea_attention_backend: unsupported value / 不支持的选项")
    if config.get("fp8_base") and not config.get("fp8_scaled"):
        errors.append("fp8_scaled: Krea 2 requires scaled FP8 with fp8_base / fp8_base 必须同时启用 fp8_scaled")

    return errors


def build_krea2_dataset_config(config: dict[str, Any]) -> dict[str, Any]:
    """Build musubi's separate dataset TOML object from the visible Krea form."""

    width, height = parse_krea2_resolution(config["resolution"])
    return {
        "general": {
            "resolution": [width, height],
            "caption_extension": str(config["caption_extension"]),
            "batch_size": int(config["train_batch_size"]),
            "enable_bucket": bool(config.get("enable_bucket", True)),
            "bucket_no_upscale": bool(config.get("bucket_no_upscale", True)),
        },
        "datasets": [
            {
                "image_directory": str(config["train_data_dir"]),
                "cache_directory": str(config["dataset_cache_dir"]),
                "num_repeats": int(config.get("krea_num_repeats", 1)),
            }
        ],
    }


def build_krea2_train_config(
    config: dict[str, Any],
    dataset_config_path: str | Path,
    output_dir: str | Path,
    logging_dir: str | Path,
) -> dict[str, Any]:
    """Encode only musubi Krea 2 flags into the flat training TOML."""

    # Batch size belongs solely to the musubi dataset TOML. Keep unsupported
    # legacy sd-scripts keys out of this file: musubi's config loader retains
    # unknown keys silently, which would otherwise make a displayed setting
    # look effective when it is not.
    result: dict[str, Any] = {
        "dit": str(config["dit"]),
        "vae": str(config["vae"]),
        "dataset_config": str(dataset_config_path),
        "network_module": KREA2_NETWORK_MODULE,
        "network_dim": int(config["network_dim"]),
        "network_alpha": int(config["network_alpha"]),
        "network_dropout": float(config.get("network_dropout", 0)),
        "max_train_epochs": int(config["max_train_epochs"]),
        "gradient_accumulation_steps": int(config["gradient_accumulation_steps"]),
        "gradient_checkpointing": bool(config.get("gradient_checkpointing", False)),
        "learning_rate": float(config["learning_rate"]),
        "seed": int(config.get("seed", 42)),
        "mixed_precision": str(config.get("mixed_precision", "bf16")),
        "timestep_sampling": str(config.get("timestep_sampling", "shift")),
        "weighting_scheme": "none",
        "optimizer_type": str(config.get("optimizer_type", "adamw8bit")),
        "output_dir": str(output_dir),
        "output_name": str(config["output_name"]),
        "logging_dir": str(logging_dir),
        "save_precision": str(config.get("save_precision", "bf16")),
        "save_every_n_epochs": int(config.get("save_every_n_epochs", 1)),
        "max_data_loader_n_workers": int(config.get("max_data_loader_n_workers", 2)),
    }
    if result["timestep_sampling"] == "shift":
        result["discrete_flow_shift"] = float(config.get("discrete_flow_shift", 2.5))
    if bool(config.get("persistent_data_loader_workers", True)):
        result["persistent_data_loader_workers"] = True
    if bool(config.get("save_state", False)):
        result["save_state"] = True
    if not _is_empty(config.get("resume")):
        result["resume"] = str(config["resume"])
    if int(config.get("blocks_to_swap", 0)) > 0:
        result["blocks_to_swap"] = int(config["blocks_to_swap"])
    if bool(config.get("fp8_base", False)):
        result["fp8_base"] = True
        result["fp8_scaled"] = True
    if bool(config.get("compile", False)):
        result["compile"] = True

    attention = str(config.get("krea_attention_backend", "sdpa"))
    result[_ATTENTION_FLAGS[attention]] = True
    if attention != "sdpa":
        result["split_attn"] = True

    network_args = _split_args(config.get("network_args_custom"))
    if network_args:
        result["network_args"] = network_args
    optimizer_args = _split_args(config.get("krea_optimizer_args"))
    if optimizer_args:
        result["optimizer_args"] = optimizer_args
    return result


def _musubi_runtime_versions() -> tuple[dict[str, str | None], str | None]:
    """Read versions from musubi's isolated core interpreter.

    Inspecting metadata in the web-server interpreter would inspect
    sd-scripts' environment instead, defeating dependency isolation.
    """
    runtime_python = get_engine("musubi_tuner").python_executable
    if runtime_python is None or not runtime_python.is_file():
        return {}, (
            "musubi core virtual environment is not installed / "
            f"musubi 核心虚拟环境未安装: {runtime_python}"
        )

    probe = (
        "import importlib.metadata as m, json, torch, accelerate, av, cv2, diffusers, einops, ftfy, safetensors, sentencepiece, toml, voluptuous; "
        "from PIL import Image; from transformers import Qwen3VLConfig, Qwen3VLForConditionalGeneration; "
        "installed={d.metadata['Name'].lower():d.version for d in m.distributions() if d.metadata.get('Name')}; "
        f"names={tuple(_MUSUBI_RUNTIME_PACKAGES)!r}; "
        "print(json.dumps({name: installed.get(name.lower()) for name in names}))"
    )
    try:
        completed = subprocess.run(
            [str(runtime_python), "-X", "utf8", "-c", probe],
            cwd=MUSUBI_TUNER_DIR,
            capture_output=True,
            encoding="utf-8",
            errors="strict",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {}, f"failed to inspect musubi runtime / 无法检查 musubi 运行环境: {exc}"
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[:500]
        return {}, f"failed to inspect musubi runtime / 无法检查 musubi 运行环境: {detail}"
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return {}, f"invalid musubi runtime probe result / musubi 运行环境检查结果无效: {exc}"
    if not isinstance(payload, dict):
        return {}, "invalid musubi runtime probe result / musubi 运行环境检查结果无效"
    return {str(key): (str(value) if value is not None else None) for key, value in payload.items()}, None


def _runtime_version_error(package_name: str, expected: str | None, installed: str) -> str | None:
    """Return an actionable version mismatch message, if any."""

    if expected is None:
        return None
    if expected.startswith(">="):
        minimum = expected[2:]
        try:
            if Version(installed) >= Version(minimum):
                return None
        except InvalidVersion:
            pass
        return (
            f"{package_name} must be {expected}, found {installed} / "
            f"{package_name} 版本必须为 {expected}，当前为 {installed}"
        )
    if installed == expected:
        return None
    return (
        f"{package_name} must be {expected}, found {installed} / "
        f"{package_name} 版本必须为 {expected}，当前为 {installed}"
    )


def krea2_preflight(config: dict[str, Any], require_cache: bool = True) -> dict[str, Any]:
    """Check runtime, dependency, local model and cache readiness before launch."""

    errors: list[str] = []
    script = MUSUBI_TUNER_DIR / "krea2_train_network.py"
    package_dir = MUSUBI_TUNER_DIR / "src" / "musubi_tuner"
    if not script.is_file() or not package_dir.is_dir():
        errors.append(
            f"musubi-tuner source is not installed / musubi-tuner 源码未安装: {MUSUBI_TUNER_DIR}"
        )

    installed_packages, probe_error = _musubi_runtime_versions()
    if probe_error:
        errors.append(probe_error)
    for package_name, expected in _MUSUBI_RUNTIME_PACKAGES.items():
        installed = installed_packages.get(package_name)
        if installed is None:
            errors.append(f"{package_name} is not installed / 未安装 {package_name}")
            continue
        version_error = _runtime_version_error(package_name, expected, installed)
        if version_error:
            errors.append(version_error)

    for key, label in (("dit", "Krea 2 RAW DiT"), ("vae", "Qwen-Image VAE"), ("text_encoder", "Qwen3-VL text encoder")):
        path = Path(str(config.get(key) or ""))
        if not path.is_file():
            errors.append(f"{label} not found / 模型文件不存在: {path}")

    images = image_files(config.get("train_data_dir") or "", config.get("dataset_cache_dir"))
    if not images:
        errors.append("Dataset directory has no supported images / 数据集目录没有可用图片")

    cache_status = get_krea2_cache_status(config)
    if require_cache and not cache_status["ready"]:
        errors.append(
            "Krea 2 latent/text caches are missing or stale; prepare both caches before training / "
            "Krea 2 latent 与文本缓存缺失或已失效，请先生成缓存"
        )

    return {"ok": not errors, "errors": errors, "cache": cache_status}


def estimate_krea2_steps(config: dict[str, Any]) -> dict[str, Any]:
    """Return a transparent, non-sd-scripts estimate for the Krea profile."""

    try:
        parse_krea2_resolution(config.get("resolution", "1024,1024"))
    except ValueError as exc:
        raise ValueError(f"resolution: {exc}") from exc
    images = image_files(config["train_data_dir"], config.get("dataset_cache_dir"))
    if not images:
        raise ValueError("Dataset directory has no supported images / 数据集路径不存在或无图片")

    try:
        repeats = int(config.get("krea_num_repeats", 1))
        batch_size = int(config.get("train_batch_size", 1))
        accumulation = int(config.get("gradient_accumulation_steps", 1))
        epochs = int(config.get("max_train_epochs", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("batch size, repeats, accumulation and epochs must be integers / 批量、重复、累积和轮数必须为整数") from exc
    if min(repeats, batch_size, accumulation, epochs) < 1:
        raise ValueError("batch size, repeats, accumulation and epochs must be positive / 批量、重复、累积和轮数必须大于 0")
    gpu_ids = config.get("gpu_ids")
    gpu_processes = len(gpu_ids) if isinstance(gpu_ids, (list, tuple)) and gpu_ids else 1
    repeated_samples = len(images) * repeats
    batches = math.ceil(repeated_samples / batch_size)
    steps_per_epoch = math.ceil(batches / gpu_processes / accumulation)
    return {
        "engine_id": "musubi_tuner",
        "approximate": bool(config.get("enable_bucket", True)),
        "original_images": len(images),
        "repeated_samples": repeated_samples,
        "subsets": [{"name": Path(config["train_data_dir"]).name, "image_count": len(images), "repeats": repeats}],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_count": 1,
        "batches_per_epoch": batches,
        "batch_size": batch_size,
        "gradient_accumulation_steps": accumulation,
        "gpu_processes": gpu_processes,
        "effective_batch": batch_size * accumulation * gpu_processes,
        "steps_per_epoch": steps_per_epoch,
        "max_train_epochs": epochs,
        "total_steps": steps_per_epoch * epochs,
    }
