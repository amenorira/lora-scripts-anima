"""Optimizer parameter and execution contracts used by the product layer."""
from __future__ import annotations

import ast
import math
from dataclasses import dataclass, field
from typing import Any, Mapping


AUTOMAGIC_OPTIMIZER_TYPE = "vendor.automagic_optimizer.integration.Automagic3"
AUTOMAGIC_MAX_LR_DEFAULT = 1e3
AUTOMAGIC_MAX_LR_DEFAULT_TEXT = "1e3"
EMOSENS_OPTIMIZER_TYPE = "vendor.emo_optimizer.emosens.EmoSens"
PRODIGY_OPTIMIZER_TYPE = "Prodigy"
PRODIGYPLUS_OPTIMIZER_TYPE = "prodigyplus.ProdigyPlusScheduleFree"
ADAFACTOR_OPTIMIZER_TYPE = "AdaFactor"
CAME_OPTIMIZER_TYPE = "pytorch_optimizer.CAME"
STABLE_ADAMW_OPTIMIZER_TYPE = "pytorch_optimizer.StableAdamW"
ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE = "AdamWScheduleFree"
MUON_OPTIMIZER_TYPE = "Muon"

PRODIGY_OPTIMIZERS = frozenset(
    {PRODIGY_OPTIMIZER_TYPE, PRODIGYPLUS_OPTIMIZER_TYPE}
)
SCHEDULEFREE_OPTIMIZERS = frozenset(
    {ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, PRODIGYPLUS_OPTIMIZER_TYPE}
)

_EMPTY_STRINGS = {"", "undefined", "null", "nan"}


def is_empty_optimizer_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() in _EMPTY_STRINGS
    return isinstance(value, float) and math.isnan(value)


def parse_optimizer_args(config: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Parse the exact Python literals accepted by sd-scripts optimizer_args."""
    raw_args = config.get("optimizer_args")
    items: list[Any] = []
    errors: list[str] = []
    if raw_args is not None:
        if isinstance(raw_args, list):
            items.extend(raw_args)
        else:
            errors.append("optimizer_args: must be a list / 必须是列表")

    custom_args = config.get("optimizer_args_custom")
    if not is_empty_optimizer_value(custom_args):
        if isinstance(custom_args, str):
            items.extend(line.strip() for line in custom_args.splitlines() if line.strip())
        else:
            errors.append("optimizer_args_custom: must be text / 必须是文本")

    parsed: dict[str, Any] = {}
    for raw in items:
        if not isinstance(raw, str) or "=" not in raw:
            errors.append(f"optimizer_args: invalid item {raw!r} / 参数格式无效")
            continue
        key, literal = raw.split("=", 1)
        key = key.strip()
        if not key:
            errors.append(f"optimizer_args: invalid item {raw!r} / 参数名不能为空")
            continue
        try:
            parsed[key] = ast.literal_eval(literal.strip())
        except (SyntaxError, ValueError):
            errors.append(
                f"optimizer_args: {key} must use a Python literal / 必须使用 Python 字面量"
            )
    return parsed, errors


@dataclass(frozen=True)
class ArgumentSpec:
    kind: str = "number"
    minimum: float | None = None
    maximum: float | None = None
    minimum_inclusive: bool = True
    maximum_inclusive: bool = True
    allow_none: bool = False
    length: int | None = None
    item_minimum: float | None = None
    item_maximum: float | None = None
    item_maximum_inclusive: bool = False
    last_item_maximum_inclusive: bool | None = None
    choices: tuple[Any, ...] = ()


@dataclass(frozen=True)
class OptimizerContract:
    argument_specs: Mapping[str, ArgumentSpec] = field(default_factory=dict)
    scheduler_owner: str = "external"
    warmup_owner: str = "external"
    external_grad_clip: str = "allowed"
    learning_rate_minimum: float = 0.0
    learning_rate_minimum_inclusive: bool = False


def _number(
    minimum: float | None = None,
    maximum: float | None = None,
    *,
    minimum_inclusive: bool = True,
    maximum_inclusive: bool = True,
    allow_none: bool = False,
) -> ArgumentSpec:
    return ArgumentSpec(
        kind="number",
        minimum=minimum,
        maximum=maximum,
        minimum_inclusive=minimum_inclusive,
        maximum_inclusive=maximum_inclusive,
        allow_none=allow_none,
    )


def _integer(
    minimum: int | None = None,
    maximum: int | None = None,
    *,
    allow_none: bool = False,
) -> ArgumentSpec:
    return ArgumentSpec(
        kind="integer",
        minimum=minimum,
        maximum=maximum,
        allow_none=allow_none,
    )


def _boolean(*, allow_none: bool = False) -> ArgumentSpec:
    return ArgumentSpec(kind="boolean", allow_none=allow_none)


def _sequence(
    length: int,
    minimum: float,
    maximum: float,
    *,
    maximum_inclusive: bool = False,
    last_maximum_inclusive: bool | None = None,
) -> ArgumentSpec:
    return ArgumentSpec(
        kind="sequence",
        length=length,
        item_minimum=minimum,
        item_maximum=maximum,
        item_maximum_inclusive=maximum_inclusive,
        last_item_maximum_inclusive=last_maximum_inclusive,
    )


def _choice(*values: Any) -> ArgumentSpec:
    return ArgumentSpec(kind="choice", choices=tuple(values))


_NON_NEGATIVE = _number(0.0)
_POSITIVE = _number(0.0, minimum_inclusive=False)
_BETA = _number(0.0, 1.0, maximum_inclusive=False, allow_none=True)
_BETAS_2 = _sequence(2, 0.0, 1.0)

_TORCH_ADAMW_ARGS = {
    "betas": _BETAS_2,
    "eps": _NON_NEGATIVE,
    "weight_decay": _NON_NEGATIVE,
    "amsgrad": _boolean(),
    "maximize": _boolean(),
    "foreach": _boolean(allow_none=True),
    "capturable": _boolean(),
    "differentiable": _boolean(),
    "fused": _boolean(allow_none=True),
}

_BNB_ADAMW_ARGS = {
    "betas": _BETAS_2,
    "eps": _NON_NEGATIVE,
    "weight_decay": _NON_NEGATIVE,
    "amsgrad": _boolean(),
    # bitsandbytes keeps this compatibility argument in the 8-bit class
    # signatures, but explicitly rejects every value except 32.
    "optim_bits": _choice(32),
    "min_8bit_size": _integer(0),
    "percentile_clipping": _integer(1, 100),
    "block_wise": _boolean(),
}

_LION_ARGS = {
    "betas": _BETAS_2,
    "weight_decay": _NON_NEGATIVE,
    "use_triton": _boolean(),
    "decoupled_weight_decay": _boolean(),
}

_BNB_LION_ARGS = {
    "betas": _BETAS_2,
    "weight_decay": _NON_NEGATIVE,
    "min_8bit_size": _integer(0),
    "percentile_clipping": _integer(1, 100),
    "block_wise": _boolean(),
}

_PRODIGY_ARGS = {
    "betas": _BETAS_2,
    "beta3": _BETA,
    "eps": _POSITIVE,
    "weight_decay": _NON_NEGATIVE,
    "decouple": _boolean(),
    "use_bias_correction": _boolean(),
    "safeguard_warmup": _boolean(),
    "d0": _POSITIVE,
    "d_coef": _POSITIVE,
    "growth_rate": _POSITIVE,
    "fsdp_in_use": _boolean(),
    "slice_p": _integer(1),
}

_PRODIGYPLUS_ARGS = {
    "betas": _BETAS_2,
    "beta3": _BETA,
    "weight_decay": _NON_NEGATIVE,
    "weight_decay_by_lr": _boolean(),
    "use_bias_correction": _boolean(),
    "d0": _POSITIVE,
    "d_coef": _POSITIVE,
    "prodigy_steps": _integer(0),
    "use_speed": _boolean(),
    "eps": _number(0.0, minimum_inclusive=False, allow_none=True),
    "split_groups": _boolean(),
    "split_groups_mean": _boolean(),
    "factored": _boolean(),
    "factored_fp32": _boolean(),
    "fused_back_pass": _boolean(),
    "use_stableadamw": _boolean(),
    "use_muon_pp": _boolean(),
    "use_cautious": _boolean(),
    "use_grams": _boolean(),
    "use_adopt": _boolean(),
    "use_orthograd": _boolean(),
    "use_focus": _boolean(),
    "stochastic_rounding": _boolean(),
}

_ADAFACTOR_ARGS = {
    "eps": ArgumentSpec(
        kind="sequence",
        length=2,
        item_minimum=0.0,
        item_maximum=None,
        item_maximum_inclusive=True,
    ),
    "clip_threshold": _POSITIVE,
    "decay_rate": _number(),
    "beta1": _BETA,
    "weight_decay": _NON_NEGATIVE,
    "scale_parameter": _boolean(),
    "relative_step": _boolean(),
    "warmup_init": _boolean(),
}

_CAME_ARGS = {
    "betas": _sequence(
        3,
        0.0,
        1.0,
        last_maximum_inclusive=True,
    ),
    "weight_decay": _NON_NEGATIVE,
    "weight_decouple": _boolean(),
    "fixed_decay": _boolean(),
    "clip_threshold": _POSITIVE,
    "ams_bound": _boolean(),
    "eps1": _NON_NEGATIVE,
    "eps2": _NON_NEGATIVE,
    "maximize": _boolean(),
}

_STABLE_ADAMW_ARGS = {
    "betas": _BETAS_2,
    "eps": _NON_NEGATIVE,
    "weight_decay": _NON_NEGATIVE,
    "weight_decouple": _boolean(),
    "kahan_sum": _boolean(),
    "foreach": _boolean(allow_none=True),
    "maximize": _boolean(),
}

_SCHEDULEFREE_ARGS = {
    "betas": _BETAS_2,
    "eps": _POSITIVE,
    "weight_decay": _NON_NEGATIVE,
    "warmup_steps": _integer(0),
    "r": _number(),
    "weight_lr_power": _NON_NEGATIVE,
    "foreach": _boolean(allow_none=True),
}

_EMOSENS_ARGS = {
    "betas": _BETAS_2,
    "eps": _POSITIVE,
    "weight_decay": _NON_NEGATIVE,
    "stopcoef": _POSITIVE,
    "use_shadow": _boolean(),
    "notify": _boolean(),
}

_MUON_ARGS = {
    "weight_decay": _NON_NEGATIVE,
    "momentum": _NON_NEGATIVE,
    "nesterov": _boolean(),
    "ns_coefficients": ArgumentSpec(
        kind="sequence",
        length=3,
        item_minimum=None,
        item_maximum=None,
    ),
    "eps": _POSITIVE,
    "ns_steps": _integer(1, 99),
    "adjust_lr_fn": _choice(None, "original", "match_rms_adamw"),
}


OPTIMIZER_CONTRACTS: dict[str, OptimizerContract] = {
    "AdamW": OptimizerContract(_TORCH_ADAMW_ARGS, learning_rate_minimum_inclusive=True),
    "AdamW8bit": OptimizerContract(_BNB_ADAMW_ARGS, learning_rate_minimum_inclusive=True),
    "PagedAdamW8bit": OptimizerContract(_BNB_ADAMW_ARGS, learning_rate_minimum_inclusive=True),
    MUON_OPTIMIZER_TYPE: OptimizerContract(
        _MUON_ARGS,
        learning_rate_minimum_inclusive=True,
    ),
    "Lion": OptimizerContract(_LION_ARGS),
    "Lion8bit": OptimizerContract(_BNB_LION_ARGS),
    "PagedLion8bit": OptimizerContract(_BNB_LION_ARGS),
    PRODIGY_OPTIMIZER_TYPE: OptimizerContract(
        _PRODIGY_ARGS,
        external_grad_clip="advisory",
    ),
    PRODIGYPLUS_OPTIMIZER_TYPE: OptimizerContract(
        _PRODIGYPLUS_ARGS,
        scheduler_owner="optimizer",
        warmup_owner="none",
        external_grad_clip="conditional",
    ),
    ADAFACTOR_OPTIMIZER_TYPE: OptimizerContract(
        _ADAFACTOR_ARGS,
        scheduler_owner="sd_scripts",
        warmup_owner="conditional",
        external_grad_clip="forbidden",
    ),
    CAME_OPTIMIZER_TYPE: OptimizerContract(_CAME_ARGS),
    STABLE_ADAMW_OPTIMIZER_TYPE: OptimizerContract(_STABLE_ADAMW_ARGS),
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE: OptimizerContract(
        _SCHEDULEFREE_ARGS,
        scheduler_owner="optimizer",
        warmup_owner="optimizer",
    ),
    EMOSENS_OPTIMIZER_TYPE: OptimizerContract(
        _EMOSENS_ARGS,
        scheduler_owner="optimizer",
        warmup_owner="none",
    ),
}


@dataclass(frozen=True)
class FormArgument:
    argument: str
    optimizers: frozenset[str]


_ADAM_OPTIMIZERS = frozenset(
    {
        "AdamW",
        "AdamW8bit",
        "PagedAdamW8bit",
        STABLE_ADAMW_OPTIMIZER_TYPE,
        ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
        PRODIGY_OPTIMIZER_TYPE,
        PRODIGYPLUS_OPTIMIZER_TYPE,
        EMOSENS_OPTIMIZER_TYPE,
    }
)
_BETAS_OPTIMIZERS = _ADAM_OPTIMIZERS | frozenset(
    {"Lion", "Lion8bit", "PagedLion8bit", CAME_OPTIMIZER_TYPE}
)
_EPS_OPTIMIZERS = _ADAM_OPTIMIZERS | frozenset({MUON_OPTIMIZER_TYPE})

FORM_ARGUMENTS: dict[str, FormArgument] = {
    "weight_decay": FormArgument("weight_decay", frozenset(OPTIMIZER_CONTRACTS)),
    "betas": FormArgument("betas", _BETAS_OPTIMIZERS),
    "eps": FormArgument("eps", _EPS_OPTIMIZERS),
    "muon_momentum": FormArgument("momentum", frozenset({MUON_OPTIMIZER_TYPE})),
    "muon_nesterov": FormArgument("nesterov", frozenset({MUON_OPTIMIZER_TYPE})),
    "muon_ns_steps": FormArgument("ns_steps", frozenset({MUON_OPTIMIZER_TYPE})),
    "muon_ns_coefficients": FormArgument(
        "ns_coefficients", frozenset({MUON_OPTIMIZER_TYPE})
    ),
    "muon_adjust_lr_fn": FormArgument(
        "adjust_lr_fn", frozenset({MUON_OPTIMIZER_TYPE})
    ),
    "bnb_percentile_clipping": FormArgument(
        "percentile_clipping",
        frozenset({"AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"}),
    ),
    "bnb_min_8bit_size": FormArgument(
        "min_8bit_size",
        frozenset({"AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"}),
    ),
    "stableadamw_kahan_sum": FormArgument(
        "kahan_sum", frozenset({STABLE_ADAMW_OPTIMIZER_TYPE})
    ),
    "stableadamw_weight_decouple": FormArgument(
        "weight_decouple", frozenset({STABLE_ADAMW_OPTIMIZER_TYPE})
    ),
    "stopcoef": FormArgument("stopcoef", frozenset({EMOSENS_OPTIMIZER_TYPE})),
    "prodigy_d_coef": FormArgument("d_coef", PRODIGY_OPTIMIZERS),
    "prodigy_d0": FormArgument("d0", PRODIGY_OPTIMIZERS),
    "prodigy_safeguard_warmup": FormArgument(
        "safeguard_warmup", frozenset({PRODIGY_OPTIMIZER_TYPE})
    ),
    "prodigyplus_use_stableadamw": FormArgument(
        "use_stableadamw", frozenset({PRODIGYPLUS_OPTIMIZER_TYPE})
    ),
    "schedulefree_warmup_steps": FormArgument(
        "warmup_steps", frozenset({ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE})
    ),
    "adafactor_relative_step": FormArgument(
        "relative_step", frozenset({ADAFACTOR_OPTIMIZER_TYPE})
    ),
    "adafactor_scale_parameter": FormArgument(
        "scale_parameter", frozenset({ADAFACTOR_OPTIMIZER_TYPE})
    ),
    "adafactor_warmup_init": FormArgument(
        "warmup_init", frozenset({ADAFACTOR_OPTIMIZER_TYPE})
    ),
    "adafactor_clip_threshold": FormArgument(
        "clip_threshold", frozenset({ADAFACTOR_OPTIMIZER_TYPE})
    ),
    "adafactor_eps": FormArgument("eps", frozenset({ADAFACTOR_OPTIMIZER_TYPE})),
    "came_weight_decouple": FormArgument(
        "weight_decouple", frozenset({CAME_OPTIMIZER_TYPE})
    ),
    "came_fixed_decay": FormArgument("fixed_decay", frozenset({CAME_OPTIMIZER_TYPE})),
    "came_clip_threshold": FormArgument(
        "clip_threshold", frozenset({CAME_OPTIMIZER_TYPE})
    ),
    "came_ams_bound": FormArgument("ams_bound", frozenset({CAME_OPTIMIZER_TYPE})),
    "came_eps1": FormArgument("eps1", frozenset({CAME_OPTIMIZER_TYPE})),
    "came_eps2": FormArgument("eps2", frozenset({CAME_OPTIMIZER_TYPE})),
}


def _coerce_form_argument(value: Any) -> Any:
    """Interpret merged text fields exactly as sd-scripts interprets optimizer_args."""
    if not isinstance(value, str):
        return value
    try:
        return ast.literal_eval(value.strip())
    except (SyntaxError, ValueError):
        return value


def collect_optimizer_args(
    config: Mapping[str, Any], parsed_args: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    optimizer_type = str(config.get("optimizer_type", ""))
    result = dict(parsed_args or {})
    for form_key, mapping in FORM_ARGUMENTS.items():
        if optimizer_type not in mapping.optimizers:
            continue
        value = config.get(form_key)
        if not is_empty_optimizer_value(value):
            result[mapping.argument] = _coerce_form_argument(value)
    return result


def _validate_number(value: Any, spec: ArgumentSpec) -> str | None:
    if value is None and spec.allow_none:
        return None
    if isinstance(value, bool):
        return "must be a number / 必须是数字"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "must be a number / 必须是数字"
    if not math.isfinite(number):
        return "must be finite / 必须是有限数字"
    if spec.kind == "integer" and not number.is_integer():
        return "must be an integer / 必须是整数"
    if spec.minimum is not None:
        invalid = number < spec.minimum if spec.minimum_inclusive else number <= spec.minimum
        if invalid:
            operator = ">=" if spec.minimum_inclusive else ">"
            return f"must be {operator} {spec.minimum:g} / 必须 {operator} {spec.minimum:g}"
    if spec.maximum is not None:
        invalid = number > spec.maximum if spec.maximum_inclusive else number >= spec.maximum
        if invalid:
            operator = "<=" if spec.maximum_inclusive else "<"
            return f"must be {operator} {spec.maximum:g} / 必须 {operator} {spec.maximum:g}"
    return None


def _validate_sequence(value: Any, spec: ArgumentSpec) -> str | None:
    if not isinstance(value, (tuple, list)) or len(value) != spec.length:
        return f"must contain exactly {spec.length} values / 必须恰好包含 {spec.length} 个值"
    for index, item in enumerate(value):
        maximum_inclusive = spec.item_maximum_inclusive
        if index == len(value) - 1 and spec.last_item_maximum_inclusive is not None:
            maximum_inclusive = spec.last_item_maximum_inclusive
        error = _validate_number(
            item,
            ArgumentSpec(
                minimum=spec.item_minimum,
                maximum=spec.item_maximum,
                maximum_inclusive=maximum_inclusive,
            ),
        )
        if error:
            return f"item {index}: {error}"
    return None


def _validate_argument(value: Any, spec: ArgumentSpec) -> str | None:
    if value is None and spec.allow_none:
        return None
    if spec.kind == "boolean":
        return None if isinstance(value, bool) else "must be true or false / 必须是布尔值"
    if spec.kind in {"number", "integer"}:
        return _validate_number(value, spec)
    if spec.kind == "sequence":
        return _validate_sequence(value, spec)
    if spec.kind == "choice":
        return None if value in spec.choices else f"must be one of {spec.choices!r} / 取值不受支持"
    return None


def _is_effectively_enabled(value: Any) -> bool:
    if value in (None, False, 0):
        return False
    if isinstance(value, str):
        return value.strip().lower() not in {"", "false", "0", "none"}
    return True


def validate_optimizer_contract(
    config: Mapping[str, Any], parsed_args: Mapping[str, Any]
) -> list[str]:
    optimizer_type = str(config.get("optimizer_type", ""))
    args = collect_optimizer_args(config, parsed_args)
    errors: list[str] = []

    if _is_effectively_enabled(config.get("fused_backward_pass")):
        errors.append(
            "fused_backward_pass: unsupported by the SDXL/Anima network trainers / "
            "当前 SDXL/Anima network trainer 不支持此参数"
        )

    if optimizer_type == PRODIGYPLUS_OPTIMIZER_TYPE:
        if _is_effectively_enabled(args.get("fused_back_pass")):
            errors.append(
                "ProdigyPlus fused_back_pass: unsupported; it can make optimizer.step() "
                "skip all updates / 当前训练器不支持，启用后可能完全不更新权重"
            )
        if "fused_backward_pass" in args:
            errors.append(
                "ProdigyPlus fused_backward_pass: not a valid optimizer argument / "
                "不是有效的优化器参数"
            )

    if (
        optimizer_type == MUON_OPTIMIZER_TYPE
        and config.get("model_train_type") != "anima-lora"
    ):
        errors.append(
            "Muon: currently supported only for Anima LoRA / "
            "当前仅支持 Anima LoRA"
        )

    contract = OPTIMIZER_CONTRACTS.get(optimizer_type)
    if contract is None:
        return errors

    for key, value in args.items():
        spec = contract.argument_specs.get(key)
        if spec is None:
            if (
                optimizer_type == PRODIGYPLUS_OPTIMIZER_TYPE
                and key == "fused_backward_pass"
            ):
                continue  # reported above with the precise failure reason
            errors.append(
                f"{optimizer_type} optimizer_args: unsupported argument {key!r} / "
                "不支持此参数"
            )
            continue
        error = _validate_argument(value, spec)
        if error:
            errors.append(f"{optimizer_type} optimizer_args {key}: {error}")

    for key in ("learning_rate", "unet_lr", "text_encoder_lr"):
        value = config.get(key)
        if is_empty_optimizer_value(value):
            continue
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
        if optimizer_type in PRODIGY_OPTIMIZERS:
            continue  # adapter normalizes Prodigy's LR scaling factor to 1.0
        minimum = contract.learning_rate_minimum
        invalid = (
            number < minimum
            if contract.learning_rate_minimum_inclusive
            else number <= minimum
        )
        if invalid:
            operator = ">=" if contract.learning_rate_minimum_inclusive else ">"
            errors.append(f"{key}: must be {operator} {minimum:g} for {optimizer_type}")

    if optimizer_type in {"AdamW8bit", "PagedAdamW8bit"} and args.get("amsgrad") is True:
        errors.append(f"{optimizer_type} optimizer_args amsgrad: must be False")

    return errors


def _format_optimizer_value(value: Any) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if value is None:
        return "None"
    if isinstance(value, list):
        return repr(tuple(value))
    return str(value)


def _set_optimizer_arg(config: dict[str, Any], key: str, value: Any) -> None:
    values = list(config.get("optimizer_args") or [])
    prefix = f"{key}="
    values = [item for item in values if not str(item).strip().startswith(prefix)]
    formatted = (
        repr(value)
        if key == "adjust_lr_fn" and isinstance(value, str)
        else _format_optimizer_value(value)
    )
    values.append(f"{key}={formatted}")
    config["optimizer_args"] = values


def _remove_optimizer_arg(config: dict[str, Any], key: str) -> None:
    prefix = f"{key}="
    values = [
        item
        for item in list(config.get("optimizer_args") or [])
        if not str(item).strip().startswith(prefix)
    ]
    if values:
        config["optimizer_args"] = values
    else:
        config.pop("optimizer_args", None)


def _merge_form_arguments(config: dict[str, Any]) -> None:
    optimizer_type = str(config.get("optimizer_type", ""))
    for form_key, mapping in FORM_ARGUMENTS.items():
        if optimizer_type not in mapping.optimizers:
            continue
        value = config.get(form_key)
        if not is_empty_optimizer_value(value):
            if mapping.argument == "ns_coefficients":
                value = _coerce_form_argument(value)
            _set_optimizer_arg(config, mapping.argument, value)


def _numeric_value(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def normalize_optimizer_config(config: dict[str, Any], warnings: list[str]) -> None:
    """Normalize safe product behavior after validation and before TOML output."""
    optimizer_type = str(config.get("optimizer_type", ""))
    top_level_fused = config.pop("fused_backward_pass", None)
    if _is_effectively_enabled(top_level_fused):
        warnings.append(
            "[Conflict] fused_backward_pass removed: unsupported by the SDXL/Anima "
            "network trainers / 当前训练器不支持，已移除"
        )
    if (
        optimizer_type == CAME_OPTIMIZER_TYPE
        and config.get("came_weight_decouple") is False
    ):
        config.pop("came_fixed_decay", None)
    _merge_form_arguments(config)
    args, _ = parse_optimizer_args(config)

    if optimizer_type in PRODIGY_OPTIMIZERS:
        for key in ("learning_rate", "unet_lr", "text_encoder_lr"):
            value = config.get(key)
            if is_empty_optimizer_value(value):
                if key == "learning_rate":
                    config[key] = 1.0
                    warnings.append(
                        "Prodigy: learning_rate defaulted to 1.0 "
                        "(D-adaptation 缩放因子必须为 1.0)"
                    )
                continue
            if not math.isclose(_numeric_value(value, 1.0), 1.0):
                config[key] = 1.0
                warnings.append(
                    f"Prodigy: {key} forced to 1.0 (D-adaptation 缩放因子必须为 1.0)"
                )

    if optimizer_type in SCHEDULEFREE_OPTIMIZERS:
        if config.get("lr_scheduler") != "constant":
            config["lr_scheduler"] = "constant"
            warnings.append("ScheduleFree: lr_scheduler forced to constant / 已固定为 constant")
        if _numeric_value(config.get("lr_warmup_steps"), 0.0) != 0:
            config["lr_warmup_steps"] = 0
            warnings.append(
                "ScheduleFree: external lr_warmup_steps disabled; use optimizer warmup_steps "
                "where supported / 已关闭外部预热"
            )

    if optimizer_type == ADAFACTOR_OPTIMIZER_TYPE:
        relative_step = args.get("relative_step", True)
        warmup_init = args.get("warmup_init", False)
        if warmup_init and relative_step is False:
            relative_step = True
            _set_optimizer_arg(config, "relative_step", True)
            warnings.append(
                "AdaFactor: relative_step enabled because warmup_init=True / "
                "warmup_init=True 时已启用 relative_step"
            )
        if _numeric_value(config.get("max_grad_norm"), 1.0) != 0:
            config["max_grad_norm"] = 0
            warnings.append(
                "AdaFactor: max_grad_norm forced to 0; use internal clip_threshold / "
                "已关闭外部梯度裁剪，请使用内部 clip_threshold"
            )
        if relative_step:
            if config.get("lr_scheduler") != "constant":
                config["lr_scheduler"] = "constant"
                warnings.append(
                    "AdaFactor: external scheduler disabled in relative_step mode / "
                    "relative_step 模式已关闭外部调度器"
                )
            if _numeric_value(config.get("lr_warmup_steps"), 0.0) != 0:
                config["lr_warmup_steps"] = 0
                warnings.append(
                    "AdaFactor: external lr_warmup_steps disabled in relative_step mode / "
                    "relative_step 模式已关闭外部预热"
                )

    if optimizer_type == PRODIGYPLUS_OPTIMIZER_TYPE:
        if _is_effectively_enabled(args.get("fused_back_pass")):
            _set_optimizer_arg(config, "fused_back_pass", False)
            warnings.append(
                "[Conflict] ProdigyPlus fused_back_pass disabled because regular "
                "optimizer.step() is used / 当前训练器使用常规 optimizer.step()，已关闭"
            )
        if "fused_backward_pass" in args:
            _remove_optimizer_arg(config, "fused_backward_pass")
            warnings.append(
                "[Conflict] ProdigyPlus fused_backward_pass removed because it is not a "
                "valid optimizer argument / 参数名无效，已移除"
            )
        use_stableadamw = args.get("use_stableadamw", True)
        eps = args.get("eps", 1e-8)
        uses_internal_scaling = use_stableadamw is not False or eps is None
        if uses_internal_scaling and _numeric_value(config.get("max_grad_norm"), 1.0) != 0:
            config["max_grad_norm"] = 0
            warnings.append(
                "ProdigyPlus: max_grad_norm forced to 0 while internal update scaling is active / "
                "内部更新缩放启用时已关闭外部梯度裁剪"
            )

    if optimizer_type == PRODIGY_OPTIMIZER_TYPE:
        warmup_steps = _numeric_value(config.get("lr_warmup_steps"), 0.0)
        if warmup_steps > 0 and args.get("safeguard_warmup") is not True:
            _set_optimizer_arg(config, "safeguard_warmup", True)
            warnings.append(
                "Prodigy: safeguard_warmup=True enabled for external warmup / "
                "检测到预热，已启用 safeguard_warmup"
            )
        if config.get("lr_scheduler") == "cosine_with_restarts":
            warnings.append(
                "Prodigy: cosine_with_restarts can disturb D estimation; cosine or constant is recommended / "
                "重启调度可能干扰 D 估计，建议使用 cosine 或 constant"
            )
        if _numeric_value(config.get("max_grad_norm"), 0.0) > 0:
            warnings.append(
                "Prodigy: external gradient clipping can affect D estimation / "
                "外部梯度裁剪可能影响 D 估计"
            )
