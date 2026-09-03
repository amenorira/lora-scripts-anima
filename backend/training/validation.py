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
    ADAFACTOR_OPTIMIZER_TYPE,
    AUTOMAGIC_MAX_LR_DEFAULT,
    AUTOMAGIC_MERGED_ARG_MAP,
    parse_optimizer_args,
    validate_optimizer_contract,
)


_TRAIN_TYPE_GROUP = {"sdxl-lora": "sdxl", "anima-lora": "anima", "krea2-lora": "krea2"}
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
    step = 16 if train_type == "anima-lora" else 32
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


def _effective_optimizer_arg(
    config: dict[str, Any],
    parsed_args: dict[str, Any],
    form_key: str,
    arg_key: str,
    default: Any,
) -> Any:
    value = config.get(form_key)
    if not _is_empty(value):
        return value
    return parsed_args.get(arg_key, default)


def _validate_loraplus(
    config: dict[str, Any], parsed_optimizer_args: dict[str, Any]
) -> list[str]:
    if (
        config.get("enable_loraplus") is not True
        or config.get("network_module") not in LORAPLUS_NETWORK_MODULES
    ):
        return []

    errors: list[str] = []
    if all(_is_empty(config.get(key)) for key in LORAPLUS_RATIO_KEYS):
        errors.append(
            "enable_loraplus: at least one LoRA+ ratio is required / "
            "启用 LoRA+ 后至少需要填写一个学习率倍率"
        )

    optimizer_type = str(config.get("optimizer_type", ""))
    if optimizer_type in LORAPLUS_INCOMPATIBLE_OPTIMIZERS:
        errors.append(
            f"enable_loraplus: {optimizer_type} is incompatible with LoRA+ because it "
            "cannot preserve distinct parameter-group learning rates / "
            f"{optimizer_type} 无法保留 LoRA+ 的分组学习率，不能与 LoRA+ 同时使用"
        )

    if optimizer_type == ADAFACTOR_OPTIMIZER_TYPE:
        relative_step = _effective_optimizer_arg(
            config,
            parsed_optimizer_args,
            "adafactor_relative_step",
            "relative_step",
            True,
        )
        warmup_init = _effective_optimizer_arg(
            config,
            parsed_optimizer_args,
            "adafactor_warmup_init",
            "warmup_init",
            False,
        )
        if relative_step is not False or warmup_init is True:
            errors.append(
                "enable_loraplus: AdaFactor relative_step=True or warmup_init=True is "
                "incompatible with LoRA+; disable both to preserve parameter-group rates / "
                "AdaFactor 的 relative_step=True 或 warmup_init=True 会破坏 LoRA+ "
                "分组学习率；请同时关闭两者"
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

    for form_key, arg_key in AUTOMAGIC_MERGED_ARG_MAP.items():
        if not _is_empty(config.get(form_key)):
            args[arg_key] = config[form_key]

    defaults = {
        "min_lr": 1e-8,
        "max_lr": AUTOMAGIC_MAX_LR_DEFAULT,
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
    parsed_start_rates: dict[str, float] = {}
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
        else:
            parsed_start_rates[key] = rate

    if (
        config.get("enable_loraplus") is True
        and config.get("network_module") in LORAPLUS_NETWORK_MODULES
        and min_lr is not None
        and max_lr is not None
    ):
        # Missing flags follow sd-scripts' store_true defaults: both components train.
        unet_only = config.get("network_train_unet_only", False) is True
        text_encoder_only = config.get("network_train_text_encoder_only", False) is True
        if unet_only and text_encoder_only:
            text_encoder_only = False  # mirrors adapter conflict normalization
        if config.get("cache_text_encoder_outputs") is True and text_encoder_only:
            unet_only = True
            text_encoder_only = False  # mirrors adapter cache conflict normalization

        component_specs = (
            (
                "UNet/DiT",
                not text_encoder_only,
                "unet_lr",
                "loraplus_unet_lr_ratio",
            ),
            (
                "text encoder",
                not unet_only,
                "text_encoder_lr",
                "loraplus_text_encoder_lr_ratio",
            ),
        )
        for component, is_trained, base_key, component_ratio_key in component_specs:
            if not is_trained:
                continue
            ratio_key = (
                component_ratio_key
                if not _is_empty(config.get(component_ratio_key))
                else "loraplus_lr_ratio"
            )
            ratio_value = config.get(ratio_key)
            if _is_empty(ratio_value):
                continue
            actual_base_key = (
                base_key if not _is_empty(config.get(base_key)) else "learning_rate"
            )
            base_rate = parsed_start_rates.get(actual_base_key)
            if base_rate is None:
                continue
            try:
                ratio = float(ratio_value)
            except (TypeError, ValueError):
                continue  # generic field validation reports invalid ratio values
            if not math.isfinite(ratio):
                continue
            effective_rate = base_rate * ratio
            if not min_lr <= effective_rate <= max_lr:
                errors.append(
                    f"{ratio_key}: Automagic3 effective {component} LoRA+ LR "
                    f"{effective_rate:g} ({actual_base_key} {base_rate:g} x ratio {ratio:g}) "
                    f"must be within [{min_lr:g}, {max_lr:g}] / LoRA+ 倍率后的实际 "
                    f"{component} 学习率必须位于 min_lr 与 max_lr 之间"
                )
    return errors


def validate_training_config(config: dict[str, Any], gpu_ids: Any = None) -> list[str]:
    """根据字段注册表与跨字段契约返回所有配置错误。"""
    errors: list[str] = []
    train_type = str(config.get("model_train_type", "sdxl-lora"))
    if train_type == "krea2-lora":
        # Krea uses musubi-tuner arguments and a separate dataset TOML. Running
        # the sd-scripts optimizer and adapter contracts against it would reject
        # valid Krea values and, worse, normalize them into invalid flags.
        from backend.training.musubi_krea2 import validate_krea2_config

        return validate_krea2_config(config)
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

    parsed_optimizer_args, optimizer_arg_errors = parse_optimizer_args(config)
    errors.extend(optimizer_arg_errors)
    errors.extend(_validate_loraplus(config, parsed_optimizer_args))

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

        bucket_step = config.get("bucket_reso_steps", 64)
        try:
            bucket_step_number = float(bucket_step)
        except (TypeError, ValueError):
            pass
        else:
            required_step = 16 if train_type == "anima-lora" else 32
            if (
                not math.isfinite(bucket_step_number)
                or not bucket_step_number.is_integer()
                or bucket_step_number <= 0
                or int(bucket_step_number) % required_step != 0
            ):
                errors.append(
                    f"bucket_reso_steps: must be a positive multiple of {required_step} / "
                    f"必须为 {required_step} 的正整数倍"
                )

    cache_text_outputs = config.get("cache_text_encoder_outputs") is True or config.get(
        "cache_text_encoder_outputs_to_disk"
    ) is True
    if cache_text_outputs:
        caption_conflicts: list[str] = []
        if config.get("shuffle_caption") is True:
            caption_conflicts.append("shuffle_caption")
        try:
            tag_dropout = float(config.get("caption_tag_dropout_rate") or 0)
        except (TypeError, ValueError):
            tag_dropout = 0
        if tag_dropout > 0:
            caption_conflicts.append("caption_tag_dropout_rate")
        if train_type == "sdxl-lora":
            try:
                caption_dropout = float(config.get("caption_dropout_rate") or 0)
            except (TypeError, ValueError):
                caption_dropout = 0
            if caption_dropout > 0:
                caption_conflicts.append("caption_dropout_rate")
        if caption_conflicts:
            errors.append(
                "cache_text_encoder_outputs: incompatible with "
                + ", ".join(caption_conflicts)
                + " / 文本编码器缓存与这些 Caption 选项不兼容"
            )

    if config.get("network_module") == "lycoris.kohya" and str(config.get("lycoris_algo", "")).lower() == "dylora":
        block_size = config.get("block_size", 4)
        network_dim = config.get("network_dim")
        if isinstance(block_size, int) and block_size > 0 and isinstance(network_dim, int) and network_dim % block_size != 0:
            errors.append("block_size: must divide network_dim / 必须能整除 network_dim")

    if config.get("network_module") == "lycoris.kohya" and str(config.get("lycoris_algo", "")).lower() == "lokr":
        factor = config.get("lokr_factor", -1)
        try:
            factor_number = int(str(factor).strip())
        except (TypeError, ValueError):
            errors.append("lokr_factor: must be -1 or a positive integer / 必须为 -1 或正整数")
        else:
            if str(factor).strip() != str(factor_number) or factor_number == 0 or factor_number < -1:
                errors.append("lokr_factor: must be -1 or a positive integer / 必须为 -1 或正整数")

    weights = config.get("base_weights")
    multipliers = config.get("base_weights_multiplier")
    if not _is_empty(weights) and not _is_empty(multipliers):
        weight_count = len([part for part in str(weights).split(",") if part.strip()])
        multiplier_count = len([part for part in str(multipliers).split(",") if part.strip()])
        if weight_count != multiplier_count:
            errors.append("base_weights_multiplier: count must match base_weights / 数量必须与基底权重一致")

    errors.extend(validate_optimizer_contract(config, parsed_optimizer_args))
    errors.extend(_validate_automagic(config, parsed_optimizer_args, gpu_ids))
    errors.extend(_validate_emosens(config, gpu_ids))

    return errors
