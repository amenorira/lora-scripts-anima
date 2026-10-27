"""MOSS-Image schema and contracts for the shared sd-scripts runtime."""
from __future__ import annotations

import math
from pathlib import Path
import re
from typing import Any

PROFILE_ID = "moss-image-lora"
GROUP = "moss_image"
NETWORK_MODULES = ("networks.lora_generic", "networks.loha", "networks.lokr")


# These use the same upstream implementations as Anima, without its model-specific VAE/TE options.
SHARED_FIELDS = {
    "timestep_sampling", "sigmoid_scale", "discrete_flow_shift", "weighting_scheme",
    "logit_mean", "logit_std", "timestep_cutoff", "timestep_uniform_ratio", "mode_scale", "subset_timestep_offsets", "attn_mode",
    "split_attn", "cuda_allow_tf32", "cuda_cudnn_benchmark", "blocks_to_swap",
    "cpu_offload_checkpointing", "unsloth_offload_checkpointing", "compile",
    "compile_backend", "compile_mode", "compile_dynamic", "compile_fullgraph",
    "compile_cache_size_limit", "sample_flow_shift",
}
DEFAULTS = {
    "pretrained_model_name_or_path": "", "vae": "", "network_module": "networks.lora_generic",
    # Keep the guide's alpha/LR pair together; higher alpha needs LR retuning.
    "gradient_checkpointing": True, "network_dim": 16, "network_alpha": 1,
    "learning_rate": "1e-4", "max_data_loader_n_workers": 2,
    "timestep_sampling": "truncated_logit_normal", "weighting_scheme": "uniform",
    "logit_mean": -1.09, "logit_std": 0.95, "lr_scheduler": "constant",
    "sample_width": 1024, "sample_height": 1024, "sample_steps": 50,
    "sample_cfg": 3.0, "sample_flow_shift": 5.0,
}


def extend_fields(fields: list[dict[str, Any]]) -> None:
    """Add one architecture to the sd-scripts schema while preserving existing defaults."""
    by_key = {field["key"]: field for field in fields}
    from backend.training.optimizer_contracts import LORA_MUON_OPTIMIZER_TYPE, LORARITE_OPTIMIZER_TYPE

    for option_group in by_key["optimizer_type"].get("groups", []):
        for option in option_group.get("options", []):
            if option["v"] in (LORA_MUON_OPTIMIZER_TYPE, LORARITE_OPTIMIZER_TYPE):
                option.setdefault("group", ["anima", "sdxl"])
    for key in SHARED_FIELDS:
        by_key[key]["group"] = ["anima", GROUP]
    for key, value in DEFAULTS.items():
        by_key[key].setdefault("default_by_group", {})[GROUP] = value
    for key in ("bucket_reso_steps",):
        by_key[key].setdefault("constraints_by_group", {})[GROUP] = {"min": 16, "step": 16}
    by_key["blocks_to_swap"].setdefault("constraints_by_group", {})[GROUP] = {"max": 40}
    # Product UI follows OpenMOSS's recommendation to keep Qwen frozen.
    # DiT text-embedder adapters are separate from the frozen text encoder.
    for key in ("network_train_unet_only", "network_train_text_encoder_only"):
        by_key[key]["readonly_if"] = {
            "key": "model_train_type", "eq": PROFILE_ID,
            "reason_key": "field.mossTextEncoderFrozen",
        }
    for conditions in by_key["loraplus_text_encoder_lr_ratio"]["show_if_any"]:
        conditions.append({"key": "model_train_type", "neq": PROFILE_ID})
    by_key["vae"]["requiredGroups"].append(GROUP)
    by_key["model_train_type"]["options"].append({
        "v": PROFILE_ID, "l": "MOSS-Image LoRA", "dk": "opt.model_train_type_moss-image-lora",
    })
    by_key["network_module"]["options"].insert(1, {
        "v": "networks.lora_generic", "l": "networks.lora_generic",
        "dk": "opt.network_module_networks_lora_generic", "group": GROUP,
    })
    for option in by_key["network_module"]["options"]:
        if option["v"] in ("networks.loha", "networks.lokr"):
            option["group"] = ["anima", "sdxl", GROUP]
        elif option["v"] == "lycoris.kohya":
            option["group"] = ["anima", "sdxl"]
    for key in ("conv_dim", "conv_alpha", "use_tucker"):
        by_key[key]["group"] = ["anima", "sdxl"]
    for key in ("rank_dropout", "module_dropout"):
        by_key[key]["show_if"]["_or"].append("networks.lora_generic")

    additions = [
        ("qwen3", {"key": "text_encoder", "type": "text", "default": "", "section": "model", "role": "file-model", "required": True}),
        ("text_encoder", {"key": "tokenizer_cache_dir", "type": "text", "default": "", "section": "model", "role": "file-folder"}),
        ("train_adaln", {"key": "train_text_embedder", "type": "toggle", "default": False, "omit_default": True, "section": "network", "target": "ui", "doc_slug": "network-parameters", "doc_anchor": "moss-text-embedder"}),
        ("qwen3_max_token_length", {"key": "moss_max_token_length", "type": "number", "default": 4096, "section": "caption", "min": 1, "max": 4096, "step": 1}),
        ("moss_max_token_length", {"key": "enable_multiline_caption", "type": "toggle", "default": True, "section": "caption"}),
        ("enable_multiline_caption", {"key": "multiline_caption_separator", "type": "text", "default": "---===---", "section": "caption", "show_if": {"key": "enable_multiline_caption", "eq": True}}),
        ("cache_text_encoder_outputs_to_disk", {"key": "convrot_int8", "type": "toggle", "default": False, "section": "performance"}),
        ("cache_text_encoder_outputs_to_disk", {"key": "text_encoder_batch_size", "type": "number", "default": 1, "min": 1, "step": 1, "section": "performance"}),
        ("convrot_int8", {"key": "convrot_int8_text_encoder", "type": "toggle", "default": False, "section": "performance"}),
        ("convrot_int8_text_encoder", {"key": "convrot_int8_bwd", "type": "select", "default": "bf16", "section": "performance", "options": [
            {"v": "bf16", "l": "bf16", "dk": "opt.convrot_int8_bwd_bf16"},
            {"v": "int8", "l": "int8", "dk": "opt.convrot_int8_bwd_int8"},
        ]}),
        ("sample_flow_shift", {"key": "sample_uncond_skip_layers", "type": "text", "default": "22", "section": "preview", "keep_empty": True, "show_if": {"key": "enable_preview", "eq": True}}),
    ]
    for after, field in additions:
        key = field["key"]
        field.setdefault("target", "toml")
        field.update(group=GROUP, desc_key=f"field.{key}_moss", hint_key=f"field.{key}_mossHint")
        index = next(i for i, existing in enumerate(fields) if existing["key"] == after)
        fields.insert(index + 1, field)


def validate_config(config: dict[str, Any]) -> list[str]:
    errors = []
    if config.get("network_module") not in NETWORK_MODULES:
        errors.append("MOSS-Image: only networks.lora_generic, networks.loha and networks.lokr are supported / MOSS 仅支持原生 LoRA、LoHa 和 LoKr；暂不支持 LyCORIS")
    cache = config.get("cache_text_encoder_outputs") is True or config.get("cache_text_encoder_outputs_to_disk") is True
    if cache and (config.get("network_train_unet_only") is not True or config.get("network_train_text_encoder_only") is True):
        errors.append("MOSS-Image: Text Encoder caching requires network_train_unet_only / 文本缓存要求仅训练 DiT")
    if cache and config.get("caption_dropout_every_n_epochs"):
        errors.append("MOSS-Image: caption_dropout_every_n_epochs requires disabling Text Encoder caching / 整轮描述丢弃需要关闭文本缓存")
    if cache and config.get("token_warmup_step"):
        errors.append("MOSS-Image: token warmup requires disabling Text Encoder caching / Token 预热需要关闭文本缓存")
    if config.get("enable_multiline_caption") and not str(config.get("multiline_caption_separator", "---===---")).strip():
        errors.append("multiline_caption_separator: cannot be empty / 多行描述分隔符不能为空")
    if config.get("compile") and config.get("torch_compile"):
        errors.append("MOSS-Image: compile and torch_compile are mutually exclusive / 两种编译模式不可同时启用")
    if config.get("compile") and config.get("compile_fullgraph") and (config.get("split_attn") or config.get("attn_mode") == "xformers"):
        errors.append("MOSS-Image: compile_fullgraph cannot be combined with split_attn / 完整图编译与分割注意力不兼容")
    if any(config.get(key) for key in ("fp8_base", "fp8_base_unet", "fp8_scaled")):
        errors.append("MOSS-Image: FP8 is unsupported; use ConvRot INT8 / 不支持 FP8，请使用 ConvRot INT8")
    errors.extend(_validate_quantized_options(config))
    raw = config.get("sample_uncond_skip_layers", "22")
    if raw not in (None, ""):
        parts = str(raw).split(",")
        if any(not re.fullmatch(r"\s*\d+\s*", part) or not 0 <= int(part) < 42 for part in parts):
            errors.append("sample_uncond_skip_layers: use comma-separated layer indices 0..41, or leave empty / 填写 0..41 的层索引，以逗号分隔，留空关闭跳层")
    for key in ("sample_width", "sample_height"):
        value = config.get(key)
        if value in (None, ""):
            continue
        try:
            number = float(value)
            valid = math.isfinite(number) and number > 0 and number % 16 == 0
        except (TypeError, ValueError):
            valid = False
        if not valid:
            errors.append(f"{key}: MOSS-Image requires positive multiples of 16 / MOSS 采样尺寸必须为 16 的正整数倍")
    return errors


def _has_base_weights(config: dict[str, Any]) -> bool:
    weights = config.get("base_weights") or []
    if isinstance(weights, str):
        weights = weights.split(",")
    return any(str(weight).strip() for weight in weights)


def _validate_quantized_options(
    config: dict[str, Any], *, dit_quantized: bool = False, text_encoder_quantized: bool = False,
) -> list[str]:
    errors = []
    dit_quantized = dit_quantized or bool(config.get("convrot_int8"))
    text_encoder_quantized = text_encoder_quantized or bool(config.get("convrot_int8_text_encoder"))
    if _has_base_weights(config) and (dit_quantized or text_encoder_quantized):
        errors.append("MOSS-Image: base_weights cannot be merged into ConvRot INT8 models; use unquantized checkpoints and disable both ConvRot options / "
                      "预合并 LoRA 不支持 ConvRot INT8 模型；请使用未量化权重并关闭两个 ConvRot 开关")
    return errors


def _checkpoint_is_quantized(paths: list[Path]) -> bool:
    # Read tensor names only: no tensor payloads, GPU allocation or trainer imports.
    # Inspect every shard; quantization markers need not occur in the first one.
    from safetensors import safe_open

    for path in paths:
        with safe_open(str(path), framework="numpy") as checkpoint:
            if any(key.endswith(".comfy_quant") for key in checkpoint.keys()):
                return True
    return False


def validate_captions(config: dict[str, Any]) -> list[str]:
    if not config.get("enable_multiline_caption"):
        return []
    from backend.training.sd_dataset_config import build_sd_scripts_dataset_config
    from backend.training.step_estimator import _sd_dataset_helpers

    _, glob_images, _ = _sd_dataset_helpers()
    from library.dataset import split_caption_candidates
    from library.dreambooth_dataset import read_caption

    separator = str(config.get("multiline_caption_separator", "---===---"))
    errors = []
    for subset in build_sd_scripts_dataset_config(config, {})["datasets"][0]["subsets"]:
        for image in glob_images(subset["image_dir"], "*"):
            try:
                caption = read_caption(str(image), str(config.get("caption_extension") or ".txt"), False, True)
                if caption is None:
                    continue
                # Validate the separator structure; v0.12.2 caches every candidate.
                split_caption_candidates(caption, separator)
            except (OSError, UnicodeError, ValueError, AssertionError) as exc:
                errors.append(f"Invalid caption for image / 图片描述无效: {image}: {exc}")
                return errors
    return errors


def validate_model_files(config: dict[str, Any]) -> list[str]:
    """Check required shards without loading model tensors or importing the training core."""
    errors = []
    model_paths: dict[str, list[Path]] = {}
    for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
        path = Path(str(config.get(key) or ""))
        if not path.is_file() or path.suffix.lower() != ".safetensors":
            errors.append(f"{key}: select a local safetensors checkpoint / 请选择本地 safetensors 权重: {path}")
            continue
        match = re.fullmatch(r"(.+)-(\d{5})-of-(\d{5})\.safetensors", path.name)
        if match:
            stem, first, total = match.groups()
            count = int(total)
            if int(first) != 1 or not 1 <= count <= 100:
                errors.append(f"{key}: select the first model shard / 请选择模型第一分片")
                continue
            missing = [f"{stem}-{index:05d}-of-{count:05d}.safetensors" for index in range(1, count + 1)
                       if not path.with_name(f"{stem}-{index:05d}-of-{count:05d}.safetensors").is_file()]
            if missing:
                errors.append(f"{key}: missing model shards / 缺少模型分片: {', '.join(missing)}")
            model_paths[key] = [path.with_name(f"{stem}-{index:05d}-of-{count:05d}.safetensors")
                                for index in range(1, count + 1)]
        else:
            model_paths[key] = [path]
    tokenizer = str(config.get("tokenizer_cache_dir") or "").strip()
    if tokenizer and not Path(tokenizer).is_dir():
        errors.append("tokenizer_cache_dir: directory not found / 分词器目录不存在")
    premerge = _has_base_weights(config)
    if not errors and premerge:
        try:
            errors.extend(_validate_quantized_options(
                config,
                dit_quantized=_checkpoint_is_quantized(model_paths["pretrained_model_name_or_path"]),
                text_encoder_quantized=premerge and _checkpoint_is_quantized(model_paths["text_encoder"]),
            ))
        except Exception as exc:
            errors.append(f"Cannot inspect checkpoint quantization / 无法检查权重量化信息: {exc}")
    return errors
