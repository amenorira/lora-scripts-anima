"""
训练字段注册表 — Single Source of Truth

统一管理所有训练参数的元数据：类型、默认值、所属分类、i18n key、
是否传递给 sd-scripts 等。前后端共享此定义。

添加新字段只需在此文件中新增一条记录，无需修改 adapter.py 或 config.js。
"""
from __future__ import annotations

from typing import Any


# ═══════════════════════════════════════════════════════════════
# 字段定义
# ═══════════════════════════════════════════════════════════════
#
# 每个字段的元数据：
#   key       — 字段名（对应 sd-scripts 参数名）
#   type      — 输入类型: text, number, toggle, select, textarea, stepper
#   default   — 默认值
#   section   — 所属分组: model, dataset, save, trainParams, lrOptimizer,
#               network, caption, preview, speed, other, animaParams
#   desc_key  — i18n 描述键
#   target    — "toml"（传入 sd-scripts）, "ui"（仅 UI）, "merged"（UI 输入合并后传入）
#   role      — 文件选择器类型（可选）: file-model, file-folder, file-model-saved
#   options   — select 选项列表（可选）
#   show_if   — 条件显示（可选）: {"key": "...", "eq": ...}
#   hint_key  — 提示文本 i18n 键（可选）
#   step      — number 步长（可选）
#   min       — 最小值（可选）
#   max       — 最大值（可选）
#   hidden    — 是否隐藏（可选）
#   group     — 所属训练类型: "all", "anima"（可选，默认 "all"）

FIELDS: list[dict[str, Any]] = [
    # ── 模型路径 ──────────────────────────────────────────
    {"key": "pretrained_model_name_or_path", "type": "text", "default": "./sd-models/model.safetensors", "section": "model", "desc_key": "field.pretrained_model_name_or_path", "target": "toml", "role": "file-model"},
    {"key": "vae", "type": "text", "default": "", "section": "model", "desc_key": "field.vae", "target": "toml", "role": "file-model"},
    {"key": "resume", "type": "text", "default": "", "section": "model", "desc_key": "field.resume", "target": "toml", "role": "file-folder"},
    {"key": "model_train_type", "type": "select", "default": "sd-lora", "section": "model", "desc_key": "field.model_train_type", "target": "ui", "hidden": True, "options": [
        {"v": "sd-lora", "l": "SD LoRA", "dk": "opt.model_train_type_sd-lora"},
        {"v": "sdxl-lora", "l": "SDXL LoRA", "dk": "opt.model_train_type_sdxl-lora"},
        {"v": "anima-lora", "l": "Anima LoRA", "dk": "opt.model_train_type_anima-lora"},
    ]},

    # ── 数据集 ────────────────────────────────────────────
    {"key": "train_data_dir", "type": "text", "default": "./train/aki", "section": "dataset", "desc_key": "field.train_data_dir", "target": "toml", "role": "file-folder"},
    {"key": "reg_data_dir", "type": "text", "default": "", "section": "dataset", "desc_key": "field.reg_data_dir", "target": "toml", "role": "file-folder"},
    {"key": "resolution", "type": "text", "default": "1024,1024", "section": "dataset", "desc_key": "field.resolution", "target": "toml", "hint_key": "field.resolutionHint"},
    {"key": "prior_loss_weight", "type": "number", "default": 1.0, "section": "dataset", "desc_key": "field.prior_loss_weight", "target": "toml", "step": 0.1},
    {"key": "enable_bucket", "type": "toggle", "default": True, "section": "dataset", "desc_key": "field.enable_bucket", "target": "toml"},
    {"key": "bucket_no_upscale", "type": "toggle", "default": True, "section": "dataset", "desc_key": "field.bucket_no_upscale", "target": "toml", "show_if": {"key": "enable_bucket", "eq": True}},
    {"key": "min_bucket_reso", "type": "number", "default": 256, "section": "dataset", "desc_key": "field.min_bucket_reso", "target": "toml", "min": 64, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
    {"key": "max_bucket_reso", "type": "number", "default": 2048, "section": "dataset", "desc_key": "field.max_bucket_reso", "target": "toml", "min": 256, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
    {"key": "bucket_reso_steps", "type": "number", "default": 64, "section": "dataset", "desc_key": "field.bucket_reso_steps", "target": "toml", "min": 16, "step": 16, "show_if": {"key": "enable_bucket", "eq": True}},

    # ── 保存 ──────────────────────────────────────────────
    {"key": "output_name", "type": "text", "default": "my_lora", "section": "save", "desc_key": "field.output_name", "target": "toml"},
    {"key": "output_dir", "type": "text", "default": "./output", "section": "save", "desc_key": "field.output_dir", "target": "toml", "role": "file-folder"},
    {"key": "save_model_as", "type": "select", "default": "safetensors", "section": "save", "desc_key": "field.save_model_as", "target": "toml", "options": [
        {"v": "safetensors", "l": "safetensors", "dk": "opt.save_model_as_safetensors"},
        {"v": "pt", "l": "pt", "dk": "opt.save_model_as_pt"},
        {"v": "ckpt", "l": "ckpt", "dk": "opt.save_model_as_ckpt"},
    ]},
    {"key": "save_precision", "type": "select", "default": "fp16", "section": "save", "desc_key": "field.save_precision", "target": "toml", "options": [
        {"v": "fp16", "l": "fp16", "dk": "opt.save_precision_fp16"},
        {"v": "bf16", "l": "bf16", "dk": "opt.save_precision_bf16"},
        {"v": "float", "l": "float", "dk": "opt.save_precision_float"},
    ]},
    {"key": "save_every_n_epochs", "type": "number", "default": 2, "section": "save", "desc_key": "field.save_every_n_epochs", "target": "toml", "min": 1},
    {"key": "save_state", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state", "target": "toml"},
    {"key": "save_last_n_epochs_state", "type": "number", "default": None, "section": "save", "desc_key": "field.save_last_n_epochs_state", "target": "toml", "min": 1, "show_if": {"key": "save_state", "eq": True}},

    # ── 训练参数 ──────────────────────────────────────────
    {"key": "max_train_epochs", "type": "number", "default": 10, "section": "trainParams", "desc_key": "field.max_train_epochs", "target": "toml", "min": 1},
    {"key": "max_train_steps", "type": "number", "default": None, "section": "trainParams", "desc_key": "field.max_train_steps", "target": "toml", "min": 1},
    {"key": "train_batch_size", "type": "number", "default": 1, "section": "trainParams", "desc_key": "field.train_batch_size", "target": "toml", "min": 1},
    {"key": "gradient_accumulation_steps", "type": "number", "default": 1, "section": "trainParams", "desc_key": "field.gradient_accumulation_steps", "target": "toml", "min": 1},
    {"key": "gradient_checkpointing", "type": "toggle", "default": False, "section": "trainParams", "desc_key": "field.gradient_checkpointing", "target": "toml"},
    {"key": "network_train_unet_only", "type": "toggle", "default": True, "section": "trainParams", "desc_key": "field.network_train_unet_only", "target": "toml"},
    {"key": "network_train_text_encoder_only", "type": "toggle", "default": False, "section": "trainParams", "desc_key": "field.network_train_text_encoder_only", "target": "toml"},

    # ── 学习率与优化器 ────────────────────────────────────
    {"key": "learning_rate", "type": "text", "default": "1e-4", "section": "lrOptimizer", "desc_key": "field.learning_rate", "target": "toml"},
    {"key": "unet_lr", "type": "text", "default": "1e-4", "section": "lrOptimizer", "desc_key": "field.unet_lr", "target": "toml"},
    {"key": "text_encoder_lr", "type": "text", "default": "1e-5", "section": "lrOptimizer", "desc_key": "field.text_encoder_lr", "target": "toml"},
    {"key": "lr_scheduler", "type": "select", "default": "cosine_with_restarts", "section": "lrOptimizer", "desc_key": "field.lr_scheduler", "target": "toml", "options": [
        {"v": "cosine_with_restarts", "l": "cosine_with_restarts", "dk": "opt.lr_scheduler_cosine_with_restarts"},
        {"v": "cosine", "l": "cosine", "dk": "opt.lr_scheduler_cosine"},
        {"v": "linear", "l": "linear", "dk": "opt.lr_scheduler_linear"},
        {"v": "polynomial", "l": "polynomial", "dk": "opt.lr_scheduler_polynomial"},
        {"v": "constant", "l": "constant", "dk": "opt.lr_scheduler_constant"},
        {"v": "constant_with_warmup", "l": "constant_with_warmup", "dk": "opt.lr_scheduler_constant_with_warmup"},
    ]},
    {"key": "lr_scheduler_num_cycles", "type": "number", "default": 1, "section": "lrOptimizer", "desc_key": "field.lr_scheduler_num_cycles", "target": "toml", "min": 1, "show_if": {"key": "lr_scheduler", "eq": "cosine_with_restarts"}},
    {"key": "lr_warmup_steps", "type": "number", "default": 0, "section": "lrOptimizer", "desc_key": "field.lr_warmup_steps", "target": "toml", "min": 0},
    {"key": "optimizer_type", "type": "select", "default": "AdamW8bit", "section": "lrOptimizer", "desc_key": "field.optimizer_type", "target": "toml", "options": [
        {"v": "AdamW", "l": "AdamW", "dk": "opt.optimizer_type_AdamW"},
        {"v": "AdamW8bit", "l": "AdamW8bit", "dk": "opt.optimizer_type_AdamW8bit"},
        {"v": "PagedAdamW8bit", "l": "PagedAdamW8bit", "dk": "opt.optimizer_type_PagedAdamW8bit"},
        {"v": "Lion", "l": "Lion", "dk": "opt.optimizer_type_Lion"},
        {"v": "Lion8bit", "l": "Lion8bit", "dk": "opt.optimizer_type_Lion8bit"},
        {"v": "PagedLion8bit", "l": "PagedLion8bit", "dk": "opt.optimizer_type_PagedLion8bit"},
        {"v": "SGDNesterov", "l": "SGDNesterov", "dk": "opt.optimizer_type_SGDNesterov"},
        {"v": "SGDNesterov8bit", "l": "SGDNesterov8bit", "dk": "opt.optimizer_type_SGDNesterov8bit"},
        {"v": "Prodigy", "l": "Prodigy", "dk": "opt.optimizer_type_Prodigy"},
        {"v": "prodigyplus.ProdigyPlusScheduleFree", "l": "ProdigyPlusScheduleFree", "dk": "opt.optimizer_type_ProdigyPlus"},
        {"v": "AdaFactor", "l": "AdaFactor", "dk": "opt.optimizer_type_AdaFactor"},
        {"v": "RAdamScheduleFree", "l": "RAdamScheduleFree", "dk": "opt.optimizer_type_RAdamScheduleFree"},
        {"v": "pytorch_optimizer.CAME", "l": "CAME", "dk": "opt.optimizer_type_CAME"},
    ]},
    {"key": "loss_type", "type": "select", "default": "", "section": "lrOptimizer", "desc_key": "field.loss_type", "target": "toml", "options": [
        {"v": "", "l": "Default", "dk": "opt.loss_type_default"},
        {"v": "l1", "l": "l1", "dk": "opt.loss_type_l1"},
        {"v": "l2", "l": "l2", "dk": "opt.loss_type_l2"},
        {"v": "huber", "l": "huber", "dk": "opt.loss_type_huber"},
        {"v": "smooth_l1", "l": "smooth_l1", "dk": "opt.loss_type_smooth_l1"},
    ]},
    {"key": "min_snr_gamma", "type": "number", "default": None, "section": "lrOptimizer", "desc_key": "field.min_snr_gamma", "target": "toml", "step": 0.1},
    {"key": "weight_decay", "type": "number", "default": None, "section": "lrOptimizer", "desc_key": "field.weight_decay", "target": "toml", "step": 0.001},
    {"key": "prodigy_d_coef", "type": "text", "default": "2.0", "section": "lrOptimizer", "desc_key": "field.prodigy_d_coef", "target": "toml", "show_if": {"key": "optimizer_type", "eq": "Prodigy"}},
    {"key": "prodigy_d0", "type": "text", "default": "", "section": "lrOptimizer", "desc_key": "field.prodigy_d0", "target": "toml", "show_if": {"key": "optimizer_type", "eq": "Prodigy"}},
    {"key": "optimizer_args", "type": "text", "default": "", "section": "lrOptimizer", "desc_key": "field.optimizer_args_custom", "target": "toml", "hint_key": "field.optimizer_args_customHint"},
    {"key": "optimizer_args_custom", "type": "textarea", "default": "", "section": "lrOptimizer", "desc_key": "field.optimizer_args_custom", "target": "ui", "hint_key": "field.optimizer_args_customHint"},

    # ── 网络结构 ──────────────────────────────────────────
    {"key": "network_module", "type": "select", "default": "networks.lora", "section": "network", "desc_key": "field.network_module", "target": "toml", "options": [
        {"v": "networks.lora", "l": "networks.lora", "dk": "opt.network_module_networks_lora"},
        {"v": "networks.lora_anima", "l": "networks.lora_anima", "dk": "opt.network_module_networks_lora_anima"},
        {"v": "lycoris.kohya", "l": "lycoris.kohya", "dk": "opt.network_module_lycoris_kohya"},
    ]},
    {"key": "network_dim", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_dim", "target": "toml", "min": 1, "max": 256, "step": 8},
    {"key": "network_alpha", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_alpha", "target": "toml", "min": 1},
    {"key": "network_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.network_weights", "target": "toml", "role": "file-model-saved"},
    {"key": "network_dropout", "type": "number", "default": 0, "section": "network", "desc_key": "field.network_dropout", "target": "toml", "min": 0, "max": 0.5, "step": 0.01},
    {"key": "scale_weight_norms", "type": "number", "default": None, "section": "network", "desc_key": "field.scale_weight_norms", "target": "toml", "min": 0, "step": 0.01},
    {"key": "enable_base_weight", "type": "toggle", "default": False, "section": "network", "desc_key": "field.enable_base_weight", "target": "ui"},
    {"key": "base_weights", "type": "textarea", "default": "", "section": "network", "desc_key": "field.base_weights", "target": "toml", "show_if": {"key": "enable_base_weight", "eq": True}},
    {"key": "base_weights_multiplier", "type": "textarea", "default": "", "section": "network", "desc_key": "field.base_weights_multiplier", "target": "toml", "show_if": {"key": "enable_base_weight", "eq": True}},
    {"key": "enable_block_weights", "type": "toggle", "default": False, "section": "network", "desc_key": "field.enable_block_weights", "target": "ui"},
    {"key": "down_lr_weight", "type": "text", "default": "1,1,1,1,1,1,1,1,1,1,1,1", "section": "network", "desc_key": "field.down_lr_weight", "target": "toml", "show_if": {"key": "enable_block_weights", "eq": True}},
    {"key": "mid_lr_weight", "type": "text", "default": "1", "section": "network", "desc_key": "field.mid_lr_weight", "target": "toml", "show_if": {"key": "enable_block_weights", "eq": True}},
    {"key": "up_lr_weight", "type": "text", "default": "1,1,1,1,1,1,1,1,1,1,1,1", "section": "network", "desc_key": "field.up_lr_weight", "target": "toml", "show_if": {"key": "enable_block_weights", "eq": True}},
    {"key": "block_lr_zero_threshold", "type": "number", "default": 0, "section": "network", "desc_key": "field.block_lr_zero_threshold", "target": "toml", "step": 0.01, "show_if": {"key": "enable_block_weights", "eq": True}},
    {"key": "network_args", "type": "text", "default": "", "section": "network", "desc_key": "field.network_args_custom", "target": "toml"},
    {"key": "network_args_custom", "type": "textarea", "default": "", "section": "network", "desc_key": "field.network_args_custom", "target": "ui", "hint_key": "field.network_args_customHint"},

    # ── Caption ───────────────────────────────────────────
    {"key": "caption_extension", "type": "text", "default": ".txt", "section": "caption", "desc_key": "field.caption_extension", "target": "toml"},
    {"key": "max_token_length", "type": "number", "default": 255, "section": "caption", "desc_key": "field.max_token_length", "target": "toml", "min": 1},
    {"key": "keep_tokens", "type": "number", "default": 0, "section": "caption", "desc_key": "field.keep_tokens", "target": "toml", "min": 0, "max": 255},
    {"key": "shuffle_caption", "type": "toggle", "default": True, "section": "caption", "desc_key": "field.shuffle_caption", "target": "toml"},
    {"key": "weighted_captions", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.weighted_captions", "target": "toml"},
    {"key": "caption_dropout_rate", "type": "number", "default": None, "section": "caption", "desc_key": "field.caption_dropout_rate", "target": "toml", "min": 0, "step": 0.01},
    {"key": "caption_dropout_every_n_epochs", "type": "number", "default": None, "section": "caption", "desc_key": "field.caption_dropout_every_n_epochs", "target": "toml", "min": 0, "max": 100},
    {"key": "caption_tag_dropout_rate", "type": "number", "default": None, "section": "caption", "desc_key": "field.caption_tag_dropout_rate", "target": "toml", "min": 0, "step": 0.01},

    # ── 预览 ──────────────────────────────────────────────
    {"key": "enable_preview", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.enable_preview", "target": "ui"},
    {"key": "positive_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.sample_prompts", "target": "ui", "hint_key": "field.sample_promptsHint", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "negative_prompts", "type": "text", "default": "", "section": "preview", "desc_key": "field.negative_prompts", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_sampler", "type": "select", "default": "euler_a", "section": "preview", "desc_key": "field.sample_sampler", "target": "toml", "show_if": {"key": "enable_preview", "eq": True}, "options": [
        {"v": "ddim", "l": "ddim", "dk": "opt.sample_sampler_ddim"},
        {"v": "euler", "l": "euler", "dk": "opt.sample_sampler_euler"},
        {"v": "euler_a", "l": "euler_a", "dk": "opt.sample_sampler_euler_a"},
        {"v": "heun", "l": "heun", "dk": "opt.sample_sampler_heun"},
        {"v": "dpmsolver", "l": "dpmsolver", "dk": "opt.sample_sampler_dpmsolver"},
        {"v": "dpmsolver++", "l": "dpmsolver++", "dk": "opt.sample_sampler_dpmsolver++"},
    ]},
    {"key": "sample_every_n_epochs", "type": "number", "default": 2, "section": "preview", "desc_key": "field.sample_every_n_epochs", "target": "toml", "min": 1, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_cfg", "type": "number", "default": 7, "section": "preview", "desc_key": "field.sample_cfg", "target": "toml", "min": 1, "max": 30, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_width", "type": "number", "default": 512, "section": "preview", "desc_key": "field.sample_width", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_height", "type": "number", "default": 512, "section": "preview", "desc_key": "field.sample_height", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_seed", "type": "number", "default": 2333, "section": "preview", "desc_key": "field.sample_seed", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_steps", "type": "number", "default": 24, "section": "preview", "desc_key": "field.sample_steps", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},

    # ── 速度优化 ──────────────────────────────────────────
    {"key": "mixed_precision", "type": "select", "default": "bf16", "section": "speed", "desc_key": "field.mixed_precision", "target": "toml", "options": [
        {"v": "bf16", "l": "bf16", "dk": "opt.mixed_precision_bf16"},
        {"v": "fp16", "l": "fp16", "dk": "opt.mixed_precision_fp16"},
        {"v": "no", "l": "no", "dk": "opt.mixed_precision_no"},
    ]},
    {"key": "xformers", "type": "toggle", "default": True, "section": "speed", "desc_key": "field.xformers", "target": "toml"},
    {"key": "sdpa", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.sdpa", "target": "toml"},
    {"key": "cache_latents", "type": "toggle", "default": True, "section": "speed", "desc_key": "field.cache_latents", "target": "toml"},
    {"key": "cache_latents_to_disk", "type": "toggle", "default": True, "section": "speed", "desc_key": "field.cache_latents_to_disk", "target": "toml"},
    {"key": "cache_text_encoder_outputs", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.cache_text_encoder_outputs", "target": "toml"},
    {"key": "cache_text_encoder_outputs_to_disk", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.cache_text_encoder_outputs_to_disk", "target": "toml"},
    {"key": "no_half_vae", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.no_half_vae", "target": "toml"},
    {"key": "lowram", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.lowram", "target": "toml"},
    {"key": "full_fp16", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.full_fp16", "target": "toml"},
    {"key": "full_bf16", "type": "toggle", "default": False, "section": "speed", "desc_key": "field.full_bf16", "target": "toml"},
    {"key": "persistent_data_loader_workers", "type": "toggle", "default": True, "section": "speed", "desc_key": "field.persistent_data_loader_workers", "target": "toml"},
    {"key": "vae_batch_size", "type": "number", "default": None, "section": "speed", "desc_key": "field.vae_batch_size", "target": "toml", "min": 1},

    # ── 其他 ──────────────────────────────────────────────
    {"key": "seed", "type": "number", "default": 1337, "section": "other", "desc_key": "field.seed", "target": "toml"},
    {"key": "clip_skip", "type": "stepper", "default": 2, "section": "other", "desc_key": "field.clip_skip", "target": "toml", "min": 0, "max": 12, "step": 1},
    {"key": "ui_custom_params", "type": "textarea", "default": "", "section": "other", "desc_key": "field.ui_custom_params", "target": "ui"},
    {"key": "gpu_ids", "type": "text", "default": "", "section": "other", "desc_key": "field.gpu_ids", "target": "ui"},
    {"key": "logging_dir", "type": "text", "default": "./logs", "section": "other", "desc_key": "field.logging_dir", "target": "toml", "hidden": True},
    {"key": "log_with", "type": "text", "default": "tensorboard", "section": "other", "desc_key": "field.log_with", "target": "toml", "hidden": True},

    # ── Anima 专有 ────────────────────────────────────────
    {"key": "qwen3", "type": "text", "default": "", "section": "animaParams", "desc_key": "field.qwen3", "target": "toml", "role": "file-model", "group": "anima"},
    {"key": "timestep_sampling", "type": "select", "default": "sigmoid", "section": "animaParams", "desc_key": "field.timestep_sampling", "target": "toml", "group": "anima", "options": [
        {"v": "sigma", "l": "sigma", "dk": "opt.timestep_sampling_sigma"},
        {"v": "uniform", "l": "uniform", "dk": "opt.timestep_sampling_uniform"},
        {"v": "sigmoid", "l": "sigmoid", "dk": "opt.timestep_sampling_sigmoid"},
        {"v": "shift", "l": "shift", "dk": "opt.timestep_sampling_shift"},
    ]},
    {"key": "sigmoid_scale", "type": "number", "default": 1.0, "section": "animaParams", "desc_key": "field.sigmoid_scale", "target": "toml", "step": 0.001, "group": "anima"},
    {"key": "weighting_scheme", "type": "select", "default": "uniform", "section": "animaParams", "desc_key": "field.weighting_scheme", "target": "toml", "group": "anima", "options": [
        {"v": "sigma_sqrt", "l": "sigma_sqrt", "dk": "opt.weighting_scheme_sigma_sqrt"},
        {"v": "logit_normal", "l": "logit_normal", "dk": "opt.weighting_scheme_logit_normal"},
        {"v": "mode", "l": "mode", "dk": "opt.weighting_scheme_mode"},
        {"v": "cosmap", "l": "cosmap", "dk": "opt.weighting_scheme_cosmap"},
        {"v": "none", "l": "none", "dk": "opt.weighting_scheme_none"},
        {"v": "uniform", "l": "uniform", "dk": "opt.weighting_scheme_uniform"},
    ]},
    {"key": "logit_mean", "type": "number", "default": 0.0, "section": "animaParams", "desc_key": "field.logit_mean", "target": "toml", "step": 0.01, "group": "anima"},
    {"key": "logit_std", "type": "number", "default": 1.0, "section": "animaParams", "desc_key": "field.logit_std", "target": "toml", "step": 0.01, "group": "anima"},
    {"key": "qwen3_max_token_length", "type": "number", "default": 512, "section": "animaParams", "desc_key": "field.qwen3_max_token_length", "target": "toml", "step": 1, "group": "anima"},
    {"key": "t5_max_token_length", "type": "number", "default": 512, "section": "animaParams", "desc_key": "field.t5_max_token_length", "target": "toml", "step": 1, "group": "anima"},
    {"key": "attn_mode", "type": "select", "default": "torch", "section": "animaParams", "desc_key": "field.attn_mode", "target": "toml", "group": "anima", "options": [
        {"v": "torch", "l": "torch", "dk": "opt.attn_mode_torch"},
        {"v": "xformers", "l": "xformers", "dk": "opt.attn_mode_xformers"},
        {"v": "flash", "l": "flash", "dk": "opt.attn_mode_flash"},
    ]},
    {"key": "split_attn", "type": "toggle", "default": False, "section": "animaParams", "desc_key": "field.split_attn", "target": "toml", "group": "anima"},
    {"key": "torch_compile", "type": "toggle", "default": False, "section": "animaParams", "desc_key": "field.torch_compile", "target": "toml", "group": "anima"},
]


# ═══════════════════════════════════════════════════════════════
# 派生集合（供 adapter.py 使用）
# ═══════════════════════════════════════════════════════════════

def get_supported_fields() -> set[str]:
    """返回需要传入 sd-scripts 的字段名集合"""
    return {f["key"] for f in FIELDS if f["target"] in ("toml", "merged")}


def get_ui_only_fields() -> set[str]:
    """返回仅 UI 使用、不传入 sd-scripts 的字段名集合"""
    return {f["key"] for f in FIELDS if f["target"] == "ui"}


def get_fields_json() -> dict:
    """返回前端可用的字段定义 JSON"""
    sections: dict[str, list[dict]] = {}
    section_meta = {
        "model": {"title_key": "section.model"},
        "dataset": {"title_key": "section.dataset"},
        "save": {"title_key": "section.save"},
        "trainParams": {"title_key": "section.trainParams"},
        "lrOptimizer": {"title_key": "section.lrOptimizer"},
        "network": {"title_key": "section.network"},
        "caption": {"title_key": "section.caption"},
        "preview": {"title_key": "section.preview"},
        "speed": {"title_key": "section.speed"},
        "other": {"title_key": "section.other"},
        "animaParams": {"title_key": "section.animaParams"},
    }

    for f in FIELDS:
        section_name = f["section"]
        if section_name not in sections:
            sections[section_name] = {
                "key": section_name,
                "titleKey": section_meta.get(section_name, {}).get("title_key", f"section.{section_name}"),
                "fields": [],
            }
        # 只传前端需要的字段
        field_json = {k: v for k, v in f.items() if k != "target"}
        sections[section_name]["fields"].append(field_json)

    result = {
        "sections_common": [s for k, s in sections.items() if k != "animaParams"],
        "sections_anima": [sections["animaParams"]] if "animaParams" in sections else [],
    }
    return result
