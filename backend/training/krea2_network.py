"""Application-owned Krea 2 network controls and equivalent target selection.

LyCORIS is loaded through musubi's existing compatibility entry. A per-run
preset targets individual Linear names, including K2's eight projection layers
which LyCORIS' generic block presets omit. No vendor changes are required.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from backend.training.lycoris_layout import apply_lycoris_panel_layout
from backend.training.shared_fields import shared_training_field

KREA2_NETWORK_MODULE = "networks.lora_krea2"
KREA2_LYCORIS_MODULE = "lycoris.kohya"
KREA2_NETWORK_MODULES = (KREA2_NETWORK_MODULE, KREA2_LYCORIS_MODULE)
KREA2_TARGET_MODES = ("all", "attention", "attention_mlp", "custom")
KREA2_PRESET_FILENAME = "krea2-network.toml"
_LYCORIS = {"key": "network_module", "eq": KREA2_LYCORIS_MODULE}


def _field(key, kind, default, **extra):
    return {"key": key, "type": kind, "default": default, "section": "network",
            "desc_key": f"field.{key}", "profiles": ["krea2-lora"],
            **extra}


KREA2_NETWORK_FIELDS = [
    _field("lycoris_algo", "select", "lokr", show_if=_LYCORIS,
           options=[{"v": v, "l": label, "dk": f"opt.lycoris_algo_{v}"}
                    for v, label in (("lokr", "LoKr"), ("loha", "LoHa"))]),
    _field("krea_target_mode", "select", "all", desc_key="field.krea_target_mode",
           hint_key="field.krea_target_modeHint", nested=False,
           doc_slug="network-parameters", doc_anchor="krea-targets",
           options=[{"v": v, "l": v, "dk": f"opt.krea_target_{v}"} for v in KREA2_TARGET_MODES]),
    _field("krea_target_include", "textarea", ".*", hint_key="field.krea_target_includeHint",
           show_if={"key": "krea_target_mode", "eq": "custom"}),
    _field("krea_target_exclude", "textarea", "", hint_key="field.krea_target_excludeHint",
           show_if={"key": "krea_target_mode", "eq": "custom"}),
    shared_training_field('rank_dropout',
        default=0,
        hint_key="field.krea_rank_dropoutHint",
        show_if_any=[[{"key": "network_module", "eq": KREA2_NETWORK_MODULE}],
                        [_LYCORIS, {"key": "lycoris_algo", "eq": "loha"}]],
        profiles=['krea2-lora'],
    ),
    shared_training_field('module_dropout', default=0, profiles=['krea2-lora']),
    shared_training_field('lokr_factor',
        default=-1,
        show_if=[_LYCORIS, {"key": "lycoris_algo", "eq": "lokr"}],
        hint_key="field.krea_lokr_factorHint",
        profiles=['krea2-lora'],
    ),
    # full_matrix controls availability, not nesting: these algorithm options are siblings.
    *[_field(key, "toggle", False, nested=False,
             show_if=[_LYCORIS, {"key": "lycoris_algo", "eq": "lokr"},
             *([{"key": "full_matrix", "eq": False}] if key == "decompose_both" else [])],
             hint_key=f"field.krea_{key}Hint" if key != "full_matrix" else "field.full_matrixHint")
      for key in ("decompose_both", "full_matrix", "unbalanced_factorization")],
    *[_field(key, "toggle", False, show_if=_LYCORIS, hint_key=f"field.{key}Hint")
      for key in ("use_scalar", "rs_lora", "dora_wd")],
    _field("wd_on_output", "toggle", True,
           show_if=[_LYCORIS, {"key": "dora_wd", "eq": True}], hint_key="field.wd_on_outputHint"),
    _field("bypass_mode", "toggle", False, show_if=_LYCORIS,
           hint_key="field.krea_bypass_modeHint",
           auto_value=[{"watch": "fp8_base", "when": True, "set": True},
                       {"watch": "dora_wd", "when": True, "set": False}],
           readonly_if_any=[{"key": "fp8_base", "eq": True}, {"key": "dora_wd", "eq": True}],
           readonly_reason_key="field.krea_bypass_modeHint"),
    shared_training_field('lycoris_kernel_backend', default="auto", profiles=['krea2-lora']),
]

apply_lycoris_panel_layout(KREA2_NETWORK_FIELDS)

_LYCORIS_ARGS = {"lokr_factor": "factor", **{key: key for key in (
    "decompose_both", "full_matrix", "unbalanced_factorization", "use_scalar",
    "rs_lora", "dora_wd", "wd_on_output", "bypass_mode")}}
_LOKR_ONLY = {"lokr_factor", "decompose_both", "full_matrix", "unbalanced_factorization"}
_MANAGED_ARGS = {"algo", "preset", "rank_dropout", "module_dropout", *_LYCORIS_ARGS.values()}
_NETWORK_DEFAULTS = {field["key"]: field["default"] for field in KREA2_NETWORK_FIELDS}


def linear_target_names() -> tuple[str, ...]:
    projections = ("attn.wq", "attn.wk", "attn.wv", "attn.wo", "attn.gate", "mlp.gate", "mlp.up", "mlp.down")
    return tuple(
        [f"blocks.{i}.{suffix}" for i in range(28) for suffix in projections]
        + [f"txtfusion.{group}.{i}.{suffix}" for group in ("layerwise_blocks", "refiner_blocks")
           for i in range(2) for suffix in projections]
        + ["first", "last.linear", "tmlp.0", "tmlp.2", "txtmlp.1", "txtmlp.3", "tproj.1", "txtfusion.projector"]
    )


def _lines(value: Any) -> list[str]:
    return [str(item).strip() for item in (value if isinstance(value, list) else str(value or "").splitlines())
            if str(item).strip()]


def selected_targets(config: dict) -> tuple[str, ...]:
    mode = config.get("krea_target_mode", "all")
    names = linear_target_names()
    if mode == "attention":
        return tuple(name for name in names if name.startswith("blocks.") and ".attn." in name)
    if mode == "attention_mlp":
        return tuple(name for name in names if name.startswith("blocks."))
    if mode == "custom":
        include = [re.compile(pattern) for pattern in _lines(config.get("krea_target_include", ".*"))]
        exclude = [re.compile(pattern) for pattern in _lines(config.get("krea_target_exclude"))]
        return tuple(name for name in names if any(p.fullmatch(name) for p in include)
                     and not any(p.fullmatch(name) for p in exclude))
    if mode != "all":
        raise ValueError("krea_target_mode: unsupported value / 不支持的目标层选项")
    return names


def build_krea2_network_preset(config: dict) -> dict:
    return {"enable_conv": False, "unet_target_module": [],
            "unet_target_name": [f"^{re.escape(name)}$" for name in selected_targets(config)],
            "text_encoder_target_module": [], "text_encoder_target_name": [],
            "module_algo_map": {}, "name_algo_map": {}, "exclude_name": [], "use_fnmatch": False}


def validate_krea2_network(config: dict) -> list[str]:
    errors = []
    # Earlier Krea presets could only express these controls in the text box.
    # Preserve those presets when the newly introduced controls are still zero.
    remaining = []
    legacy_dropout = {}
    for arg in _lines(config.get("network_args_custom")):
        key, separator, value = arg.partition("=")
        key = key.strip()
        if separator and key in {"rank_dropout", "module_dropout"}:
            legacy_dropout[key] = value.strip()
        else:
            remaining.append(arg)
    if config.get("network_args_custom"):
        config["network_args_custom"] = "\n".join(remaining)
    for key, value in legacy_dropout.items():
        if config.get(key) in (None, "", 0, "0"):
            config[key] = value
    module = config.setdefault("network_module", KREA2_NETWORK_MODULE)
    if module not in KREA2_NETWORK_MODULES:
        errors.append("network_module: unsupported Krea 2 module / 不支持的 Krea 2 网络模块")
    for field in KREA2_NETWORK_FIELDS:
        config.setdefault(field["key"], field["default"])
        if field["type"] == "toggle" and not isinstance(config[field["key"]], bool):
            errors.append(f"{field['key']}: must be boolean / 必须为布尔值")
    config.setdefault("network_dropout", 0)
    if config["krea_target_mode"] not in KREA2_TARGET_MODES:
        errors.append("krea_target_mode: unsupported value / 不支持的目标层选项")
    else:
        try:
            if not selected_targets(config):
                errors.append("krea_target_include: no Krea 2 Linear layers selected / 没有匹配的 Krea 2 Linear 目标层")
        except (re.error, TypeError) as exc:
            errors.append(f"krea_target_include/exclude: invalid regex / 正则无效: {exc}")
    for key in ("rank_dropout", "module_dropout"):
        try:
            value = float(config[key])
            if isinstance(config[key], bool) or not 0 <= value <= (0.99 if key == "rank_dropout" else 1):
                raise ValueError()
            config[key] = value
        except (ValueError, TypeError):
            errors.append(f"{key}: invalid probability / 概率超出有效范围")
    if module == KREA2_LYCORIS_MODULE:
        if config["lycoris_algo"] not in ("loha", "lokr"):
            errors.append("lycoris_algo: Krea 2 supports LoHa / LoKr only / Krea 2 仅支持 LoHa、LoKr")
        if config["lycoris_kernel_backend"] not in ("auto", "torch", "triton", "tilelang", "compile"):
            errors.append("lycoris_kernel_backend: unsupported value / 不支持的内核后端")
        if config["lycoris_algo"] == "lokr":
            try:
                value = float(config["lokr_factor"])
                if isinstance(config["lokr_factor"], bool) or not value.is_integer() or (value != -1 and value < 1):
                    raise ValueError()
                config["lokr_factor"] = int(value)
            except (ValueError, TypeError, OverflowError):
                errors.append("lokr_factor: use -1 or a positive integer / 必须为 -1 或正整数")
        if config.get("fp8_base"):
            config["bypass_mode"] = True
            if config.get("dora_wd"):
                errors.append("dora_wd: disable FP8 to use DoRA / DoRA 需要关闭 FP8")
        if config.get("dora_wd") and config.get("bypass_mode"):
            errors.append("dora_wd: requires bypass_mode=False / DoRA 需要关闭旁路模式")
        if config["lycoris_algo"] == "lokr" and config.get("rank_dropout"):
            errors.append("rank_dropout: unsupported by the current LyCORIS LoKr path / 当前 LyCORIS LoKr 路径不支持此参数，请使用 module_dropout")
    for argument in _lines(config.get("network_args_custom")):
        key, separator, value = argument.partition("=")
        key = key.strip()
        if not separator or not key or "=" in value:
            errors.append(f"network_args_custom: invalid key=value / 参数格式无效: {argument}")
        elif key in _MANAGED_ARGS:
            errors.append(f"network_args_custom: {key} is managed by the form / 请使用界面中的对应参数")
        elif key in {"include_patterns", "exclude_patterns"}:
            if module == KREA2_LYCORIS_MODULE or config["krea_target_mode"] != "all":
                errors.append(f"network_args_custom: use custom target layers for {key} / 请改用自定义目标层")
            else:
                try:
                    patterns = ast.literal_eval(value)
                    if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
                        raise ValueError()
                    for pattern in patterns:
                        re.compile(pattern)
                except (ValueError, SyntaxError, re.error):
                    errors.append(f"network_args_custom: invalid {key} / 目标层正则无效")
        elif module == KREA2_LYCORIS_MODULE:
            errors.append(f"network_args_custom: unsupported LyCORIS argument {key} / 不支持的 LyCORIS 参数")
    return errors


def build_krea2_network_args(config: dict, preset_path: str | Path) -> list[str]:
    args = _lines(config.get("network_args_custom"))
    if config.get("network_module", KREA2_NETWORK_MODULE) == KREA2_LYCORIS_MODULE:
        args += [f"algo={config.get('lycoris_algo', 'lokr')}", f"preset={Path(preset_path).as_posix()}"]
        for key, argument in _LYCORIS_ARGS.items():
            if key in _LOKR_ONLY and config.get("lycoris_algo", "lokr") != "lokr":
                continue
            if key == "wd_on_output" and not config.get("dora_wd"):
                continue
            # kohya passes decompose_both through without str_bool conversion:
            # the string "False" is truthy in LokrModule. Omit it when disabled.
            if key == "decompose_both" and (config.get("full_matrix") or not config.get(key)):
                continue
            value = config.get(key, _NETWORK_DEFAULTS[key])
            if key == "bypass_mode" and config.get("fp8_base"):
                value = True
            args.append(f"{argument}={value}")
    elif config.get("krea_target_mode", "all") != "all":
        args += ["exclude_patterns=['.*']", f"include_patterns={list(map(re.escape, selected_targets(config)))!r}"]
    for key in ("rank_dropout", "module_dropout"):
        if config.get(key):
            args.append(f"{key}={float(config[key])}")
    return args


def extract_krea2_network_form(config: dict) -> dict:
    """Restore guided controls from native args without losing old LoRA filters."""
    result = dict(config)
    native = result.pop("network_args", [])
    if not isinstance(native, list) or any(not isinstance(arg, str) for arg in native):
        raise ValueError("network_args must be a string array / 必须为字符串数组")
    inverse = {value: key for key, value in _LYCORIS_ARGS.items()}
    inverse.update(algo="lycoris_algo", rank_dropout="rank_dropout", module_dropout="module_dropout")
    extras, parsed = [], {}
    for arg in [*native, *_lines(result.pop("network_args_custom", ""))]:
        key, separator, raw = arg.partition("=")
        key = key.strip()
        if separator and key in inverse:
            try:
                value = ast.literal_eval(raw)
            except (ValueError, SyntaxError):
                value = {"true": True, "false": False}.get(raw.strip().lower(), raw.strip())
            parsed[inverse[key]] = value
        elif key == "preset":
            raise ValueError("preset: import the portable training.yaml to restore Krea 2 target layers / 请导入 training.yaml 恢复 Krea 2 目标层设置")
        else:
            extras.append(arg)
    if extras:
        result["network_args_custom"] = "\n".join(extras)
    for key, value in parsed.items():
        result.setdefault(key, value)
    return result
