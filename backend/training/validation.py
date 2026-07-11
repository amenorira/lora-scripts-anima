"""训练配置契约校验。"""
from __future__ import annotations

import math
import re
from typing import Any

from backend.training.field_registry import FIELDS


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


def validate_training_config(config: dict[str, Any]) -> list[str]:
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

    return errors
