"""Shared sd-scripts option dependencies, including legacy native configs."""
from typing import Any


def _present(value: Any) -> bool:
    return value is not None and value != ""


def sample_interval_mode(config: dict) -> str:
    if _present(config.get("sample_interval_mode")):
        return str(config["sample_interval_mode"])
    if _present(config.get("sample_every_n_epochs")):
        return "epochs"
    if _present(config.get("sample_every_n_steps")):
        return "steps"
    return "none"


def normalize_sd_options(config: dict) -> None:
    """Keep only effective CLI options; selectors themselves remain UI-only."""
    interval = "none" if config.get("enable_preview") is False else sample_interval_mode(config)
    if config.get("enable_preview") is False:
        config.pop("sample_at_first", None)
    for key, active in (("sample_every_n_epochs", "epochs"), ("sample_every_n_steps", "steps")):
        if interval != active:
            config.pop(key, None)
    if config.get("cpu_offload_checkpointing") or config.get("unsloth_offload_checkpointing"):
        config["gradient_checkpointing"] = True
    if not config.get("block_swap_h2d_only"):
        config.pop("block_swap_ring_size", None)
        config.pop("use_pinned_memory_for_block_swap", None)


def validate_sd_option_dependencies(config: dict) -> list[str]:
    errors = []
    if config.get("block_swap_h2d_only") and config.get("model_train_type") not in ("anima-lora", "moss-image-lora"):
        errors.append("block_swap_h2d_only: supported only for Anima / MOSS LoRA profiles / 仅支持 Anima / MOSS 适配器训练")
    try:
        epoch_dropout = float(config.get("caption_dropout_every_n_epochs") or 0) > 0
    except (TypeError, ValueError):
        epoch_dropout = False  # Numeric validation reports invalid values.
    if (config.get("cache_text_encoder_outputs") or config.get("cache_text_encoder_outputs_to_disk")) and epoch_dropout:
        errors.append("caption_dropout_every_n_epochs: requires disabling both Text Encoder caches / 按轮丢弃标注需要关闭内存和磁盘文本缓存")
    if config.get("model_train_type") in ("anima-lora", "moss-image-lora"):
        cpu = bool(config.get("cpu_offload_checkpointing"))
        unsloth = bool(config.get("unsloth_offload_checkpointing"))
        try:
            swapping = float(config.get("blocks_to_swap") or 0) > 0
        except (TypeError, ValueError):
            swapping = False  # Numeric validation reports the invalid value.
        if cpu and unsloth:
            errors.append("cpu_offload_checkpointing / unsloth_offload_checkpointing: mutually exclusive / 两种激活卸载不能同时启用")
        if swapping and (cpu or unsloth):
            errors.append("blocks_to_swap: cannot be combined with checkpoint offloading / 换块不能与 CPU 或 Unsloth 激活卸载同时启用")
        if config.get("block_swap_h2d_only"):
            if not swapping:
                errors.append("block_swap_h2d_only: requires blocks_to_swap > 0 / 需要至少换出一个块")
            if config.get("gradient_checkpointing") is not True:
                errors.append("block_swap_h2d_only: requires gradient_checkpointing / 必须启用梯度检查点")
            try:
                ring = config.get("block_swap_ring_size", 2)
                valid_ring = not isinstance(ring, bool) and float(ring) >= 1 and float(ring).is_integer()
            except (ValueError, TypeError, OverflowError):
                valid_ring = False
            if not valid_ring:
                errors.append("block_swap_ring_size: must be a positive integer / 必须为正整数")
        if swapping and config.get("compile") and config.get("compile_fullgraph"):
            errors.append("compile_fullgraph: cannot be combined with blocks_to_swap; disable fullgraph / 完整图编译不能与换块并用；请关闭完整图编译")
    if config.get("enable_preview") and config.get("sample_interval_mode") in ("epochs", "steps"):
        key = "sample_every_n_steps" if sample_interval_mode(config) == "steps" else "sample_every_n_epochs"
        if not _present(config.get(key)):
            errors.append(f"{key}: required for the selected preview interval / 请填写所选模式的预览间隔")
    # Native TOMLs have no enable_preview selector. Check their effective
    # schedule too, before the MOSS sampler can receive sample_prompts=None.
    mode = sample_interval_mode(config)
    scheduled = mode in ("epochs", "steps") and _present(config.get(
        "sample_every_n_steps" if mode == "steps" else "sample_every_n_epochs"
    ))
    if (config.get("model_train_type") == "moss-image-lora"
            and config.get("enable_preview") is not False
            and (config.get("sample_at_first") or scheduled)
            and not config.get("randomly_choice_prompt")
            and not any(str(config.get(key) or "").strip() for key in (
                "positive_prompts", "prompt_file", "sample_prompts"
            ))):
        errors.append("positive_prompts: MOSS preview requires a prompt or prompt file / MOSS 预览需要填写提示词或指定提示词文件")
    return errors
