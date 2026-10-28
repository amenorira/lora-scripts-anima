"""Prepare sd-scripts profiles under an existing task reservation."""
import os
from pathlib import Path

from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.constants import AUTOSAVE_DIR, OUTPUT_DIR
from backend.log import log
from backend.monitor.run_registry import resolve_user_path, write_output_dir_reference
from backend.training import run_files, toml_writer
from backend.training.metrics_config import training_metrics_environment
from backend.training.preparation import training_error as _training_error
from backend.training.sd_dataset_config import (
    SUBSET_TIMESTEP_OFFSETS_KEY, build_sd_scripts_dataset_config, normalize_subset_timestep_offsets,
)
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.supervisor import detect_lycoris_kernel_backend
from backend.training.te_cache_check import TE_CACHE_CHECK_PROFILES, check_te_cache
from backend.training.training_config import (
    TRAINING_CONFIG_NAME, build_training_config, write_training_config,
)
from backend.utils import train_utils


def get_sample_prompts(config: dict):
    """Build prompt text; filesystem errors must abort preparation."""
    import random

    positive_prompts = config.get('positive_prompts', None)
    negative_prompts = config.get('negative_prompts', '')
    is_moss = config.get('model_train_type') == 'moss-image-lora'
    sample_width = config.get('sample_width', 1024 if is_moss else 512)
    sample_height = config.get('sample_height', 1024 if is_moss else 512)
    sample_cfg = config.get('sample_cfg', 3.0 if is_moss else 7)
    sample_seed = config.get('sample_seed', 2333)
    sample_steps = config.get('sample_steps', 50 if is_moss else 24)
    sample_flow_shift = config.get('sample_flow_shift', 5.0 if is_moss else 3.0)
    randomly_choice_prompt = config.get('randomly_choice_prompt', False)

    if randomly_choice_prompt:
        dataset_subdirs = [p for p in Path(config["train_data_dir"]).iterdir() if p.is_dir()]
        if len(dataset_subdirs) != 1:
            raise ValueError(
                'Multiple subdirectories found / 多子文件夹; '
                'random prompt selection requires a single subdirectory / 随机选取 Prompt 需要单一子文件夹'
            )

        # 排序保证同一 seed 下选中的文件稳定（glob 顺序依赖文件系统，不可预期）
        caption_files = sorted(dataset_subdirs[0].glob('*.txt'))
        if not caption_files:
            raise ValueError('No .txt files found in dataset directory / 数据集路径没有 txt 文件')
        sample_prompt_file = random.Random(int(config.get("seed", 2333))).choice(caption_files)
        positive_prompts = sample_prompt_file.read_text(encoding="utf-8")

    if is_moss:
        import json

        if not positive_prompts or not positive_prompts.strip():
            return ''
        return json.dumps([{
            "prompt": positive_prompts, "negative_prompt": negative_prompts or "",
            "width": sample_width, "height": sample_height,
            "scale": sample_cfg, "sample_steps": sample_steps,
            "seed": sample_seed, "flow_shift": sample_flow_shift,
        }], ensure_ascii=False)

    # Sanitise negative prompt: replace newlines with ", " to keep --n on one line
    negative_prompts = negative_prompts.replace(chr(10), ", ") if negative_prompts else ""

    param_suffix = (
        f'--n {negative_prompts} '
        f'--w {sample_width} --h {sample_height} '
        f'--l {sample_cfg} --s {sample_steps} --d {sample_seed} '
        f'--fs {sample_flow_shift}'
    )

    if positive_prompts and positive_prompts.strip():
        # Multi-line: treat each non-empty line as a separate sample entry
        lines = [ln.strip() for ln in positive_prompts.strip().splitlines() if ln.strip()]
        sample_prompts_arg = chr(10).join(f'{line} {param_suffix}' for line in lines)
    else:
        sample_prompts_arg = ''

    return sample_prompts_arg


async def prepare_run(config, gpu_ids, timestamp, form_snapshot, reserved_task, profile):
    try:
        subset_timestep_offsets = normalize_subset_timestep_offsets(
            config.pop(SUBSET_TIMESTEP_OFFSETS_KEY, None)
        )
    except ValueError as exc:
        return _training_error(message=str(exc))
    if profile.id not in ("anima-lora", "moss-image-lora"):
        subset_timestep_offsets = {}

    # Keep the legacy sd-scripts adapter input byte-for-byte compatible. Core
    # metadata is restored at the supervisor boundary instead of being passed
    # through to sd-scripts as an unknown command line field.
    config.pop("engine_id", None)
    adapter_id = str(config.pop("adapter_id", profile.adapter_id))
    model_train_type = profile.id
    trainer_file = profile.trainer_file

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
        return _training_error(
            message="Invalid training configuration / 训练参数无效:\n" + "\n".join(validation_errors)
        )

    # ── TE 磁盘缓存一致性检查（按引擎）：改 caption/dropout 率不会让缓存失效，启动前提示 ──
    ignore_te_cache_warnings = bool(config.pop("ignore_te_cache_warnings", None))
    if profile.id in TE_CACHE_CHECK_PROFILES and not ignore_te_cache_warnings:
        te_cache_warnings = await _settled_to_thread(check_te_cache, config, profile.id)
        if te_cache_warnings:
            return _training_error(
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
        return _training_error(message=f"Training step calculation failed / 训练步数计算失败: {exc}")

    from backend.training.validation import validate_scheduler_step_budget

    scheduler_errors = validate_scheduler_step_budget(
        config, step_estimate["total_steps"], step_estimate["gpu_processes"],
    )
    if scheduler_errors:
        return _training_error(
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
            return _training_error(message=attn_warning)
        if attn_warning:
            log.warning(f"[Attn] {attn_warning}")
            config["attn_mode"] = attn_actual
    # ──────────────────────────────────────────────────────────

    # ── Per-run folder: internal control data + user-selected artifacts ──
    output_name = config.get("output_name", "my_lora")
    safe_name = run_files.safe_output_name(str(output_name))
    run_dir_name = f"{safe_name}_{timestamp}_{reserved_task.task_id[:12]}"
    is_resume = bool(config.get("resume", "").strip())

    # 用户设置的路径仅决定模型/断点/sample 的位置；日志、配置、TB 均保存在内部 run_dir。
    requested_output_dir = str(config.get("output_dir", "./output") or "./output").strip()
    try:
        output_base_path = await _settled_to_thread(resolve_user_path, requested_output_dir)
    except (OSError, ValueError) as exc:
        return _training_error(
            message=f"Invalid output path / 输出路径无效: {exc}",
            data={"errorCode": "invalidOutputPath"},
        )
    internal_run_dir = (OUTPUT_DIR / run_dir_name).resolve()
    artifact_run_dir = output_base_path if is_resume else output_base_path / run_dir_name
    # ──────────────────────────────────────────────────────────

    dataset_ok = train_utils.validate_data_dir(config["train_data_dir"])
    if not dataset_ok:
        return _training_error(message="Dataset path does not exist or has no images / 数据集路径不存在或无图片")

    # 正则化数据目录：填了但不存在时直接报错，避免 sd-scripts 静默忽略导致用户以为有正则数据。
    # 目录存在但没有任何"数字_类名"子目录时同样报错——sd-scripts 只扫描子目录（子目录缺失时
    # 生成空子集并仅打警告，训练照常跑但没有正则化）。
    reg_data_dir = str(config.get("reg_data_dir") or "").strip()
    if reg_data_dir:
        if not os.path.isdir(reg_data_dir):
            return _training_error(
                message=f"Regularization data dir does not exist / 正则化数据目录不存在: {reg_data_dir}",
                data={"errorCode": "regDataDirNotFound"},
            )
        reg_subdirs = [
            name
            for name in os.listdir(reg_data_dir)
            if os.path.isdir(os.path.join(reg_data_dir, name)) and name.split("_")[0].isdigit()
        ]
        if not reg_subdirs:
            return _training_error(
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
        return _training_error(message=message)

    # ── Anima: qwen3 编码器路径必填校验 ─────────────────
    if model_train_type == "anima-lora":
        qwen3_path = config.get("qwen3", "").strip()
        if not qwen3_path:
            return _training_error(
                message="Anima LoRA training requires the Qwen3 encoder path / Anima LoRA 训练需要填写 Qwen3 编码器路径"
            )
        if not os.path.exists(qwen3_path):
            return _training_error(message=f"Qwen3 model not found / Qwen3 模型不存在: {qwen3_path}")
        vae_path = config.get("vae", "").strip()
        if not os.path.exists(vae_path):
            return _training_error(message=f"VAE model not found / VAE 模型不存在: {vae_path}")

    if model_train_type == "moss-image-lora":
        from backend.training.moss_image import validate_captions, validate_model_files

        model_errors = await _settled_to_thread(validate_model_files, config)
        if model_errors:
            return _training_error(message="\n".join(model_errors))
        caption_errors = await _settled_to_thread(validate_captions, config)
        if caption_errors:
            return _training_error(message="\n".join(caption_errors))
        if config.get("convrot_int8_bwd") == "int8":
            from library.convrot_int8_kernels import HAS_TRITON

            if not HAS_TRITON:
                return _training_error(message="ConvRot INT8 backward requires CUDA and Triton / INT8 反向需要 CUDA 与 Triton")

    sample_prompts_arg = ""
    # Raw trainer TOMLs call the prompt file sample_prompts; the UI calls it prompt_file.
    prompt_file = str(_ui_config.get("prompt_file") or _ui_config.get("sample_prompts") or "").strip()
    if prompt_file:
        if not os.path.exists(prompt_file):
            return _training_error(message=f"Sample prompt file not found / 采样提示词文件不存在: {prompt_file}")
        config["sample_prompts"] = prompt_file
    else:
        try:
            sample_prompts_arg = await _settled_to_thread(get_sample_prompts, _ui_config)

        except ValueError as e:
            log.error(f"Error while processing prompts / 处理采样提示词时出错: {e}")
            return _training_error(message=str(e))

    try:
        # 优先检查用户产物目录；磁盘 I/O 放入线程，避免离线盘阻塞 API。
        await _settled_to_thread(
            run_files.prepare_run_directories,
            artifact_run_dir,
            internal_run_dir,
            resume=is_resume,
            owned=reserved_task.owned_run_paths,
        )
    except OSError as exc:
        log.warning("Output directory unavailable / 输出目录不可用: %s", exc)
        return _training_error(
            message=f"Output directory is unavailable or not writable / 输出目录不可用或无法写入: {exc}",
            data={
                "errorCode": "outputDirectoryUnavailable",
                "outputPath": str(artifact_run_dir),
            },
        )

    config["output_dir"] = str(artifact_run_dir)
    config["logging_dir"] = str(internal_run_dir / "log")

    if sample_prompts_arg:
        prompts_path = internal_run_dir / ("prompts.json" if model_train_type == "moss-image-lora" else "prompts.txt")
        prompts_path.write_text(sample_prompts_arg, encoding="utf-8")
        config["sample_prompts"] = str(prompts_path)
        log.info(f"Sample prompts written / 采样 prompt 已写入: {prompts_path}")

    # ── A: autosave — 保留最近 50 个，清理旧文件 ────────────
    AUTOSAVE_DIR.mkdir(parents=True, exist_ok=True)
    run_files.cleanup_autosave(str(AUTOSAVE_DIR), keep=50)

    toml_file = str(AUTOSAVE_DIR / f"{timestamp}_{reserved_task.task_id[:12]}.toml")
    reserved_task.owned_autosave = Path(toml_file)
    toml_content = toml_writer.dumps(config)
    training_document = build_training_config(
        form_snapshot,
        profile_id=profile.id,
    )
    dataset_config_file: Path | None = None
    dataset_toml = ""
    if subset_timestep_offsets:
        try:
            dataset_config = build_sd_scripts_dataset_config(config, subset_timestep_offsets)
        except ValueError as exc:
            return _training_error(message=str(exc))
        dataset_config_file = internal_run_dir / "dataset.toml"
        dataset_toml = toml_writer.dumps(dataset_config)

    def _write_configs():
        with open(toml_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        run_config_file = str(internal_run_dir / "config.toml")
        with open(run_config_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        write_training_config(internal_run_dir / TRAINING_CONFIG_NAME, training_document)
        if dataset_config_file is not None:
            dataset_config_file.write_text(dataset_toml, encoding="utf-8")

    # ── A-2: 并发写入 config + run 信息（写入不同文件，无依赖）──
    def _write_run_files():
        _write_configs()
        run_files.write_run_info(str(internal_run_dir), config, model_train_type, timestamp, is_resume)
        write_output_dir_reference(str(internal_run_dir), str(artifact_run_dir))

    await _settled_to_thread(_write_run_files)
    # ──────────────────────────────────────────────────────────

    extra_args = ["--dataset_config", str(dataset_config_file)] if dataset_config_file is not None else None
    result = reserved_task.launch(
        toml_file,
        trainer_file,
        gpu_ids,
        suggest_cpu_threads,
        extra_args=extra_args,
        run_dir=str(internal_run_dir),
        artifact_dir=str(artifact_run_dir),
        output_base_dir=requested_output_dir,
        preview_enabled=bool(_ui_config.get("enable_preview", False)),
        engine_id=profile.engine_id,
        run_metadata={
            "profile_id": profile.id,
            "adapter_id": adapter_id,
        },
        extra_env={
            **training_metrics_environment(_ui_config),
            "ANIMA_ENABLE_FLASH_ATTN": "1" if config.get("attn_mode") == "flash" else "0",
            **({"LYCORIS_KERNEL_BACKEND": lycoris_kernel_backend} if lycoris_kernel_backend else {}),
        },
    )

    # 将适配器警告附加到返回结果中（前端弹窗展示）
    if lycoris_kernel_warning:
        adapter_warnings.append(lycoris_kernel_warning)
    if result["status"] == "success" and adapter_warnings:
        result["data"]["warnings"] = adapter_warnings

    return result
