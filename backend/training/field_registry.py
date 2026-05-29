"""
训练字段注册表 — Single Source of Truth

统一管理所有训练参数的元数据：类型、默认值、所属分类、i18n key、
是否传递给 sd-scripts、条件显示规则、训练类型适用性、自动填值规则等。
前后端共享此定义。

添加新字段只需在此文件中新增一条记录，无需修改 adapter.py 或 config.js。
"""
from __future__ import annotations

from typing import Any


# ═══════════════════════════════════════════════════════════════
# 字段定义
# ═══════════════════════════════════════════════════════════════
#
# 每个字段的元数据：
#   key        — 字段名（对应 sd-scripts 参数名）
#   type       — 输入类型: text, number, toggle, select, textarea, stepper
#   default    — 默认值
#   section    — 所属分组: model, network, training, optimizer, regularization,
#                performance, save, caption, preview
#   desc_key   — i18n 描述键
#   target     — "toml"（传入 sd-scripts）, "ui"（仅 UI）, "merged"（UI 输入合并后传入）
#   role       — 文件选择器类型（可选）: file-model, file-folder, file-model-saved
#   options    — select 选项列表（可选）
#   show_if    — 条件显示（可选）: {"key": "...", "eq": ...} 或 {"key": "...", "neq": ...}
#                可带 "_or" 键表示多值匹配任一
#   hint_key   — 提示文本 i18n 键（可选）
#   step       — number 步长（可选）
#   min        — 最小值（可选）
#   max        — 最大值（可选）
#   hidden     — 是否隐藏（可选）
#   group      — 所属训练类型: "all" / "sd" / "sdxl" / "anima" / "diT", 列表表示多选
#                None 或 "all" 表示所有类型通用。前端根据 model_train_type 过滤显示。
#   auto_value — 自动填值规则（可选）: [{"watch": "key", "when": "val", "set": new_val}, ...]
#                set 为 null 表示恢复默认值。
#   advanced   — 是否为进阶参数（可选，默认 false）。

FIELDS: list[dict[str, Any]] = [
# ── Model ──
{"key": "model_train_type", "type": "select", "default": "sd-lora", "section": "model", "desc_key": "field.model_train_type", "target": "ui", "hidden": True, "options": [{"v": "sd-lora", "l": "SD LoRA", "dk": "opt.model_train_type_sd-lora"}, {"v": "sdxl-lora", "l": "SDXL LoRA", "dk": "opt.model_train_type_sdxl-lora"}, {"v": "anima-lora", "l": "Anima LoRA", "dk": "opt.model_train_type_anima-lora"}]},
{"key": "pretrained_model_name_or_path", "type": "text", "default": "./sd-models/model.safetensors", "section": "model", "desc_key": "field.pretrained_model_name_or_path", "target": "toml", "role": "file-model"},
{"key": "vae", "type": "text", "default": "", "section": "model", "desc_key": "field.vae", "target": "toml", "role": "file-model"},
{"key": "qwen3", "type": "text", "default": "", "section": "model", "desc_key": "field.qwen3", "target": "toml", "role": "file-model", "group": "anima"},
{"key": "train_data_dir", "type": "text", "default": "./train/aki", "section": "model", "desc_key": "field.train_data_dir", "target": "toml", "role": "file-folder"},
{"key": "resume", "type": "text", "default": "", "section": "model", "desc_key": "field.resume", "target": "toml", "role": "file-folder"},
{"key": "resolution", "type": "text", "default": "1024,1024", "section": "model", "desc_key": "field.resolution", "target": "toml", "hint_key": "field.resolutionHint"},
{"key": "enable_bucket", "type": "toggle", "default": True, "section": "model", "desc_key": "field.enable_bucket", "target": "toml"},
{"key": "bucket_no_upscale", "type": "toggle", "default": True, "section": "model", "desc_key": "field.bucket_no_upscale", "target": "toml", "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "min_bucket_reso", "type": "number", "default": 256, "section": "model", "desc_key": "field.min_bucket_reso", "target": "toml", "min": 64, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "max_bucket_reso", "type": "number", "default": 2048, "section": "model", "desc_key": "field.max_bucket_reso", "target": "toml", "min": 256, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "bucket_reso_steps", "type": "number", "default": 64, "section": "model", "desc_key": "field.bucket_reso_steps", "target": "toml", "min": 16, "step": 16, "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "v_parameterization", "type": "toggle", "default": False, "section": "model", "desc_key": "field.v_parameterization", "target": "toml", "group": ["sd", "sdxl"]},
{"key": "clip_skip", "type": "stepper", "default": 2, "section": "model", "desc_key": "field.clip_skip", "target": "toml", "min": 0, "max": 12, "step": 1, "group": ["sd", "sdxl"]},
# ── Network ──
{"key": "network_module", "type": "select", "default": "networks.lora", "section": "network", "desc_key": "field.network_module", "target": "toml", "options": [{"v": "networks.lora", "l": "networks.lora", "dk": "opt.network_module_networks_lora"}, {"v": "networks.loha", "l": "networks.loha", "dk": "opt.network_module_networks_loha"}, {"v": "networks.lokr", "l": "networks.lokr", "dk": "opt.network_module_networks_lokr"}, {"v": "networks.lora_anima", "l": "networks.lora_anima", "dk": "opt.network_module_networks_lora_anima", "group": "anima"}, {"v": "lycoris.kohya", "l": "lycoris.kohya", "dk": "opt.network_module_lycoris_kohya"}]},
{"key": "network_dim", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_dim", "target": "toml", "min": 1, "max": 256, "step": 8},
{"key": "network_alpha", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_alpha", "target": "toml", "min": 1},
{"key": "network_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.network_weights", "target": "toml", "role": "file-model-saved"},
{"key": "network_dropout", "type": "number", "default": 0, "section": "network", "desc_key": "field.network_dropout", "target": "toml", "min": 0, "max": 0.5, "step": 0.01},
{"key": "scale_weight_norms", "type": "number", "section": "network", "desc_key": "field.scale_weight_norms", "target": "toml", "min": 0, "step": 0.01},
{"key": "network_train_unet_only", "type": "toggle", "default": True, "section": "network", "desc_key": "field.network_train_unet_only", "target": "toml"},
{"key": "network_train_text_encoder_only", "type": "toggle", "default": False, "section": "network", "desc_key": "field.network_train_text_encoder_only", "target": "toml"},
{"key": "network_args_custom", "type": "textarea", "default": "", "section": "network", "desc_key": "field.network_args_custom", "target": "ui", "hint_key": "field.network_args_customHint"},
    # lycoris.kohya 算法选择器
    {"key": "lycoris_algo", "type": "select", "default": "lora", "section": "network", "desc_key": "field.lycoris_algo", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "options": [{"v": "lora", "l": "LoCon", "dk": "opt.lycoris_algo_locon"}, {"v": "loha", "l": "LoHa", "dk": "opt.lycoris_algo_loha"}, {"v": "lokr", "l": "LoKr", "dk": "opt.lycoris_algo_lokr"}, {"v": "dylora", "l": "DyLoRA", "dk": "opt.lycoris_algo_dylora"}, {"v": "glora", "l": "GLoRA", "dk": "opt.lycoris_algo_glora"}, {"v": "diag-oft", "l": "Diag-OFT", "dk": "opt.lycoris_algo_diagoft"}, {"v": "boft", "l": "Butterfly OFT", "dk": "opt.lycoris_algo_boft"}, {"v": "ia3", "l": "IA³", "dk": "opt.lycoris_algo_ia3"}]},
    # LyCORIS (show_if network_module=networks.loha or networks.lokr or lycoris.kohya)
    {"key": "conv_dim", "type": "number", "section": "network", "desc_key": "field.conv_dim", "target": "ui", "min": 0, "show_if": {"key": "network_module", "eq": "networks.loha", "_or": ["networks.lokr", "lycoris.kohya"]}},
    {"key": "conv_alpha", "type": "number", "section": "network", "desc_key": "field.conv_alpha", "target": "ui", "min": 0, "show_if": {"key": "network_module", "eq": "networks.loha", "_or": ["networks.lokr", "lycoris.kohya"]}},
    {"key": "lokr_factor", "type": "number", "section": "network", "desc_key": "field.lokr_factor", "target": "ui", "min": 1, "step": 1, "show_if": {"key": "network_module", "eq": "networks.loha", "_or": ["networks.lokr", "lycoris.kohya"]}, "hint_key": "field.lokr_factorHint"},
    {"key": "use_cp", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_cp", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "use_scalar", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_scalar", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "decompose_both", "type": "toggle", "default": False, "section": "network", "desc_key": "field.decompose_both", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "full_matrix", "type": "toggle", "default": False, "section": "network", "desc_key": "field.full_matrix", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "train_norm", "type": "toggle", "default": False, "section": "network", "desc_key": "field.train_norm", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "rank_dropout", "type": "number", "section": "network", "desc_key": "field.rank_dropout", "target": "ui", "min": 0, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.loha", "_or": ["networks.lokr", "lycoris.kohya"]}},
    {"key": "module_dropout", "type": "number", "section": "network", "desc_key": "field.module_dropout", "target": "ui", "min": 0, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.loha", "_or": ["networks.lokr", "lycoris.kohya"]}},
    {"key": "dropout", "type": "number", "section": "network", "desc_key": "field.lycoris_dropout", "target": "ui", "min": 0, "max": 0.5, "step": 0.01, "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.lycoris_dropoutHint"},
    # lycoris.kohya 专有参数
    {"key": "dora_wd", "type": "toggle", "default": False, "section": "network", "desc_key": "field.dora_wd", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.dora_wdHint"},
    {"key": "block_size", "type": "number", "default": 4, "section": "network", "desc_key": "field.block_size", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "constraint", "type": "number", "default": 0, "step": 0.1, "section": "network", "desc_key": "field.constraint", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.constraintHint"},
    {"key": "rescaled", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rescaled", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "bypass_mode", "type": "toggle", "default": False, "section": "network", "desc_key": "field.bypass_mode", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}},
    {"key": "rs_lora", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rs_lora", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.rs_loraHint"},
# ── Training Core ──
{"key": "max_train_epochs", "type": "number", "default": 10, "section": "training", "desc_key": "field.max_train_epochs", "target": "toml", "min": 1},
{"key": "max_train_steps", "type": "number", "section": "training", "desc_key": "field.max_train_steps", "target": "toml", "min": 1},
{"key": "train_batch_size", "type": "number", "default": 1, "section": "training", "desc_key": "field.train_batch_size", "target": "toml", "min": 1},
{"key": "gradient_accumulation_steps", "type": "number", "default": 1, "section": "training", "desc_key": "field.gradient_accumulation_steps", "target": "toml", "min": 1},
{"key": "seed", "type": "number", "default": 1337, "section": "training", "desc_key": "field.seed", "target": "toml"},
{"key": "mixed_precision", "type": "select", "default": "bf16", "section": "training", "desc_key": "field.mixed_precision", "target": "toml", "options": [{"v": "bf16", "l": "bf16", "dk": "opt.mixed_precision_bf16"}, {"v": "fp16", "l": "fp16", "dk": "opt.mixed_precision_fp16"}, {"v": "no", "l": "no", "dk": "opt.mixed_precision_no"}]},
    # Anima: Timestep & Weighting (training core for DiT)
    {"key": "timestep_sampling", "type": "select", "default": "sigmoid", "section": "training", "desc_key": "field.timestep_sampling", "target": "toml", "group": "anima", "options": [{"v": "sigmoid", "l": "sigmoid", "dk": "opt.timestep_sampling_sigmoid"}, {"v": "sigma", "l": "sigma", "dk": "opt.timestep_sampling_sigma"}, {"v": "uniform", "l": "uniform", "dk": "opt.timestep_sampling_uniform"}, {"v": "shift", "l": "shift", "dk": "opt.timestep_sampling_shift"}]},
    {"key": "sigmoid_scale", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.sigmoid_scale", "target": "toml", "step": 0.001, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "sigmoid", "_or": ["shift"]}},
    {"key": "discrete_flow_shift", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.discrete_flow_shift", "target": "toml", "step": 0.01, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "shift"}},
    {"key": "weighting_scheme", "type": "select", "default": "uniform", "section": "training", "desc_key": "field.weighting_scheme", "target": "toml", "group": "anima", "options": [{"v": "uniform", "l": "uniform", "dk": "opt.weighting_scheme_uniform"}, {"v": "sigma_sqrt", "l": "sigma_sqrt", "dk": "opt.weighting_scheme_sigma_sqrt"}, {"v": "logit_normal", "l": "logit_normal", "dk": "opt.weighting_scheme_logit_normal"}, {"v": "mode", "l": "mode", "dk": "opt.weighting_scheme_mode"}, {"v": "cosmap", "l": "cosmap", "dk": "opt.weighting_scheme_cosmap"}, {"v": "none", "l": "none", "dk": "opt.weighting_scheme_none"}]},
    {"key": "logit_mean", "type": "number", "default": 0.0, "section": "training", "desc_key": "field.logit_mean", "target": "toml", "step": 0.01, "group": "anima", "show_if": {"key": "weighting_scheme", "eq": "logit_normal"}},
    {"key": "logit_std", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.logit_std", "target": "toml", "step": 0.01, "group": "anima", "show_if": {"key": "weighting_scheme", "eq": "logit_normal"}},
    {"key": "mode_scale", "type": "number", "default": 1.29, "section": "training", "desc_key": "field.mode_scale", "target": "toml", "step": 0.01, "group": "anima", "show_if": {"key": "weighting_scheme", "eq": "mode"}},
    # Anima: 时间步范围控制（advanced）
    {"key": "min_timestep", "type": "number", "section": "training", "desc_key": "field.min_timestep", "target": "toml", "min": 0, "max": 999, "step": 1, "group": "anima", "advanced": True, "hint_key": "field.min_timestepHint"},
    {"key": "max_timestep", "type": "number", "section": "training", "desc_key": "field.max_timestep", "target": "toml", "min": 1, "max": 1000, "step": 1, "group": "anima", "advanced": True, "hint_key": "field.max_timestepHint"},
# ── Optimizer & Learning Rate ──
{"key": "optimizer_type", "type": "select", "default": "AdamW8bit", "section": "optimizer", "desc_key": "field.optimizer_type", "target": "toml", "groups": [{"label_key": "opt.optimizer_group_adamw", "options": [{"v": "AdamW", "l": "AdamW", "dk": "opt.optimizer_type_AdamW"}, {"v": "AdamW8bit", "l": "AdamW8bit", "dk": "opt.optimizer_type_AdamW8bit"}, {"v": "PagedAdamW8bit", "l": "PagedAdamW8bit", "dk": "opt.optimizer_type_PagedAdamW8bit"}]}, {"label_key": "opt.optimizer_group_lion", "options": [{"v": "Lion", "l": "Lion", "dk": "opt.optimizer_type_Lion"}, {"v": "Lion8bit", "l": "Lion8bit", "dk": "opt.optimizer_type_Lion8bit"}, {"v": "PagedLion8bit", "l": "PagedLion8bit", "dk": "opt.optimizer_type_PagedLion8bit"}]}, {"label_key": "opt.optimizer_group_prodigy", "options": [{"v": "Prodigy", "l": "Prodigy", "dk": "opt.optimizer_type_Prodigy"}, {"v": "prodigyplus.ProdigyPlusScheduleFree", "l": "ProdigyPlusScheduleFree", "dk": "opt.optimizer_type_ProdigyPlus"}]}, {"label_key": "opt.optimizer_group_other", "options": [{"v": "AdaFactor", "l": "AdaFactor", "dk": "opt.optimizer_type_AdaFactor"}, {"v": "pytorch_optimizer.CAME", "l": "CAME", "dk": "opt.optimizer_type_CAME"}, {"v": "AdamWScheduleFree", "l": "AdamWScheduleFree", "dk": "opt.optimizer_type_AdamWScheduleFree"}]}, {"label_key": "opt.optimizer_group_emo", "options": [{"v": "vendor.emo_optimizer.emosens.EmoSens", "l": "EmoSens", "dk": "opt.optimizer_type_EmoSens"}]}]},
{"key": "learning_rate", "type": "text", "default": "1e-4", "section": "optimizer", "desc_key": "field.learning_rate", "target": "toml", "auto_value": [{"watch": "optimizer_type", "when": "Prodigy", "set": "1.0"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "1.0"}, {"watch": {"optimizer_type": "vendor.emo_optimizer.emosens.EmoSens", "model_train_type": "anima-lora"}, "set": "0.1"}, {"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.learning_rate_prodigyLocked"}},
{"key": "unet_lr", "type": "text", "default": "1e-4", "section": "optimizer", "desc_key": "field.unet_lr", "target": "toml"},
{"key": "text_encoder_lr", "type": "text", "default": "1e-5", "section": "optimizer", "desc_key": "field.text_encoder_lr", "target": "toml"},
    # Anima: 逐层学习率控制（advanced）
    {"key": "self_attn_lr", "type": "text", "section": "optimizer", "desc_key": "field.self_attn_lr", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.self_attn_lrHint"},
    {"key": "cross_attn_lr", "type": "text", "section": "optimizer", "desc_key": "field.cross_attn_lr", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.cross_attn_lrHint"},
    {"key": "mlp_lr", "type": "text", "section": "optimizer", "desc_key": "field.mlp_lr", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.mlp_lrHint"},
    {"key": "mod_lr", "type": "text", "section": "optimizer", "desc_key": "field.mod_lr", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.mod_lrHint"},
    {"key": "llm_adapter_lr", "type": "text", "section": "optimizer", "desc_key": "field.llm_adapter_lr", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.llm_adapter_lrHint"},
{"key": "lr_scheduler", "type": "select", "default": "cosine_with_restarts", "section": "optimizer", "desc_key": "field.lr_scheduler", "target": "toml", "options": [{"v": "cosine_with_restarts", "l": "cosine_with_restarts", "dk": "opt.lr_scheduler_cosine_with_restarts"}, {"v": "cosine", "l": "cosine", "dk": "opt.lr_scheduler_cosine"}, {"v": "linear", "l": "linear", "dk": "opt.lr_scheduler_linear"}, {"v": "polynomial", "l": "polynomial", "dk": "opt.lr_scheduler_polynomial"}, {"v": "constant", "l": "constant", "dk": "opt.lr_scheduler_constant"}, {"v": "constant_with_warmup", "l": "constant_with_warmup", "dk": "opt.lr_scheduler_constant_with_warmup"}], "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": "constant"}, {"watch": "optimizer_type", "when": "AdamWScheduleFree", "set": "constant"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "constant"}], "readonly_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens", "_or": ["AdamWScheduleFree", "prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.lr_scheduler_locked"}},
{"key": "lr_warmup_steps", "type": "number", "default": 0, "section": "optimizer", "desc_key": "field.lr_warmup_steps", "target": "toml", "min": 0, "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0}], "readonly_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens", "reason_key": "field.lr_warmup_steps_emoLocked"}},
{"key": "lr_scheduler_num_cycles", "type": "number", "default": 1, "section": "optimizer", "desc_key": "field.lr_scheduler_num_cycles", "target": "toml", "min": 1, "show_if": {"key": "lr_scheduler", "eq": "cosine_with_restarts"}},
{"key": "lr_scheduler_power", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.lr_scheduler_power", "target": "toml", "min": 0.1, "step": 0.1, "show_if": {"key": "lr_scheduler", "eq": "polynomial"}},
{"key": "max_grad_norm", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.max_grad_norm", "target": "toml", "step": 0.1, "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0}]},
{"key": "weight_decay", "type": "number", "section": "optimizer", "desc_key": "field.weight_decay", "target": "merged", "step": 0.001, "hint_key": "field.weight_decayHint", "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0.01}]},
    # EmoSens 专用：收敛灵敏度（stopcoef）
    {"key": "stopcoef", "type": "number", "default": 0.04, "section": "optimizer", "desc_key": "field.stopcoef", "target": "merged", "min": 0.001, "max": 1.0, "step": 0.001, "hint_key": "field.stopcoefHint", "show_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens"}},
{"key": "prodigy_d_coef", "type": "text", "default": "1.0", "section": "optimizer", "desc_key": "field.prodigy_d_coef", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"]}},
{"key": "prodigy_d0", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.prodigy_d0", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"]}},
# ── Optimizer Merged: betas / eps ──
{"key": "betas", "type": "text", "section": "optimizer", "desc_key": "field.betas", "target": "merged", "hint_key": "field.betasHint", "show_if": {"key": "optimizer_type", "eq": "AdamW", "_or": ["AdamW8bit", "PagedAdamW8bit", "Lion", "Lion8bit", "PagedLion8bit", "pytorch_optimizer.CAME", "vendor.emo_optimizer.emosens.EmoSens"]}},
{"key": "eps", "type": "text", "section": "optimizer", "desc_key": "field.eps", "target": "merged", "hint_key": "field.epsHint", "show_if": {"key": "optimizer_type", "eq": "AdamW", "_or": ["AdamW8bit", "PagedAdamW8bit", "pytorch_optimizer.CAME", "vendor.emo_optimizer.emosens.EmoSens"]}},
# ── CAME 专用参数 ──
{"key": "came_weight_decouple", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.came_weight_decouple", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_fixed_decay", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_fixed_decay", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_clip_threshold", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.came_clip_threshold", "target": "merged", "step": 0.1, "min": 0.1, "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_ams_bound", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_ams_bound", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_eps1", "type": "text", "section": "optimizer", "desc_key": "field.came_eps1", "target": "merged", "hint_key": "field.came_eps1Hint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_eps2", "type": "text", "section": "optimizer", "desc_key": "field.came_eps2", "target": "merged", "hint_key": "field.came_eps2Hint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "optimizer_args_custom", "type": "textarea", "default": "", "section": "optimizer", "desc_key": "field.optimizer_args_custom", "target": "ui", "hint_key": "field.optimizer_args_customHint"},
# ── Regularization & Loss ──
{"key": "loss_type", "type": "select", "default": "l2", "section": "regularization", "desc_key": "field.loss_type", "target": "toml", "options": [{"v": "l2", "l": "L2", "dk": "opt.loss_type_l2"}, {"v": "l1", "l": "L1", "dk": "opt.loss_type_l1"}, {"v": "huber", "l": "Huber", "dk": "opt.loss_type_huber"}, {"v": "smooth_l1", "l": "Smooth L1", "dk": "opt.loss_type_smooth_l1"}]},
{"key": "huber_schedule", "type": "select", "default": "snr", "section": "regularization", "desc_key": "field.huber_schedule", "target": "toml", "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "options": [{"v": "snr", "l": "SNR", "dk": "opt.huber_schedule_snr"}, {"v": "constant", "l": "constant", "dk": "opt.huber_schedule_constant"}, {"v": "exponential", "l": "exponential", "dk": "opt.huber_schedule_exponential"}]},
{"key": "huber_c", "type": "number", "default": 0.1, "section": "regularization", "desc_key": "field.huber_c", "target": "toml", "step": 0.01, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}},
{"key": "huber_scale", "type": "number", "default": 1.0, "section": "regularization", "desc_key": "field.huber_scale", "target": "toml", "step": 0.1, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}},
{"key": "min_snr_gamma", "type": "number", "section": "regularization", "desc_key": "field.min_snr_gamma", "target": "toml", "step": 0.1},
{"key": "noise_offset", "type": "number", "section": "regularization", "desc_key": "field.noise_offset", "target": "toml", "step": 0.001},
{"key": "zero_terminal_snr", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.zero_terminal_snr", "target": "toml"},
{"key": "gradient_checkpointing", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.gradient_checkpointing", "target": "toml"},
# ── Performance & Cache ──
{"key": "xformers", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.xformers", "target": "toml", "group": ["sd", "sdxl"]},
{"key": "sdpa", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.sdpa", "target": "toml", "group": ["sd", "sdxl"]},
{"key": "attn_mode", "type": "select", "default": "torch", "section": "performance", "desc_key": "field.attn_mode", "target": "toml", "group": "anima", "options": [{"v": "torch", "l": "torch", "dk": "opt.attn_mode_torch"}, {"v": "xformers", "l": "xformers", "dk": "opt.attn_mode_xformers"}, {"v": "flash", "l": "flash", "dk": "opt.attn_mode_flash"}]},
{"key": "split_attn", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.split_attn", "target": "toml", "group": "anima"},
{"key": "cache_latents", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents", "target": "toml"},
{"key": "cache_latents_to_disk", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents_to_disk", "target": "toml"},
{"key": "cache_text_encoder_outputs", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cache_text_encoder_outputs", "target": "toml"},
{"key": "cache_text_encoder_outputs_to_disk", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cache_text_encoder_outputs_to_disk", "target": "toml"},
{"key": "no_half_vae", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.no_half_vae", "target": "toml", "group": ["sd", "sdxl"]},
{"key": "lowram", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.lowram", "target": "toml"},
    # Anima: VAE performance
    {"key": "vae_chunk_size", "type": "number", "section": "performance", "desc_key": "field.vae_chunk_size", "target": "toml", "min": 2, "step": 2, "group": "anima", "hint_key": "field.vae_chunk_sizeHint"},
    {"key": "vae_disable_cache", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.vae_disable_cache", "target": "toml", "group": "anima"},
    {"key": "blocks_to_swap", "type": "number", "section": "performance", "desc_key": "field.blocks_to_swap", "target": "toml", "min": 0, "max": 32, "step": 1, "group": "anima", "advanced": True, "hint_key": "field.blocks_to_swapHint"},
    # torch.compile（性能加速，需 PyTorch 2.0+）
    {"key": "torch_compile", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.torch_compile", "target": "toml", "hint_key": "field.torch_compileHint"},
    {"key": "dynamo_backend", "type": "select", "default": "inductor", "section": "performance", "desc_key": "field.dynamo_backend", "target": "toml", "show_if": {"key": "torch_compile", "eq": True}, "hint_key": "field.dynamo_backendHint", "options": [{"v": "inductor", "l": "inductor", "dk": "opt.dynamo_backend_inductor"}, {"v": "eager", "l": "eager", "dk": "opt.dynamo_backend_eager"}, {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.dynamo_backend_cudagraphs"}]},
# ── Save ──
{"key": "output_name", "type": "text", "default": "my_lora", "section": "save", "desc_key": "field.output_name", "target": "toml"},
{"key": "output_dir", "type": "text", "default": "./output", "section": "save", "desc_key": "field.output_dir", "target": "toml", "role": "file-folder"},
{"key": "save_model_as", "type": "select", "default": "safetensors", "section": "save", "desc_key": "field.save_model_as", "target": "toml", "options": [{"v": "safetensors", "l": "safetensors", "dk": "opt.save_model_as_safetensors"}, {"v": "pt", "l": "pt", "dk": "opt.save_model_as_pt"}, {"v": "diffusers_safetensors", "l": "diffusers_safetensors", "dk": "opt.save_model_as_diffusers_safetensors"}]},
{"key": "save_precision", "type": "select", "default": "fp16", "section": "save", "desc_key": "field.save_precision", "target": "toml", "options": [{"v": "fp16", "l": "fp16", "dk": "opt.save_precision_fp16"}, {"v": "bf16", "l": "bf16", "dk": "opt.save_precision_bf16"}, {"v": "float", "l": "float", "dk": "opt.save_precision_float"}]},
{"key": "save_every_n_epochs", "type": "number", "default": 2, "section": "save", "desc_key": "field.save_every_n_epochs", "target": "toml", "min": 1},
{"key": "save_every_n_steps", "type": "number", "section": "save", "desc_key": "field.save_every_n_steps", "target": "toml", "min": 1, "hint_key": "field.save_every_n_stepsHint"},
{"key": "save_state", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state", "target": "toml"},
{"key": "save_last_n_epochs_state", "type": "number", "section": "save", "desc_key": "field.save_last_n_epochs_state", "target": "toml", "min": 1, "show_if": {"key": "save_state", "eq": True}},
{"key": "logging_dir", "type": "text", "default": "./logs", "section": "save", "desc_key": "field.logging_dir", "target": "toml", "hidden": True},
{"key": "log_with", "type": "select", "default": "tensorboard", "section": "save", "desc_key": "field.log_with", "target": "toml", "hidden": True, "options": [{"v": "tensorboard", "l": "TensorBoard", "dk": "opt.log_with_tensorboard"}, {"v": "wandb", "l": "Weights & Biases", "dk": "opt.log_with_wandb"}, {"v": "all", "l": "TensorBoard + WandB", "dk": "opt.log_with_all"}]},
# ── Caption ──
{"key": "caption_extension", "type": "text", "default": ".txt", "section": "caption", "desc_key": "field.caption_extension", "target": "toml"},
{"key": "max_token_length", "type": "select", "default": "75", "section": "caption", "desc_key": "field.max_token_length", "target": "toml", "options": [{"v": "75", "l": "75", "dk": "opt.max_token_length_75"}, {"v": "150", "l": "150", "dk": "opt.max_token_length_150"}, {"v": "225", "l": "225", "dk": "opt.max_token_length_225"}]},
{"key": "qwen3_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.qwen3_max_token_length", "target": "toml", "step": 1, "group": "anima"},
{"key": "t5_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.t5_max_token_length", "target": "toml", "step": 1, "group": "anima"},
{"key": "shuffle_caption", "type": "toggle", "default": True, "section": "caption", "desc_key": "field.shuffle_caption", "target": "toml"},
{"key": "keep_tokens", "type": "number", "default": 0, "section": "caption", "desc_key": "field.keep_tokens", "target": "toml", "min": 0},
{"key": "weighted_captions", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.weighted_captions", "target": "toml"},
{"key": "caption_dropout_rate", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_rate", "target": "toml", "min": 0, "step": 0.01},
{"key": "caption_dropout_every_n_epochs", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_every_n_epochs", "target": "toml", "min": 0},
{"key": "caption_tag_dropout_rate", "type": "number", "section": "caption", "desc_key": "field.caption_tag_dropout_rate", "target": "toml", "min": 0, "step": 0.01},
# ── Preview ──
{"key": "enable_preview", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.enable_preview", "target": "ui"},
{"key": "positive_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.sample_prompts", "target": "ui", "hint_key": "field.sample_promptsHint", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "negative_prompts", "type": "text", "default": "", "section": "preview", "desc_key": "field.negative_prompts", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_sampler", "type": "select", "default": "euler_a", "section": "preview", "desc_key": "field.sample_sampler", "target": "toml", "show_if": {"key": "enable_preview", "eq": True}, "options": [{"v": "euler_a", "l": "euler_a", "dk": "opt.sample_sampler_euler_a"}, {"v": "euler", "l": "euler", "dk": "opt.sample_sampler_euler"}, {"v": "ddim", "l": "ddim", "dk": "opt.sample_sampler_ddim"}, {"v": "dpmsolver++", "l": "dpmsolver++", "dk": "opt.sample_sampler_dpmsolver_plus"}, {"v": "heun", "l": "heun", "dk": "opt.sample_sampler_heun"}]},
{"key": "sample_every_n_epochs", "type": "number", "default": 2, "section": "preview", "desc_key": "field.sample_every_n_epochs", "target": "toml", "min": 1, "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_cfg", "type": "number", "default": 7, "section": "preview", "desc_key": "field.sample_cfg", "target": "ui", "min": 1, "max": 30, "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_width", "type": "number", "default": 512, "section": "preview", "desc_key": "field.sample_width", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_height", "type": "number", "default": 512, "section": "preview", "desc_key": "field.sample_height", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_seed", "type": "number", "default": 2333, "section": "preview", "desc_key": "field.sample_seed", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "sample_steps", "type": "number", "default": 24, "section": "preview", "desc_key": "field.sample_steps", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
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


# snake_case → camelCase key mapping for frontend
_FIELD_KEY_MAP = {
    "desc_key": "descKey",
    "hint_key": "hintKey",
    "show_if": "showIf",
    "label_key": "labelKey",
    "dk": "dKey",
    "auto_value": "autoValue",
    "readonly_if": "readonlyIf",
    "reason_key": "reasonKey",
}


def _to_camel(field: dict) -> dict:
    """Convert field dict keys from snake_case to camelCase for frontend consumption."""
    result = {}
    for k, v in field.items():
        if k == "target":
            continue  # 仅后端需要
        if k == "_or":
            continue  # internal to show_if, handled during show_if conversion
        new_key = _FIELD_KEY_MAP.get(k, k)
        # 递归处理嵌套的 option groups
        if k == "groups" and isinstance(v, list):
            result[new_key] = [
                {
                    "labelKey": g.get("label_key", g.get("label", "")),
                    "options": [_to_camel(o) for o in (g.get("options") or [])],
                }
                for g in v
            ]
        elif k == "options" and isinstance(v, list):
            result[new_key] = [_to_camel(o) for o in v]
        elif k == "show_if" and isinstance(v, dict):
            # Convert show_if; keep _or as "or" in camelCase
            converted = {}
            for sk, sv in v.items():
                if sk == "_or":
                    converted["or"] = sv
                elif sk == "neq":
                    converted["neq"] = sv
                else:
                    converted[sk] = sv
            result[new_key] = converted
        elif k == "readonly_if" and isinstance(v, dict):
            # Convert readonly_if similarly to show_if
            converted = {}
            for rk, rv in v.items():
                if rk == "_or":
                    converted["or"] = rv
                elif rk == "reason_key":
                    converted["reasonKey"] = rv
                else:
                    converted[rk] = rv
            result[new_key] = converted
        elif k == "auto_value" and isinstance(v, list):
            result[new_key] = v
        else:
            result[new_key] = v
    return result


def get_fields_json() -> dict:
    """返回前端可用的字段定义 JSON"""
    sections: dict[str, list[dict]] = {}
    section_meta = {
        "model": {"title_key": "section.model"},
        "network": {"title_key": "section.network"},
        "training": {"title_key": "section.training"},
        "optimizer": {"title_key": "section.optimizer"},
        "regularization": {"title_key": "section.regularization"},
        "performance": {"title_key": "section.performance"},
        "save": {"title_key": "section.save"},
        "caption": {"title_key": "section.caption"},
        "preview": {"title_key": "section.preview"},
    }

    for f in FIELDS:
        section_name = f["section"]
        if section_name not in sections:
            sections[section_name] = {
                "key": section_name,
                "titleKey": section_meta.get(section_name, {}).get("title_key", f"section.{section_name}"),
                "fields": [],
            }
        sections[section_name]["fields"].append(_to_camel(f))

    result = {
        "sections": list(sections.values()),
    }
    return result
