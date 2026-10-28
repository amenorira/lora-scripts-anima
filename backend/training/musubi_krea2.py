"""Krea 2 profile codec and runtime preflight.

Krea 2 is intentionally kept outside the sd-scripts adapter. Its dataset TOML,
two-stage cache, model arguments, and attention flags are musubi-tuner
semantics and must never inherit sd-scripts-only values.
"""
from __future__ import annotations

import ast
import importlib.metadata
import json
import logging
import math
from pathlib import Path
from typing import Any

from backend.training.core_registry import MUSUBI_TUNER_DIR
from backend.training.krea2_dataset import dataset_groups, parse_krea2_resolution
from backend.training.krea2_cache import get_krea2_cache_status
from backend.training.krea2_network import (
    KREA2_NETWORK_MODULE, KREA2_LYCORIS_MODULE,
    KREA2_PRESET_FILENAME, build_krea2_network_args, validate_krea2_network,
)
from backend.training.scheduler_config import normalize_scheduler_config, validate_scheduler_config
from backend.training.optimizer_contracts import extract_optimizer_form
from backend.training.krea2_optimizers import (
    collect_arguments as _collect_krea2_arguments,
    validate_optimizer as _validate_krea2_optimizer,
)
from backend.training.musubi_runtime import MUSUBI_RUNTIME_PACKAGES, shared_runtime_status
from backend.training.krea2_fields import KREA2_FIELDS
from backend.training.krea2_options import (
    KREA2_PROFILE_ID,
    ATTENTION_FLAGS as _ATTENTION_FLAGS,
    MIXED_PRECISIONS as _KREA2_MIXED_PRECISIONS,
    TRAINING_DURATIONS as _KREA2_TRAINING_DURATIONS,
    LR_SCHEDULERS as _KREA2_LR_SCHEDULERS,
    COMPILE_MODES as _KREA2_COMPILE_MODES,
    COMPILE_DYNAMIC_VALUES as _KREA2_COMPILE_DYNAMIC_VALUES,
    PRODIGYPLUS_OPTIMIZER as _KREA2_PRODIGYPLUS_OPTIMIZER,
    INTERNAL_SCHEDULER_OPTIMIZERS as _KREA2_INTERNAL_SCHEDULER_OPTIMIZERS,
    SCHEDULEFREE_WARMUP_OPTIMIZERS as _KREA2_SCHEDULEFREE_WARMUP_OPTIMIZERS,
    PRODIGY_OPTIMIZERS as _KREA2_PRODIGY_OPTIMIZERS,
    BETA_LENGTHS as _KREA2_BETA_LENGTHS,
    BETA_OPTIMIZERS as _KREA2_BETA_OPTIMIZERS,
    EPS_OPTIMIZERS as _KREA2_EPS_OPTIMIZERS,
    MIN_LR_RATIO_SCHEDULERS as _KREA2_MIN_LR_RATIO_SCHEDULERS,
    NUM_CYCLES_SCHEDULERS as _KREA2_NUM_CYCLES_SCHEDULERS,
    LEGACY_OPTIMIZER_ALIASES as _KREA2_LEGACY_OPTIMIZER_ALIASES,
    VISIBLE_OPTIMIZERS as _KREA2_VISIBLE_OPTIMIZERS,
    CURATED_OPTIMIZERS as _KREA2_CURATED_OPTIMIZERS,
    OPTIMIZER_ARGUMENTS as _KREA2_OPTIMIZER_ARGUMENTS,
    OPTIONAL_OPTIMIZER_PACKAGES as _KREA2_OPTIONAL_OPTIMIZER_PACKAGES,
)


KREA2_TRAINER_FILE = "./backend/training/krea2_train.py"
KREA2_CACHE_RUNNER_FILE = "./backend/training/krea2_cache_runner.py"
KREA2_AUTO_CACHE_DIR_NAME = ".krea2-cache"


_KREA2_OPTIMIZER_DEFAULTS = {
    field["key"]: field["default"] for field in KREA2_FIELDS
    if field["key"] in _KREA2_OPTIMIZER_ARGUMENTS and field["default"] != ""
}


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def krea2_auto_cache_dir(train_data_dir: Any) -> str:
    """Return Krea's deterministic cache directory for one source dataset."""

    raw_path = str(train_data_dir or "").strip()
    return str(Path(raw_path) / KREA2_AUTO_CACHE_DIR_NAME) if raw_path else ""


def _as_int(config: dict[str, Any], key: str, errors: list[str], minimum: int = 0) -> int | None:
    value = config.get(key)
    if isinstance(value, bool):
        errors.append(f"{key}: must be an integer / 必须是整数")
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be an integer / 必须是整数")
        return None
    if not math.isfinite(number) or not number.is_integer():
        errors.append(f"{key}: must be an integer / 必须是整数")
        return None
    integer = int(number)
    if integer < minimum:
        errors.append(f"{key}: must be >= {minimum} / 不能小于 {minimum}")
        return None
    config[key] = integer
    return integer


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


def _as_steps_or_ratio(config: dict[str, Any], key: str, errors: list[str]) -> int | float | None:
    """Normalize musubi's integer-step or fractional-ratio scheduler values."""

    value = config.get(key)
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be a non-negative step count or ratio / 必须是非负步数或比例")
        return None
    if not math.isfinite(number) or number < 0:
        errors.append(f"{key}: must be non-negative and finite / 必须是非负有限数")
        return None
    if number >= 1 and not number.is_integer():
        errors.append(f"{key}: values >= 1 must be whole steps / 大于等于 1 时必须是整数步数")
        return None
    normalized: int | float = int(number) if number >= 1 and number.is_integer() else number
    config[key] = normalized
    return normalized


def _has_krea2_sample_prompts(value: Any) -> bool:
    """Return whether a musubi prompt file would contain at least one prompt."""

    if not isinstance(value, str):
        return False
    return any(line.strip() and not line.lstrip().startswith("#") for line in value.splitlines())


def _normalize_numeric_literal(
    config: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    """Normalize an optional numeric Python literal used in optimizer args."""

    if _is_empty(config.get(key)):
        return None
    try:
        value = ast.literal_eval(str(config[key]).strip())
        number = float(value)
    except (SyntaxError, ValueError, TypeError):
        errors.append(f"{key}: must be a numeric Python literal / 必须是数字 Python 字面量")
        return None
    if not math.isfinite(number) or (minimum is not None and number < minimum) or (
        maximum is not None and number > maximum
    ):
        errors.append(f"{key}: value is out of range / 数值超出有效范围")
        return None
    config[key] = number
    return number


def _normalize_numeric_tuple(
    config: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    lengths: set[int],
    minimum: float | None = None,
    maximum: float | None = None,
) -> tuple[float, ...] | None:
    """Normalize a comma-separated/tuple numeric literal for musubi kwargs."""

    if _is_empty(config.get(key)):
        return None
    try:
        value = ast.literal_eval(str(config[key]).strip())
    except (SyntaxError, ValueError):
        errors.append(f"{key}: must use comma-separated Python numbers / 必须使用逗号分隔的 Python 数字")
        return None
    if not isinstance(value, (tuple, list)) or len(value) not in lengths:
        expected = "/".join(str(length) for length in sorted(lengths))
        errors.append(f"{key}: requires {expected} values / 需要 {expected} 个数值")
        return None
    try:
        numbers = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        errors.append(f"{key}: values must be numeric / 每个值必须是数字")
        return None
    if any(
        not math.isfinite(number)
        or (minimum is not None and number < minimum)
        or (maximum is not None and number > maximum)
        for number in numbers
    ):
        errors.append(f"{key}: value is out of range / 数值超出有效范围")
        return None
    config[key] = numbers
    return numbers


def _build_krea2_optimizer_args(config: dict[str, Any]) -> list[str]:
    """Use the same profile-specific mapping for native import and export."""
    warnings: list[str] = []
    arguments = _collect_krea2_arguments(
        config, _KREA2_OPTIMIZER_DEFAULTS, _KREA2_OPTIMIZER_ARGUMENTS, warnings=warnings
    )
    for warning in warnings:
        logging.getLogger("anima-trainer").warning(warning)
    if arguments.get("warmup_steps") == 0:
        arguments.pop("warmup_steps")
    return [f"{key}={value!r}" for key, value in arguments.items()]


def extract_krea2_optimizer_form(config: dict[str, Any]) -> dict[str, Any]:
    """Restore supported controls; never silently discard unsupported native kwargs."""
    if (
        "optimizer_args" not in config
        and not config.get("optimizer_args_custom")
        and "bnb_percentile_clipping" not in config
    ):
        return dict(config)
    form = {"optimizer_type": "adamw8bit", "optimizer_args": [], **config}
    errors: list[str] = []
    _normalize_krea2_optimizer_type(form, errors)
    if errors:
        raise ValueError("; ".join(errors))
    if "krea_adamw_fused" in form:
        form["krea_adamw_fused"] = {"auto": None, "true": True, "false": False}.get(form["krea_adamw_fused"], form["krea_adamw_fused"])
    form = extract_optimizer_form(form, mappings=_KREA2_OPTIMIZER_ARGUMENTS)
    extra = form.pop("optimizer_args_custom", "")
    if form["optimizer_type"] == "AdamW":
        extra = "\n".join(line for line in extra.splitlines() if line != "fused=None")
    if "krea_adamw_fused" in form:
        form["krea_adamw_fused"] = "true" if form["krea_adamw_fused"] is True else "false" if form["krea_adamw_fused"] is False else "auto"
    if extra:
        form["optimizer_args_custom"] = extra
    return form


def _normalize_krea2_optimizer_type(config: dict[str, Any], errors: list[str]) -> str:
    """Resolve legacy aliases into an audited optimizer allowlist entry."""

    requested = str(config.get("optimizer_type") or "").strip()
    if not requested:
        errors.append("optimizer_type: required / 必填")
        return ""

    lowered = requested.lower()
    if lowered == "adamw8bit":
        requested = "adamw8bit"
    elif lowered == "adamw":
        requested = "AdamW"
    elif lowered == "adafactor":
        requested = "AdaFactor"
    elif lowered in _KREA2_LEGACY_OPTIMIZER_ALIASES:
        requested = _KREA2_LEGACY_OPTIMIZER_ALIASES[lowered]
    if requested not in _KREA2_CURATED_OPTIMIZERS:
        errors.append(
            "optimizer_type: only the built-in Krea 2 optimizer list is supported "
            "/ 当前仅支持内置的 Krea 2 优化器列表"
        )
        return ""

    config["optimizer_type"] = requested
    return requested


def _selected_optional_optimizer_package(optimizer_type: Any) -> str | None:
    """Return the distribution required by a curated non-musubi optimizer."""

    value = str(optimizer_type or "")
    return next(
        (package for prefix, package in _KREA2_OPTIONAL_OPTIMIZER_PACKAGES.items() if value.startswith(prefix)),
        None,
    )


def _validate_krea2_compute_options(config: dict[str, Any]) -> list[str]:
    """Keep unsupported execution modes out of both launch and native export."""
    errors = []
    if str(config.get("mixed_precision", "bf16")) not in _KREA2_MIXED_PRECISIONS:
        errors.append(
            "mixed_precision: Krea 2 requires bf16 or fp16 because the DiT uses BF16 weights "
            "/ Krea 2 主模型使用 BF16 权重，混合精度请选择 bf16 或 fp16"
        )
    attention = str(config.get("krea_attention_backend", "sdpa"))
    if attention == "sage_attn":
        errors.append(
            "krea_attention_backend: SageAttention does not support Krea 2 training; "
            "select SDPA, FlashAttention or xFormers "
            "/ Krea 2 训练不支持 SageAttention，请选择 SDPA、FlashAttention 或 xFormers"
        )
    elif attention not in _ATTENTION_FLAGS:
        errors.append("krea_attention_backend: unsupported value / 不支持的选项")
    return errors


def validate_krea2_config(config: dict[str, Any]) -> list[str]:
    """Validate and normalize the strict Krea 2 UI payload."""
    from backend.training.attention_config import normalize_attention_config

    normalize_attention_config(config)

    # Keep old saved Krea presets and direct API callers compatible with newer
    # optional controls.  The browser normally supplies these defaults, but a
    # persisted preset may predate a field we added later.
    for key, default in {
        "krea_training_duration_mode": "epochs",
        "optimizer_type": "adamw8bit",
        "max_grad_norm": 1.0,
        "lr_scheduler": "constant",
        "lr_warmup_steps": 0,
        "lr_decay_steps": 0,
        "lr_scheduler_num_cycles": 1,
        "lr_scheduler_power": 1.0,
        **_KREA2_OPTIMIZER_DEFAULTS,
        "compile_mode": "default",
        "compile_dynamic": "auto",
        "block_swap_ring_size": 2,
        "enable_krea_samples": False,
        "sample_every_n_epochs": 1,
        "min_timestep": 0,
        "max_timestep": 1000,
        "krea_latent_cache_device": "auto", "krea_text_cache_device": "auto",
        "krea_latent_cache_batch_size": 1, "krea_cache_num_workers": 2,
        "krea_cache_reuse": True, "krea_cache_vae_tiling": False, "krea_split_attn": "auto",
    }.items():
        config.setdefault(key, default)

    # Keep every cache beside the dataset that produced it.  This is a UI and
    # launch invariant rather than an optional musubi argument: a stale preset
    # or direct API call must not scatter Krea cache files elsewhere.
    automatic_cache_dir = krea2_auto_cache_dir(config.get("train_data_dir"))
    if automatic_cache_dir:
        config["dataset_cache_dir"] = automatic_cache_dir

    errors = _validate_krea2_compute_options(config)
    for key in ("krea_latent_cache_device", "krea_text_cache_device"):
        if config[key] not in ("auto", "cuda", "cpu"):
            errors.append(f"{key}: choose auto, cuda or cpu / 请选择自动、GPU 或 CPU")
    for key in ("krea_adamw_fused", "krea_split_attn"):
        if config[key] not in ("auto", "true", "false"):
            errors.append(f"{key}: unsupported value / 不支持的选项")
    for key in ("krea_cache_reuse", "krea_cache_vae_tiling"):
        if not isinstance(config[key], bool):
            errors.append(f"{key}: must be boolean / 必须为布尔值")
    if config.get("krea_attention_backend") == "xformers" and config["krea_split_attn"] == "false":
        errors.append("krea_split_attn: xFormers requires split attention for Krea 2 / Krea 2 使用 xFormers 时需要拆分注意力")
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

    errors.extend(validate_krea2_network(config))

    try:
        width, height = parse_krea2_resolution(config.get("resolution", ""))
        config["resolution"] = f"{width},{height}"
    except ValueError as exc:
        errors.append(f"resolution: {exc}")

    caption_extension = str(config.get("caption_extension") or "")
    if caption_extension and not caption_extension.startswith("."):
        errors.append("caption_extension: must start with '.' / 必须以 '.' 开头")

    duration_mode = str(config.get("krea_training_duration_mode", "epochs"))
    if duration_mode not in _KREA2_TRAINING_DURATIONS:
        errors.append("krea_training_duration_mode: unsupported value / 不支持的选项")
    else:
        config["krea_training_duration_mode"] = duration_mode

    optimizer_type = _normalize_krea2_optimizer_type(config, errors)
    if optimizer_type == "AdaFactor":
        for key in ("krea_adafactor_relative_step", "krea_adafactor_scale_parameter", "krea_adafactor_warmup_init"):
            if not isinstance(config[key], bool):
                errors.append(f"{key}: must be true or false / 必须是布尔值")
        if config["krea_adafactor_warmup_init"] is True and config["krea_adafactor_relative_step"] is False:
            errors.append(
                "krea_adafactor_warmup_init: requires krea_adafactor_relative_step=True "
                "/ 启用预热初始化时必须启用相对步长"
            )
    adafactor_relative_step = config["krea_adafactor_relative_step"] is True

    # musubi's trainer returns an internal dummy scheduler for ScheduleFree,
    # and switches to its own AdafactorSchedule in relative-step mode.  Keep
    # the persisted config honest rather than displaying external settings
    # that the upstream training loop will ignore.
    internal_scheduler = optimizer_type in _KREA2_INTERNAL_SCHEDULER_OPTIMIZERS or (
        optimizer_type == "AdaFactor" and adafactor_relative_step
    )
    if internal_scheduler:
        config["lr_scheduler"] = "constant"
        config["lr_warmup_steps"] = 0

    for key, minimum in (
        ("network_dim", 1),
        ("train_batch_size", 1),
        ("gradient_accumulation_steps", 1),
        ("krea_num_repeats", 1),
        ("blocks_to_swap", 0),
        ("max_data_loader_n_workers", 0),
        ("text_cache_batch_size", 1),
        ("krea_latent_cache_batch_size", 1),
        ("krea_cache_num_workers", 1),
        ("save_every_n_epochs", 1),
    ):
        _as_int(config, key, errors, minimum)
    if duration_mode == "steps":
        _as_int(config, "max_train_steps", errors, 1)
    else:
        _as_int(config, "max_train_epochs", errors, 1)

    for key, minimum in (
        ("block_swap_ring_size", 1),
        ("save_every_n_steps", 1),
        ("save_last_n_epochs", 1),
        ("save_last_n_epochs_state", 1),
        ("save_last_n_steps", 1),
        ("save_last_n_steps_state", 1),
        ("num_timestep_buckets", 2),
        ("sample_every_n_steps", 1),
    ):
        if not _is_empty(config.get(key)):
            _as_int(config, key, errors, minimum)
    if isinstance(config.get("blocks_to_swap"), int) and config["blocks_to_swap"] > 26:
        errors.append("blocks_to_swap: Krea 2 maximum is 26 / Krea 2 最大值为 26")

    for key, minimum in (
        ("network_dropout", 0.0),
        ("network_alpha", 0.0),
        ("discrete_flow_shift", 0.01),
        ("learning_rate", 0.0),
        ("max_grad_norm", 0.0),
        ("lr_scheduler_power", 0.01),
    ):
        if key == "discrete_flow_shift" and config.get("timestep_sampling", "shift") != "shift":
            continue
        if key == "lr_scheduler_power" and str(config.get("lr_scheduler", "constant")) != "polynomial":
            continue
        number = _as_float(config, key, errors, minimum)
        if key == "network_dropout" and number is not None and number > 1.0:
            errors.append("network_dropout: must be <= 1 / 不能大于 1")
        if key == "learning_rate" and number is not None and number <= 0:
            errors.append("learning_rate: must be > 0 / 必须大于 0")
    if not _is_empty(config.get("sigmoid_scale")):
        _as_float(config, "sigmoid_scale", errors)
    timestep_sampling = str(config.get("timestep_sampling", "shift"))
    for key, default in (("min_timestep", 0), ("max_timestep", 1000)):
        if _is_empty(config.get(key)):
            config[key] = default
    low = _as_int(config, "min_timestep", errors, 0)
    high = _as_int(config, "max_timestep", errors, 1)
    if low is not None and high is not None and not 0 <= low < high <= 1000:
        errors.append("min_timestep/max_timestep: require 0 <= min < max <= 1000 / 时间步范围必须满足 0 ≤ 最小值 < 最大值 ≤ 1000")
    if not _is_empty(config.get("scale_weight_norms")):
        _as_float(config, "scale_weight_norms", errors, 0)
    if config.get("dim_from_weights") and (not config.get("network_weights") or config.get("network_module") != KREA2_NETWORK_MODULE):
        errors.append("dim_from_weights: requires native LoRA and network_weights / 从权重推导维度需要原生 LoRA 和初始权重")
    weighting_scheme = str(config.get("weighting_scheme", "none"))
    uses_logit_parameters = timestep_sampling == "logsnr" or (
        timestep_sampling == "sigma" and weighting_scheme == "logit_normal"
    )
    uses_mode_scale = timestep_sampling == "sigma" and weighting_scheme == "mode"
    if uses_logit_parameters and not _is_empty(config.get("logit_mean")):
        _as_float(config, "logit_mean", errors)
    if uses_logit_parameters and not _is_empty(config.get("logit_std")):
        _as_float(config, "logit_std", errors, 0.0)
    if uses_mode_scale and not _is_empty(config.get("mode_scale")):
        _as_float(config, "mode_scale", errors)

    for key in ("lr_warmup_steps", "lr_decay_steps"):
        if not _is_empty(config.get(key)):
            _as_steps_or_ratio(config, key, errors)
    scheduler_name = str(config.get("lr_scheduler", "constant"))
    errors.extend(validate_scheduler_config(config))
    if scheduler_name == "piecewise_constant":
        config["lr_warmup_steps"] = 0
    # get_cosine_with_min_lr_schedule_with_warmup rejects a missing floor;
    # use zero to match an ordinary cosine schedule for direct API callers and
    # old presets that naturally predate this guided field.
    if scheduler_name == "cosine_with_min_lr" and _is_empty(config.get("lr_scheduler_min_lr_ratio")):
        config["lr_scheduler_min_lr_ratio"] = 0.0
    if scheduler_name == "constant":
        try:
            has_warmup = float(config.get("lr_warmup_steps", 0) or 0) != 0
        except (TypeError, ValueError):
            has_warmup = False
        if has_warmup:
            errors.append("lr_warmup_steps: constant scheduler does not accept warmup / constant 调度器不支持预热")
    if scheduler_name in _KREA2_NUM_CYCLES_SCHEDULERS:
        _as_int(config, "lr_scheduler_num_cycles", errors, 1)
    if scheduler_name == "inverse_sqrt" and not _is_empty(config.get("lr_scheduler_timescale")):
        _as_int(config, "lr_scheduler_timescale", errors, 1)
    if scheduler_name in _KREA2_MIN_LR_RATIO_SCHEDULERS and not _is_empty(
        config.get("lr_scheduler_min_lr_ratio")
    ):
        ratio = _as_float(config, "lr_scheduler_min_lr_ratio", errors, 0.0)
        if ratio is not None and ratio > 1.0:
            errors.append("lr_scheduler_min_lr_ratio: must be <= 1 / 不能大于 1")

    if not _is_empty(config.get("krea_optimizer_weight_decay")):
        _as_float(config, "krea_optimizer_weight_decay", errors, 0.0)
    if not _is_empty(config.get("krea_optimizer_betas")):
        if optimizer_type not in _KREA2_BETA_OPTIMIZERS:
            errors.append("krea_optimizer_betas: not supported by the selected optimizer / 当前优化器不支持 betas")
        else:
            _normalize_numeric_tuple(
                config,
                "krea_optimizer_betas",
                errors,
                lengths=_KREA2_BETA_LENGTHS[optimizer_type],
                minimum=0.0,
                maximum=0.999999999,
            )
    if not _is_empty(config.get("krea_optimizer_eps")):
        if optimizer_type not in _KREA2_EPS_OPTIMIZERS:
            errors.append("krea_optimizer_eps: not supported by the selected optimizer / 当前优化器不支持 eps")
        elif optimizer_type == _KREA2_PRODIGYPLUS_OPTIMIZER and str(config["krea_optimizer_eps"]).strip() == "None":
            config["krea_optimizer_eps"] = "None"
        else:
            _normalize_numeric_literal(config, "krea_optimizer_eps", errors, minimum=1e-30)

    if optimizer_type in _KREA2_PRODIGY_OPTIMIZERS:
        config["learning_rate"] = 1.0
        _normalize_numeric_literal(config, "krea_prodigy_d_coef", errors, minimum=1e-30)
        _normalize_numeric_literal(config, "krea_prodigy_d0", errors, minimum=1e-30)

    if optimizer_type == "AdaFactor":
        _as_float(config, "krea_adafactor_clip_threshold", errors, 0.00000001)
        _normalize_numeric_tuple(
            config,
            "krea_adafactor_eps",
            errors,
            lengths={2},
            minimum=1e-30,
        )
    if optimizer_type in _KREA2_SCHEDULEFREE_WARMUP_OPTIMIZERS:
        _as_int(config, "krea_schedulefree_warmup_steps", errors, 0)

    if optimizer_type in _KREA2_VISIBLE_OPTIMIZERS:
        try:
            arguments = _collect_krea2_arguments(config, _KREA2_OPTIMIZER_DEFAULTS, _KREA2_OPTIMIZER_ARGUMENTS)
            errors.extend(_validate_krea2_optimizer(config, arguments, config.get("gpu_ids")))
            if optimizer_type == _KREA2_PRODIGYPLUS_OPTIMIZER and (
                arguments.get("use_stableadamw", True) is not False or arguments.get("eps", 1e-8) is None
            ):
                config["max_grad_norm"] = 0.0
        except (TypeError, ValueError) as exc:
            errors.append(f"optimizer_args: {exc}")
        if optimizer_type in {"AdaFactor", "pytorch_optimizer.LoRARite"}:
            config["max_grad_norm"] = 0.0

    for key, message in (
        ("krea_optimizer_custom_type", "custom optimizer classes are not supported / 不支持自定义优化器类"),
        ("krea_optimizer_args", "raw optimizer args are not supported; use the guided fields / 不支持原始优化器参数，请使用界面字段"),
        ("krea_lr_scheduler_type", "custom scheduler classes are not supported / 不支持自定义学习率调度器类"),
        ("krea_lr_scheduler_args", "raw scheduler args are not supported; use the guided fields / 不支持原始调度器参数，请使用界面字段"),
    ):
        if not _is_empty(config.get(key)):
            errors.append(f"{key}: {message}")
    if not _is_empty(config.get("compile_cache_size_limit")):
        _as_int(config, "compile_cache_size_limit", errors, 1)

    if str(config.get("timestep_sampling", "shift")) not in {
        "uniform", "sigmoid", "sigma", "shift", "flux_shift", "krea2_shift", "logsnr"
    }:
        errors.append("timestep_sampling: unsupported value / 不支持的选项")
    if str(config.get("weighting_scheme", "none")) not in {
        "none", "sigma_sqrt", "cosmap", "logit_normal", "mode"
    }:
        errors.append("weighting_scheme: unsupported value / 不支持的选项")
    if str(config.get("lr_scheduler", "constant")) not in _KREA2_LR_SCHEDULERS:
        errors.append("lr_scheduler: unsupported value / 不支持的选项")
    if str(config.get("lr_scheduler", "constant")) == "adafactor":
        errors.append(
            "lr_scheduler: adafactor is managed internally; select AdaFactor relative-step mode instead "
            "/ adafactor 由内部管理，请改用 AdaFactor 相对步长模式"
        )
    if str(config.get("compile_mode", "default")) not in _KREA2_COMPILE_MODES:
        errors.append("compile_mode: unsupported value / 不支持的选项")
    if str(config.get("compile_dynamic", "auto")) not in _KREA2_COMPILE_DYNAMIC_VALUES:
        errors.append("compile_dynamic: unsupported value / 不支持的选项")
    # Krea 2 exposes scaled FP8 as one real choice.  Keep the old wire key
    # readable, but normalize it from fp8_base so stale presets cannot express
    # the unsupported plain-FP8 combination.
    config["fp8_scaled"] = bool(config.get("fp8_base", False))
    if str(config.get("save_precision", "bf16")) not in {"bf16", "fp16", "float"}:
        errors.append("save_precision: unsupported value / 不支持的保存精度")
    if config.get("convrot_int8"):
        if config.get("fp8_base"):
            errors.append("convrot_int8: cannot be combined with fp8_base / ConvRot INT8 与 FP8 不能同时启用")
        if config.get("convrot_int8_bwd", "bf16") not in {"bf16", "int8"}:
            errors.append("convrot_int8_bwd: expected bf16 or int8 / 请选择 bf16 或 int8")
    if config.get("gradient_checkpointing_cpu_offload") and not config.get("gradient_checkpointing"):
        errors.append(
            "gradient_checkpointing_cpu_offload: requires gradient_checkpointing / 必须同时启用 gradient_checkpointing"
        )
    if config.get("block_swap_h2d_only"):
        if int(config.get("blocks_to_swap") or 0) < 1:
            errors.append("block_swap_h2d_only: requires blocks_to_swap > 0 / 需要至少换出一个块")
        if not config.get("gradient_checkpointing"):
            errors.append("block_swap_h2d_only: requires gradient_checkpointing / 必须启用 gradient_checkpointing")

    samples_enabled = bool(config.get("enable_krea_samples", False))
    if samples_enabled:
        if not _has_krea2_sample_prompts(config.get("krea_sample_prompts")):
            errors.append("krea_sample_prompts: at least one non-comment prompt is required / 至少需要一条非注释提示词")
        _as_int(config, "sample_every_n_epochs", errors, 1)
        turbo_dit = str(config.get("turbo_dit") or "").strip()
        turbo_lora = str(config.get("turbo_lora") or "").strip()
        if turbo_dit and turbo_lora:
            errors.append("turbo_lora: cannot be combined with turbo_dit / Turbo LoRA 与 Turbo DiT 不能同时使用")
        if turbo_dit and config.get("convrot_int8"):
            errors.append("turbo_dit: cannot be combined with convrot_int8 / Turbo DiT 暂不支持 ConvRot INT8")
        if turbo_lora:
            config.setdefault("turbo_lora_multiplier", 1.0)
            _as_float(config, "turbo_lora_multiplier", errors)
        if config.get("turbo_dit_cache") and not turbo_dit:
            errors.append("turbo_dit_cache: requires turbo_dit / 必须先指定 Turbo DiT")
        if turbo_dit and int(config.get("blocks_to_swap") or 0) > 0:
            errors.append("turbo_dit: cannot be combined with blocks_to_swap / 不能与 blocks_to_swap 同时使用")

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
                "image_directory": str(directory),
                "cache_directory": str(cache),
                "num_repeats": int(config.get("krea_num_repeats", 1)),
            }
            for directory, cache, _ in dataset_groups(config)
        ],
    }


def build_krea2_train_config(
    config: dict[str, Any],
    dataset_config_path: str | Path,
    output_dir: str | Path,
    logging_dir: str | Path,
    sample_prompts_path: str | Path | None = None,
) -> dict[str, Any]:
    """Encode only musubi Krea 2 flags into the flat training TOML."""
    from backend.training.attention_config import normalize_attention_config

    config = dict(config)
    normalize_attention_config(config)
    errors = _validate_krea2_compute_options(config) + validate_krea2_network(config)
    if errors:
        raise ValueError("; ".join(errors))

    optimizer_type = str(config.get("optimizer_type", "adamw8bit"))
    # Normal launch paths call validate_krea2_config first, but keep this
    # serialization boundary closed for direct integrations as well.
    if optimizer_type not in _KREA2_CURATED_OPTIMIZERS:
        raise ValueError(
            "optimizer_type: only the built-in Krea 2 optimizer list is supported "
            "/ 当前仅支持内置的 Krea 2 优化器列表"
        )

    # Batch size belongs solely to the musubi dataset TOML. Keep unsupported
    # legacy sd-scripts keys out of this file: musubi's config loader retains
    # unknown keys silently, which would otherwise make a displayed setting
    # look effective when it is not.
    result: dict[str, Any] = {
        "dit": str(config["dit"]),
        "vae": str(config["vae"]),
        "dataset_config": str(dataset_config_path),
        "network_module": config["network_module"],
        "network_dim": int(config["network_dim"]),
        "network_alpha": float(config["network_alpha"]),
        "network_dropout": float(config.get("network_dropout", 0)),
        "gradient_accumulation_steps": int(config["gradient_accumulation_steps"]),
        "gradient_checkpointing": bool(config.get("gradient_checkpointing", False)),
        "learning_rate": float(config["learning_rate"]),
        "max_grad_norm": float(config.get("max_grad_norm", 1.0)),
        "seed": int(config.get("seed", 42)),
        "mixed_precision": str(config.get("mixed_precision", "bf16")),
        "timestep_sampling": str(config.get("timestep_sampling", "shift")),
        "weighting_scheme": str(config.get("weighting_scheme", "none")),
        "optimizer_type": optimizer_type,
        "lr_scheduler": str(config.get("lr_scheduler", "constant")),
        "output_dir": str(output_dir),
        "output_name": str(config["output_name"]),
        "logging_dir": str(logging_dir),
        "save_precision": str(config.get("save_precision", "bf16")),
        "save_every_n_epochs": int(config.get("save_every_n_epochs", 1)),
        "max_data_loader_n_workers": int(config.get("max_data_loader_n_workers", 2)),
    }
    if config["network_module"] == KREA2_LYCORIS_MODULE:
        result.pop("network_dropout", None)
    if str(config.get("krea_training_duration_mode", "epochs")) == "steps":
        result["max_train_steps"] = int(config["max_train_steps"])
    else:
        result["max_train_epochs"] = int(config["max_train_epochs"])
    if result["timestep_sampling"] == "shift":
        result["discrete_flow_shift"] = float(config.get("discrete_flow_shift", 2.5))
    if result["timestep_sampling"] in {"sigmoid", "shift", "flux_shift", "krea2_shift"}:
        result["sigmoid_scale"] = float(config.get("sigmoid_scale", 1.0))
    for key in ("min_timestep", "max_timestep"):
        if not _is_empty(config.get(key)):
            result[key] = int(config[key])
    if result["timestep_sampling"] != "sigma":
        if config.get("preserve_distribution_shape"):
            result["preserve_distribution_shape"] = True
        if not _is_empty(config.get("num_timestep_buckets")):
            result["num_timestep_buckets"] = int(config["num_timestep_buckets"])
    if not _is_empty(config.get("network_weights")):
        result["network_weights"] = str(config["network_weights"])
        if config.get("dim_from_weights") and config["network_module"] == KREA2_NETWORK_MODULE:
            result["dim_from_weights"] = True
    if not _is_empty(config.get("scale_weight_norms")):
        result["scale_weight_norms"] = float(config["scale_weight_norms"])
    uses_logit_parameters = result["timestep_sampling"] == "logsnr" or (
        result["timestep_sampling"] == "sigma"
        and result["weighting_scheme"] == "logit_normal"
    )
    if uses_logit_parameters:
        result["logit_mean"] = float(config.get("logit_mean", 0.0))
        result["logit_std"] = float(config.get("logit_std", 1.0))
    if (
        result["timestep_sampling"] == "sigma"
        and result["weighting_scheme"] == "mode"
    ):
        result["mode_scale"] = float(config.get("mode_scale", 1.29))
    if not _is_empty(config.get("lr_warmup_steps")) and float(config["lr_warmup_steps"]) != 0:
        result["lr_warmup_steps"] = config["lr_warmup_steps"]
    if not _is_empty(config.get("lr_decay_steps")) and float(config["lr_decay_steps"]) != 0:
        result["lr_decay_steps"] = config["lr_decay_steps"]
    if result["lr_scheduler"] in _KREA2_NUM_CYCLES_SCHEDULERS:
        result["lr_scheduler_num_cycles"] = int(config.get("lr_scheduler_num_cycles", 1))
    if result["lr_scheduler"] == "polynomial":
        result["lr_scheduler_power"] = float(config.get("lr_scheduler_power", 1.0))
    if result["lr_scheduler"] == "inverse_sqrt" and not _is_empty(config.get("lr_scheduler_timescale")):
        result["lr_scheduler_timescale"] = int(config["lr_scheduler_timescale"])
    if result["lr_scheduler"] in _KREA2_MIN_LR_RATIO_SCHEDULERS and not _is_empty(
        config.get("lr_scheduler_min_lr_ratio")
    ):
        result["lr_scheduler_min_lr_ratio"] = float(config["lr_scheduler_min_lr_ratio"])
    if bool(config.get("persistent_data_loader_workers", True)) and result["max_data_loader_n_workers"] > 0:
        result["persistent_data_loader_workers"] = True
    if bool(config.get("save_state", False)):
        result["save_state"] = True
    if bool(config.get("save_state_on_train_end", False)):
        result["save_state_on_train_end"] = True
    if not _is_empty(config.get("resume")):
        result["resume"] = str(config["resume"])
    for key in ("save_every_n_steps", "save_last_n_epochs", "save_last_n_epochs_state", "save_last_n_steps", "save_last_n_steps_state"):
        if not _is_empty(config.get(key)):
            result[key] = int(config[key])
    if int(config.get("blocks_to_swap", 0)) > 0:
        result["blocks_to_swap"] = int(config["blocks_to_swap"])
        if bool(config.get("use_pinned_memory_for_block_swap", False)):
            result["use_pinned_memory_for_block_swap"] = True
        if bool(config.get("block_swap_h2d_only", False)):
            result["block_swap_h2d_only"] = True
            result["block_swap_ring_size"] = int(config.get("block_swap_ring_size", 2))
    if bool(config.get("fp8_base", False)):
        result["fp8_base"] = True
        result["fp8_scaled"] = True
    if config.get("convrot_int8"):
        result["convrot_int8"] = True
        result["convrot_int8_bwd"] = str(config.get("convrot_int8_bwd", "bf16"))
    if bool(config.get("compile", False)):
        result["compile"] = True
        result["compile_backend"] = str(config.get("compile_backend", "inductor"))
        result["compile_mode"] = str(config.get("compile_mode", "default"))
        result["compile_dynamic"] = str(config.get("compile_dynamic", "auto"))
        if bool(config.get("compile_fullgraph", False)):
            result["compile_fullgraph"] = True
        if not _is_empty(config.get("compile_cache_size_limit")):
            result["compile_cache_size_limit"] = int(config["compile_cache_size_limit"])
    if bool(config.get("gradient_checkpointing_cpu_offload", False)):
        result["gradient_checkpointing_cpu_offload"] = True
    if bool(config.get("cuda_allow_tf32", False)):
        result["cuda_allow_tf32"] = True
    if bool(config.get("cuda_cudnn_benchmark", False)):
        result["cuda_cudnn_benchmark"] = True

    attention = str(config.get("krea_attention_backend", "sdpa"))
    result[_ATTENTION_FLAGS[attention]] = True
    result["split_attn"] = attention != "sdpa" if config.get("krea_split_attn", "auto") == "auto" else config["krea_split_attn"] == "true"

    network_args = build_krea2_network_args(config, Path(dataset_config_path).parent / KREA2_PRESET_FILENAME)
    if network_args:
        result["network_args"] = network_args
    optimizer_args = _build_krea2_optimizer_args(config)
    if optimizer_args:
        result["optimizer_args"] = optimizer_args
    if bool(config.get("enable_krea_samples", False)):
        if sample_prompts_path is None:
            raise ValueError("sample_prompts_path is required when Krea sampling is enabled")
        result["text_encoder"] = str(config["text_encoder"])
        result["sample_prompts"] = str(sample_prompts_path)
        result["sample_every_n_epochs"] = int(config.get("sample_every_n_epochs", 1))
        if not _is_empty(config.get("sample_every_n_steps")):
            result["sample_every_n_steps"] = int(config["sample_every_n_steps"])
        if bool(config.get("sample_at_first", False)):
            result["sample_at_first"] = True
        if not _is_empty(config.get("turbo_dit")):
            result["turbo_dit"] = str(config["turbo_dit"])
            if bool(config.get("turbo_dit_cache", False)):
                result["turbo_dit_cache"] = True
        if not _is_empty(config.get("turbo_lora")):
            result["turbo_lora"] = str(config["turbo_lora"])
            result["turbo_lora_multiplier"] = float(config.get("turbo_lora_multiplier", 1.0))
    scheduler_config = {**result, **{key: config[key] for key in ("warmup_type", "decay_type", "step_rules") if key in config}}
    normalize_scheduler_config(scheduler_config)
    if "lr_scheduler_args" in scheduler_config:
        result["lr_scheduler_args"] = scheduler_config["lr_scheduler_args"]
    if result["lr_scheduler"] == "piecewise_constant":
        result.pop("lr_warmup_steps", None)
    return result


def _read_krea2_checkpoint_tensors(path: Path) -> dict[str, dict]:
    """Read tensor metadata only; never load multi-GB weights during preflight."""
    try:
        with path.open("rb") as stream:
            header_size = int.from_bytes(stream.read(8), "little")
            if not 2 <= header_size <= 16 * 1024 * 1024:
                return {}  # The model loader reports malformed/non-safetensors files.
            header = json.loads(stream.read(header_size))
        return {name: tensor for name, tensor in header.items()
                if name != "__metadata__" and isinstance(tensor, dict)}
    except (OSError, ValueError, AttributeError):
        return {}


def inspect_krea2_checkpoint_format(path: Path) -> dict[str, str]:
    """Identify the selectable DiT format without importing the training runtime."""
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
    """Check runtime, dependency, local model and cache readiness before launch."""

    errors: list[str] = []
    script = MUSUBI_TUNER_DIR / "krea2_train_network.py"
    package_dir = MUSUBI_TUNER_DIR / "src" / "musubi_tuner"
    if not script.is_file() or not package_dir.is_dir():
        errors.append(
            f"musubi-tuner source is not installed / musubi-tuner 源码未安装: {MUSUBI_TUNER_DIR}"
        )

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
    if require_cache and bool(config.get("enable_krea_samples", False)) and not _is_empty(config.get("turbo_dit")):
        turbo_path = Path(str(config["turbo_dit"]))
        if not turbo_path.is_file():
            errors.append(f"Krea 2 Turbo DiT not found / Turbo 模型文件不存在: {turbo_path}")
        else:
            errors.extend(_krea2_checkpoint_format_errors(turbo_path, "turbo_dit", config))
    for key in ("network_weights", "turbo_lora"):
        if key == "turbo_lora" and not config.get("enable_krea_samples"):
            continue
        if not _is_empty(config.get(key)) and not Path(str(config[key])).is_file():
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


def estimate_krea2_steps(config: dict[str, Any]) -> dict[str, Any]:
    """Return a transparent, non-sd-scripts estimate for the Krea profile."""

    try:
        parse_krea2_resolution(config.get("resolution", "1024,1024"))
    except ValueError as exc:
        raise ValueError(f"resolution: {exc}") from exc
    groups = dataset_groups(config)
    images = [image for _, _, group_images in groups for image in group_images]
    if not images:
        raise ValueError("Dataset has no supported images with matching captions / 数据集路径不存在或没有带同名标注的可用图片")

    try:
        repeats = int(config.get("krea_num_repeats", 1))
        batch_size = int(config.get("train_batch_size", 1))
        accumulation = int(config.get("gradient_accumulation_steps", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("batch size, repeats and accumulation must be integers / 批量、重复和累积必须为整数") from exc
    if min(repeats, batch_size, accumulation) < 1:
        raise ValueError("batch size, repeats and accumulation must be positive / 批量、重复和累积必须大于 0")
    gpu_ids = config.get("gpu_ids")
    gpu_processes = len(gpu_ids) if isinstance(gpu_ids, (list, tuple)) and gpu_ids else 1
    repeated_samples = len(images) * repeats
    batches = sum(math.ceil(len(group_images) * repeats / batch_size) for _, _, group_images in groups)
    steps_per_epoch = math.ceil(batches / gpu_processes / accumulation)
    duration_mode = str(config.get("krea_training_duration_mode", "epochs"))
    if duration_mode == "steps":
        try:
            total_steps = int(config.get("max_train_steps", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_train_steps must be an integer / 最大训练步数必须为整数") from exc
        if total_steps < 1:
            raise ValueError("max_train_steps must be positive / 最大训练步数必须大于 0")
        epochs = math.ceil(total_steps / steps_per_epoch)
    else:
        try:
            epochs = int(config.get("max_train_epochs", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_train_epochs must be an integer / 最大训练轮数必须为整数") from exc
        if epochs < 1:
            raise ValueError("max_train_epochs must be positive / 最大训练轮数必须大于 0")
        total_steps = steps_per_epoch * epochs
    return {
        "engine_id": "musubi_tuner",
        "approximate": bool(config.get("enable_bucket", True)),
        "original_images": len(images),
        "repeated_samples": repeated_samples,
        "subsets": [
            {"name": directory.name, "image_count": len(group_images), "repeats": repeats}
            for directory, _, group_images in groups
        ],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_count": 1,
        "batches_per_epoch": batches,
        "batch_size": batch_size,
        "gradient_accumulation_steps": accumulation,
        "gpu_processes": gpu_processes,
        "effective_batch": batch_size * accumulation * gpu_processes,
        "steps_per_epoch": steps_per_epoch,
        "max_train_epochs": epochs,
        "max_train_steps": total_steps,
        "total_steps": total_steps,
    }
