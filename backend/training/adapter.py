"""
Training Adapter — 配置适配层

UI JSON → TOML 转换：白名单过滤 + 字段映射 + 防御性过滤。
字段集从 field_registry.py 派生（Single Source of Truth）。
"""
from __future__ import annotations

import math
from copy import deepcopy
from pathlib import Path
from typing import Any

# ── 字段集：从统一注册表派生（Single Source of Truth）──────
from backend.training.field_registry import get_supported_fields, get_ui_only_fields, FIELDS

SUPPORTED_FIELDS = get_supported_fields()
UI_ONLY_FIELDS = get_ui_only_fields()
# merged 字段应由 UI 层合并进父字段（如 weight_decay→optimizer_args），adapter 不直接透传
MERGED_FIELDS = {f["key"] for f in FIELDS if f.get("target") == "merged"}

# ── 已知的可显示警告的 Anima 前缀字段 ─────────────────────────
ANIMA_KNOWN_PREFIX = {"anima_"}

# ── T-LoRA 字段映射 ──────────────────────────────────────────
TLORA_NETWORK_ARG_FIELDS = {
    "tlora_min_rank", "tlora_rank_schedule", "tlora_orthogonal_init",
}

# ── LyCORIS 字段映射 ─────────────────────────────────────────
LYCORIS_NETWORK_ARG_MAP: dict[str, str] = {
    "conv_dim": "conv_dim",
    "conv_alpha": "conv_alpha",
    "lokr_factor": "factor",
    "use_cp": "use_cp",
    "use_scalar": "use_scalar",
    "decompose_both": "decompose_both",
    "bypass_mode": "bypass_mode",
    "dora_wd": "dora_wd",
    "full_matrix": "full_matrix",
    "rank_dropout": "rank_dropout",
    "module_dropout": "module_dropout",
    "rank_dropout_scale": "rank_dropout_scale",
    "train_norm": "train_norm",
    "dropout": "dropout",
}


def _is_empty_value(value: Any) -> bool:
    """检测空值/无效值：None、NaN、空字符串、'undefined'、'null'"""
    if value is None or value is False:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    if isinstance(value, str) and value.strip().lower() in {"", "undefined", "null", "nan"}:
        return True
    return False


def _normalize_network_args(values: Any) -> list[str]:
    """
    规范化 network_args：
    - 去重（同 key 保留最后一个）
    - 过滤空/无效项
    - 过滤 key=NaN / key=undefined / key=null
    """
    if not isinstance(values, list):
        return []

    ordered: list[str] = []
    key_index: dict[str, int] = {}

    for raw in values:
        if not isinstance(raw, str):
            continue
        item = raw.strip()
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value.lower() in {"undefined", "null", "nan"}:
            continue
        if math.isnan(float(value)) if _is_float(value) else False:
            continue

        normalized = f"{key}={value}"
        if key in key_index:
            ordered[key_index[key]] = normalized
        else:
            key_index[key] = len(ordered)
            ordered.append(normalized)

    return ordered


def _is_float(s: str) -> bool:
    try:
        float(s)
        return True
    except (ValueError, TypeError):
        return False


def _normalize_path(value: str) -> str:
    """路径规范化：反斜杠 → 正斜杠"""
    if isinstance(value, str) and "\\" in value:
        return value.replace("\\", "/")
    return value


def _merge_custom_args(source: dict, custom_key: str, target_key: str) -> None:
    """合并自定义参数到主参数列表"""
    custom = source.pop(custom_key, None)
    if not custom or not isinstance(custom, str) or not custom.strip():
        return

    existing = source.get(target_key)
    if isinstance(existing, str):
        existing = [existing]
    elif not isinstance(existing, list):
        existing = []

    for line in custom.strip().split("\n"):
        line = line.strip()
        if line and "=" in line:
            existing.append(line)

    if existing:
        source[target_key] = existing


def adapt_config(config: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """
    将 UI JSON 配置转换为 sd-scripts TOML 配置。

    返回 (adapted_config, warnings)
    """
    source = deepcopy(config)
    adapted: dict[str, Any] = {}
    warnings: list[str] = []

    # ── 1. 合并自定义参数 ──────────────────────────────────
    _merge_custom_args(source, "network_args_custom", "network_args")
    _merge_custom_args(source, "optimizer_args_custom", "optimizer_args")

    # ── 2. 规范化 network_args ─────────────────────────────
    merged_network_args: list[str] = []
    if isinstance(source.get("network_args"), list):
        merged_network_args.extend(source["network_args"])
    if isinstance(source.get("network_args_custom"), list):
        merged_network_args.extend(source.pop("network_args_custom"))

    normalized_network_args = _normalize_network_args(merged_network_args)
    if normalized_network_args:
        source["network_args"] = normalized_network_args
    elif "network_args" in source:
        source.pop("network_args", None)

    # ── 3. LyCORIS preset 补全（networks.loha / networks.lokr）──
    if source.get("network_module") in ("networks.loha", "networks.lokr"):
        network_args = source.get("network_args")
        has_preset = isinstance(network_args, list) and any(
            isinstance(item, str) and item.strip().startswith("preset=")
            for item in network_args
        )
        if not has_preset:
            preset_path = (
                Path(__file__).resolve().parents[2] / "config" / "lycoris_anima_preset.toml"
            )
            # 只有 preset 文件存在时才注入
            if preset_path.exists():
                source["network_args"] = list(network_args or []) + [
                    f"preset={preset_path.as_posix()}"
                ]

    # ── 4. LyCORIS 顶层字段 → network_args（networks.loha / networks.lokr）──
    if source.get("network_module") in ("networks.loha", "networks.lokr"):
        network_args = list(source.get("network_args") or [])
        for ui_field, arg_key in LYCORIS_NETWORK_ARG_MAP.items():
            value = source.pop(ui_field, None)
            if not _is_empty_value(value):
                network_args.append(f"{arg_key}={value}")
        if network_args:
            source["network_args"] = network_args

    # ── 5. T-LoRA 顶层字段 → network_args ─────────────────
    if source.get("network_module") in ("networks.tlora_anima", "networks.tlora"):
        network_args = list(source.get("network_args") or [])
        for field in TLORA_NETWORK_ARG_FIELDS:
            value = source.pop(field, None)
            if not _is_empty_value(value):
                network_args.append(f"{field}={value}")
        if network_args:
            source["network_args"] = network_args

    # ── 6. 主循环：白名单过滤 ─────────────────────────────
    for key, value in source.items():
        # 跳过纯 UI 字段、合并字段、及已处理的 T-LoRA/LyCORIS 字段
        if key in UI_ONLY_FIELDS or key in MERGED_FIELDS or key in TLORA_NETWORK_ARG_FIELDS or key in LYCORIS_NETWORK_ARG_MAP:
            continue
        # 跳过空值
        if _is_empty_value(value):
            continue
        # 白名单放行
        if key in SUPPORTED_FIELDS:
            if key == "attn_mode" and value in ("", None):
                continue
            if isinstance(value, str):
                value = _normalize_path(value)
            adapted[key] = value
            continue
        # 未知 Anima 前缀字段
        if any(key.startswith(prefix) for prefix in ANIMA_KNOWN_PREFIX):
            warnings.append(f"[Anima field ignored] {key}")
            continue
        # 未知字段：警告但透传
        warnings.append(f"[Unknown field passed through] {key}")
        if isinstance(value, str):
            value = _normalize_path(value)
        adapted[key] = value

    return adapted, warnings
