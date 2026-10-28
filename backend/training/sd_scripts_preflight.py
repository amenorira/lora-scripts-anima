"""Validate and adapt sd-scripts inputs before generating run files."""
import os
from dataclasses import dataclass

from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.log import log
from backend.training.preparation import training_error as _training_error
from backend.training.sd_dataset_config import SUBSET_TIMESTEP_OFFSETS_KEY, normalize_subset_timestep_offsets
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.supervisor import detect_lycoris_kernel_backend
from backend.training.te_cache_check import TE_CACHE_CHECK_PROFILES, check_te_cache
from backend.utils import train_utils


@dataclass
class SdScriptsSettings:
    config: dict
    ui_config: dict
    adapter_id: str
    subset_timestep_offsets: dict
    warnings: list[str]
    lycoris_kernel_backend: str | None
    lycoris_kernel_warning: str


async def prepare_settings(config, gpu_ids, profile) -> tuple[SdScriptsSettings | None, dict | None]:
    try:
        subset_timestep_offsets = normalize_subset_timestep_offsets(
            config.pop(SUBSET_TIMESTEP_OFFSETS_KEY, None)
        )
    except ValueError as exc:
        return None, _training_error(message=str(exc))
    if profile.id not in ("anima-lora", "moss-image-lora"):
        subset_timestep_offsets = {}

    # Keep the legacy sd-scripts adapter input byte-for-byte compatible. Core
    # metadata is restored at the supervisor boundary instead of being passed
    # through to sd-scripts as an unknown command line field.
    config.pop("engine_id", None)
    adapter_id = str(config.pop("adapter_id", profile.adapter_id))

    # ── Anima Backend Adapter: whitelist filter + NaN cleanup + path normalization ──
    # 保存原始 config（含 UI-only 字段如 positive_prompts），adapter 之后会被剥离
    _ui_config = dict(config)
    # ── LyCORIS 融合内核后端：进程级环境变量，不进 TOML ──────────
    # vendor 经 LYCORIS_KERNEL_BACKEND 读取（kernels/dispatch.py:58 / select.py:78）。
    # 启动前探测可用性：不可用的命名后端回退 auto 并携带警告（与 attn_mode 降级同模式）。
    lycoris_kernel_backend: str | None = None
    lycoris_kernel_warning = ""
    if str(config.get("network_module") or "") == "lycoris.kohya":
        requested = str(config.get("lycoris_kernel_backend") or "auto")
        lycoris_kernel_backend, lycoris_kernel_warning = detect_lycoris_kernel_backend(requested)
    from backend.training import adapt_config, detect_attention_backend, validate_training_config

    validation_errors = validate_training_config(config, gpu_ids=gpu_ids)
    if validation_errors:
        return None, _training_error(
            message="Invalid training configuration / 训练参数无效:\n" + "\n".join(validation_errors)
        )

    # ── TE 磁盘缓存一致性检查（按引擎）：改 caption/dropout 率不会让缓存失效，启动前提示 ──
    ignore_te_cache_warnings = bool(config.pop("ignore_te_cache_warnings", None))
    if profile.id in TE_CACHE_CHECK_PROFILES and not ignore_te_cache_warnings:
        te_cache_warnings = await _settled_to_thread(check_te_cache, config, profile.id)
        if te_cache_warnings:
            return None, _training_error(
                message="Text encoder cache may be stale / 文本编码器缓存可能已过期",
                data={"errorCode": "teCacheStale", "warnings": te_cache_warnings},
            )
    adapted_config, adapter_warnings = adapt_config(config, gpu_ids=gpu_ids)
    for w in adapter_warnings:
        log.warning(f"[Adapter] {w}")
    config = adapted_config

    estimate_config = dict(config)
    if gpu_ids is not None:
        estimate_config["gpu_ids"] = gpu_ids
    try:
        step_estimate = await _settled_to_thread(estimate_training_steps, estimate_config)
    except StepEstimateError as exc:
        return None, _training_error(message=f"Training step calculation failed / 训练步数计算失败: {exc}")

    from backend.training.validation import validate_scheduler_step_budget

    scheduler_errors = validate_scheduler_step_budget(
        config, step_estimate["total_steps"], step_estimate["gpu_processes"],
    )
    if scheduler_errors:
        return None, _training_error(
            message="Invalid training configuration / 训练参数无效:\n" + "\n".join(scheduler_errors)
        )

    # AdEMAMix 的 α/β3 调度按预估总步数自动注入（仅在用户留空对应字段时）
    from backend.training.optimizer_contracts import apply_ademamix_step_schedule

    schedule_warnings = apply_ademamix_step_schedule(config, step_estimate["total_steps"])
    adapter_warnings.extend(schedule_warnings)
    for warning in schedule_warnings:
        log.warning(f"[Adapter] {warning}")

    if "attn_mode" in config:
        attn_requested = config.get("attn_mode", "torch")
        attn_actual, attn_warning = detect_attention_backend(attn_requested)
        if attn_requested == "flash" and attn_actual != "flash":
            return None, _training_error(message=attn_warning)
        if attn_warning:
            log.warning(f"[Attn] {attn_warning}")
            config["attn_mode"] = attn_actual

    return SdScriptsSettings(
        config=config, ui_config=_ui_config, adapter_id=adapter_id,
        subset_timestep_offsets=subset_timestep_offsets, warnings=adapter_warnings,
        lycoris_kernel_backend=lycoris_kernel_backend, lycoris_kernel_warning=lycoris_kernel_warning,
    ), None


async def check_input_files(config, model_train_type) -> tuple[int | None, dict | None]:
    dataset_ok = train_utils.validate_data_dir(config["train_data_dir"])
    if not dataset_ok:
        return None, _training_error(message="Dataset path does not exist or has no images / 数据集路径不存在或无图片")

    # 正则化数据目录：填了但不存在时直接报错，避免 sd-scripts 静默忽略导致用户以为有正则数据。
    # 目录存在但没有任何"数字_类名"子目录时同样报错——sd-scripts 只扫描子目录（子目录缺失时
    # 生成空子集并仅打警告，训练照常跑但没有正则化）。
    reg_data_dir = str(config.get("reg_data_dir") or "").strip()
    if reg_data_dir:
        if not os.path.isdir(reg_data_dir):
            return None, _training_error(
                message=f"Regularization data dir does not exist / 正则化数据目录不存在: {reg_data_dir}",
                data={"errorCode": "regDataDirNotFound"},
            )
        reg_subdirs = [
            name
            for name in os.listdir(reg_data_dir)
            if os.path.isdir(os.path.join(reg_data_dir, name)) and name.split("_")[0].isdigit()
        ]
        if not reg_subdirs:
            return None, _training_error(
                message=f"No valid subfolder (e.g. 10_face) found in regularization data dir / 正则化数据目录中未找到有效子文件夹（如 10_face）: {reg_data_dir}",
                data={"errorCode": "regDataDirNoSubfolders"},
            )

    image_count = await _settled_to_thread(
        train_utils.count_images, config["train_data_dir"], True, 201
    )
    suggest_cpu_threads = 8 if image_count > 200 else 2

    validated, message = await _settled_to_thread(
        train_utils.validate_model, config["pretrained_model_name_or_path"]
    )
    if not validated:
        return None, _training_error(message=message)

    # ── Anima: qwen3 编码器路径必填校验 ─────────────────
    if model_train_type == "anima-lora":
        qwen3_path = config.get("qwen3", "").strip()
        if not qwen3_path:
            return None, _training_error(
                message="Anima LoRA training requires the Qwen3 encoder path / Anima LoRA 训练需要填写 Qwen3 编码器路径"
            )
        if not os.path.exists(qwen3_path):
            return None, _training_error(message=f"Qwen3 model not found / Qwen3 模型不存在: {qwen3_path}")
        vae_path = config.get("vae", "").strip()
        if not os.path.exists(vae_path):
            return None, _training_error(message=f"VAE model not found / VAE 模型不存在: {vae_path}")

    if model_train_type == "moss-image-lora":
        from backend.training.moss_image import validate_captions, validate_model_files

        model_errors = await _settled_to_thread(validate_model_files, config)
        if model_errors:
            return None, _training_error(message="\n".join(model_errors))
        caption_errors = await _settled_to_thread(validate_captions, config)
        if caption_errors:
            return None, _training_error(message="\n".join(caption_errors))
        if config.get("convrot_int8_bwd") == "int8":
            from library.convrot_int8_kernels import HAS_TRITON

            if not HAS_TRITON:
                return None, _training_error(message="ConvRot INT8 backward requires CUDA and Triton / INT8 反向需要 CUDA 与 Triton")

    return suggest_cpu_threads, None
