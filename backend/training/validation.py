"""训练配置契约校验。"""
from __future__ import annotations

import math
import re
from typing import Any

from backend.training.field_registry import (
    AUTOMAGIC_OPTIMIZER_TYPE,
    EMOSENS_OPTIMIZER_TYPE,
    FIELDS,
    LORAPLUS_INCOMPATIBLE_OPTIMIZERS,
    LORAPLUS_NETWORK_MODULES,
    LORAPLUS_RATIO_KEYS,
)
from backend.training.optimizer_contracts import (
    parse_optimizer_args,
    validate_optimizer_contract,
)


_TRAIN_TYPE_GROUP = {"sdxl-lora": "sdxl", "anima-lora": "anima"}
_EMPTY_STRINGS = {"", "undefined", "null", "nan"}


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() in _EMPTY_STRINGS
    return isinstance(value, float) and math.isnan(value)


def _applies_to_group(field: dict[str, Any], group: str | None) -> bool:
    field_group = field.get("group")
    if not field_group or field_group == "all" or group is None:
        return True
    groups = field_group if isinstance(field_group, list) else [field_group]
    return group in groups


def _select_values(field: dict[str, Any], group: str | None) -> set[Any]:
    options = list(field.get("options") or [])
    for option_group in field.get("groups") or []:
        options.extend(option_group.get("options") or [])
    return {
        option.get("v")
        for option in options
        if "v" in option and _applies_to_group(option, group)
    }


def _validate_resolution(value: Any, train_type: str) -> str | None:
    parts = re.split(r"\s*[,xX]\s*", str(value).strip())
    if len(parts) not in (1, 2) or any(not part.isdigit() for part in parts):
        return "resolution must be one or two positive integers, e.g. 1024,1024 / 分辨率格式应为正整数，如 1024,1024"
    dimensions = [int(part) for part in parts]
    step = 16 if train_type == "anima-lora" else 64
    if any(dimension <= 0 or dimension % step != 0 for dimension in dimensions):
        return f"resolution must use positive multiples of {step} / 分辨率必须为 {step} 的正整数倍"
    return None


def get_automagic_fused_conflicts(
    config: dict[str, Any], gpu_ids: Any = None
) -> list[str]:
    """Return execution modes that are unsafe for backward-hook updates."""
    conflicts: list[str] = []

    try:
        accumulation = float(config.get("gradient_accumulation_steps", 1))
    except (TypeError, ValueError):
        accumulation = 1
    if accumulation != 1:
        conflicts.append(
            "gradient_accumulation_steps must be 1 / gradient_accumulation_steps 必须为 1"
        )

    try:
        max_grad_norm = float(config.get("max_grad_norm", 1.0))
    except (TypeError, ValueError):
        max_grad_norm = 0
    if max_grad_norm != 0:
        conflicts.append("max_grad_norm must be 0 / max_grad_norm 必须为 0")

    if str(config.get("mixed_precision", "bf16")).lower() == "fp16":
        conflicts.append("mixed_precision cannot be fp16 / mixed_precision 不能为 fp16")

    if isinstance(gpu_ids, (list, tuple)) and len(gpu_ids) > 1:
        conflicts.append("only one GPU is supported / 仅支持单卡")

    return conflicts


def get_emosens_conflicts(config: dict[str, Any], gpu_ids: Any = None) -> list[str]:
    """Return execution modes that do not preserve EmoSens ECC semantics."""
    conflicts: list[str] = []

    try:
        accumulation = float(config.get("gradient_accumulation_steps", 1))
    except (TypeError, ValueError):
        accumulation = 1
    if accumulation != 1:
        conflicts.append(
            "gradient_accumulation_steps must be 1 / gradient_accumulation_steps 必须为 1"
        )

    if str(config.get("mixed_precision", "bf16")).lower() == "fp16":
        conflicts.append("mixed_precision cannot be fp16 / mixed_precision 不能为 fp16")

    if isinstance(gpu_ids, (list, tuple)) and len(gpu_ids) > 1:
        conflicts.append("only one GPU is supported / 仅支持单卡")

    return conflicts


def _validate_emosens(config: dict[str, Any], gpu_ids: Any = None) -> list[str]:
    if config.get("optimizer_type") != EMOSENS_OPTIMIZER_TYPE:
        return []

    errors = [f"EmoSens: {conflict}" for conflict in get_emosens_conflicts(config, gpu_ids)]
    learning_rate = config.get("learning_rate", 1e-4)
    try:
        rate = float(learning_rate)
    except (TypeError, ValueError):
        errors.append("learning_rate: must be a number for EmoSens / 使用 EmoSens 时必须是数字")
    else:
        if not math.isfinite(rate) or rate <= 0:
            errors.append(
                "learning_rate: must be finite and > 0 for EmoSens / "
                "使用 EmoSens 时必须为有限正数"
            )
    return errors


def _validate_automagic(
    config: dict[str, Any], parsed_args: dict[str, Any], gpu_ids: Any = None
) -> list[str]:
    if config.get("optimizer_type") != AUTOMAGIC_OPTIMIZER_TYPE:
        return []

    args = dict(parsed_args)
    errors: list[str] = []
    supported_args = {
        "min_lr",
        "max_lr",
        "beta2",
        "eps",
        "clip_threshold",
        "weight_decay",
        "polarity_history",
        "fused",
    }
    for key in sorted(args.keys() - supported_args):
        errors.append(f"Automagic3 optimizer_args: unsupported argument {key!r} / 不支持此参数")

    top_level_map = {
        "automagic_min_lr": "min_lr",
        "automagic_max_lr": "max_lr",
        "automagic_beta2": "beta2",
        "automagic_clip_threshold": "clip_threshold",
        "automagic_polarity_history": "polarity_history",
        "automagic_fused": "fused",
        "eps": "eps",
        "weight_decay": "weight_decay",
    }
    for form_key, arg_key in top_level_map.items():
        if not _is_empty(config.get(form_key)):
            args[arg_key] = config[form_key]

    defaults = {
        "min_lr": 1e-8,
        "max_lr": 1e-3,
        "beta2": 0.999,
        "eps": 1e-30,
        "clip_threshold": 1.0,
        "weight_decay": 0.0,
    }
    numbers: dict[str, float] = {}
    for key, default in defaults.items():
        value = args.get(key, default)
        try:
            number = float(value)
        except (TypeError, ValueError):
            errors.append(f"Automagic3 {key}: must be a number / 必须是数字")
            continue
        if not math.isfinite(number):
            errors.append(f"Automagic3 {key}: must be finite / 必须是有限数字")
            continue
        numbers[key] = number

    for key in ("min_lr", "max_lr", "eps", "clip_threshold"):
        if key in numbers and numbers[key] <= 0:
            errors.append(f"Automagic3 {key}: must be > 0 / 必须大于 0")
    if "weight_decay" in numbers and numbers["weight_decay"] < 0:
        errors.append("Automagic3 weight_decay: must be >= 0 / 不能小于 0")
    if "beta2" in numbers and not 0 <= numbers["beta2"] < 1:
        errors.append("Automagic3 beta2: must be in [0, 1) / 必须在 [0, 1) 范围内")
    fused = args.get("fused", False)
    if fused not in (False, True, 0, 1):
        errors.append("Automagic3 fused: must be true or false / 必须是布尔值")
    elif fused in (True, 1):
        for conflict in get_automagic_fused_conflicts(config, gpu_ids):
            errors.append(f"Automagic3 fused: {conflict}")

    history = args.get("polarity_history", 8)
    try:
        history_number = float(history)
        if not history_number.is_integer() or not 2 <= history_number <= 64:
            raise ValueError
    except (TypeError, ValueError):
        errors.append("Automagic3 polarity_history: must be an integer from 2 to 64 / 必须是 2 到 64 的整数")

    min_lr = numbers.get("min_lr")
    max_lr = numbers.get("max_lr")
    if min_lr is not None and max_lr is not None and min_lr > max_lr:
        errors.append("Automagic3 min_lr: must not exceed max_lr / 不能大于 max_lr")

    start_rates = [("learning_rate", config.get("learning_rate", 1e-4))]
    start_rates.extend(
        (key, config[key])
        for key in ("unet_lr", "text_encoder_lr")
        if not _is_empty(config.get(key))
    )
    for key, value in start_rates:
        try:
            rate = float(value)
        except (TypeError, ValueError):
            errors.append(f"{key}: must be a number for Automagic3 / 使用 Automagic3 时必须是数字")
            continue
        if not math.isfinite(rate) or rate <= 0:
            errors.append(f"{key}: must be finite and > 0 for Automagic3 / 使用 Automagic3 时必须为有限正数")
        elif min_lr is not None and max_lr is not None and not min_lr <= rate <= max_lr:
            errors.append(
                f"{key}: Automagic3 start LR must be within [{min_lr}, {max_lr}] / "
                "启动学习率必须位于 min_lr 与 max_lr 之间"
            )
    return errors


def validate_training_config(config: dict[str, Any], gpu_ids: Any = None) -> list[str]:
    """根据字段注册表与跨字段契约返回所有配置错误。"""
    errors: list[str] = []
    train_type = str(config.get("model_train_type", "sdxl-lora"))
    group = _TRAIN_TYPE_GROUP.get(train_type)

    for field in FIELDS:
        if not _applies_to_group(field, group):
            continue
        key = field["key"]
        value = config.get(key)
        required = bool(field.get("required")) or group in (field.get("requiredGroups") or [])
        if _is_empty(value):
            if required:
                errors.append(f"{key}: required / 必填")
            continue

        if field.get("type") == "number":
            if isinstance(value, bool):
                errors.append(f"{key}: must be a number / 必须是数字")
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                errors.append(f"{key}: must be a number / 必须是数字")
                continue
            if not math.isfinite(number):
                errors.append(f"{key}: must be finite / 必须是有限数字")
                continue
            normalized_number: int | float = int(number) if number.is_integer() else number
            config[key] = normalized_number
            if "min" in field and number < float(field["min"]):
                errors.append(f"{key}: must be >= {field['min']} / 不能小于 {field['min']}")
            if "max" in field and number > float(field["max"]):
                errors.append(f"{key}: must be <= {field['max']} / 不能大于 {field['max']}")
            step = field.get("step")
            if step and float(step).is_integer():
                base = float(field.get("min", 0))
                if not number.is_integer() or not math.isclose((number - base) % float(step), 0, abs_tol=1e-9):
                    errors.append(f"{key}: must follow step {step} / 必须按步长 {step} 取值")

        if field.get("type") == "toggle" and not isinstance(value, bool):
            errors.append(f"{key}: must be true or false / 必须是布尔值")

        if field.get("type") == "select":
            allowed = _select_values(field, group)
            equivalent = next((candidate for candidate in allowed if str(candidate) == str(value)), None)
            if equivalent is not None:
                config[key] = equivalent
                value = equivalent
            if allowed and value not in allowed:
                errors.append(f"{key}: unsupported value {value!r} / 不支持的选项")

    if config.get("enable_loraplus") and config.get("network_module") in LORAPLUS_NETWORK_MODULES:
        if all(_is_empty(config.get(key)) for key in LORAPLUS_RATIO_KEYS):
            errors.append(
                "enable_loraplus: at least one LoRA+ ratio is required / "
                "启用 LoRA+ 后至少需要填写一个学习率倍率"
            )
        if config.get("optimizer_type") in LORAPLUS_INCOMPATIBLE_OPTIMIZERS:
            errors.append(
                "enable_loraplus: Prodigy optimizers are incompatible with LoRA+ in sd-scripts / "
                "sd-scripts 不支持 Prodigy 系列优化器与 LoRA+ 组合"
            )

    if not _is_empty(config.get("resolution")):
        resolution_error = _validate_resolution(config["resolution"], train_type)
        if resolution_error:
            errors.append(resolution_error)

    if config.get("enable_bucket"):
        try:
            if float(config.get("min_bucket_reso")) > float(config.get("max_bucket_reso")):
                errors.append("min_bucket_reso: must not exceed max_bucket_reso / 不能大于最大桶分辨率")
        except (TypeError, ValueError):
            pass

    weights = config.get("base_weights")
    multipliers = config.get("base_weights_multiplier")
    if not _is_empty(weights) and not _is_empty(multipliers):
        weight_count = len([part for part in str(weights).split(",") if part.strip()])
        multiplier_count = len([part for part in str(multipliers).split(",") if part.strip()])
        if weight_count != multiplier_count:
            errors.append("base_weights_multiplier: count must match base_weights / 数量必须与基底权重一致")

    parsed_optimizer_args, optimizer_arg_errors = parse_optimizer_args(config)
    errors.extend(optimizer_arg_errors)
    errors.extend(validate_optimizer_contract(config, parsed_optimizer_args))
    errors.extend(_validate_automagic(config, parsed_optimizer_args, gpu_ids))
    errors.extend(_validate_emosens(config, gpu_ids))

    return errors
