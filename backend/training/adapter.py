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

# ── LyCORIS 通用字段映射（sd-scripts 原生 LoHa/LoKr 和 lycoris.kohya 均支持）───
LYCORIS_COMMON_ARG_MAP: dict[str, str] = {
    "conv_dim": "conv_dim",
    "conv_alpha": "conv_alpha",
    "lokr_factor": "factor",
    "rank_dropout": "rank_dropout",
    "module_dropout": "module_dropout",
}

# ── 仅 lycoris.kohya 支持的高级字段 ──────────────────────────
LYCORIS_KOHYA_ONLY_ARG_MAP: dict[str, str] = {
    "use_cp": "use_cp",
    "use_scalar": "use_scalar",
    "decompose_both": "decompose_both",
    "full_matrix": "full_matrix",
    "train_norm": "train_norm",
    "dropout": "dropout",
}

# ── lycoris.kohya 专有字段映射（算法选择器等）────────────────
LYCORIS_KOHYA_SPECIFIC_ARG_MAP: dict[str, str] = {
    "lycoris_algo": "algo",
    "dora_wd": "dora_wd",
    "block_size": "block_size",
    "constraint": "constraint",
    "rescaled": "rescaled",
    "bypass_mode": "bypass_mode",
    "rs_lora": "rs_lora",
}

# lycoris.kohya 模块下所有需从顶层 pop 掉的 UI 字段
LYCORIS_KOHYA_UI_FIELDS = (
    set(LYCORIS_COMMON_ARG_MAP.keys())
    | set(LYCORIS_KOHYA_ONLY_ARG_MAP.keys())
    | set(LYCORIS_KOHYA_SPECIFIC_ARG_MAP.keys())
)


def _is_empty_value(value: Any) -> bool:
    """检测空值/无效值：None、NaN、空字符串、'undefined'、'null'
    注意：布尔值 False 不是空值，toggle 关闭时应显式传入 false"""
    if value is None:
        return True
    if isinstance(value, bool):
        return False
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

    # ── 4. LyCORIS 通用字段 → network_args（networks.loha / networks.lokr，仅原生支持的参数）──
    if source.get("network_module") in ("networks.loha", "networks.lokr"):
        network_args = list(source.get("network_args") or [])
        for ui_field, arg_key in LYCORIS_COMMON_ARG_MAP.items():
            value = source.pop(ui_field, None)
            if not _is_empty_value(value):
                network_args.append(f"{arg_key}={value}")
        if network_args:
            source["network_args"] = network_args

    # ── 4.5. lycoris.kohya 字段 → network_args（通用 + kohya特有 + kohya专有）───
    if source.get("network_module") == "lycoris.kohya":
        network_args = list(source.get("network_args") or [])
        # lycoris.kohya 专有映射（algo, dora_wd, block_size 等）
        for ui_field, arg_key in LYCORIS_KOHYA_SPECIFIC_ARG_MAP.items():
            value = source.pop(ui_field, None)
            if not _is_empty_value(value):
                if isinstance(value, bool):
                    value = str(value).lower()
                network_args.append(f"{arg_key}={value}")
        # 通用 LyCORIS 字段（conv_dim, rank_dropout 等，sd-scripts 原生也支持）
        for ui_field, arg_key in LYCORIS_COMMON_ARG_MAP.items():
            value = source.pop(ui_field, None)
            if not _is_empty_value(value):
                if isinstance(value, bool):
                    value = str(value).lower()
                network_args.append(f"{arg_key}={value}")
        # 仅 lycoris.kohya 支持的高级字段（use_cp, decompose_both 等）
        for ui_field, arg_key in LYCORIS_KOHYA_ONLY_ARG_MAP.items():
            value = source.pop(ui_field, None)
            if not _is_empty_value(value):
                if isinstance(value, bool):
                    value = str(value).lower()
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

    # ── 5.5. 互斥字段校验 ────────────────────────────────
    # network_train_unet_only 和 network_train_text_encoder_only 互斥
    unet_only = source.get("network_train_unet_only")
    te_only = source.get("network_train_text_encoder_only")
    if unet_only and te_only:
        warnings.append(
            "[Conflict] network_train_unet_only and network_train_text_encoder_only "
            "are both true; forcing text_encoder_only=false / 两者同时为 true，"
            "自动关闭 text_encoder_only"
        )
        source["network_train_text_encoder_only"] = False

    # ── 5.6. EmoSens 优化器：强制 lr_scheduler + 模型感知 LR ──
    _EMO_OPTIMIZERS = {"vendor.emo_optimizer.emosens.EmoSens"}
    if source.get("optimizer_type") in _EMO_OPTIMIZERS:
        # 强制 lr_scheduler = constant（忽略用户可能的残留值）
        if source.get("lr_scheduler") != "constant":
            source["lr_scheduler"] = "constant"
            warnings.append(
                "EmoSens: lr_scheduler forced to constant (内部自动管理学习率)"
            )
        # 根据模型架构调整学习率（仅当前端未正确预填时）
        model_type = source.get("model_train_type", "sd-lora")
        lr = source.get("learning_rate", "1.0")
        if model_type == "anima-lora" and lr == "1.0":
            source["learning_rate"] = "0.1"
            warnings.append(
                "EmoSens + Anima(DiT): learning_rate auto-adjusted to 0.1 (Transformer 推荐值)"
            )
        # weight_decay 安全网：EmoSens 官方默认 0.01
        wd = source.get("weight_decay")
        if wd is None or wd == "":
            source["weight_decay"] = 0.01
            warnings.append(
                "EmoSens: weight_decay auto-set to 0.01 (官方默认值)"
            )

    # ── 5.6b. Prodigy 优化器：锁定 learning_rate ─────────
    _PRODIGY_OPTIMIZERS = {"Prodigy", "prodigyplus.ProdigyPlusScheduleFree"}
    if source.get("optimizer_type") in _PRODIGY_OPTIMIZERS:
        lr = source.get("learning_rate", "1.0")
        try:
            lr_val = float(lr)
        except (ValueError, TypeError):
            lr_val = 1.0
        if abs(lr_val - 1.0) > 1e-6:
            source["learning_rate"] = "1.0"
            warnings.append(
                "Prodigy: learning_rate forced to 1.0 (D-adaptation 缩放因子必须为 1.0)"
            )

    # ── 5.6c. ScheduleFree 优化器：锁定 lr_scheduler ─────
    _SCHEDULEFREE_OPTIMIZERS = {"AdamWScheduleFree", "prodigyplus.ProdigyPlusScheduleFree"}
    if source.get("optimizer_type") in _SCHEDULEFREE_OPTIMIZERS:
        if source.get("lr_scheduler") != "constant":
            source["lr_scheduler"] = "constant"
            warnings.append(
                "ScheduleFree: lr_scheduler forced to constant (内部自动管理调度)"
            )

    # ── 5.7. torch.compile 兼容性校验 ────────────────────
    if source.get("torch_compile"):
        # torch.compile 与 blocks_to_swap 不兼容
        blocks = source.get("blocks_to_swap", 0) or 0
        if blocks > 0:
            source["torch_compile"] = False
            warnings.append(
                "[Conflict] torch_compile is incompatible with blocks_to_swap; "
                "disabling torch_compile / torch_compile 与 blocks_to_swap 不兼容，已自动关闭 torch_compile"
            )
        # Windows + inductor 警告
        import sys
        dynamo_backend = source.get("dynamo_backend", "inductor")
        if sys.platform == "win32" and dynamo_backend == "inductor":
            warnings.append(
                "[Warning] inductor backend may be unstable on Windows; "
                "consider switching to eager / Windows 上 inductor 后端可能不稳定，建议切换为 eager"
            )

    # ── 5.8. cache_text_encoder_outputs 与 text_encoder_only 互斥 ──
    if source.get("cache_text_encoder_outputs") and source.get("network_train_text_encoder_only"):
        source["network_train_text_encoder_only"] = False
        source["network_train_unet_only"] = True
        warnings.append(
            "[Conflict] cache_text_encoder_outputs and network_train_text_encoder_only "
            "are incompatible; forcing unet_only=True, text_encoder_only=False / "
            "缓存文本编码器输出与仅训练文本编码器不兼容，已自动切换为仅训练主干"
        )

    # ── 5.9. attn_mode=xformers 需要 split_attn ──
    if source.get("attn_mode") == "xformers" and not source.get("split_attn"):
        source["split_attn"] = True
        warnings.append(
            "[Auto] attn_mode=xformers requires split_attn; "
            "enabling split_attn automatically / "
            "xformers 注意力模式需要 split_attn，已自动开启"
        )

    # ── 5.10. sageattn 不支持训练 ──
    if source.get("attn_mode") == "sageattn":
        source["attn_mode"] = "torch"
        warnings.append(
            "[Warning] sageattn does not support training; "
            "falling back to torch mode / "
            "sageattn 不支持训练，已回退为 torch 模式"
        )

    # ── 6. 主循环：白名单过滤 ─────────────────────────────
    # sd-scripts 内部字段，适配层透传不走警告
    _INTERNAL_PASSTHROUGH = {"network_args", "optimizer_args"}
    for key, value in source.items():
        # 跳过纯 UI 字段、合并字段、及已处理的 T-LoRA/LyCORIS 字段
        if key in UI_ONLY_FIELDS or key in MERGED_FIELDS or key in TLORA_NETWORK_ARG_FIELDS or key in LYCORIS_KOHYA_UI_FIELDS:
            continue
        # 跳过空值
        if _is_empty_value(value):
            continue
        # 内部透传字段，直接放行
        if key in _INTERNAL_PASSTHROUGH:
            if isinstance(value, str):
                value = _normalize_path(value)
            adapted[key] = value
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
