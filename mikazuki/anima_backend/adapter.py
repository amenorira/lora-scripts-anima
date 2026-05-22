"""
Anima Backend — 配置适配层

UI JSON → TOML 转换的白名单 + 字段映射 + 防御性过滤。
解决了原 api.py 中 UI 字段直接透传到 sd-scripts 导致的静默失败问题。
"""
from __future__ import annotations

import math
from copy import deepcopy
from pathlib import Path
from typing import Any

# ── 白名单：允许传递到 sd-scripts 的字段 ──────────────────────
SUPPORTED_FIELDS = {
    # 模型路径
    "pretrained_model_name_or_path", "vae", "qwen3", "llm_adapter_path",
    "t5_tokenizer_path", "resume",
    # 数据集
    "train_data_dir", "reg_data_dir",
    "resolution", "enable_bucket", "min_bucket_reso", "max_bucket_reso",
    "bucket_reso_steps", "bucket_no_upscale",
    # 输出
    "output_dir", "output_name", "save_model_as", "save_precision",
    "save_every_n_epochs", "save_every_n_steps", "save_state",
    "save_last_n_epochs_state",
    # 训练参数
    "max_train_epochs", "max_train_steps", "train_batch_size",
    "gradient_checkpointing", "gradient_accumulation_steps",
    "network_train_unet_only", "network_train_text_encoder_only",
    # 优化器 + 学习率
    "learning_rate", "unet_lr", "text_encoder_lr",
    "optimizer_type", "optimizer_args",
    "lr_scheduler", "lr_scheduler_num_cycles", "lr_warmup_steps",
    "loss_type", "min_snr_gamma", "weight_decay",
    "prodigy_d_coef", "prodigy_d0",
    # 网络结构
    "network_module", "network_weights", "network_dim", "network_alpha",
    "network_dropout", "network_args",
    "dim_from_weights", "scale_weight_norms", "train_norm",
    "full_matrix", "pissa_init", "pissa_method", "pissa_niter",
    "pissa_oversample", "pissa_apply_conv2d", "pissa_export_mode",
    # 采样
    "sample_prompts", "sample_at_first", "sample_every_n_epochs",
    "sample_every_n_steps", "sample_sampler", "sample_cfg",
    # Caption
    "caption_extension", "shuffle_caption", "keep_tokens",
    "caption_tag_dropout_rate", "caption_dropout_rate",
    "caption_dropout_every_n_epochs",
    "prefer_json_caption", "weighted_captions", "max_token_length",
    # 噪声
    "noise_offset", "multires_noise_iterations", "multires_noise_discount",
    # 性能
    "fp8_base", "fp8_base_unet",
    "cache_latents", "cache_latents_to_disk",
    "cache_text_encoder_outputs", "cache_text_encoder_outputs_to_disk",
    "persistent_data_loader_workers", "max_data_loader_n_workers",
    "text_encoder_batch_size",
    "disable_mmap_load_safetensors",
    "blocks_to_swap", "cpu_offload_checkpointing",
    # 精度
    "mixed_precision", "full_fp16", "full_bf16",
    # 杂项
    "seed", "logging_dir", "log_with", "clip_skip",
    "lowram", "no_half_vae", "vae_batch_size",
    "xformers", "sdpa",
    # Anima 专有
    "qwen3_max_token_length", "t5_max_token_length",
    "timestep_sampling", "sigmoid_scale", "discrete_flow_shift",
    "weighting_scheme", "logit_mean", "logit_std", "mode_scale",
    "attn_mode", "split_attn", "vae_chunk_size", "vae_disable_cache",
    "torch_compile",
    "unsloth_offload_checkpointing",
    # 块权重
    "down_lr_weight", "mid_lr_weight", "up_lr_weight",
    "block_lr_zero_threshold", "enable_block_weights",
    "enable_base_weight", "base_weights", "base_weights_multiplier",
    "prior_loss_weight",
}

# ── 纯 UI 字段（不传给训练器）─────────────────────────────────
UI_ONLY_FIELDS = {
    "model_train_type", "enable_preview",
    "positive_prompts", "negative_prompts",
    "sample_width", "sample_height", "sample_seed", "sample_steps",
    "sample_scheduler", "randomly_choice_prompt", "prompt_file",
    "enable_debug_options", "json_caption_hint",
    "lora_type",
    "gpu_ids", "enable_status",
    "ui_custom_params",
    "optimizer_args_custom",  # 会被合并到 optimizer_args
    "network_args_custom",    # 会被合并到 network_args
}

# ── 已知的可显示警告的 Anima 前缀字段 ─────────────────────────
ANIMA_KNOWN_PREFIX = {"anima_"}

# ── T-LoRA 字段映射 ──────────────────────────────────────────
TLORA_NETWORK_ARG_FIELDS = {
    "tlora_min_rank", "tlora_rank_schedule", "tlora_orthogonal_init",
}

# ── LyCORIS 字段映射 ─────────────────────────────────────────
LYCORIS_NETWORK_ARG_MAP: dict[str, str] = {
    "lycoris_algo": "algo",
    "lokr_factor": "factor",
    "conv_dim": "conv_dim",
    "conv_alpha": "conv_alpha",
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

    # ── 3. LyCORIS Anima preset 补全 ─────────────────────
    if source.get("network_module") == "lycoris.kohya":
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

    # ── 4. LyCORIS 顶层字段 → network_args ────────────────
    if source.get("network_module") == "lycoris.kohya":
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
        # 跳过纯 UI 字段
        if key in UI_ONLY_FIELDS or key in TLORA_NETWORK_ARG_FIELDS or key in LYCORIS_NETWORK_ARG_MAP:
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
