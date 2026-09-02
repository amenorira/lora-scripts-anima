"""
训练字段注册表 — Single Source of Truth

统一管理所有训练参数的元数据：类型、默认值、所属分类、i18n key、
是否传递给 sd-scripts、条件显示规则、训练类型适用性、自动填值规则等。
前后端共享此定义。

添加新字段只需在此文件中新增一条记录，无需修改 adapter.py 或 config.js。
"""
from __future__ import annotations

from typing import Any

from backend.training.optimizer_contracts import (
    ADAFACTOR_OPTIMIZER_TYPE,
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    ADAN_OPTIMIZER_TYPE,
    ADEMAMIX8BIT_OPTIMIZER_TYPE,
    ADEMAMIX_OPTIMIZER_TYPE,
    AUTOMAGIC_MAX_LR_DEFAULT_TEXT,
    AUTOMAGIC_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    EMOSENS_OPTIMIZER_TYPE,
    LORA_MUON_OPTIMIZER_TYPE,
    LORARITE_OPTIMIZER_TYPE,
    MUON_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)
from backend.training.optimizer_metadata import (
    SD_OPTIMIZER_AUTO_VALUES,
    SD_SCRIPTS_PROFILE,
    optimizer_beta_hint_map,
    optimizer_eps_selectors,
    optimizer_groups,
)


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
#   nested     — 条件字段是否显示为父字段的缩进子项（可选，默认 true）。
#   hint_key   — 提示文本 i18n 键（可选）
#   hint_key_by — 按另一个字段当前值选择提示文本：
#                 {"key": "optimizer_type", "values": {"AdamW": "field.someHint"}}
#   step       — number 步长（可选）
#   min        — 最小值（可选）
#   max        — 最大值（可选）
#   hidden     — 是否隐藏（可选）
#   readonly   — 静态只读（可选）。用于展示由应用自动管理、不可手工覆盖的值。
#   group      — 所属训练类型: "all" / "sdxl" / "anima" / "diT", 列表表示多选
#                None 或 "all" 表示所有类型通用。前端根据 model_train_type 过滤显示。
#   auto_value — 自动填值规则（可选）: [{"watch": "key", "when": "val", "set": new_val}, ...]
#                set 为 null 表示恢复默认值。
#                set_if_default 为 true 时，仅在目标字段来源仍为默认值或自动推荐时更新。
#   omit_default — 默认值省略（可选，默认 false）。仅当 registry default == sd-scripts
#                  argparse default 时才可标记 True：前端在值==default 时不传给
#                  sd-scripts、不在 TOML 预览显示，输入框以淡色 placeholder 提示默认值。
#                  有意差异字段（learning_rate/mixed_precision/cache_* 等）禁止标记，
#                  否则不传会让 sd-scripts 用它自己的默认值，训练行为改变。

LORAPLUS_NETWORK_MODULES = (
    "networks.lora",
    "networks.lora_anima",
    "networks.loha",
    "networks.lokr",
)
LORAPLUS_RATIO_KEYS = (
    "loraplus_lr_ratio",
    "loraplus_unet_lr_ratio",
    "loraplus_text_encoder_lr_ratio",
)
LORAPLUS_INCOMPATIBLE_OPTIMIZERS = (
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    EMOSENS_OPTIMIZER_TYPE,
    # LoRA-RITE 要求参数按 A/B 交替配对；LoRA+ 的分组学习率会破坏该前提
    LORARITE_OPTIMIZER_TYPE,
    # LoRA-Muon 使用单一矩阵更新路径，无法保留 LoRA+ 的分组学习率
    LORA_MUON_OPTIMIZER_TYPE,
)

# AdaLN 调制层（Anima 专属）：上游默认经排除正则剔出 LoRA（lora_anima.py:254 追加
# .*(_modulation|_norm|_embedder|final_layer).*；loha/lokr 经 network_base.py 的 Anima
# ArchConfig 继承同一排除）。UI 开关由 adapter 注入 include_patterns 强制豁免排除，
# 三个模块的 include/exclude 机制一致（均对 original_name 做 fullmatch）。
ADALN_INCLUDE_MODULES = (
    "networks.lora_anima",
    "networks.loha",
    "networks.lokr",
)
ADALN_INCLUDE_PATTERN = r".*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*"


def _show_if_one_of(key: str, values: tuple[str, ...]) -> dict[str, Any]:
    condition: dict[str, Any] = {"key": key, "eq": values[0]}
    if len(values) > 1:
        condition["_or"] = list(values[1:])
    return condition


def _loraplus_ratio_show_if() -> list[list[dict[str, Any]]]:
    return [
        [
            {"key": "enable_loraplus", "eq": True},
            {"key": "network_module", "eq": module},
        ]
        for module in LORAPLUS_NETWORK_MODULES
    ]


def _loraplus_auto_disable_rules() -> list[dict[str, Any]]:
    rules = [
        {"watch": "optimizer_type", "when": optimizer, "set": False}
        for optimizer in LORAPLUS_INCOMPATIBLE_OPTIMIZERS
    ]
    rules.append(
        {
            "watch": {
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "adafactor_relative_step": True,
            },
            "set": False,
        }
    )
    rules.append(
        {
            "watch": {
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "adafactor_warmup_init": True,
            },
            "set": False,
        }
    )
    return rules


def _loraplus_readonly_conditions() -> list[dict[str, Any] | list[dict[str, Any]]]:
    conditions: list[dict[str, Any] | list[dict[str, Any]]] = [
        {"key": "optimizer_type", "eq": optimizer}
        for optimizer in LORAPLUS_INCOMPATIBLE_OPTIMIZERS
    ]
    conditions.append(
        [
            {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE},
            {"key": "adafactor_relative_step", "eq": True},
        ]
    )
    conditions.append(
        [
            {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE},
            {"key": "adafactor_warmup_init", "eq": True},
        ]
    )
    return conditions


_SD_OPTIMIZER_SELECTORS = tuple(
    entry["v"]
    for group in optimizer_groups(SD_SCRIPTS_PROFILE)
    for entry in group["options"]
)
_SD_BETA_HINTS = optimizer_beta_hint_map(SD_SCRIPTS_PROFILE)
_SD_EPS_OPTIMIZERS = optimizer_eps_selectors(SD_SCRIPTS_PROFILE)


FIELDS: list[dict[str, Any]] = [
# ── Model ──
{"key": "model_train_type", "type": "select", "default": "sdxl-lora", "section": "model", "desc_key": "field.model_train_type", "target": "ui", "hidden": True, "options": [{"v": "sdxl-lora", "l": "SDXL LoRA", "dk": "opt.model_train_type_sdxl-lora"}, {"v": "anima-lora", "l": "Anima LoRA", "dk": "opt.model_train_type_anima-lora"}, {"v": "krea2-lora", "l": "Krea 2 LoRA", "dk": "opt.model_train_type_krea2-lora"}]},
# 三个底模路径默认指向环境管理页可下载的 Anima 核心文件（见 tools/download_anima_model.py）。
# 用户下载后即可直接开训，无需手动填写；路径与 ANIMA_FILES 的本地文件名保持一致。
{"key": "pretrained_model_name_or_path", "type": "text", "default": "./models/anima-base-v1.0.safetensors", "section": "model", "desc_key": "field.pretrained_model_name_or_path", "target": "toml", "role": "file-model", "required": True},
{"key": "vae", "type": "text", "default": "./models/qwen_image_vae.safetensors", "section": "model", "desc_key": "field.vae", "target": "toml", "role": "file-model", "requiredGroups": ["anima"]},
{"key": "qwen3", "type": "text", "default": "./models/qwen_3_06b_base.safetensors", "section": "model", "desc_key": "field.qwen3", "hint_key": "field.qwen3Hint", "target": "toml", "role": "file-model", "group": "anima", "required": True},
{"key": "train_data_dir", "type": "text", "default": "./train", "section": "model", "desc_key": "field.train_data_dir", "target": "toml", "role": "file-folder", "required": True},
# ── 正则化数据（DreamBooth 正则）──
# sd-scripts 侧：train_network.py:942 经 generate_dreambooth_subsets_config_by_subdirs 把 reg_data_dir 子目录
# 生成 is_reg=True 的 subset，loss 按 prior_loss_weight 加权（library/dataset.py:1016）。
# 开关关闭时字段不可见 → 不进 TOML，行为与不填完全一致；目录须为独立目录，不能混入训练目录
# （*_reg 文件夹放在训练目录里会被当作普通训练子集，见 config_util.py extract_dreambooth_params）。
# prior_loss_weight 与 reg_data_dir 同槽展示（开开关即可见），不放进"正则化与损失"折叠区。
{"key": "enable_reg_data", "type": "toggle", "default": False, "section": "model", "desc_key": "field.enable_reg_data", "hint_key": "field.enable_reg_dataHint", "target": "ui"},
{"key": "reg_data_dir", "type": "text", "default": "", "section": "model", "desc_key": "field.reg_data_dir", "hint_key": "field.reg_data_dirHint", "target": "toml", "role": "file-folder", "omit_default": True, "show_if": {"key": "enable_reg_data", "eq": True}},
{"key": "prior_loss_weight", "type": "number", "default": 1.0, "section": "model", "desc_key": "field.prior_loss_weight", "hint_key": "field.prior_loss_weightHint", "target": "toml", "min": 0, "step": 0.1, "show_if": {"key": "enable_reg_data", "eq": True}, "omit_default": True},
{"key": "resume", "type": "text", "default": "", "section": "model", "desc_key": "field.resume", "hint_key": "field.resumeHint", "target": "toml", "role": "file-folder"},
{"key": "resolution", "type": "text", "default": "1024,1024", "section": "model", "desc_key": "field.resolution", "target": "toml", "hint_key": "field.resolutionHint", "required": True},
{"key": "enable_bucket", "type": "toggle", "default": True, "section": "model", "desc_key": "field.enable_bucket", "target": "toml", "hint_key": "field.enable_bucketHint"},
{"key": "bucket_no_upscale", "type": "toggle", "default": True, "section": "model", "desc_key": "field.bucket_no_upscale", "target": "toml", "hint_key": "field.bucket_no_upscaleHint", "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "min_bucket_reso", "type": "number", "default": 256, "section": "model", "desc_key": "field.min_bucket_reso", "target": "toml", "min": 64, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}, "omit_default": True},
{"key": "max_bucket_reso", "type": "number", "default": 2048, "section": "model", "desc_key": "field.max_bucket_reso", "target": "toml", "min": 256, "step": 64, "show_if": {"key": "enable_bucket", "eq": True}},
{"key": "bucket_reso_steps", "type": "number", "default": 64, "section": "model", "desc_key": "field.bucket_reso_steps", "target": "toml", "min": 16, "step": 16, "constraints_by_group": {"sdxl": {"min": 32, "step": 32}, "anima": {"min": 16, "step": 16}}, "show_if": {"key": "enable_bucket", "eq": True}, "hint_key": "field.bucket_reso_stepsHint", "omit_default": True},
{"key": "v_parameterization", "type": "toggle", "default": False, "section": "model", "desc_key": "field.v_parameterization", "hint_key": "field.v_parameterizationHint", "target": "toml", "group": "sdxl"},
# 与 v_parameterization 属于同一训练目标设置；保留条件显示，但不作为缩进子项。
{"key": "zero_terminal_snr", "type": "toggle", "default": False, "section": "model", "desc_key": "field.zero_terminal_snr", "target": "toml", "group": "sdxl", "show_if": {"key": "v_parameterization", "eq": True}, "nested": False, "omit_default": True},
# ── Network ──
# 通用基础参数在前（对所有 module 生效）；network_module 作为"算法开关"置于其后。
# show_if 子参数紧随触发源展开（A1 重排），按层级缩进渲染，不引入额外的分组盒子。
{"key": "network_train_unet_only", "type": "toggle", "default": True, "section": "network", "desc_key": "field.network_train_unet_only", "target": "toml"},
{"key": "network_train_text_encoder_only", "type": "toggle", "default": False, "section": "network", "desc_key": "field.network_train_text_encoder_only", "target": "toml", "omit_default": True},
{"key": "network_dim", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_dim", "hint_key": "field.network_dimHint", "hint_key_by": {"key": "optimizer_type", "values": {LORA_MUON_OPTIMIZER_TYPE: "field.network_dimHint_lora_muon"}}, "target": "toml", "min": 1, "max": 256, "step": 1},
{"key": "network_alpha", "type": "number", "default": 32, "section": "network", "desc_key": "field.network_alpha", "hint_key": "field.network_alphaHint", "hint_key_by": {"key": "optimizer_type", "values": {LORA_MUON_OPTIMIZER_TYPE: "field.network_alphaHint_lora_muon"}}, "target": "toml", "min": 1},
{"key": "network_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.network_weights", "hint_key": "field.network_weightsHint", "target": "toml", "role": "file-model-saved"},
{"key": "dim_from_weights", "type": "toggle", "default": False, "section": "network", "desc_key": "field.dim_from_weights", "target": "toml", "show_if": {"key": "network_weights", "neq": ""}, "hint_key": "field.dim_from_weightsHint"},
# network_dropout 是 train_network.py 顶层 CLI（:1930），对所有 module 自动经 neuron_dropout= 兜底传入
# create_network（train_network.py:1081-1093）。四个原生模块签名一致均消费 neuron_dropout
# （lora.py:423 / lora_anima.py:232 / loha.py:406 / lokr.py:400）。LyCORIS 与下方专用 dropout 同槽
# （train_network.py:1081 "dropout in net_kwargs" 检测：专用 dropout 在 network_args 中先占槽 → network_dropout 不再注入）。
# 故为顶层 Network 参数，不带 show_if（与 network_dim/network_alpha 同级），对所有模块可见。
{"key": "network_dropout", "type": "number", "default": 0, "section": "network", "desc_key": "field.network_dropout", "target": "toml", "min": 0, "max": 0.5, "step": 0.01, "hint_key": "field.network_dropoutHint"},
# ── 算法开关：network_module（选不同模块后，下列子参数紧随其后展开）──
{"key": "network_module", "type": "select", "default": "networks.lora", "section": "network", "desc_key": "field.network_module", "target": "toml", "options": [{"v": "networks.lora_anima", "l": "networks.lora_anima", "dk": "opt.network_module_networks_lora_anima", "group": "anima"}, {"v": "networks.lora", "l": "networks.lora", "dk": "opt.network_module_networks_lora", "group": "sdxl"}, {"v": "networks.loha", "l": "networks.loha", "dk": "opt.network_module_networks_loha"}, {"v": "networks.lokr", "l": "networks.lokr", "dk": "opt.network_module_networks_lokr"}, {"v": "lycoris.kohya", "l": "lycoris.kohya", "dk": "opt.network_module_lycoris_kohya"}]},
    # ── 平级开关（nested: False）：与 network_module 同级渲染，仅显隐与其联动 ──
    # AdaLN 调制层（Anima 专属，见上方 ADALN_* 常量注释）。lycoris.kohya 的 Anima
    # 路径未验证，不在支持集合内。
    {"key": "train_adaln", "type": "toggle", "default": False, "section": "network", "desc_key": "field.train_adaln", "target": "ui", "group": "anima", "nested": False, "show_if": _show_if_one_of("network_module", ADALN_INCLUDE_MODULES), "hint_key": "field.train_adalnHint", "doc_slug": "adaln", "doc_anchor": "overview"},
    # LoRA+ 是 network_args 功能，不是顶层 CLI 参数。UI 开关仅控制是否生成下列三个
    # sd-scripts 原生参数；支持面与各 network module 的 create_network 实现保持一致。
    {"key": "enable_loraplus", "type": "toggle", "default": False, "section": "network", "desc_key": "field.enable_loraplus", "target": "ui", "nested": False, "show_if": _show_if_one_of("network_module", LORAPLUS_NETWORK_MODULES), "hint_key": "field.enable_loraplusHint", "auto_value": _loraplus_auto_disable_rules(), "readonly_if_any": _loraplus_readonly_conditions(), "readonly_reason_key": "field.enable_loraplus_optimizerLocked", "doc_slug": "lora-plus", "doc_anchor": "overview"},
    # 三个比率项的 show_if_any 每组末位是 network_module，不显式 layout_parent 会被
    # 归到 network_module 下；这里显式挂到 enable_loraplus 作为其子项。
    {"key": "loraplus_lr_ratio", "type": "number", "default": 2.0, "section": "network", "desc_key": "field.loraplus_lr_ratio", "target": "ui", "min": 1.0, "step": 0.5, "layout_parent": "enable_loraplus", "show_if_any": _loraplus_ratio_show_if(), "hint_key": "field.loraplus_lr_ratioHint", "doc_slug": "lora-plus", "doc_anchor": "loraplus-lr-ratio"},
    {"key": "loraplus_unet_lr_ratio", "type": "number", "default": "", "section": "network", "desc_key": "field.loraplus_unet_lr_ratio", "target": "ui", "min": 1.0, "step": 0.5, "layout_parent": "enable_loraplus", "show_if_any": _loraplus_ratio_show_if(), "hint_key": "field.loraplus_unet_lr_ratioHint", "doc_slug": "lora-plus", "doc_anchor": "loraplus-unet-lr-ratio"},
    {"key": "loraplus_text_encoder_lr_ratio", "type": "number", "default": "", "section": "network", "desc_key": "field.loraplus_text_encoder_lr_ratio", "target": "ui", "min": 1.0, "step": 0.5, "layout_parent": "enable_loraplus", "show_if_any": _loraplus_ratio_show_if(), "hint_key": "field.loraplus_text_encoder_lr_ratioHint", "doc_slug": "lora-plus", "doc_anchor": "loraplus-text-encoder-lr-ratio"},
    # lycoris.kohya 算法选择器 + 预设：作为 network_module 的第 1、2 个子参数紧随其后展开，
    # 其余 lycoris 子参数一律按 show_if 挂到 network_module / lycoris_algo 下做层级缩进。
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
    {"key": "rank_dropout", "type": "number", "section": "network", "desc_key": "field.rank_dropout", "target": "ui", "min": 0, "max": 0.99, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"]}, "hint_key": "field.rank_dropoutHint"},
    {"key": "module_dropout", "type": "number", "section": "network", "desc_key": "field.module_dropout", "target": "ui", "min": 0, "max": 1, "step": 0.01, "show_if": {"key": "network_module", "eq": "networks.lora", "_or": ["networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"]}, "hint_key": "field.module_dropoutHint"},
    # use_tucker：仅 Conv2d 3x3+ 的 Tucker 分解有效。原生 loha/lokr 模块消费；
    # lycoris 仅 LoCon/Loha/Lokr 模块消费（dylora/glora/ia3/diag-oft/boft 签名有但忽略）。
    # 故显示条件为 OR-of-ANDs：原生 loha/lokr，或 lycoris.kohya + algo∈{lora,loha,lokr}。
    {"key": "use_tucker", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_tucker", "target": "ui", "show_if_any": [[{"key": "network_module", "eq": "networks.loha"}], [{"key": "network_module", "eq": "networks.lokr"}], [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}]], "hint_key": "field.use_tuckerHint", "omit_default": True},
    # lycoris.kohya 其他基础子参数。use_scalar 按算法显示（show_if 末位是 lycoris_algo → 挂其下）
    {"key": "use_scalar", "type": "toggle", "default": False, "section": "network", "desc_key": "field.use_scalar", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr", "glora"]}], "omit_default": True},
    {"key": "decompose_both", "type": "toggle", "default": False, "section": "network", "desc_key": "field.decompose_both", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "omit_default": True},
    {"key": "dropout", "type": "number", "section": "network", "desc_key": "field.lycoris_dropout", "target": "ui", "min": 0, "max": 0.5, "step": 0.01, "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "hint_key": "field.lycoris_dropoutHint"},
    # lycoris.kohya 算法子参数：算法特定的挂 lycoris_algo 下（show_if 末位是 lycoris_algo），
    # 对所有算法生效的 train_norm/bypass_mode 挂 network_module 下。
    {"key": "full_matrix", "type": "toggle", "default": False, "section": "network", "desc_key": "field.full_matrix", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "omit_default": True},
    {"key": "train_norm", "type": "toggle", "default": False, "section": "network", "desc_key": "field.train_norm", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "omit_default": True},
    {"key": "dora_wd", "type": "toggle", "default": False, "section": "network", "desc_key": "field.dora_wd", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}], "hint_key": "field.dora_wdHint", "omit_default": True},
    {"key": "block_size", "type": "number", "default": 4, "section": "network", "desc_key": "field.block_size", "hint_key": "field.block_sizeHint", "target": "ui", "min": 1, "step": 1, "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "dylora"}], "omit_default": True},
    {"key": "constraint", "type": "number", "default": 0, "step": 0.1, "section": "network", "desc_key": "field.constraint", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "diag-oft", "_or": ["boft"]}], "hint_key": "field.constraintHint", "omit_default": True},
    {"key": "rescaled", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rescaled", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "diag-oft", "_or": ["boft"]}], "omit_default": True},
    {"key": "bypass_mode", "type": "toggle", "default": False, "section": "network", "desc_key": "field.bypass_mode", "target": "ui", "show_if": {"key": "network_module", "eq": "lycoris.kohya"}, "omit_default": True},
    {"key": "rs_lora", "type": "toggle", "default": False, "section": "network", "desc_key": "field.rs_lora", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr", "glora"]}], "hint_key": "field.rs_loraHint", "omit_default": True},
    {"key": "unbalanced_factorization", "type": "toggle", "default": False, "section": "network", "desc_key": "field.unbalanced_factorization", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lokr"}], "omit_default": True},
    # wd_on_output：DoRA 权重分解的作用维度（输出 vs 输入）。仅 dora_wd=True（开启 DoRA）时生效，
    # 故显示条件追加 dora_wd=True（lycoris 各模块仅在 self.wd 为真时才读 wd_on_out）。
    {"key": "wd_on_output", "type": "toggle", "default": True, "section": "network", "desc_key": "field.wd_on_output", "target": "ui", "show_if": [{"key": "network_module", "eq": "lycoris.kohya"}, {"key": "lycoris_algo", "eq": "lora", "_or": ["loha", "lokr"]}, {"key": "dora_wd", "eq": True}], "hint_key": "field.wd_on_outputHint", "omit_default": True},
    # ── 通用参数（所有 module 可见）──
    # base_weights：训练前把已有 LoRA 权重合并进 base 模型再训练（LoRA 叠加工作流）。
    # sd-scripts argparse nargs="*"，adapter 把逗号分隔字符串转 list。
    {"key": "scale_weight_norms", "type": "number", "section": "network", "desc_key": "field.scale_weight_norms", "target": "toml", "min": 0, "step": 0.01, "hint_key": "field.scale_weight_normsHint"},
    {"key": "base_weights", "type": "text", "default": "", "section": "network", "desc_key": "field.base_weights", "target": "toml", "hint_key": "field.base_weightsHint"},
    {"key": "base_weights_multiplier", "type": "text", "default": "", "section": "network", "desc_key": "field.base_weights_multiplier", "target": "toml", "hint_key": "field.base_weights_multiplierHint", "show_if": {"key": "base_weights", "neq": ""}},
    {"key": "network_args_custom", "type": "textarea", "default": "", "section": "network", "desc_key": "field.network_args_custom", "target": "ui", "hint_key": "field.network_args_customHint"},
# ── Training Core ──
{"key": "max_train_epochs", "type": "number", "default": 10, "section": "training", "desc_key": "field.max_train_epochs", "target": "toml", "min": 1},
{"key": "train_batch_size", "type": "number", "default": 1, "section": "training", "desc_key": "field.train_batch_size", "target": "toml", "min": 1, "hint_key": "field.train_batch_sizeHint", "omit_default": True},
{"key": "gradient_accumulation_steps", "type": "number", "default": 1, "section": "training", "desc_key": "field.gradient_accumulation_steps", "target": "toml", "min": 1, "hint_key": "field.gradient_accumulation_stepsHint", "auto_value": [{"watch": "optimizer_type", "when": EMOSENS_OPTIMIZER_TYPE, "set": 1}], "readonly_if": {"key": "optimizer_type", "eq": EMOSENS_OPTIMIZER_TYPE, "reason_key": "field.gradient_accumulation_steps_emosensLocked"}, "omit_default": True},
{"key": "gradient_checkpointing", "type": "toggle", "default": False, "section": "training", "desc_key": "field.gradient_checkpointing", "target": "toml", "hint_key": "field.gradient_checkpointingHint", "omit_default": True},
{"key": "seed", "type": "number", "default": 1337, "section": "training", "desc_key": "field.seed", "target": "toml"},
{"key": "mixed_precision", "type": "select", "default": "bf16", "section": "training", "desc_key": "field.mixed_precision", "hint_key": "field.mixed_precisionHint", "target": "toml", "options": [{"v": "bf16", "l": "bf16", "dk": "opt.mixed_precision_bf16"}, {"v": "fp16", "l": "fp16", "dk": "opt.mixed_precision_fp16"}, {"v": "no", "l": "no", "dk": "opt.mixed_precision_no"}]},
    # full_bf16: 将模型 + Network 全部参数 cast 为 bf16，消除 autocast 与 compile/LoRA 交互的 dtype 不一致问题。
    # 与 mixed_precision=bf16 搭配使用；仅在选择 bf16 时显示。默认关闭（标准 mixed precision 行为）。
    {"key": "full_bf16", "type": "toggle", "default": False, "section": "training", "desc_key": "field.full_bf16", "hint_key": "field.full_bf16Hint", "target": "toml", "show_if": {"key": "mixed_precision", "eq": "bf16"}, "auto_value": [{"watch": "optimizer_type", "when": AUTOMAGIC_OPTIMIZER_TYPE, "set": False}], "readonly_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE, "reason_key": "field.full_bf16_automagicLocked"}, "omit_default": True},
    # Anima: Timestep & Weighting (training core for DiT)
    {"key": "timestep_sampling", "type": "select", "default": "sigmoid", "section": "training", "desc_key": "field.timestep_sampling", "hint_key": "field.timestep_samplingHint", "target": "toml", "group": "anima", "options": [{"v": "sigmoid", "l": "sigmoid", "dk": "opt.timestep_sampling_sigmoid"}, {"v": "sigma", "l": "sigma", "dk": "opt.timestep_sampling_sigma"}, {"v": "uniform", "l": "uniform", "dk": "opt.timestep_sampling_uniform"}, {"v": "shift", "l": "shift", "dk": "opt.timestep_sampling_shift"}, {"v": "flux_shift", "l": "flux_shift", "dk": "opt.timestep_sampling_flux_shift"}], "doc_slug": "timesteps", "doc_anchor": "sampling"},
    {"key": "sigmoid_scale", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.sigmoid_scale", "hint_key": "field.sigmoid_scaleHint", "target": "toml", "step": 0.001, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "sigmoid", "_or": ["shift", "flux_shift"]}, "omit_default": True, "doc_slug": "timesteps", "doc_anchor": "sigmoid-scale"},
    {"key": "discrete_flow_shift", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.discrete_flow_shift", "hint_key": "field.discrete_flow_shiftHint", "target": "toml", "min": 0.01, "step": 0.01, "group": "anima", "show_if": {"key": "timestep_sampling", "eq": "shift", "_or": ["sigma"]}, "omit_default": True, "doc_slug": "timesteps", "doc_anchor": "flow-shift"},
    {"key": "weighting_scheme", "type": "select", "default": "uniform", "section": "training", "desc_key": "field.weighting_scheme", "hint_key": "field.weighting_schemeHint", "target": "toml", "group": "anima", "options": [{"v": "uniform", "l": "uniform", "dk": "opt.weighting_scheme_uniform"}, {"v": "sigma_sqrt", "l": "sigma_sqrt", "dk": "opt.weighting_scheme_sigma_sqrt"}, {"v": "logit_normal", "l": "logit_normal", "dk": "opt.weighting_scheme_logit_normal"}, {"v": "mode", "l": "mode", "dk": "opt.weighting_scheme_mode"}, {"v": "cosmap", "l": "cosmap", "dk": "opt.weighting_scheme_cosmap"}], "doc_slug": "timesteps", "doc_anchor": "weighting"},
    # logit_mean/logit_std/mode_scale 是 weighting_scheme 的子参数。前端 _fieldLayoutParentKey
    # 对 show_if 数组从尾部取父键（会取到 timestep_sampling），故必须显式 layout_parent，
    # 否则三个字段会被提到 weighting_scheme 之前、把它挤到时间步分组末尾。
    {"key": "logit_mean", "type": "number", "default": 0.0, "section": "training", "desc_key": "field.logit_mean", "hint_key": "field.logit_meanHint", "target": "toml", "step": 0.01, "group": "anima", "layout_parent": "weighting_scheme", "show_if": [{"key": "weighting_scheme", "eq": "logit_normal"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True, "doc_slug": "timesteps", "doc_anchor": "logit-normal"},
    {"key": "logit_std", "type": "number", "default": 1.0, "section": "training", "desc_key": "field.logit_std", "hint_key": "field.logit_stdHint", "target": "toml", "step": 0.01, "group": "anima", "layout_parent": "weighting_scheme", "show_if": [{"key": "weighting_scheme", "eq": "logit_normal"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True, "doc_slug": "timesteps", "doc_anchor": "logit-normal"},
    {"key": "mode_scale", "type": "number", "default": 1.29, "section": "training", "desc_key": "field.mode_scale", "hint_key": "field.mode_scaleHint", "target": "toml", "step": 0.01, "group": "anima", "layout_parent": "weighting_scheme", "show_if": [{"key": "weighting_scheme", "eq": "mode"}, {"key": "timestep_sampling", "eq": "sigma"}], "omit_default": True, "doc_slug": "timesteps", "doc_anchor": "mode"},
    {"key": "subset_timestep_offsets", "type": "hidden", "default": {}, "section": "training", "desc_key": "field.subset_timestep_offsets", "target": "ui", "group": "anima", "hidden": True},
    # SDXL/SD3: 时间步范围控制（对 Anima flow-matching 训练无效，故划归 sdxl 组）
    {"key": "min_timestep", "type": "number", "section": "training", "desc_key": "field.min_timestep", "target": "toml", "min": 0, "max": 999, "step": 1, "group": "sdxl", "hint_key": "field.min_timestepHint", "doc_slug": "timesteps", "doc_anchor": "sdxl-range"},
    {"key": "max_timestep", "type": "number", "default": "", "section": "training", "desc_key": "field.max_timestep", "target": "toml", "min": 1, "max": 1000, "step": 1, "group": "sdxl", "hint_key": "field.max_timestepHint", "doc_slug": "timesteps", "doc_anchor": "sdxl-range"},
# ── Learning Rate & Optimizer ──
# 学习率取值链：unet_lr / text_encoder_lr 非空时覆盖 learning_rate；为空时回退 learning_rate。
# 默认留空 → 默认走 learning_rate 一个总学习率（符合 sd-scripts fallback 语义与 i18n 描述）；
# 用户想分开调 U-Net / 文本编码器学习率时再填入分量值。
# auto_value 范围：
#   - Anima：按优化器提供保守起点；仅覆盖未手动修改的值，导入配置保持原值。
#   - Prodigy→1.0、EmoSens+Anima→0.1、EmoSens+SDXL→1.0（算法缩放基准）。
#   - unet_lr / text_encoder_lr：仅 Prodigy 填 1.0 并只读（D-adaptation 硬性要求三者同 1.0）。
#     EmoSens 不预填分量，内部 emoPulse 统一使用 learning_rate。
# 开关联动（adapter 强制 + 前端 setField 同步）：
#   network_train_unet_only=True   → text_encoder_lr 置空（被排除的分量不写 TOML）
#   network_train_text_encoder_only=True → unet_lr 置空
{"key": "optimizer_type", "type": "select", "default": "AdamW8bit", "section": "optimizer", "desc_key": "field.optimizer_type", "target": "toml", "doc_slug": "optimizers", "doc_anchor": "optimizer-type", "groups": optimizer_groups(SD_SCRIPTS_PROFILE), "keep_children_position": True},
{"key": "learning_rate", "type": "text", "default": "1e-4", "section": "optimizer", "desc_key": "field.learning_rate", "target": "toml", "hint_key_by": {"key": "optimizer_type", "values": {LORA_MUON_OPTIMIZER_TYPE: "field.learning_rateHint_lora_muon"}}, "doc_slug": "optimizers", "doc_anchor": "learning-rate", "auto_value": SD_OPTIMIZER_AUTO_VALUES["learning_rate"], "readonly_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE, "_or": [PRODIGYPLUS_OPTIMIZER_TYPE], "reason_key": "field.learning_rate_prodigyLocked"}},
{"key": "unet_lr", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.unet_lr", "target": "toml", "show_if": {"key": "network_train_text_encoder_only", "neq": True}, "auto_value": [{"watch": "optimizer_type", "when": PRODIGY_OPTIMIZER_TYPE, "set": "1.0"}, {"watch": "optimizer_type", "when": PRODIGYPLUS_OPTIMIZER_TYPE, "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE, "_or": [PRODIGYPLUS_OPTIMIZER_TYPE], "reason_key": "field.unet_lr_prodigyLocked"}, "omit_default": True},
{"key": "text_encoder_lr", "type": "text", "default": "", "section": "optimizer", "desc_key": "field.text_encoder_lr", "target": "toml", "show_if": {"key": "network_train_unet_only", "neq": True}, "auto_value": [{"watch": "optimizer_type", "when": PRODIGY_OPTIMIZER_TYPE, "set": "1.0"}, {"watch": "optimizer_type", "when": PRODIGYPLUS_OPTIMIZER_TYPE, "set": "1.0"}], "readonly_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE, "_or": [PRODIGYPLUS_OPTIMIZER_TYPE], "reason_key": "field.text_encoder_lr_prodigyLocked"}, "omit_default": True},
{"key": "lr_scheduler", "type": "select", "default": "cosine_with_restarts", "section": "optimizer", "desc_key": "field.lr_scheduler", "hint_key": "field.lr_schedulerHint", "target": "toml", "doc_slug": "optimizers", "doc_anchor": "scheduler-warmup", "options": [{"v": "cosine_with_restarts", "l": "cosine_with_restarts", "dk": "opt.lr_scheduler_cosine_with_restarts"}, {"v": "cosine", "l": "cosine", "dk": "opt.lr_scheduler_cosine"}, {"v": "linear", "l": "linear", "dk": "opt.lr_scheduler_linear"}, {"v": "polynomial", "l": "polynomial", "dk": "opt.lr_scheduler_polynomial"}, {"v": "constant", "l": "constant", "dk": "opt.lr_scheduler_constant"}, {"v": "constant_with_warmup", "l": "constant_with_warmup", "dk": "opt.lr_scheduler_constant_with_warmup"}], "auto_value": [{"watch": "optimizer_type", "when": PRODIGY_OPTIMIZER_TYPE, "set": "cosine", "set_if_default": True}, {"watch": "optimizer_type", "when": EMOSENS_OPTIMIZER_TYPE, "set": "constant"}, {"watch": "optimizer_type", "when": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "set": "constant"}, {"watch": "optimizer_type", "when": PRODIGYPLUS_OPTIMIZER_TYPE, "set": "constant"}, {"watch": "optimizer_type", "when": AUTOMAGIC_OPTIMIZER_TYPE, "set": "constant"}, {"watch": {"optimizer_type": ADAFACTOR_OPTIMIZER_TYPE, "adafactor_relative_step": True}, "set": "constant"}, {"watch": "model_train_type", "when": "anima-lora", "set": "constant", "set_if_default": True}], "readonly_if_any": [{"key": "optimizer_type", "eq": EMOSENS_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": PRODIGYPLUS_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, [{"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, {"key": "adafactor_relative_step", "eq": True}]], "readonly_reason_key": "field.lr_scheduler_locked"},
{"key": "lr_warmup_steps", "type": "number", "default": 0, "section": "optimizer", "desc_key": "field.lr_warmup_steps", "target": "toml", "min": 0, "auto_value": [{"watch": "optimizer_type", "when": EMOSENS_OPTIMIZER_TYPE, "set": 0}, {"watch": "optimizer_type", "when": AUTOMAGIC_OPTIMIZER_TYPE, "set": 0}, {"watch": "optimizer_type", "when": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "set": 0}, {"watch": "optimizer_type", "when": PRODIGYPLUS_OPTIMIZER_TYPE, "set": 0}, {"watch": {"optimizer_type": ADAFACTOR_OPTIMIZER_TYPE, "adafactor_relative_step": True}, "set": 0}], "readonly_if_any": [{"key": "optimizer_type", "eq": EMOSENS_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": PRODIGYPLUS_OPTIMIZER_TYPE}, [{"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, {"key": "adafactor_relative_step", "eq": True}]], "readonly_reason_key": "field.lr_warmup_steps_internalLocked", "omit_default": True, "doc_slug": "optimizers", "doc_anchor": "scheduler-warmup"},
{"key": "lr_scheduler_num_cycles", "type": "number", "default": 1, "section": "optimizer", "desc_key": "field.lr_scheduler_num_cycles", "target": "toml", "min": 1, "show_if": {"key": "lr_scheduler", "eq": "cosine_with_restarts"}, "omit_default": True},
{"key": "lr_scheduler_power", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.lr_scheduler_power", "target": "toml", "min": 0.1, "step": 0.1, "show_if": {"key": "lr_scheduler", "eq": "polynomial"}, "omit_default": True},
{"key": "max_grad_norm", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.max_grad_norm", "target": "toml", "min": 0, "step": 0.1, "hint_key": "field.max_grad_normHint", "hint_key_by": {"key": "optimizer_type", "values": {LORA_MUON_OPTIMIZER_TYPE: "field.max_grad_normHint_lora_muon"}}, "auto_value": [{"watch": "optimizer_type", "when": ADAFACTOR_OPTIMIZER_TYPE, "set": 0}, {"watch": "optimizer_type", "when": LORARITE_OPTIMIZER_TYPE, "set": 0}, {"watch": {"optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE, "prodigyplus_use_stableadamw": True}, "set": 0}, {"watch": {"optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE, "eps": "None"}, "set": 0}, {"watch": "optimizer_type", "when": PRODIGY_OPTIMIZER_TYPE, "set": 0, "set_if_default": True}, {"watch": {"optimizer_type": LORA_MUON_OPTIMIZER_TYPE, "model_train_type": "anima-lora"}, "set": 0, "set_if_default": True}], "readonly_if_any": [{"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, {"key": "optimizer_type", "eq": LORARITE_OPTIMIZER_TYPE}, [{"key": "optimizer_type", "eq": PRODIGYPLUS_OPTIMIZER_TYPE}, {"key": "prodigyplus_use_stableadamw", "eq": True}], [{"key": "optimizer_type", "eq": PRODIGYPLUS_OPTIMIZER_TYPE}, {"key": "eps", "eq": "None"}]], "readonly_reason_key": "field.max_grad_norm_optimizerLocked", "omit_default": True, "doc_slug": "optimizers", "doc_anchor": "gradient-clipping"},
{"key": "weight_decay", "type": "number", "default": "", "section": "optimizer", "desc_key": "field.weight_decay", "target": "merged", "min": 0, "step": 0.001, "hint_key": "field.weight_decayHint", "doc_slug": "optimizers", "doc_anchor": "weight-decay", "auto_value": SD_OPTIMIZER_AUTO_VALUES["weight_decay"], "layout_parent": "optimizer_type"},
{"key": "bnb_percentile_clipping", "type": "number", "default": 100, "section": "optimizer", "desc_key": "field.bnb_percentile_clipping", "target": "merged", "min": 1, "max": 100, "step": 1, "show_if": {"key": "optimizer_type", "eq": "AdamW8bit", "_or": ["PagedAdamW8bit", "Lion8bit", "PagedLion8bit"]}, "hint_key": "field.bnb_percentile_clippingHint", "doc_slug": "optimizers", "doc_anchor": "percentile-clipping"},
{"key": "bnb_min_8bit_size", "type": "number", "default": 4096, "section": "optimizer", "desc_key": "field.bnb_min_8bit_size", "target": "merged", "min": 0, "step": 1, "show_if": {"key": "optimizer_type", "eq": "AdamW8bit", "_or": ["PagedAdamW8bit", "Lion8bit", "PagedLion8bit"]}, "hint_key": "field.bnb_min_8bit_sizeHint", "doc_slug": "optimizers", "doc_anchor": "min-8bit-size"},
{"key": "stableadamw_kahan_sum", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.stableadamw_kahan_sum", "target": "merged", "show_if": {"key": "optimizer_type", "eq": STABLE_ADAMW_OPTIMIZER_TYPE}, "hint_key": "field.stableadamw_kahan_sumHint", "doc_slug": "optimizers", "doc_anchor": "stableadamw-options"},
{"key": "stableadamw_weight_decouple", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.stableadamw_weight_decouple", "target": "merged", "show_if": {"key": "optimizer_type", "eq": STABLE_ADAMW_OPTIMIZER_TYPE}, "hint_key": "field.stableadamw_weight_decoupleHint", "doc_slug": "optimizers", "doc_anchor": "stableadamw-options"},
{"key": "muon_adjust_lr_fn", "type": "select", "default": "match_rms_adamw", "section": "optimizer", "desc_key": "field.muon_adjust_lr_fn", "hint_key": "field.muon_adjust_lr_fnHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": MUON_OPTIMIZER_TYPE}, "options": [{"v": "match_rms_adamw", "l": "match_rms_adamw", "dk": "opt.muon_adjust_lr_match_rms_adamw"}, {"v": "original", "l": "original", "dk": "opt.muon_adjust_lr_original"}], "doc_slug": "optimizers", "doc_anchor": "muon-options"},
{"key": "muon_momentum", "type": "number", "default": 0.95, "section": "optimizer", "desc_key": "field.muon_momentum", "hint_key": "field.muon_momentumHint", "target": "merged", "min": 0, "step": 0.01, "show_if": {"key": "optimizer_type", "eq": MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "muon-options"},
{"key": "muon_nesterov", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.muon_nesterov", "hint_key": "field.muon_nesterovHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "muon-options"},
{"key": "muon_ns_steps", "type": "number", "default": 5, "section": "optimizer", "desc_key": "field.muon_ns_steps", "hint_key": "field.muon_ns_stepsHint", "target": "merged", "min": 1, "max": 99, "step": 1, "show_if": {"key": "optimizer_type", "eq": MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "muon-options"},
{"key": "muon_ns_coefficients", "type": "text", "default": "3.4445, -4.775, 2.0315", "section": "optimizer", "desc_key": "field.muon_ns_coefficients", "hint_key": "field.muon_ns_coefficientsHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "muon-options"},
{"key": "momentum", "type": "number", "default": 0.9, "section": "optimizer", "desc_key": "field.lora_muon_momentum", "hint_key": "field.lora_muon_momentumHint", "target": "merged", "min": 0, "max": 0.999999, "step": 0.01, "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "ns_steps", "type": "number", "default": 8, "section": "optimizer", "desc_key": "field.lora_muon_ns_steps", "hint_key": "field.lora_muon_ns_stepsHint", "target": "merged", "min": 1, "max": 8, "step": 1, "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "inv_sqrt_steps", "type": "number", "default": 7, "section": "optimizer", "desc_key": "field.lora_muon_inv_sqrt_steps", "hint_key": "field.lora_muon_inv_sqrt_stepsHint", "target": "merged", "min": 1, "max": 7, "step": 1, "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "msign_eps", "type": "text", "default": "1e-20", "section": "optimizer", "desc_key": "field.lora_muon_msign_eps", "hint_key": "field.lora_muon_msign_epsHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "inv_sqrt_eps", "type": "text", "default": "1e-5", "section": "optimizer", "desc_key": "field.lora_muon_inv_sqrt_eps", "hint_key": "field.lora_muon_inv_sqrt_epsHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "inv_sqrt_gamma", "type": "text", "default": "1.001", "section": "optimizer", "desc_key": "field.lora_muon_inv_sqrt_gamma", "hint_key": "field.lora_muon_inv_sqrt_gammaHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "gauge_rebalance", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.lora_muon_gauge_rebalance", "hint_key": "field.lora_muon_gauge_rebalanceHint", "target": "merged", "show_if": {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "gauge_rebalance_alpha", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.lora_muon_gauge_rebalance_alpha", "hint_key": "field.lora_muon_gauge_rebalance_alphaHint", "target": "merged", "min": 0.000001, "max": 1, "step": 0.01, "layout_parent": "gauge_rebalance", "show_if": [{"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, {"key": "gauge_rebalance", "eq": True}], "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "gauge_rebalance_interval", "type": "number", "default": 1, "section": "optimizer", "desc_key": "field.lora_muon_gauge_rebalance_interval", "hint_key": "field.lora_muon_gauge_rebalance_intervalHint", "target": "merged", "min": 1, "step": 1, "layout_parent": "gauge_rebalance", "show_if": [{"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, {"key": "gauge_rebalance", "eq": True}], "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "gauge_power_steps", "type": "number", "default": 2, "section": "optimizer", "desc_key": "field.lora_muon_gauge_power_steps", "hint_key": "field.lora_muon_gauge_power_stepsHint", "target": "merged", "min": 1, "step": 1, "layout_parent": "gauge_rebalance", "show_if": [{"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE}, {"key": "gauge_rebalance", "eq": True}], "doc_slug": "optimizers", "doc_anchor": "lora-muon-options"},
{"key": "automagic_min_lr", "type": "text", "default": "1e-8", "section": "optimizer", "desc_key": "field.automagic_min_lr", "target": "merged", "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}},
{"key": "automagic_max_lr", "type": "text", "default": AUTOMAGIC_MAX_LR_DEFAULT_TEXT, "section": "optimizer", "desc_key": "field.automagic_max_lr", "target": "merged", "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, "hint_key": "field.automagic_max_lrHint"},
{"key": "automagic_beta2", "type": "number", "default": 0.999, "section": "optimizer", "desc_key": "field.automagic_beta2", "target": "merged", "min": 0, "max": 0.999999, "step": 0.001, "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}},
{"key": "automagic_clip_threshold", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.automagic_clip_threshold", "target": "merged", "min": 1e-8, "step": 0.1, "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, "hint_key": "field.automagic_clip_thresholdHint"},
{"key": "automagic_polarity_history", "type": "number", "default": 8, "section": "optimizer", "desc_key": "field.automagic_polarity_history", "target": "merged", "min": 2, "max": 64, "step": 1, "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, "hint_key": "field.automagic_polarity_historyHint"},
{"key": "automagic_fused", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.automagic_fused", "target": "merged", "show_if": {"key": "optimizer_type", "eq": AUTOMAGIC_OPTIMIZER_TYPE}, "auto_value": [{"watch": "optimizer_type", "when": AUTOMAGIC_OPTIMIZER_TYPE, "set": False}], "readonly_if_any": [{"key": "gradient_accumulation_steps", "neq": 1}, {"key": "max_grad_norm", "neq": 0}, {"key": "mixed_precision", "eq": "fp16"}], "readonly_reason_key": "field.automagic_fusedLocked"},
    # EmoSens 专用：收敛灵敏度 stopcoef
    {"key": "stopcoef", "type": "number", "default": 0.04, "section": "optimizer", "desc_key": "field.stopcoef", "target": "merged", "min": 0.001, "max": 1.0, "step": 0.001, "hint_key": "field.stopcoefHint", "show_if": {"key": "optimizer_type", "eq": EMOSENS_OPTIMIZER_TYPE}},
{"key": "prodigy_d_coef", "type": "text", "default": "1.0", "section": "optimizer", "desc_key": "field.prodigy_d_coef", "target": "merged", "show_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE, "_or": [PRODIGYPLUS_OPTIMIZER_TYPE]}},
{"key": "prodigy_d0", "type": "text", "default": "1e-6", "section": "optimizer", "desc_key": "field.prodigy_d0", "target": "merged", "show_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE, "_or": [PRODIGYPLUS_OPTIMIZER_TYPE]}},
{"key": "prodigy_safeguard_warmup", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.prodigy_safeguard_warmup", "target": "merged", "show_if": {"key": "optimizer_type", "eq": PRODIGY_OPTIMIZER_TYPE}, "hint_key": "field.prodigy_safeguard_warmupHint"},
{"key": "prodigyplus_use_stableadamw", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.prodigyplus_use_stableadamw", "target": "merged", "show_if": {"key": "optimizer_type", "eq": PRODIGYPLUS_OPTIMIZER_TYPE}, "hint_key": "field.prodigyplus_use_stableadamwHint"},
{"key": "schedulefree_warmup_steps", "type": "number", "default": 0, "section": "optimizer", "desc_key": "field.schedulefree_warmup_steps", "target": "merged", "min": 0, "step": 1, "show_if": {"key": "optimizer_type", "eq": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE}, "hint_key": "field.schedulefree_warmup_stepsHint"},
{"key": "adafactor_relative_step", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.adafactor_relative_step", "target": "merged", "show_if": {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, "hint_key": "field.adafactor_relative_stepHint"},
{"key": "adafactor_scale_parameter", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.adafactor_scale_parameter", "target": "merged", "show_if": {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, "auto_value": [{"watch": "adafactor_relative_step", "when": False, "set": False, "set_if_default": True}]},
{"key": "adafactor_warmup_init", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.adafactor_warmup_init", "target": "merged", "show_if": [{"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, {"key": "adafactor_relative_step", "eq": True}], "hint_key": "field.adafactor_warmup_initHint", "auto_value": [{"watch": "adafactor_relative_step", "when": False, "set": False, "set_if_default": True}]},
{"key": "adafactor_clip_threshold", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.adafactor_clip_threshold", "target": "merged", "min": 1e-8, "step": 0.1, "show_if": {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}},
{"key": "adafactor_eps", "type": "text", "default": "1e-30, 1e-3", "section": "optimizer", "desc_key": "field.adafactor_eps", "target": "merged", "show_if": {"key": "optimizer_type", "eq": ADAFACTOR_OPTIMIZER_TYPE}, "hint_key": "field.adafactor_epsHint"},
# ── Adan 专用参数 ──
{"key": "adan_weight_decouple", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.adan_weight_decouple", "target": "merged", "show_if": {"key": "optimizer_type", "eq": ADAN_OPTIMIZER_TYPE}, "hint_key": "field.adan_weight_decoupleHint", "doc_slug": "optimizers", "doc_anchor": "adan-options"},
# ── AdEMAMix 专用参数 ──
{"key": "ademamix_alpha", "type": "number", "default": 5.0, "section": "optimizer", "desc_key": "field.ademamix_alpha", "target": "merged", "min": 0, "step": 0.5, "show_if": {"key": "optimizer_type", "eq": ADEMAMIX_OPTIMIZER_TYPE, "_or": [ADEMAMIX8BIT_OPTIMIZER_TYPE]}, "hint_key": "field.ademamix_alphaHint", "doc_slug": "optimizers", "doc_anchor": "ademamix-options"},
{"key": "ademamix_t_alpha", "type": "number", "default": "", "section": "optimizer", "desc_key": "field.ademamix_t_alpha", "target": "merged", "min": 0, "show_if": {"key": "optimizer_type", "eq": ADEMAMIX_OPTIMIZER_TYPE, "_or": [ADEMAMIX8BIT_OPTIMIZER_TYPE]}, "hint_key": "field.ademamix_t_alphaHint", "doc_slug": "optimizers", "doc_anchor": "ademamix-options"},
{"key": "ademamix_t_beta3", "type": "number", "default": "", "section": "optimizer", "desc_key": "field.ademamix_t_beta3", "target": "merged", "min": 0, "show_if": {"key": "optimizer_type", "eq": ADEMAMIX_OPTIMIZER_TYPE, "_or": [ADEMAMIX8BIT_OPTIMIZER_TYPE]}, "hint_key": "field.ademamix_t_beta3Hint", "doc_slug": "optimizers", "doc_anchor": "ademamix-options"},
# ── LoRA-RITE 专用参数 ──
{"key": "lorarite_clip_unmagnified_grad", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.lorarite_clip_unmagnified_grad", "target": "merged", "min": 0, "step": 0.1, "show_if": {"key": "optimizer_type", "eq": LORARITE_OPTIMIZER_TYPE}, "hint_key": "field.lorarite_clip_unmagnified_gradHint", "doc_slug": "optimizers", "doc_anchor": "lorarite-options"},
# ── Optimizer Merged: betas / eps ──
{"key": "betas", "type": "text", "section": "optimizer", "desc_key": "field.betas", "target": "merged", "hint_key": "field.betasHint", "hint_key_by": {"key": "optimizer_type", "values": _SD_BETA_HINTS}, "doc_slug": "optimizers", "doc_anchor": "betas", "show_if": _show_if_one_of("optimizer_type", tuple(_SD_BETA_HINTS)), "auto_value": SD_OPTIMIZER_AUTO_VALUES["betas"]},
{"key": "eps", "type": "text", "section": "optimizer", "desc_key": "field.eps", "target": "merged", "hint_key": "field.epsHint", "hint_key_by": {"key": "optimizer_type", "values": {LORARITE_OPTIMIZER_TYPE: "field.epsHint_lorarite"}}, "doc_slug": "optimizers", "doc_anchor": "eps", "show_if": _show_if_one_of("optimizer_type", tuple(selector for selector in _SD_OPTIMIZER_SELECTORS if selector in _SD_EPS_OPTIMIZERS)), "auto_value": SD_OPTIMIZER_AUTO_VALUES["eps"]},
# ── CAME 专用参数 ──
{"key": "came_weight_decouple", "type": "toggle", "default": True, "section": "optimizer", "desc_key": "field.came_weight_decouple", "target": "merged", "hint_key": "field.came_weight_decoupleHint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_fixed_decay", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_fixed_decay", "target": "merged", "hint_key": "field.came_fixed_decayHint", "show_if": [{"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}, {"key": "came_weight_decouple", "eq": True}]},
{"key": "came_clip_threshold", "type": "number", "default": 1.0, "section": "optimizer", "desc_key": "field.came_clip_threshold", "target": "merged", "step": 0.1, "min": 0.1, "hint_key": "field.came_clip_thresholdHint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}, "doc_slug": "optimizers", "doc_anchor": "came-clipping"},
{"key": "came_ams_bound", "type": "toggle", "default": False, "section": "optimizer", "desc_key": "field.came_ams_bound", "target": "merged", "hint_key": "field.came_ams_boundHint", "show_if": {"key": "optimizer_type", "eq": "pytorch_optimizer.CAME"}},
{"key": "came_eps1", "type": "text", "default": "1e-30", "section": "optimizer", "desc_key": "field.came_eps1", "target": "merged", "hint_key": "field.came_eps1Hint", "show_if": {"key": "optimizer_type", "eq": CAME_OPTIMIZER_TYPE}},
{"key": "came_eps2", "type": "text", "default": "1e-16", "section": "optimizer", "desc_key": "field.came_eps2", "target": "merged", "hint_key": "field.came_eps2Hint", "show_if": {"key": "optimizer_type", "eq": CAME_OPTIMIZER_TYPE}},
{"key": "optimizer_args_custom", "type": "textarea", "default": "", "section": "optimizer", "desc_key": "field.optimizer_args_custom", "target": "ui", "hint_key": "field.optimizer_args_customHint"},
# ── Regularization & Loss ──
{"key": "loss_type", "type": "select", "default": "l2", "section": "regularization", "desc_key": "field.loss_type", "target": "toml", "options": [{"v": "l2", "l": "L2", "dk": "opt.loss_type_l2"}, {"v": "l1", "l": "L1", "dk": "opt.loss_type_l1"}, {"v": "huber", "l": "Huber", "dk": "opt.loss_type_huber"}, {"v": "smooth_l1", "l": "Smooth L1", "dk": "opt.loss_type_smooth_l1"}], "omit_default": True},
{"key": "huber_schedule", "type": "select", "default": "exponential", "section": "regularization", "desc_key": "field.huber_schedule", "target": "toml", "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "options": [{"v": "snr", "l": "SNR", "dk": "opt.huber_schedule_snr", "group": "sdxl"}, {"v": "constant", "l": "constant", "dk": "opt.huber_schedule_constant"}, {"v": "exponential", "l": "exponential", "dk": "opt.huber_schedule_exponential"}], "omit_default": True},
{"key": "huber_c", "type": "number", "default": 0.1, "section": "regularization", "desc_key": "field.huber_c", "target": "toml", "step": 0.01, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "omit_default": True},
{"key": "huber_scale", "type": "number", "default": 1.0, "section": "regularization", "desc_key": "field.huber_scale", "target": "toml", "step": 0.1, "show_if": {"key": "loss_type", "eq": "huber", "_or": ["smooth_l1"]}, "omit_default": True},
# 噪声/损失正则化族（仅 SDXL 路径消费；Anima 走 rectified-flow，flux_train_utils.get_noisy_model_input_and_timesteps
# 不读 noise_offset/adaptive_noise_scale/multires_noise_*；min_snr/debiased 仅 sdxl_train.py/fine_tune.py 消费）。
    {"key": "min_snr_gamma", "type": "number", "section": "regularization", "desc_key": "field.min_snr_gamma", "target": "toml", "step": 0.1, "hint_key": "field.min_snr_gammaHint", "group": "sdxl"},
    {"key": "debiased_estimation_loss", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.debiased_estimation_loss", "target": "toml", "omit_default": True, "group": "sdxl"},
    {"key": "noise_offset", "type": "number", "section": "regularization", "desc_key": "field.noise_offset", "target": "toml", "step": 0.001, "hint_key": "field.noise_offsetHint", "group": "sdxl"},
    {"key": "noise_offset_random_strength", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.noise_offset_random_strength", "target": "toml", "show_if": {"key": "noise_offset", "neq": ""}, "omit_default": True, "group": "sdxl"},
    {"key": "adaptive_noise_scale", "type": "number", "section": "regularization", "desc_key": "field.adaptive_noise_scale", "target": "toml", "step": 0.001, "show_if": {"key": "noise_offset", "neq": ""}, "group": "sdxl"},
    {"key": "multires_noise_iterations", "type": "number", "section": "regularization", "desc_key": "field.multires_noise_iterations", "target": "toml", "min": 0, "step": 1, "group": "sdxl", "hint_key": "field.multires_noise_iterationsHint"},
    {"key": "multires_noise_discount", "type": "number", "default": 0.3, "section": "regularization", "desc_key": "field.multires_noise_discount", "target": "toml", "step": 0.01, "show_if": {"key": "multires_noise_iterations", "neq": ""}, "group": "sdxl", "omit_default": True, "hint_key": "field.multires_noise_discountHint"},
{"key": "ip_noise_gamma", "type": "number", "section": "regularization", "desc_key": "field.ip_noise_gamma", "target": "toml", "step": 0.001},
{"key": "ip_noise_gamma_random_strength", "type": "toggle", "default": False, "section": "regularization", "desc_key": "field.ip_noise_gamma_random_strength", "target": "toml", "show_if": {"key": "ip_noise_gamma", "neq": ""}, "omit_default": True},
# ── Performance & Cache ──
{"key": "xformers", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.xformers", "target": "toml", "group": "sdxl"},
{"key": "sdpa", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.sdpa", "target": "toml", "group": "sdxl", "omit_default": True},
{"key": "attn_mode", "type": "select", "default": "torch", "section": "performance", "desc_key": "field.attn_mode", "target": "toml", "group": "anima", "options": [{"v": "torch", "l": "torch", "dk": "opt.attn_mode_torch"}, {"v": "xformers", "l": "xformers", "dk": "opt.attn_mode_xformers"}, {"v": "flash", "l": "flash", "dk": "opt.attn_mode_flash"}, {"v": "sdpa", "l": "sdpa", "dk": "opt.attn_mode_sdpa"}]},
{"key": "split_attn", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.split_attn", "target": "toml", "group": "anima", "auto_value": [{"watch": "attn_mode", "when": "xformers", "set": True, "set_if_default": True}]},
    # Anima: TF32 / cuDNN — Ampere+ GPU 几乎免费的加速
    {"key": "cuda_allow_tf32", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cuda_allow_tf32", "target": "toml", "group": "anima", "hint_key": "field.cuda_allow_tf32Hint"},
    {"key": "cuda_cudnn_benchmark", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cuda_cudnn_benchmark", "target": "toml", "group": "anima", "hint_key": "field.cuda_cudnn_benchmarkHint"},
{"key": "cache_latents", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents", "target": "toml"},
{"key": "cache_latents_to_disk", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_latents_to_disk", "hint_key": "field.cache_latents_to_diskHint", "target": "toml"},
# 文本编码器输出缓存：默认开启（配合默认 network_train_unet_only=True，纯收益，大幅省显存提速）
# cache_text_encoder_outputs 与 caption dropout/shuffle 互斥（sd-scripts is_text_encoder_output_cacheable
# 在 shuffle_caption / caption_tag_dropout_rate>0 时返回 false → anima_train_network.py assert 失败）。
# 双重保护：前端 setField 联动自动关 cache（caption 互斥项激活时）+ readonly_if_any 锁定防用户回开
# （任一互斥项激活期间 cache 开关灰显，光自动关不够，用户还能手动再开回 true）。
{"key": "cache_text_encoder_outputs", "type": "toggle", "default": True, "section": "performance", "desc_key": "field.cache_text_encoder_outputs", "target": "toml", "hint_key": "field.cache_text_encoder_outputsHint", "readonly_if_any": [{"key": "shuffle_caption", "eq": True}, {"key": "caption_tag_dropout_rate", "neq": 0}, [{"key": "model_train_type", "eq": "sdxl-lora"}, {"key": "caption_dropout_rate", "neq": 0}]], "readonly_reason_key": "field.cache_text_encoder_outputsLocked"},
# to_disk 联动 cache=true 已由 sd-scripts 后端兜底（anima_train_network.py:56-58），前端 auto_value 规则
# 曾经 watch 自身导致用户把 to_disk 切回 false 时把 cache 复位为 default=True（switchTrainType 后被偷开），删除。
{"key": "cache_text_encoder_outputs_to_disk", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cache_text_encoder_outputs_to_disk", "target": "toml", "readonly_if_any": [{"key": "shuffle_caption", "eq": True}, {"key": "caption_tag_dropout_rate", "neq": 0}, [{"key": "model_train_type", "eq": "sdxl-lora"}, {"key": "caption_dropout_rate", "neq": 0}]], "readonly_reason_key": "field.cache_text_encoder_outputsLocked"},
{"key": "no_half_vae", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.no_half_vae", "target": "toml", "group": "sdxl", "omit_default": True},
{"key": "lowram", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.lowram", "target": "toml", "omit_default": True},
    # Anima: VAE performance
    {"key": "vae_chunk_size", "type": "number", "default": "", "section": "performance", "desc_key": "field.vae_chunk_size", "target": "toml", "min": 2, "step": 2, "group": "anima", "hint_key": "field.vae_chunk_sizeHint"},
    {"key": "vae_disable_cache", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.vae_disable_cache", "target": "toml", "group": "anima"},
    {"key": "vae_batch_size", "type": "number", "default": "", "section": "performance", "desc_key": "field.vae_batch_size", "target": "toml", "min": 1, "step": 1, "hint_key": "field.vae_batch_sizeHint"},
    {"key": "blocks_to_swap", "type": "number", "section": "performance", "desc_key": "field.blocks_to_swap", "target": "toml", "min": 0, "max": 8, "step": 1, "group": "anima", "hint_key": "field.blocks_to_swapHint"},
    # cpu_offload_checkpointing：梯度检查点时把张量卸载到 CPU 省显存（与 unsloth_offload_checkpointing 互斥）。
    # adapter.py 已有互斥校验，此前 registry 无字段导致该校验为死代码，此处补全。
    {"key": "cpu_offload_checkpointing", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.cpu_offload_checkpointing", "target": "toml", "group": "anima", "hint_key": "field.cpu_offload_checkpointingHint", "omit_default": True},
    {"key": "unsloth_offload_checkpointing", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.unsloth_offload_checkpointing", "target": "toml", "group": "anima", "hint_key": "field.unsloth_offload_checkpointingHint", "omit_default": True},
    # torch.compile（通用 accelerate 版，SDXL 用；Anima 请用下方 compile 系列）
    {"key": "torch_compile", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.torch_compile", "target": "toml", "group": "sdxl", "hint_key": "field.torch_compileHint"},
    {"key": "dynamo_backend", "type": "select", "default": "inductor", "section": "performance", "desc_key": "field.dynamo_backend", "target": "toml", "show_if": {"key": "torch_compile", "eq": True}, "hint_key": "field.dynamo_backendHint", "group": "sdxl", "options": [{"v": "inductor", "l": "inductor", "dk": "opt.dynamo_backend_inductor"}, {"v": "eager", "l": "eager", "dk": "opt.dynamo_backend_eager"}, {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.dynamo_backend_cudagraphs"}]},
    # Anima 专用 per-block torch.compile（需 Triton；与 torch_compile / blocks_to_swap 互斥，adapter 会校验）
    {"key": "compile", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.compile", "target": "toml", "group": "anima", "hint_key": "field.compileHint"},
    {"key": "compile_backend", "type": "select", "default": "inductor", "section": "performance", "desc_key": "field.compile_backend", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "options": [{"v": "inductor", "l": "inductor", "dk": "opt.compile_backend_inductor"}, {"v": "eager", "l": "eager", "dk": "opt.compile_backend_eager"}, {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.compile_backend_cudagraphs"}]},
    {"key": "compile_mode", "type": "select", "default": "default", "section": "performance", "desc_key": "field.compile_mode", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "options": [{"v": "default", "l": "default", "dk": "opt.compile_mode_default"}, {"v": "reduce-overhead", "l": "reduce-overhead", "dk": "opt.compile_mode_reduce_overhead"}, {"v": "max-autotune", "l": "max-autotune", "dk": "opt.compile_mode_max_autotune"}, {"v": "max-autotune-no-cudagraphs", "l": "max-autotune-no-cudagraphs", "dk": "opt.compile_mode_max_autotune_no_cudagraphs"}]},
    {"key": "compile_dynamic", "type": "select", "default": "auto", "section": "performance", "desc_key": "field.compile_dynamic", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "options": [{"v": "auto", "l": "auto", "dk": "opt.compile_dynamic_auto"}, {"v": "true", "l": "true", "dk": "opt.compile_dynamic_true"}, {"v": "false", "l": "false", "dk": "opt.compile_dynamic_false"}]},
    {"key": "compile_fullgraph", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.compile_fullgraph", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}},
    {"key": "compile_cache_size_limit", "type": "number", "default": "", "section": "performance", "desc_key": "field.compile_cache_size_limit", "target": "toml", "group": "anima", "show_if": {"key": "compile", "eq": True}, "hint_key": "field.compile_cache_size_limitHint"},
    # DataLoader
    {"key": "persistent_data_loader_workers", "type": "toggle", "default": False, "section": "performance", "desc_key": "field.persistent_data_loader_workers", "target": "toml", "hint_key": "field.persistent_data_loader_workersHint"},
    {"key": "max_data_loader_n_workers", "type": "number", "default": "", "section": "performance", "desc_key": "field.max_data_loader_n_workers", "target": "toml", "min": 0, "step": 1, "hint_key": "field.max_data_loader_n_workersHint"},
# ── Save ──
{"key": "output_name", "type": "text", "default": "my_lora", "section": "save", "desc_key": "field.output_name", "target": "toml", "required": True},
{"key": "output_dir", "type": "text", "default": "./output", "section": "save", "desc_key": "field.output_dir", "target": "toml", "role": "file-folder", "required": True},
{"key": "save_model_as", "type": "select", "default": "safetensors", "section": "save", "desc_key": "field.save_model_as", "target": "toml", "options": [{"v": "safetensors", "l": "safetensors", "dk": "opt.save_model_as_safetensors"}, {"v": "pt", "l": "pt", "dk": "opt.save_model_as_pt"}, {"v": "ckpt", "l": "ckpt", "dk": "opt.save_model_as_ckpt"}]},
{"key": "save_precision", "type": "select", "default": "bf16", "section": "save", "desc_key": "field.save_precision", "target": "toml", "options": [{"v": "bf16", "l": "bf16", "dk": "opt.save_precision_bf16"}, {"v": "fp16", "l": "fp16", "dk": "opt.save_precision_fp16"}, {"v": "float", "l": "float", "dk": "opt.save_precision_float"}]},
{"key": "save_every_n_epochs", "type": "number", "default": 2, "section": "save", "desc_key": "field.save_every_n_epochs", "target": "toml", "min": 1},
    {"key": "save_every_n_steps", "type": "number", "default": "", "section": "save", "desc_key": "field.save_every_n_steps", "target": "toml", "min": 1, "hint_key": "field.save_every_n_stepsHint"},
    {"key": "save_last_n_epochs", "type": "number", "default": "", "section": "save", "desc_key": "field.save_last_n_epochs", "target": "toml", "min": 1, "hint_key": "field.save_last_n_epochsHint"},
{"key": "save_state", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state", "target": "toml", "omit_default": True},
    {"key": "save_last_n_epochs_state", "type": "number", "default": "", "section": "save", "desc_key": "field.save_last_n_epochs_state", "target": "toml", "min": 1, "show_if": {"key": "save_state", "eq": True}},
    {"key": "save_state_on_train_end", "type": "toggle", "default": False, "section": "save", "desc_key": "field.save_state_on_train_end", "hint_key": "field.save_state_on_train_endHint", "target": "toml", "omit_default": True},
{"key": "logging_dir", "type": "text", "default": "./logs", "section": "save", "desc_key": "field.logging_dir", "target": "toml", "hidden": True},
{"key": "log_with", "type": "select", "default": "tensorboard", "section": "save", "desc_key": "field.log_with", "target": "toml", "hidden": True, "options": [{"v": "tensorboard", "l": "TensorBoard", "dk": "opt.log_with_tensorboard"}, {"v": "wandb", "l": "Weights & Biases", "dk": "opt.log_with_wandb"}, {"v": "all", "l": "TensorBoard + WandB", "dk": "opt.log_with_all"}]},
# ── Caption ──
{"key": "caption_extension", "type": "text", "default": ".txt", "section": "caption", "desc_key": "field.caption_extension", "target": "toml"},
{"key": "max_token_length", "type": "select", "default": 225, "section": "caption", "desc_key": "field.max_token_length", "target": "toml", "group": "sdxl", "options": [{"v": 150, "l": "150", "dk": "opt.max_token_length_150"}, {"v": 225, "l": "225", "dk": "opt.max_token_length_225"}]},
{"key": "qwen3_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.qwen3_max_token_length", "target": "toml", "min": 1, "step": 1, "group": "anima", "hint_key": "field.textTokenLengthHint"},
{"key": "t5_max_token_length", "type": "number", "default": 512, "section": "caption", "desc_key": "field.t5_max_token_length", "target": "toml", "min": 1, "step": 1, "group": "anima", "hint_key": "field.textTokenLengthHint"},
# shuffle_caption 与 cache_text_encoder_outputs 互斥：默认关闭以让推荐默认 cache=true 可用。
# 用户主动开启 shuffle 时会触发 cache 的 readonly 锁定（见 performance 段对 cache_text_encoder_outputs 的注释）。
{"key": "shuffle_caption", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.shuffle_caption", "target": "toml"},
{"key": "keep_tokens", "type": "number", "default": 0, "section": "caption", "desc_key": "field.keep_tokens", "target": "toml", "min": 0, "omit_default": True, "show_if_any": [[{"key": "shuffle_caption", "eq": True}], [{"key": "caption_tag_dropout_rate", "neq": 0}]]},
{"key": "weighted_captions", "type": "toggle", "default": False, "section": "caption", "desc_key": "field.weighted_captions", "target": "toml", "omit_default": True, "group": "sdxl"},  # Anima 的 AnimaTokenizeStrategy 未实现 tokenize_with_weights，对 Anima 无效
{"key": "caption_dropout_rate", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_rate", "target": "toml", "min": 0, "max": 1, "step": 0.01},
{"key": "caption_dropout_every_n_epochs", "type": "number", "section": "caption", "desc_key": "field.caption_dropout_every_n_epochs", "target": "toml", "min": 0},
{"key": "caption_tag_dropout_rate", "type": "number", "default": 0, "section": "caption", "desc_key": "field.caption_tag_dropout_rate", "target": "toml", "min": 0, "max": 1, "step": 0.01, "omit_default": True},
# ── Preview ──
{"key": "enable_preview", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.enable_preview", "target": "ui"},
{"key": "positive_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.sample_prompts", "target": "ui", "hint_key": "field.sample_promptsHint", "show_if": {"key": "enable_preview", "eq": True}},
{"key": "negative_prompts", "type": "textarea", "default": "", "section": "preview", "desc_key": "field.negative_prompts", "target": "ui", "show_if": {"key": "enable_preview", "eq": True}},
    # 仅 SDXL 暴露采样器（sd-scripts 的 diffusers scheduler 路径）。
    # Anima 采样写死 Euler flow-match，sample_sampler 是假参数，故按 group:sdxl 隐藏。
    {"key": "sample_sampler", "type": "select", "default": "euler_a", "section": "preview", "desc_key": "field.sample_sampler", "target": "toml", "group": "sdxl", "show_if": {"key": "enable_preview", "eq": True}, "options": [
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
    {"key": "sample_every_n_steps", "type": "number", "default": "", "section": "preview", "desc_key": "field.sample_every_n_steps", "target": "toml", "min": 1, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_at_first", "type": "toggle", "default": False, "section": "preview", "desc_key": "field.sample_at_first", "target": "toml", "omit_default": True, "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_cfg", "type": "number", "default": 7, "section": "preview", "desc_key": "field.sample_cfg", "target": "ui", "min": 1, "max": 30, "hint_key": "field.sample_cfgHint", "show_if": {"key": "enable_preview", "eq": True}},
# 预览分辨率默认 1024（SDXL/Anima 训练基准），原 512 在高分辨率模型下采样不具代表性
    {"key": "sample_width", "type": "number", "default": 1024, "section": "preview", "desc_key": "field.sample_width", "target": "ui", "hint_key": "field.sampleResolutionHint", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_height", "type": "number", "default": 1024, "section": "preview", "desc_key": "field.sample_height", "target": "ui", "hint_key": "field.sampleResolutionHint", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_seed", "type": "number", "default": 2333, "section": "preview", "desc_key": "field.sample_seed", "target": "ui", "hint_key": "field.sample_seedHint", "show_if": {"key": "enable_preview", "eq": True}},
    {"key": "sample_steps", "type": "number", "default": 24, "section": "preview", "desc_key": "field.sample_steps", "target": "ui", "hint_key": "field.sample_stepsHint", "show_if": {"key": "enable_preview", "eq": True}},
    # Anima flow-match 采样时间表 shift（类比 Karras 的 sigma 偏移）。
    # 由 get_sample_prompts 拼成 --fs 传入 sd-scripts；SDXL 不读，故 group:anima 仅 Anima 显示。
    {"key": "sample_flow_shift", "type": "number", "default": 3.0, "section": "preview", "desc_key": "field.sample_flow_shift", "hint_key": "field.sample_flow_shiftHint", "target": "ui", "group": "anima", "step": 0.1, "show_if": {"key": "enable_preview", "eq": True}},
]

# Titles identify the control; behavior, applicability, and defaults belong in hints.
_FIELD_HINTS_BY_KEY = {
    "pretrained_model_name_or_path": "field.pretrained_model_name_or_pathHint",
    "vae": "field.vaeHint",
    "learning_rate": "field.learning_rateHint",
    "unet_lr": "field.unet_lrHint",
    "text_encoder_lr": "field.text_encoder_lrHint",
    "prodigy_d0": "field.prodigy_d0Hint",
    "lr_scheduler_power": "field.lr_scheduler_powerHint",
    "huber_c": "field.huber_cHint",
    "huber_scale": "field.huber_scaleHint",
    "adaptive_noise_scale": "field.adaptive_noise_scaleHint",
    "ip_noise_gamma": "field.ip_noise_gammaHint",
    "zero_terminal_snr": "field.zero_terminal_snrHint",
    "xformers": "field.xformersHint",
    "sdpa": "field.sdpaHint",
    "attn_mode": "field.attn_modeHint",
    "split_attn": "field.split_attnHint",
    "no_half_vae": "field.no_half_vaeHint",
    "vae_disable_cache": "field.vae_disable_cacheHint",
    "save_state": "field.save_stateHint",
    "shuffle_caption": "field.shuffle_captionHint",
    "keep_tokens": "field.keep_tokensHint",
    "weighted_captions": "field.weighted_captionsHint",
    "caption_tag_dropout_rate": "field.caption_tag_dropout_rateHint",
    "caption_dropout_rate": "field.caption_dropout_rateHint",
    "negative_prompts": "field.negative_promptsHint",
    "use_scalar": "field.use_scalarHint",
    "decompose_both": "field.decompose_bothHint",
    "full_matrix": "field.full_matrixHint",
    "train_norm": "field.train_normHint",
    "rescaled": "field.rescaledHint",
    "bypass_mode": "field.bypass_modeHint",
    "cache_latents": "field.cache_latentsHint",
    "lowram": "field.lowramHint",
    "compile_fullgraph": "field.compile_fullgraphHint",
    "prodigy_d_coef": "field.prodigy_d_coefHint",
    "debiased_estimation_loss": "field.debiased_estimation_lossHint",
    "noise_offset_random_strength": "field.noise_offset_random_strengthHint",
    "ip_noise_gamma_random_strength": "field.ip_noise_gamma_random_strengthHint",
}
for _field in FIELDS:
    if _field["key"] in _FIELD_HINTS_BY_KEY:
        _field.setdefault("hint_key", _FIELD_HINTS_BY_KEY[_field["key"]])


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
    "hint_key_by": "hintKeyBy",
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
    "set_if_default": "setIfDefault",
    "omit_default": "omitDefault",
    "doc_slug": "docSlug",
    "doc_anchor": "docAnchor",
    "constraints_by_group": "constraintsByGroup",
    "layout_parent": "layoutParent",
    "keep_children_position": "keepChildrenPosition",
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
            # OR clauses; a nested list is an AND group.
            result[new_key] = [
                [
                    {("neq" if ck == "neq" else ck): cv for ck, cv in cond.items()}
                    for cond in clause
                ]
                if isinstance(clause, list)
                else {("neq" if ck == "neq" else ck): cv for ck, cv in clause.items()}
                for clause in v
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


def get_all_fields() -> list[dict]:
    """Return every frontend field, including profile-scoped external cores.

    ``FIELDS`` deliberately remains the sd-scripts schema because it is also
    used by the legacy TOML adapter.  Consumers that render or describe a run
    must use this helper so a musubi profile does not silently lose labels.

    Profile-scoped Krea definitions intentionally come first.  A few keys
    (for example ``optimizer_type``) have distinct schemas per runtime; the
    legacy definition must remain the last one for older consumers that build
    a key-indexed map without profile filtering.
    """
    from backend.training.musubi_krea2 import KREA2_FIELDS

    return [*KREA2_FIELDS, *FIELDS]


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

    for f in get_all_fields():
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
