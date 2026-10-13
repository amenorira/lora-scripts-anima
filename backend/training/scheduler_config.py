"""Guided sd-scripts scheduler arguments and piecewise rule validation."""
from __future__ import annotations

import ast
import math
import re
from typing import Any


SCHEDULER_FORM_ARGUMENTS = {
    "warmup_type": ("warmup_stable_decay", "linear"),
    "decay_type": ("warmup_stable_decay", "cosine"),
    "step_rules": ("piecewise_constant", ""),
}
CURVE_TYPES = ("linear", "cosine", "1-sqrt")
_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
STEP_RULES_ERROR = (
    "step_rules: use multiplier:end_step pairs followed by a final multiplier; "
    "end steps must be increasing positive integers and multipliers finite and non-negative / "
    "格式为 倍率:结束步数,倍率:结束步数,最后倍率；累计结束步数必须为递增正整数，倍率必须为有限非负数"
)


def parse_step_rules(value: Any) -> tuple[list[tuple[int, float]], float]:
    """Match Diffusers' absolute (not duration) boundaries without silent duplicates."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(STEP_RULES_ERROR)
    parts = value.split(",")
    boundaries = []
    previous = 0
    for index, part in enumerate(parts):
        pair = [token.strip() for token in part.split(":")]
        expected = 1 if index == len(parts) - 1 else 2
        if len(pair) != expected or not _NUMBER.fullmatch(pair[0]):
            raise ValueError(STEP_RULES_ERROR)
        multiplier = float(pair[0])
        if not math.isfinite(multiplier) or multiplier < 0:
            raise ValueError(STEP_RULES_ERROR)
        if expected == 2:
            if not re.fullmatch(r"[0-9]+", pair[1]):
                raise ValueError(STEP_RULES_ERROR)
            end_step = int(pair[1])
            # Keep boundaries exact in both Python and the JavaScript preview.
            if not previous < end_step <= 2**53 - 1:
                raise ValueError(STEP_RULES_ERROR)
            boundaries.append((end_step, multiplier))
            previous = end_step
    return boundaries, multiplier


def extract_scheduler_form(config: dict[str, Any]) -> dict[str, Any]:
    """Recover guided fields when importing a native sd-scripts TOML."""
    result = dict(config)
    scheduler = result.get("lr_scheduler", "constant")
    for item in result.get("lr_scheduler_args") or []:
        if not isinstance(item, str) or "=" not in item:
            continue
        key, literal = item.split("=", 1)
        key = key.strip()
        spec = SCHEDULER_FORM_ARGUMENTS.get(key)
        if not spec or scheduler != spec[0] or key in result:
            continue
        try:
            result[key] = ast.literal_eval(literal.strip())
        except (ValueError, SyntaxError):
            raise ValueError(f"{key}: invalid scheduler argument / 调度器参数格式无效") from None
    return result


def validate_scheduler_config(config: dict[str, Any]) -> list[str]:
    try:
        source = extract_scheduler_form(config)
    except ValueError as exc:
        return [str(exc)]
    scheduler = source.get("lr_scheduler", "constant")
    errors = []
    if scheduler == "warmup_stable_decay":
        for key in ("warmup_type", "decay_type"):
            if source.get(key, SCHEDULER_FORM_ARGUMENTS[key][1]) not in CURVE_TYPES:
                errors.append(f"{key}: expected linear, cosine or 1-sqrt / 请选择 linear、cosine 或 1-sqrt")
    elif scheduler == "piecewise_constant":
        try:
            parse_step_rules(source.get("step_rules"))
        except ValueError as exc:
            errors.append(str(exc))
    return errors


def normalize_scheduler_config(config: dict[str, Any]) -> None:
    """Merge active guided fields into native args after optimizer normalization."""
    source = extract_scheduler_form(config)
    scheduler = config.get("lr_scheduler", "constant")
    args = [item for item in config.get("lr_scheduler_args") or []
            if isinstance(item, str) and item.split("=", 1)[0].strip() not in SCHEDULER_FORM_ARGUMENTS]
    for key, (mode, default) in SCHEDULER_FORM_ARGUMENTS.items():
        config.pop(key, None)
        if scheduler != mode:
            continue
        value = source.get(key, default)
        if key == "step_rules":
            parse_step_rules(value)
            value = ",".join(":".join(token.strip() for token in part.split(":")) for part in value.split(","))
        elif value not in CURVE_TYPES:
            raise ValueError(f"{key}: unsupported curve / 不支持的曲线")
        args.append(f"{key}={value!r}")
    if scheduler == "piecewise_constant":
        config["lr_warmup_steps"] = 0
    if args:
        config["lr_scheduler_args"] = args
    else:
        config.pop("lr_scheduler_args", None)
