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
#                可带 "_or" 键表示多值匹配任一。
#                多条件 AND：传 list[dict]，所有条件同时成立才显示。
#   show_if_any — 条件显示（可选，OR-of-ANDs）: list[list[dict]]，外层 OR、内层 AND。
#                任一内层 AND 组全部成立即显示。用于"原生模块 OR (lycoris + 特定 algo)"
#                这类跨两个字段的复合条件。show_if 与 show_if_any 互斥。
#   hint_key   — 提示文本 i18n 键（可选）
#   step       — number 步长（可选）
#   min        — 最小值（可选）
#   max        — 最大值（可选）
#   hidden     — 是否隐藏（可选）
#   group      — 所属训练类型: "all" / "sdxl" / "anima" / "diT", 列表表示多选
#                None 或 "all" 表示所有类型通用。前端根据 model_train_type 过滤显示。
#   auto_value — 自动填值规则（可选）: [{"watch": "key", "when": "val", "set": new_val}, ...]
#                set 为 null 表示恢复默认值。
#   advanced   — 是否为进阶参数（可选，默认 false）。
#   omit_default — 默认值省略（可选，默认 false）。仅当 registry default == sd-scripts
#                  argparse default 时才可标记 True：前端在值==default 时不传给
#                  sd-scripts、不在 TOML 预览显示，输入框以淡色 placeholder 提示默认值。
#                  有意差异字段（learning_rate/mixed_precision/cache_* 等）禁止标记，
#                  否则不传会让 sd-scripts 用它自己的默认值，训练行为改变。

FIELDS: list[dict[str, Any]] = [
# ── Model ──
{"key": "model_train_type", "type": "select", "default": "sdxl-lora", "section": "model", "desc_key": "field.model_train_type", "target": "ui", "hidden": True, "options": [{"v": "sdxl-lora", "l": "SDXL LoRA", "dk": "opt.model_train_type_sdxl-lora"}, {"v": "anima-lora", "l": "Anima LoRA", "dk": "opt.model_train_type_anima-lora"}]},
# 三个底模路径默认指向环境管理页可下载的 Anima 核心文件（见 tools/download_anima_model.py）。
# 用户下载后即可直接开训，无需手动填写；路径与 ANIMA_FILES 的本地文件名保持一致。
{"key": "pretrained_model_name_or_path", "type": "text", "default": "./models/anima-base-v1.0.safetensors", "section": "model", "desc_key": "field.pretrained_model_name_or_path", "target": "toml", "role": "file-model", "required": True},
{"key": "vae", "type": "text", "default": "./models/qwen_image_vae.safetensors", "section": "model", "desc_key": "field.vae", "target": "toml", "role": "file-model", "hint_key": "field.vaeHint", "requiredGroups": ["anima"]},
{"key": "qwen3", "type": "text", "default": "./models/qwen_3_06b_base.safetensors", "section": "model", "desc_key": "field.qwen3", "target": "toml", "role": "file-model", "group": "anima", "hint_key": "field.qwen3Hint", "required": True},
{"key": "train_data_dir", "type": "text", "default": "./train", "section": "model", "desc_key": "field.train_data_dir", "target": "toml", "role": "file-folder", "required": True},
{"key": "resume", "type": "text", "default": "", "section": "model", "desc_key": "field.resume", "target": "toml", "role": "file-folder"},
{"key": "resolution", "type": "text", "default": "1024,1024", "section": "model", "desc_key": "field.resolution", "target": "toml", "hint_key": "field.resolutionHint", "required": True},
{"key": "enable_bucket", "type": "toggle", "default": True, "section": "model", "desc_key": "field.enable_bucket", "target": "toml"},
{"key": "bucket_no_upscale", "type": "toggle", "default": True, "section": "model", "desc_key": "field.bucket_no_upscale", "target": "toml", "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "min_bucket_reso", "type": "number", "default": 256, "section": "model", "desc_key": "field.min_bucket_reso", "target": "toml", "min": 64, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}, "omit_default": True},
{"key": "max_bucket_reso", "type": "number", "default": 2048, "section": "model", "desc_key": "field.max_bucket_reso", "target": "toml", "min": 256, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "bucket_reso_steps", "type": "number", "default": 64, "section": "model", "desc_key": "field.bucket_reso_steps", "target": "toml", "min": 16, "step": 16, "show_if": {"key": "enable_bucket", "eq": True}, "omit_default": True},
{"key": "v_parameterization", "type": "toggle", "default": False, "section": "model", "desc_key": "field.v_parameterization", "target": "toml", "group": "sdxl"},
# ── Network ──
# 通用基础参数在前（对所有 module 生效）；network_module 作为"算法开关"置于其后。
# show_if 子参数紧随触发源展开（A1 重排）。带 sub_group 的字段在渲染时形成子组（含子折叠）。
{"key": "network_train_unet_only", "type": "toggle", "default": True, "section": "network", "desc_key": "field.network_train_unet_only", "target": "toml"},
{"key": "network_train_text_encoder_only", "type": "toggle", "default": False, "section": "network", "desc_key": "field.network_train_text_encoder_only", "target": "toml", "omit_default": True},
{"key": "network_dim", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_dim", "target": "toml", "min": 1, "max": 256, "step": 1},
{"key": "network_alpha", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_alpha", "target": "toml", "min": 1},
{"key": "network_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.network_weights", "target": "toml", "role": "file-model-saved"},
{"key": "dim_from_weights", "type": "toggle", "default": False, "section": "network", "desc_key": "field.dim_from_weights", "target": "toml", "show_if": {"key": "network_weights", "neq": ""}, "hint_key": "field.dim_from_weightsHint"},
# network_dropout 是 train_network.py 顶层 CLI（:1930），对所有 module 自动经 neuron_dropout= 兜底传入
# create_network（train_network.py:1081-1093）。四个原生模块签名一致均消费 neuron_dropout
# （lora.py:423 / lora_anima.py:232 / loha.py:406 / lokr.py:400）。LyCORIS 与下方专用 dropout 同槽
# （train_network.py:1081 "dropout in net_kwargs" 检测：专用 dropout 在 network_args 中先占槽 → network_dropout 不再注入）。
# 故为顶层 Network 参数，不带 show_if（与 network_dim/network_alpha 同级），对所有模块可见。
{"key": "network_dropout", "type": "number", "default": 0, "section": "network", "desc_key": "field.network_dropout", "target": "toml", "min": 0, "max": 0.5, "step": 0.01, "hint_key": "field.network_dropoutHint"},
# ── 算法开关：network_module（选不同模块后，下列子参数紧随其后展开）──
{"key": "network_module", "type": "select", "default": "networks.lora", "section": "network", "desc_key": "field.network_module", "target": "toml", "options": [{"v": "networks.lora_anima", "l": "networks.lora_anima", "dk": "opt.network_module_networks_lora_anima", "group": "anima"}, {"v": "networks.lora", "l": "networks.lora", "dk": "opt.network_module_networks_lora", "group": "sdxl"}, {"v": "networks.loha", "l": "networks.loha", "dk": "opt.network_module_networks_loha"}, {"v": "networks.lokr", "l": "networks.lokr", "dk": "opt.network_module_networks_lokr"}, {"v": "lycoris.kohya", "l": "lycoris.kohya", "dk": "opt.network_module_lycoris_kohya"}]},
    # lycoris.kohya 算法选择器 + 预设：作为 network_module 的第 1、2 个子参数紧随其后展开。
    # 不带 sub_group → 渲染为常规 inline 子参数（不包在"LyCORIS 算法参数"子组盒子里）。
    {"key": "lycoris_algo", "type": "select", "default": "lora", "section": "network", "desc_key": "field.lycoris_algo", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "options": [{"v": "lora", "l": "LoCon", "dk": "opt.lycoris_algo_locon"}, {"v": "loha", "l": "LoHa", "dk": "opt.lycoris_algo_loha"}, {"v": "lokr", "l": "LoKr", "dk": "opt.lycoris_algo_lokr"}, {"v": "dylora", "l": "DyLoRA", "dk": "opt.lycoris_algo_dylora"}, {"v": "glora", "l": "GLoRA", "dk": "opt.lycoris_algo_glora"}, {"v": "diag-oft", "l": "Diag-OFT", "dk": "opt.lycoris_algo_diagoft"}, {"v": "boft", "l": "Butterfly OFT", "dk": "opt.lycoris_algo_boft"}, {"v": "ia3", "l": "IA³", "dk": "opt.lycoris_algo_ia3"}]},
    {"key": "lycoris_preset", "type": "select", "default": "full", "section": "network", "desc_key": "field.lycoris_preset", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "options": [{"v": "full", "l": "full", "dk": "opt.lycoris_preset_full"}, {"v": "full-lin", "l": "full-lin", "dk": "opt.lycoris_preset_full_lin"}, {"v": "attn-mlp", "l": "attn-mlp", "dk": "opt.lycoris_preset_attn_mlp"}, {"v": "attn-only", "l": "attn-only", "dk": "opt.lycoris_preset_attn_only"}, {"v": "unet-only", "l": "unet-only", "dk": "opt.lycoris_preset_unet_only"}, {"v": "unet-transformer-only", "l": "unet-transformer-only", "dk": "opt.lycoris_preset_unet_transformer"}, {"v": "unet-convblock-only", "l": "unet-convblock-only", "dk": "opt.lycoris_preset_unet_convblock"}, {"v": "ia3", "l": "ia3", "dk": "opt.lycoris_preset_ia3"}]},
    # conv_dim/conv_alpha（LoCon：给 3x3 Conv2d 单独设秩）支持面：
    #   networks.lora 完整支持（lora.py:435 读取 / 939-957 create_modules 对 3x3 Conv2d 启用 conv_lora_dim）；
    #   networks.loha / networks.lokr 同样读取；lycoris.kohya 通用（kohya.py:42-43）。
    #   networks.lora_anima 不支持（create_network 不读 conv_dim，create_modules Linear/Conv2d 共用 lora_dim）。
    {"key": "conv_dim", "type": "number", "section": "network", "desc_key": "field.conv_dim", "target": "ui", "min": 0, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.loha", "networks.lokr", "lycoris.kohya"]}, "hint_key": "field.conv_dimHint"},
    {"key": "conv_alpha", "type": "number", "section": "network", "desc_key": "field.conv_alpha", "target": "ui", "min": 0, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.loha", "networks.lokr", "lycoris.kohya"]}, "hint_key": "field.conv_alphaHint"},
    # lokr_factor → sd-scripts factor：仅 LoKr 算法消费（vendor lokr.py 读 kwargs["factor"]；
    # vendor loha.py 不读；lycoris 仅 LokrModule.__init__ 有 factor 参数）。
    # 故显示条件为 OR-of-ANDs：原生 networks.lokr，或 lycoris.kohya + algo=lokr。
    {"key": "lokr_factor", "type": "number", "default": -1, "section": "network", "desc_key": "field.lokr_factor", "target": "ui", "min": -1, "step": 1, "show_if_any": [[{"key": "network_module", "eq": "networks.lokr"}], [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}]], "hint_key": "field.lokr_factorHint", "omit_default": True},
    # rank_dropout/module_dropout：四个原生模块 + lycoris.kohya 均从 kwargs 读取并消费
    # （lora.py:469-474 / lora_anima.py:40-46 / loha.py:48-53 / lokr.py:48-53 / kohya.py:45-46）。
    # 与 neuron dropout (network_dropout) 为不同正则化手段，可叠加。
    {"key": "rank_dropout", "type": "number", "section": "network", "desc_key": "field.rank_dropout", "target": "ui", "min": 0, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"]}},
    {"key": "module_dropout", "type": "number", "section": "network", "desc_key": "field.module_dropout", "target": "ui", "min": 0, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"]}},
    # use_tucker：仅 Conv2d 3x3+ 的 Tucker 分解有效。原生 loha/lokr 模块消费；
    # lycoris 仅 LoCon/Loha/Lokr 模块消费（dylora/glora/ia3/diag-oft/boft 签名有但忽略）。
    # 故显示条件为 OR-of-ANDs：原生 loha/lokr，或 lycoris.kohya + algo∈{lora,loha,lokr}。
    {"key": "use_tucker", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_tucker", "target": "ui", "show_if_any": [[{"key": "network_module", "eq": "networks.loha"}], [{"key": "network_module", "eq": "networks.lokr"}], [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}]], "hint_key": "field.use_tuckerHint", "omit_default": True},
    # lycoris.kohya 其他基础子参数（inline，无 sub_group；advanced 子参数保留 sub_group 形成下方"LyCORIS 高级"折叠）
    {"key": "use_scalar", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_scalar", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr", "glora"]}], "omit_default": True},
    {"key": "decompose_both", "type": "toggle", "default": False, "section": "network", "desc_key": "field.decompose_both", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "omit_default": True},
    {"key": "dropout", "type": "number", "section": "network", "desc_key": "field.lycoris_dropout", "target": "ui", "min": 0, "max": 0.5, "step": 0.01, "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.lycoris_dropoutHint"},
    # lycoris.kohya 高级子参数（show_if: kohya + algo 特定；advanced: true, sub_group: "kohya" → 渲染为"LyCORIS 高级"子折叠）
    {"key": "full_matrix", "type": "toggle", "default": False, "section": "network", "desc_key": "field.full_matrix", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "train_norm", "type": "toggle", "default": False, "section": "network", "desc_key": "field.train_norm", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "dora_wd", "type": "toggle", "default": False, "section": "network", "desc_key": "field.dora_wd", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}], "hint_key": "field.dora_wdHint", "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "block_size", "type": "number", "default": 4, "section": "network", "desc_key": "field.block_size", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "dylora"}], "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "constraint", "type": "number", "default": 0, "step": 0.1, "section": "network", "desc_key": "field.constraint", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "diag-oft", "_or": ["boft"]}], "hint_key": "field.constraintHint", "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "rescaled", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rescaled", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "diag-oft", "_or": ["boft"]}], "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "bypass_mode", "type": "toggle", "default": False, "section": "network", "desc_key": "field.bypass_mode", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "rs_lora", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rs_lora", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr", "glora"]}], "hint_key": "field.rs_loraHint", "advanced": True, "sub_group": "kohya", "omit_default": True},
    {"key": "unbalanced_factorization", "type": "toggle", "default": False, "section": "network", "desc_key": "field.unbalanced_factorization", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "advanced": True, "sub_group": "kohya", "omit_default": True},
    # wd_on_output：DoRA 权重分解的作用维度（输出 vs 输入）。仅 dora_wd=True（开启 DoRA）时生效，
    # 故显示条件追加 dora_wd=True（lycoris 各模块仅在 self.wd 为真时才读 wd_on_out）。
    {"key": "wd_on_output", "type": "toggle", "default": True, "section": "network", "desc_key": "field.wd_on_output", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}, {"key": "dora_wd", "eq": True}], "hint_key": "field.wd_on_outputHint", "advanced": True, "sub_group": "kohya", "omit_default": True},
    # ── 通用高级参数（所有 module 可见，advanced: true）──
    # base_weights：训练前把已有 LoRA 权重合并进 base 模型再训练（LoRA 叠加工作流）。
    # sd-scripts argparse nargs="*"，adapter 把逗号分隔字符串转 list。
    {"key": "scale_weight_norms", "type": "number", "section": "network", "desc_key": "field.scale_weight_norms", "target": "toml", "min": 0, "step": 0.01, "hint_key": "field.scale_weight_normsHint", "advanced": True},
    {"key": "base_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.base_weights", "target": "toml", "hint_key": "field.base_weightsHint", "advanced": True},
    {"key": "base_weights_multiplier", "type": "text", "default": "", "section": "network", "desc_key": "field.base_weights_multiplier", "target": "toml", "hint_key": "field.base_weights_multiplierHint", "show_if": {"key": "base_weights", "neq": ""}, "advanced": True},
    {"key": "network_args_custom", "type": "textarea", "default": "", "section": "network", "desc_key": "field.network_args_custom", "target": "ui", "hint_key": "field.network_args_customHint", "advanced": True},
# ── Training Core ──
{"key": "max_train_epochs", "type": "number", "default": 10, "section": "training", "desc_key": "field.max_train_epochs", "target": "toml", "min": 1},
{"key": "train_batch_size", "type": "number", "default": 1, "section": "training", "desc_key": "field.train_batch_size", "target": "toml", "min": 1, "omit_default": True},
{"key": "gradient_accumulation_steps", "type": "number", "default": 1, "section": "training", "desc_key": "field.gradient_accumulation_steps", "target": "toml", "min": 1, "omit_default": True},
{"key": "gradient_checkpointing", "type": "toggle", "default": False, "section": "training", "desc_key": "field.gradient_checkpointing", "target": "toml", "omit_default": True},
{"key": "seed", "type": "number", "default": 1337, "section": "training", "desc_key": "field.seed", "target": "toml"},
{"key": "mixed_precision", "type": "select", "default": "bf16", "section": "training", "desc_key": "field.mixed_precision", "target": "toml", "options": [{"v": "bf16", "l": "bf16", "dk": "opt.mixed_precision_bf16"}, {"v": "fp16", "l": "fp16", "dk": "opt.mixed_precision_fp16"}, {"v": "no", "l": "no", "dk": "opt.mixed_precision_no"}]},
    # full_bf16: 将模型 + Network 全部参数 cast 为 bf16，消除 autocast 与 compile/LoRA 交互的 dtype 不一致问题。
    # 与 mixed_precision=bf16 搭配使用；仅在选择 bf16 时显示。默认关闭（标准 mixed precision 行为）。
    {"key": "full_bf16", "type": "toggle", "default": False, "section": "training", "desc_key": "field.full_bf16", "target": "toml", "show_if": {"key": "mixed_precision", "eq": "bf16"}, "omit_default": True},
    # Anima: Timestep & Weighting (training core for DiT)
    # 注：移除 flux_shift 选项——本项目不训练 Flux，保留会造成"支持 Flux"的误导。
    {"key": "timestep_sampling", "type": "select", "default": "sigmoid", "section": "training", "desc_key": "field.timestep_sampling", "target": "toml", "group": "anima", "options": [{"v": "sigmoid", "l": "sigmoid", "dk": "opt.timestep_sampling_sigmoid"}, {"v": "sigma", "l": "sigma", "dk": "opt.timestep_sampling_sigma"}, {"v": "uniform", "l": "uniform", "dk": "opt.timestep_sampling_uniform"}, {"v": "shift", "l": "shift", "dk": "opt.timestep_sampling_shift"}]},
    {"key": "sigmoid_scale", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.sigmoid_scale", "target": "toml", "step": 0.001, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "sigmoid", "_or": ["shift"]}, "omit_default": True},
    {"key": "discrete_flow_shift", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.discrete_flow_shift", "target": "toml", "step": 0.01, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "shift"}, "omit_default": True},
    {"key": "weighting_scheme", "type": "select", "default": "uniform", "section": "training", "desc_key": "field.weighting_scheme", "target": "toml", "group": "anima", "options": [{"v": "uniform", "l": "uniform", "dk": "opt.weighting_scheme_uniform"}, {"v": "sigma_sqrt", "l": "sigma_sqrt", "dk": "opt.weighting_scheme_sigma_sqrt"}, {"v": "logit_normal", "l": "logit_normal", "dk": "opt.weighting_scheme_logit_normal"}, {"v": "mode", "l": "mode", "dk": "opt.weighting_scheme_mode"}, {"v": "cosmap", "l": "cosmap", "dk": "opt.weighting_scheme_cosmap"}, {"v": "none", "l": "none", "dk": "opt.weighting_scheme_none"}]},
    {"key": "logit_mean", "type": "number", "default": 0.0, "section": "training", "desc_key": "field.logit_mean", "target": "toml", "step": 0.01, "group": "anima", "show_if": [{"key": "weighting_scheme", "eq": "logit_normal"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True},
    {"key": "logit_std", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.logit_std", "target": "toml", "step": 0.01, "group": "anima", "show_if": [{"key": "weighting_scheme", "eq": "logit_normal"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True},
    {"key": "mode_scale", "type": "number", "default": 1.29, "section": "training", "desc_key": "field.mode_scale", "target": "toml", "step": 0.01, "group": "anima", "show_if": [{"key": "weighting_scheme", "eq": "mode"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True},
    # SDXL/SD3: 时间步范围控制（advanced；对 Anima flow-matching 训练无效，故划归 sdxl 组）
    {"key": "min_timestep", "type": "number", "section": "training", "desc_key": "field.min_timestep", "target": "toml", "min": 0, "max": 999, "step": 1, "group": "sdxl", "advanced": True, "hint_key": "field.min_timestepHint"},
    {"key": "max_timestep", "type": "number", "default": "", "section": "training", "desc_key": "field.max_timestep", "target": "toml", "min": 1, "max": 1000, "step": 1, "group": "sdxl", "advanced": True, "hint_key": "field.max_timestepHint"},
# ── Optimizer & Learning Rate ──
{"key": "optimizer_type", "type": "select", "default": "AdamW8bit", "section": "optimizer", "desc_key": "field.optimizer_type", "target": "toml", "groups": [{"label_key": "opt.optimizer_group_adamw", "options": [{"v": "AdamW", "l": "AdamW", "dk": "opt.optimizer_type_AdamW"}, {"v": "AdamW8bit", "l": "AdamW8bit", "dk": "opt.optimizer_type_AdamW8bit"}, {"v": "PagedAdamW8bit", "l": "PagedAdamW8bit", "dk": "opt.optimizer_type_PagedAdamW8bit"}]}, {"label_key": "opt.optimizer_group_lion", "options": [{"v": "Lion", "l": "Lion", "dk": "opt.optimizer_type_Lion"}, {"v": "Lion8bit", "l": "Lion8bit", "dk": "opt.optimizer_type_Lion8bit"}, {"v": "PagedLion8bit", "l": "PagedLion8bit", "dk": "opt.optimizer_type_PagedLion8bit"}]}, {"label_key": "opt.optimizer_group_prodigy", "options": [{"v": "Prodigy", "l": "Prodigy", "dk": "opt.optimizer_type_Prodigy"}, {"v": "prodigyplus.ProdigyPlusScheduleFree", "l": "ProdigyPlusScheduleFree", "dk": "opt.optimizer_type_ProdigyPlus"}]}, {"label_key": "opt.optimizer_group_other", "options": [{"v": "AdaFactor", "l": "AdaFactor", "dk": "opt.optimizer_type_AdaFactor"}, {"v": "pytorch_optimizer.CAME", "l": "CAME", "dk": "opt.optimizer_type_CAME"}, {"v": "AdamWScheduleFree", "l": "AdamWScheduleFree", "dk": "opt.optimizer_type_AdamWScheduleFree"}]}, {"label_key": "opt.optimizer_group_emo", "options": [{"v": "vendor.emo_optimizer.emosens.EmoSens", "l": "EmoSens", "dk": "opt.optimizer_type_EmoSens"}]}]},
# 学习率取值链：unet_lr / text_encoder_lr 非空时覆盖 learning_rate；为空时回退 learning_rate。
# 默认留空 → 默认走 learning_rate 一个总学习率（符合 sd-scripts fallback 语义与 i18n 描述）；
# 用户想分开调 U-Net / 文本编码器学习率时再填入分量值。
# auto_value 范围：
#   - learning_rate：Prodigy→1.0、EmoSens+Anima→0.1、EmoSens+SDXL→1.0（基准总学习率）
#   - unet_lr / text_encoder_lr：仅 Prodigy 填 1.0 并只读（D-adaptation 硬性要求三者同 1.0）。
#     EmoSens 不预填分量——留空会自动回退到 learning_rate，等于只调一个总学习率，
#     若用户填了具体分量值则是有意为之的覆盖，EmoSens 允许。
# 开关联动（adapter 强制 + 前端 setField 同步）：
#   network_train_unet_only=True   → text_encoder_lr 置空（被排除的分量不写 TOML）
#   network_train_text_encoder_only=True → unet_lr 置空
{"key": "learning_rate", "type": "text", "default": "1e-4", "section": "optimizer", "desc_key": "field.learning_rate", "target": "toml", "auto_value": [{"watch": "optimizer_type", "when": "Prodigy", "set": "1.0"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "1.0"}, {"watch": {"optimizer_type": "vendor.emo_optimizer.emosens.EmoSens", "model_train_type": "anima-lora"}, "set": "0.1"}, {"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.learning_rate_prodigyLocked"}},
{"key": "unet_lr", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.unet_lr", "target": "toml", "show_if": {"key": "network_train_text_encoder_only", "neq": True}, "auto_value": [{"watch": "optimizer_type", "when": "Prodigy", "set": "1.0"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.unet_lr_prodigyLocked"}, "omit_default": True},
{"key": "text_encoder_lr", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.text_encoder_lr", "target": "toml", "show_if": {"key": "network_train_unet_only", "neq": True}, "auto_value": [{"watch": "optimizer_type", "when": "Prodigy", "set": "1.0"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.text_encoder_lr_prodigyLocked"}, "omit_default": True},
{"key": "lr_scheduler", "type": "select", "default": "cosine_with_restarts", "section": "optimizer", "desc_key": "field.lr_scheduler", "target": "toml", "options": [{"v": "cosine_with_restarts", "l": "cosine_with_restarts", "dk": "opt.lr_scheduler_cosine_with_restarts"}, {"v": "cosine", "l": "cosine", "dk": "opt.lr_scheduler_cosine"}, {"v": "linear", "l": "linear", "dk": "opt.lr_scheduler_linear"}, {"v": "polynomial", "l": "polynomial", "dk": "opt.lr_scheduler_polynomial"}, {"v": "constant", "l": "constant", "dk": "opt.lr_scheduler_constant"}, {"v": "constant_with_warmup", "l": "constant_with_warmup", "dk": "opt.lr_scheduler_constant_with_warmup"}], "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": "constant"}, {"watch": "optimizer_type", "when": "AdamWScheduleFree", "set": "constant"}, {"watch": "optimizer_type", "when": "prodigyplus.ProdigyPlusScheduleFree", "set": "constant"}], "readonly_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens", "_or": ["AdamWScheduleFree", "prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.lr_scheduler_locked"}},
    # External scheduler class (dot-path).  Takes priority over lr_scheduler.
    # EmoPulse: loss-driven dynamic LR.  For EmoSens, it's a pass-through that
    # prevents ConstantLR from overwriting emoPulse in param_groups['lr'].
    # For other optimizers, it computes emoPulse autonomously.
    {"key": "lr_scheduler_type", "type": "select", "default": "", "section": "optimizer", "desc_key": "field.lr_scheduler_type", "target": "toml", "options": [{"v": "", "l": "None (use lr_scheduler)", "dk": "opt.lr_scheduler_type_none"}, {"v": "vendor.emo_optimizer.emopulse_scheduler.EmoPulse", "l": "EmoPulse", "dk": "opt.lr_scheduler_type_emopulse"}], "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": "vendor.emo_optimizer.emopulse_scheduler.EmoPulse"}], "readonly_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens", "_or": ["AdamWScheduleFree", "prodigyplus.ProdigyPlusScheduleFree"], "reason_key": "field.lr_scheduler_type_locked"}, "omit_default": True},
{"key": "lr_warmup_steps", "type": "number", "default": 0, "section": "optimizer", "desc_key": "field.lr_warmup_steps", "target": "toml", "min": 0, "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0}, {"watch": "lr_scheduler_type", "neq": "", "set": 0}], "readonly_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens", "reason_key": "field.lr_warmup_steps_emoLocked"}, "omit_default": True},
{"key": "lr_scheduler_num_cycles", "type": "number", "default": 1, "section": "optimizer", "desc_key": "field.lr_scheduler_num_cycles", "target": "toml", "min": 1, "show_if": [{"key": "lr_scheduler", "eq": "cosine_with_restarts"}, {"key": "lr_scheduler_type", "eq": ""}], "omit_default": True},
{"key": "lr_scheduler_power", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.lr_scheduler_power", "target": "toml", "min": 0.1, "step": 0.1, "show_if": [{"key": "lr_scheduler", "eq": "polynomial"}, {"key": "lr_scheduler_type", "eq": ""}], "omit_default": True},
{"key": "max_grad_norm", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.max_grad_norm", "target": "toml", "step": 0.1, "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0}], "omit_default": True},
{"key": "weight_decay", "type": "number", "default": "", "section": "optimizer", "desc_key": "field.weight_decay", "target": "merged", "step": 0.001, "hint_key": "field.weight_decayHint", "auto_value": [{"watch": "optimizer_type", "when": "vendor.emo_optimizer.emosens.EmoSens", "set": 0.01}]},
    # EmoSens 专用：收敛灵敏度（stopcoef）
    {"key": "stopcoef", "type": "number", "default": 0.04, "section": "optimizer", "desc_key": "field.stopcoef", "target": "merged", "min": 0.001, "max": 1.0, "step": 0.001, "hint_key": "field.stopcoefHint", "show_if": {"key": "optimizer_type", "eq": "vendor.emo_optimizer.emosens.EmoSens"}},
{"key": "prodigy_d_coef", "type": "text", "default": "1.0", "section": "optimizer", "desc_key": "field.prodigy_d_coef", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"]}},
{"key": "prodigy_d0", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.prodigy_d0", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "Prodigy", "_or": ["prodigyplus.ProdigyPlusScheduleFree"]}},
# ── Optimizer Merged: betas / eps ──
{"key": "betas", "type": "text", "section": "optimizer", "desc_key": "field.betas", "target": "merged", "hint_key": "field.betasHint", "show_if": {"key": "optimizer_type", "eq": "AdamW", "_or": ["AdamW8bit", "PagedAdamW8bit", "Lion", "Lion8bit", "PagedLion8bit", "pytorch_optimizer.CAME", "vendor.emo_optimizer.emosens.EmoSens", "AdamWScheduleFree", "Prodigy", "prodigyplus.ProdigyPlusScheduleFree"]}},
{"key": "eps", "type": "text", "section": "optimizer", "desc_key": "field.eps", "target": "merged", "hint_key": "field.epsHint", "show_if": {"key": "optimizer_type", "eq": "AdamW", "_or": ["AdamW8bit", "PagedAdamW8bit", "vendor.emo_optimizer.emosens.EmoSens", "AdamWScheduleFree", "Prodigy", "prodigyplus.ProdigyPlusScheduleFree"]}},
# ── CAME 专用参数 ──
{"key": "came_weight_decouple", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.came_weight_decouple", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_fixed_decay", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_fixed_decay", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_clip_threshold", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.came_clip_threshold", "target": "merged", "step": 0.1, "min": 0.1, "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_ams_bound", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_ams_bound", "target": "merged", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_eps1", "type": "text", "section": "optimizer", "desc_key": "field.came_eps1", "target": "merged", "hint_key": "field.came_eps1Hint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_eps2", "type": "text", "section": "optimizer", "desc_key": "field.came_eps2", "target": "merged", "hint_key": "field.came_eps2Hint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "optimizer_args_custom", "type": "textarea", "default": "", "section": "optimizer", "desc_key": "field.optimizer_args_custom", "target": "ui", "hint_key": "field.optimizer_args_customHint", "advanced": True},
# ── Regularization & Loss ──
{"key": "loss_type", "type": "select", "default": "l2", "section": "regularization", "desc_key": "field.loss_type", "target": "toml", "options": [{"v": "l2", "l": "L2", "dk": "opt.loss_type_l2"}, {"v": "l1", "l": "L1", "dk": "opt.loss_type_l1"}, {"v": "huber", "l": "Huber", "dk": "opt.loss_type_huber"}, {"v": "smooth_l1", "l": "Smooth L1", "dk": "opt.loss_type_smooth_l1"}], "omit_default": True},
{"key": "huber_schedule", "type": "select", "default": "exponential", "section": "regularization", "desc_key": "field.huber_schedule", "target": "toml", "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "options": [{"v": "snr", "l": "SNR", "dk": "opt.huber_schedule_snr", "group": "sdxl"}, {"v": "constant", "l": "constant", "dk": "opt.huber_schedule_constant"}, {"v": "exponential", "l": "exponential", "dk": "opt.huber_schedule_exponential"}], "omit_default": True},
{"key": "huber_c", "type": "number", "default": 0.1, "section": "regularization", "desc_key": "field.huber_c", "target": "toml", "step": 0.01, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "omit_default": True},
{"key": "huber_scale", "type": "number", "default": 1.0, "section": "regularization", "desc_key": "field.huber_scale", "target": "toml", "step": 0.1, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "omit_default": True},
# 噪声/损失正则化族（仅 SDXL 路径消费；Anima 走 rectified-flow，flux_train_utils.get_noisy_model_input_and_timesteps
# 不读 noise_offset/adaptive_noise_scale/multires_noise_*；min_snr/debiased 仅 sdxl_train.py/fine_tune.py 消费）。
    {"key": "min_snr_gamma", "type": "number", "section": "regularization", "desc_key": "field.min_snr_gamma", "target": "toml", "step": 0.1, "hint_key": "field.min_snr_gammaHint", "advanced": True, "group": "sdxl"},
    {"key": "debiased_estimation_loss", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.debiased_estimation_loss", "target": "toml", "advanced": True, "omit_default": True, "group": "sdxl"},
    {"key": "noise_offset", "type": "number", "section": "regularization", "desc_key": "field.noise_offset", "target": "toml", "step": 0.001, "hint_key": "field.noise_offsetHint", "group": "sdxl"},
    {"key": "noise_offset_random_strength", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.noise_offset_random_strength", "target": "toml", "show_if": {"key": "noise_offset", "neq": ""}, "advanced": True, "omit_default": True, "group": "sdxl"},
    {"key": "adaptive_noise_scale", "type": "number", "section": "regularization", "desc_key": "field.adaptive_noise_scale", "target": "toml", "step": 0.001, "show_if": {"key": "noise_offset", "neq": ""}, "advanced": True, "group": "sdxl"},
    {"key": "multires_noise_iterations", "type": "number", "section": "regularization", "desc_key": "field.multires_noise_iterations", "target": "toml", "min": 0, "step": 1, "group": "sdxl", "advanced": True, "hint_key": "field.multires_noise_iterationsHint"},
    {"key": "multires_noise_discount", "type": "number", "default": 0.3, "section": "regularization", "desc_key": "field.multires_noise_discount", "target": "toml", "step": 0.01, "show_if": {"key": "multires_noise_iterations", "neq": ""}, "group": "sdxl", "advanced": True, "omit_default": True, "hint_key": "field.multires_noise_discountHint"},
{"key": "ip_noise_gamma", "type": "number", "section": "regularization", "desc_key": "field.ip_noise_gamma", "target": "toml", "step": 0.001, "advanced": True},
{"key": "ip_noise_gamma_random_strength", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.ip_noise_gamma_random_strength", "target": "toml", "show_if": {"key": "ip_noise_gamma", "neq": ""}, "advanced": True, "omit_default": True},
# zero_terminal_snr 需配合 v_parameterization（sd-scripts 未启用 v_pred 时会警告"结果异常"）
{"key": "zero_terminal_snr", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.zero_terminal_snr", "target": "toml", "group": "sdxl", "show_if": {"key": "v_parameterization", "eq": True}, "omit_default": True},
# ── Performance & Cache ──
{"key": "xformers", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.xformers", "target": "toml", "group": "sdxl"},
{"key": "sdpa", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.sdpa", "target": "toml", "group": "sdxl", "omit_default": True},
{"key": "attn_mode", "type": "select", "default": "torch", "section": "performance", "desc_key": "field.attn_mode", "target": "toml", "group": "anima", "options": [{"v": "torch", "l": "torch", "dk": "opt.attn_mode_torch"}, {"v": "xformers", "l": "xformers", "dk": "opt.attn_mode_xformers"}, {"v": "flash", "l": "flash", "dk": "opt.attn_mode_flash"}, {"v": "sdpa", "l": "sdpa", "dk": "opt.attn_mode_sdpa"}]},
{"key": "split_attn", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.split_attn", "target": "toml", "group": "anima", "auto_value": [{"watch": "attn_mode", "when": "xformers", "set": True}]},
    # Anima: TF32 / cuDNN — Ampere+ GPU 几乎免费的加速
    {"key": "cuda_allow_tf32", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cuda_allow_tf32", "target": "toml", "group": "anima", "hint_key": "field.cuda_allow_tf32Hint"},
    {"key": "cuda_cudnn_benchmark", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cuda_cudnn_benchmark", "target": "toml", "group": "anima", "hint_key": "field.cuda_cudnn_benchmarkHint", "advanced": True},
{"key": "cache_latents", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents", "target": "toml"},
{"key": "cache_latents_to_disk", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents_to_disk", "target": "toml"},
# 文本编码器输出缓存：默认开启（配合默认 network_train_unet_only=True，纯收益，大幅省显存提速）
# cache_text_encoder_outputs 与 caption dropout/shuffle 互斥（sd-scripts is_text_encoder_output_cacheable
# 在 shuffle_caption / caption_tag_dropout_rate>0 时返回 false → anima_train_network.py assert 失败）。
# 双重保护：前端 setField 联动自动关 cache（caption 互斥项激活时）+ readonly_if_any 锁定防用户回开
# （任一互斥项激活期间 cache 开关灰显，光自动关不够，用户还能手动再开回 true）。
{"key": "cache_text_encoder_outputs", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_text_encoder_outputs", "target": "toml", "hint_key": "field.cache_text_encoder_outputsHint", "readonly_if_any": [{"key": "shuffle_caption", "eq": True}, {"key": "caption_tag_dropout_rate", "neq": 0}], "readonly_reason_key": "field.cache_text_encoder_outputsLocked"},
# to_disk 联动 cache=true 已由 sd-scripts 后端兜底（anima_train_network.py:56-58），前端 auto_value 规则
# 曾经 watch 自身导致用户把 to_disk 切回 false 时把 cache 复位为 default=True（switchTrainType 后被偷开），删除。
{"key": "cache_text_encoder_outputs_to_disk", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cache_text_encoder_outputs_to_disk", "target": "toml"},
{"key": "no_half_vae", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.no_half_vae", "target": "toml", "group": "sdxl", "omit_default": True},
{"key": "lowram", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.lowram", "target": "toml", "omit_default": True},
    # Anima: VAE performance
    {"key": "vae_chunk_size", "type": "number", "default": "", "section": "performance", "desc_key": "field.vae_chunk_size", "target": "toml", "min": 2, "step": 2, "group": "anima", "hint_key": "field.vae_chunk_sizeHint"},
    {"key": "vae_disable_cache", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.vae_disable_cache", "target": "toml", "group": "anima"},
    {"key": "vae_batch_size", "type": "number", "default": "", "section": "performance", "desc_key": "field.vae_batch_size", "target": "toml", "min": 1, "step": 1, "hint_key": "field.vae_batch_sizeHint", "advanced": True},
    {"key": "blocks_to_swap", "type": "number", "section": "performance", "desc_key": "field.blocks_to_swap", "target": "toml", "min": 0, "max": 32, "step": 1, "group": "anima", "advanced": True, "hint_key": "field.blocks_to_swapHint"},
    # cpu_offload_checkpointing：梯度检查点时把张量卸载到 CPU 省显存（与 unsloth_offload_checkpointing 互斥）。
    # adapter.py 已有互斥校验，此前 registry 无字段导致该校验为死代码，此处补全。
    {"key": "cpu_offload_checkpointing", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cpu_offload_checkpointing", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.cpu_offload_checkpointingHint", "omit_default": True},
    {"key": "unsloth_offload_checkpointing", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.unsloth_offload_checkpointing", "target": "toml", "group": "anima", "advanced": True, "hint_key": "field.unsloth_offload_checkpointingHint", "omit_default": True},
    # torch.compile（通用 accelerate 版，SDXL 用；Anima 请用下方 compile 系列）
    {"key": "torch_compile", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.torch_compile", "target": "toml", "group": "sdxl", "hint_key": "field.torch_compileHint"},
    {"key": "dynamo_backend", "type": "select", "default": "inductor", "section": "performance", "desc_key": "field.dynamo_backend", "target": "toml", "show_if": {"key": "torch_compile", "eq": True}, "hint_key": "field.dynamo_backendHint", "group": "sdxl", "options": [{"v": "inductor", "l": "inductor", "dk": "opt.dynamo_backend_inductor"}, {"v": "eager", "l": "eager", "dk": "opt.dynamo_backend_eager"}, {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.dynamo_backend_cudagraphs"}]},
    # Anima 专用 per-block torch.compile（需 Triton；与 torch_compile / blocks_to_swap 互斥，adapter 会校验）
    {"key": "compile", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.compile", "target": "toml", "group": "anima", "hint_key": "field.compileHint"},
    {"key": "compile_backend", "type": "select", "default": "inductor", "section": "performance", "desc_key": "field.compile_backend", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "options": [{"v": "inductor", "l": "inductor", "dk": "opt.compile_backend_inductor"}, {"v": "eager", "l": "eager", "dk": "opt.compile_backend_eager"}, {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.compile_backend_cudagraphs"}]},
    {"key": "compile_mode", "type": "select", "default": "default", "section": "performance", "desc_key": "field.compile_mode", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "options": [{"v": "default", "l": "default", "dk": "opt.compile_mode_default"}, {"v": "reduce-overhead", "l": "reduce-overhead", "dk": "opt.compile_mode_reduce_overhead"}, {"v": "max-autotune", "l": "max-autotune", "dk": "opt.compile_mode_max_autotune"}, {"v": "max-autotune-no-cudagraphs", "l": "max-autotune-no-cudagraphs", "dk": "opt.compile_mode_max_autotune_no_cudagraphs"}]},
    {"key": "compile_dynamic", "type": "select", "default": "auto", "section": "performance", "desc_key": "field.compile_dynamic", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "advanced": True, "options": [{"v": "auto", "l": "auto", "dk": "opt.compile_dynamic_auto"}, {"v": "true", "l": "true", "dk": "opt.compile_dynamic_true"}, {"v": "false", "l": "false", "dk": "opt.compile_dynamic_false"}]},
    {"key": "compile_fullgraph", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.compile_fullgraph", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "advanced": True},
    {"key": "compile_cache_size_limit", "type": "number", "default": "", "section": "performance", "desc_key": "field.compile_cache_size_limit", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "advanced": True, "hint_key": "field.compile_cache_size_limitHint"},
    # DataLoader
    {"key": "persistent_data_loader_workers", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.persistent_data_loader_workers", "target": "toml", "advanced": True, "hint_key": "field.persistent_data_loader_workersHint"},
    {"key": "max_data_loader_n_workers", "type": "number", "default": "", "section": "performance", "desc_key": "field.max_data_loader_n_workers", "target": "toml", "min": 0, "step": 1, "advanced": True, "hint_key": "field.max_data_loader_n_workersHint"},
# ── Save ──
{"key": "output_name", "type": "text", "default": "my_lora", "section": "save", "desc_key": "field.output_name", "target": "toml", "required": True},
{"key": "output_dir", "type": "text", "default": "./output", "section": "save", "desc_key": "field.output_dir", "target": "toml", "role": "file-folder", "required": True},
{"key": "save_model_as", "type": "select", "default": "safetensors", "section": "save", "desc_key": "field.save_model_as", "target": "toml", "options": [{"v": "safetensors", "l": "safetensors", "dk": "opt.save_model_as_safetensors"}, {"v": "pt", "l": "pt", "dk": "opt.save_model_as_pt"}, {"v": "ckpt", "l": "ckpt", "dk": "opt.save_model_as_ckpt"}]},
{"key": "save_precision", "type": "select", "default": "fp16", "section": "save", "desc_key": "field.save_precision", "target": "toml", "options": [{"v": "fp16", "l": "fp16", "dk": "opt.save_precision_fp16"}, {"v": "bf16", "l": "bf16", "dk": "opt.save_precision_bf16"}, {"v": "float", "l": "float", "dk": "opt.save_precision_float"}]},
{"key": "save_every_n_epochs", "type": "number", "default": 2, "section": "save", "desc_key": "field.save_every_n_epochs", "target": "toml", "min": 1},
    {"key": "save_every_n_steps", "type": "number", "default": "", "section": "save", "desc_key": "field.save_every_n_steps", "target": "toml", "min": 1, "hint_key": "field.save_every_n_stepsHint"},
    {"key": "save_last_n_epochs", "type": "number", "default": "", "section": "save", "desc_key": "field.save_last_n_epochs", "target": "toml", "min": 1, "hint_key": "field.save_last_n_epochsHint", "advanced": True},
{"key": "save_state", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state", "target": "toml", "omit_default": True},
    {"key": "save_last_n_epochs_state", "type": "number", "default": "", "section": "save", "desc_key": "field.save_last_n_epochs_state", "target": "toml", "min": 1, "show_if": {"key": "save_state", "eq": True}},
    {"key": "save_state_on_train_end", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state_on_train_end", "target": "toml", "advanced": True, "omit_default": True},
{"key": "logging_dir", "type": "text", "default": "./logs", "section": "save", "desc_key": "field.logging_dir", "target": "toml", "hidden": True},
{"key": "log_with", "type": "select", "default": "tensorboard", "section": "save", "desc_key": "field.log_with", "target": "toml", "hidden": True, "options": [{"v": "tensorboard", "l": "TensorBoard", "dk": "opt.log_with_tensorboard"}, {"v": "wandb", "l": "Weights & Biases", "dk": "opt.log_with_wandb"}, {"v": "all", "l": "TensorBoard + WandB", "dk": "opt.log_with_all"}]},
# ── Caption ──
{"key": "caption_extension", "type": "text", "default": ".txt", "section": "caption", "desc_key": "field.caption_extension", "target": "toml"},
{"key": "max_token_length", "type": "select", "default": 225, "section": "caption", "desc_key": "field.max_token_length", "target": "toml", "group": "sdxl", "options": [{"v": 150, "l": "150", "dk": "opt.max_token_length_150"}, {"v": 225, "l": "225", "dk": "opt.max_token_length_225"}]},
{"key": "qwen3_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.qwen3_max_token_length", "target": "toml", "step": 1, "group": "anima"},
{"key": "t5_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.t5_max_token_length", "target": "toml", "step": 1, "group": "anima"},
# shuffle_caption 与 cache_text_encoder_outputs 互斥：默认关闭以让推荐默认 cache=true 可用。
# 用户主动开启 shuffle 时会触发 cache 的 readonly 锁定（见 performance 段对 cache_text_encoder_outputs 的注释）。
{"key": "shuffle_caption", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.shuffle_caption", "target": "toml"},
{"key": "keep_tokens", "type": "number", "default": 0, "section": "caption", "desc_key": "field.keep_tokens", "target": "toml", "min": 0, "omit_default": True},
{"key": "weighted_captions", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.weighted_captions", "target": "toml", "omit_default": True},
{"key": "caption_dropout_rate", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_rate", "target": "toml", "min": 0, "step": 0.01},
{"key": "caption_dropout_every_n_epochs", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_every_n_epochs", "target": "toml", "min": 0},
{"key": "caption_tag_dropout_rate", "type": "number", "section": "caption", "desc_key": "field.caption_tag_dropout_rate", "target": "toml", "min": 0, "step": 0.01},
# ── Preview ──
{"key": "enable_preview", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.enable_preview", "target": "ui"},
{"key": "positive_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.sample_prompts", "target": "ui", "hint_key": "field.sample_promptsHint", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "negative_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.negative_prompts", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    # 仅 SDXL 暴露采样器（sd-scripts 的 diffusers scheduler 路径）。
    # Anima 采样写死 Euler flow-match，sample_sampler 是假参数，故按 group:sdxl 隐藏。
    {"key": "sample_sampler", "type": "select", "default": "euler_a", "section": "preview", "desc_key": "field.sample_sampler", "hint_key": "field.sample_samplerHint", "target": "toml", "group": "sdxl", "show_if": {"key": "enable_preview", "eq": True}, "options": [
        {"v": "euler_a", "l": "euler_a", "dk": "opt.sample_sampler_euler_a"},
        {"v": "euler", "l": "euler", "dk": "opt.sample_sampler_euler"},
        {"v": "ddim", "l": "ddim", "dk": "opt.sample_sampler_ddim"},
        {"v": "lms", "l": "lms", "dk": "opt.sample_sampler_lms"},
        {"v": "heun", "l": "heun", "dk": "opt.sample_sampler_heun"},
        {"v": "dpmsolver++", "l": "dpmsolver++", "dk": "opt.sample_sampler_dpmsolver_plus"},
        {"v": "dpmsingle", "l": "dpmsingle", "dk": "opt.sample_sampler_dpmsingle"},
        {"v": "dpm_2", "l": "dpm_2", "dk": "opt.sample_sampler_dpm_2"},
        {"v": "dpm_2_a", "l": "dpm_2_a", "dk": "opt.sample_sampler_dpm_2_a"},
        {"v": "pndm", "l": "pndm", "dk": "opt.sample_sampler_pndm"},
    ]},
    {"key": "sample_every_n_epochs", "type": "number", "default": 2, "section": "preview", "desc_key": "field.sample_every_n_epochs", "target": "toml", "min": 1, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_every_n_steps", "type": "number", "default": "", "section": "preview", "desc_key": "field.sample_every_n_steps", "target": "toml", "min": 1, "advanced": True, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_at_first", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.sample_at_first", "target": "toml", "advanced": True, "omit_default": True, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_cfg", "type": "number", "default": 7, "section": "preview", "desc_key": "field.sample_cfg", "target": "ui", "min": 1, "max": 30, "show_if": {"key": "enable_preview", "eq": True}},
# 预览分辨率默认 1024（SDXL/Anima 训练基准），原 512 在高分辨率模型下采样不具代表性
    {"key": "sample_width", "type": "number", "default": 1024, "section": "preview", "desc_key": "field.sample_width", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_height", "type": "number", "default": 1024, "section": "preview", "desc_key": "field.sample_height", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_seed", "type": "number", "default": 2333, "section": "preview", "desc_key": "field.sample_seed", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_steps", "type": "number", "default": 24, "section": "preview", "desc_key": "field.sample_steps", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    # Anima flow-match 采样时间表 shift（类比 Karras 的 sigma 偏移）。
    # 由 get_sample_prompts 拼成 --fs 传入 sd-scripts；SDXL 不读，故 group:anima 仅 Anima 显示。
    {"key": "sample_flow_shift", "type": "number", "default": 3.0, "section": "preview", "desc_key": "field.sample_flow_shift", "hint_key": "field.sample_flow_shiftHint", "target": "ui", "group": "anima", "step": 0.1, "show_if": {"key": "enable_preview", "eq": True}},
]


# ═══════════════════════════════════════════════════════════════
# 派生集合（供 adapter.py 使用）
# ═══════════════════════════════════════════════════════════════

_SUPPORTED_FIELDS_CACHE: set[str] | None = None
_UI_ONLY_FIELDS_CACHE: set[str] | None = None


def get_supported_fields() -> set[str]:
    """返回需要传入 sd-scripts 的字段名集合（首次调用后缓存）"""
    global _SUPPORTED_FIELDS_CACHE
    if _SUPPORTED_FIELDS_CACHE is None:
        _SUPPORTED_FIELDS_CACHE = {f["key"] for f in FIELDS if f["target"] in ("toml", "merged")}
    return _SUPPORTED_FIELDS_CACHE


def get_ui_only_fields() -> set[str]:
    """返回仅 UI 使用、不传入 sd-scripts 的字段名集合（首次调用后缓存）"""
    global _UI_ONLY_FIELDS_CACHE
    if _UI_ONLY_FIELDS_CACHE is None:
        _UI_ONLY_FIELDS_CACHE = {f["key"] for f in FIELDS if f["target"] == "ui"}
    return _UI_ONLY_FIELDS_CACHE


# snake_case → camelCase key mapping for frontend
_FIELD_KEY_MAP = {
    "desc_key": "descKey",
    "hint_key": "hintKey",
    "show_if": "showIf",
    "show_if_any": "showIfAny",
    "label_key": "labelKey",
    "dk": "dKey",
    "auto_value": "autoValue",
    "readonly_if": "readonlyIf",
    "readonly_if_any": "readonlyIfAny",
    "reason_key": "reasonKey",
    "readonly_reason_key": "readonlyReasonKey",
    "set_target": "setTarget",
    "omit_default": "omitDefault",
    "sub_group": "subGroup",
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
        elif k == "show_if" and isinstance(v, list):
            # Multi-condition AND: list of dicts → list of converted dicts
            result[new_key] = [
                {("or" if sk == "_or" else ("neq" if sk == "neq" else sk)): sv
                 for sk, sv in cond.items()}
                for cond in v
            ]
        elif k == "show_if_any" and isinstance(v, list):
            # OR-of-ANDs: list[list[dict]] → 外层 OR，内层 AND 组各自转换
            result[new_key] = [
                [{("or" if sk == "_or" else ("neq" if sk == "neq" else sk)): sv
                  for sk, sv in cond.items()}
                 for cond in group]
                for group in v
            ]
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
        elif k == "readonly_if_any" and isinstance(v, list):
            # list[dict]: 任一条件（eq/neq）成立即锁定。reason_key 单独留在 field 顶层。
            result[new_key] = [
                {("neq" if ck == "neq" else ck): cv for ck, cv in cond.items()}
                for cond in v
            ]
        elif k == "auto_value" and isinstance(v, list):
            result[new_key] = [
                {_FIELD_KEY_MAP.get(ik, ik): iv for ik, iv in item.items()}
                for item in v
            ]
        else:
            result[new_key] = v
    return result


_fields_json_cache: dict | None = None


def get_fields_json() -> dict:
    """返回前端可用的字段定义 JSON"""
    global _fields_json_cache
    if _fields_json_cache is not None:
        return _fields_json_cache
    section_order = ["model", "network", "training", "optimizer", "regularization", "caption", "performance", "save", "preview", "misc"]
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
        "misc": {"title_key": "section.misc"},
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

    # Render sections in defined order; skip sections with no visible fields
    result_sections = []
    for s_key in section_order:
        if s_key in sections and sections[s_key]["fields"]:
            result_sections.append(sections[s_key])

    result = {
        "sections": result_sections,
    }
    _fields_json_cache = result
    return result
