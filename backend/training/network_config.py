"""Native network arguments at the application configuration boundary."""
from __future__ import annotations

import ast
from typing import Any

from backend.training.field_registry import FIELDS, LORAPLUS_RATIO_KEYS, get_fields_json


def _argument_value(raw: str) -> Any:
    raw = raw.strip()
    if raw.lower() in ("true", "false"):
        return raw.lower() == "true"
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return raw


def validate_network_preset(config: dict[str, Any]) -> None:
    """Reject known presets that have no targets in the selected architecture."""
    if config.get("model_train_type") != "anima-lora" or config.get("network_module") != "lycoris.kohya":
        return
    arguments = [*(config.get("network_args") or []),
                 *str(config.get("network_args_custom") or "").splitlines()]
    presets = [_argument_value(item.partition("=")[2]) for item in arguments
               if isinstance(item, str) and item.partition("=")[0].strip() == "preset"]
    preset = config.get("lycoris_preset", presets[-1] if presets else "full")
    field = next(field for field in FIELDS if field["key"] == "lycoris_preset")
    if any(option["v"] == preset and option.get("group") == "sdxl" for option in field["options"]):
        raise ValueError(f"lycoris_preset: {preset} has no Anima targets / 此预设不适用于 Anima，请选择 full 或 attn-mlp")


def extract_network_form(config: dict[str, Any], *, model_train_type: str = "anima-lora") -> dict[str, Any]:
    """Restore registered controls; preserve unrecognized arguments verbatim."""
    result = dict(config)
    profile = result.get("model_train_type") or model_train_type
    if profile == "krea2-lora":
        from backend.training.krea2_network import extract_krea2_network_form
        return extract_krea2_network_form(result)
    group = {"anima-lora": "anima", "sdxl-lora": "sdxl", "moss-image-lora": "moss_image"}.get(profile)
    if group is None:
        raise ValueError(f"Unsupported model_train_type: {profile}")
    module = result.get("network_module") or {
        "anima": "networks.lora_anima", "sdxl": "networks.lora", "moss_image": "networks.lora_generic",
    }[group]
    fields = {}
    for section in get_fields_json()["sections"]:
        for field in section["fields"]:
            groups = field.get("group", "all")
            groups = groups if isinstance(groups, list) else [groups]
            if module in field.get("networkModules", []) and ("all" in groups or group in groups):
                argument = field.get("networkArgByModule", {}).get(module, field["networkArg"])
                fields[argument] = field

    arguments = result.pop("network_args", [])
    if not isinstance(arguments, list) or any(not isinstance(item, str) for item in arguments):
        raise ValueError("network_args must be a string array / network_args 必须为字符串数组")
    if arguments:
        # Match adapt_config: explicit controls > custom arguments > native arguments.
        arguments = [*arguments, *str(result.pop("network_args_custom", "") or "").splitlines()]
    parsed, extra = {}, []
    for item in arguments:
        key, separator, raw = item.partition("=")
        key = key.strip()
        if separator and (key in fields or (group == "moss_image" and key in ("train_text_embedder", "train_llm_adapter"))):
            parsed[key] = _argument_value(raw)
        else:
            extra.append(item)
    if group == "moss_image":
        aliases = ("train_llm_adapter", "train_text_embedder")
        if any(key in parsed for key in aliases):
            enabled = [str(parsed.pop(key, False)).lower() == "true" for key in aliases]
            result.setdefault("train_text_embedder", any(enabled))
    for key, value in parsed.items():
        field = fields[key]
        value = result.setdefault(field["key"], value)
        if field["type"] == "select" and value not in [option["v"] for option in field["options"]]:
            raise ValueError(f"{field['key']}: unsupported value {value!r} / 不支持的选项")
    if parsed.keys() & set(LORAPLUS_RATIO_KEYS):
        result.setdefault("enable_loraplus", True)
        # A component-only ratio must not acquire the UI's default global 2x ratio.
        for key in LORAPLUS_RATIO_KEYS:
            result.setdefault(key, "")
    if extra:
        result["network_args_custom"] = "\n".join(filter(None, [*extra, str(result.get("network_args_custom") or "")]))
    validate_network_preset({**result, "model_train_type": profile, "network_module": module})
    return result
