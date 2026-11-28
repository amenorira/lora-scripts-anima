"""Prepare sd-scripts profiles under an existing task reservation."""
import json
from pathlib import Path
from secrets import randbits

from backend import constants as _constants
from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.log import log
from backend.monitor.run_registry import write_output_dir_reference
from backend.training.config import toml_writer
from backend.training.config.storage_paths import normalize_training_path, resolve_training_path
from backend.training.execution import run_files, sd_scripts_preflight
from backend.training.config.metrics_config import training_metrics_environment
from backend.training.preview.config import CONFIG_NAME, ENV_KEY, prepare_config as prepare_preview_config
from backend.training.preview.prompt_file import read_prompt_entries, require_scheduled_prompt
from backend.training.execution.preparation import training_error as _training_error
from backend.training.datasets.sd_dataset_config import build_sd_scripts_dataset_config
from backend.training.cache.rebuild import clear_cache_files, prepare_cache_choice, sd_scripts_cache_files
from backend.training.config.training_config import (
    TRAINING_CONFIG_NAME, build_training_config, write_training_config,
)


def get_sample_prompts(config: dict, *, require_scheduled: bool = False):
    """Build prompt text; filesystem errors must abort preparation."""
    import random
    from backend.training.preview.config import compose_preview_prompts

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
        dataset_subdirs = [p for p in resolve_training_path(config["train_data_dir"]).iterdir() if p.is_dir()]
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

    positive_prompts = compose_preview_prompts(config, positive_prompts)
    reserved = compose_preview_prompts(config, config.get("reserved_prompts") or "")

    if is_moss:
        entries = [{
            "prompt": prompt, "negative_prompt": negative_prompts or "",
            "width": sample_width, "height": sample_height,
            "scale": sample_cfg, "sample_steps": steps,
            "seed": sample_seed, "flow_shift": sample_flow_shift,
        } for prompt, steps in ((positive_prompts, sample_steps), (reserved, 0)) if prompt and prompt.strip()]
        if require_scheduled:
            require_scheduled_prompt(entries)
        return json.dumps(entries, ensure_ascii=False) if entries else ""

    # Sanitise negative prompt: replace newlines with ", " to keep --n on one line
    negative_prompts = negative_prompts.replace(chr(10), ", ") if negative_prompts else ""

    def param_suffix(steps):
        return (
            f'--n {negative_prompts} '
            f'--w {sample_width} --h {sample_height} '
            f'--l {sample_cfg} --s {steps} --d {sample_seed} '
            f'--fs {sample_flow_shift}'
        )

    return "\n".join(f"{line.strip()} {param_suffix(steps)}"
                     for text, steps in ((positive_prompts or "", sample_steps), (reserved, 0))
                     for line in text.splitlines() if line.strip())


def write_manual_preview_cache(control_dir: Path, options: dict) -> Path:
    # Upstream checks external encodings against one cached embedding. Its scheduled
    # sampler skips zero-step entries, including this empty reference prompt.
    fields = {"width": "sample_width", "height": "sample_height", "scale": "sample_cfg",
              "seed": "sample_seed", "flow_shift": "sample_flow_shift", "negative_prompt": "negative_prompts"}
    template = {key: options[src] for key, src in fields.items() if options.get(src) is not None}
    template.update(prompt="", sample_steps=0)
    path = control_dir / "manual-preview.json"
    control_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([template], ensure_ascii=False), encoding="utf-8")
    return path


async def prepare_run(config, gpu_ids, timestamp, form_snapshot, reserved_task, profile):
    cache_action = config.pop("_cache_action", None)
    settings, error = await sd_scripts_preflight.prepare_settings(config, gpu_ids, profile)
    if error is not None:
        return error
    config = settings.config
    if config.get("seed") is None:
        # Every rank builds its datasets before Accelerate initializes the process group.
        config["seed"] = randbits(32)
    model_train_type = profile.id
    try:
        preview_config = await _settled_to_thread(prepare_preview_config, settings.ui_config, profile.id)
    except (ValueError, RuntimeError) as exc:
        return _training_error(message=str(exc), code="previewConfigInvalid", details=str(exc))

    # ── Per-run folder: internal control data + user-selected artifacts ──
    output_name = config.get("output_name", "my_lora")
    safe_name = run_files.safe_output_name(str(output_name))
    run_dir_name = f"{safe_name}_{timestamp}_{reserved_task.task_id[:12]}"
    is_resume = bool(config.get("resume", "").strip())

    # 用户设置的路径仅决定模型/断点/sample 的位置；日志、配置、TB 均保存在内部 run_dir。
    requested_output_dir = str(settings.ui_config.get("output_dir") or config.get("output_dir") or "./output").strip()
    output_dir_root = _constants.OUTPUT_DIR
    try:
        output_base_path = await _settled_to_thread(resolve_training_path, requested_output_dir)
    except (OSError, ValueError) as exc:
        return _training_error(
            message=f"Invalid output path / 输出路径无效: {exc}",
            code="invalidOutputPath", params={"path": requested_output_dir}, details=str(exc),
        )
    internal_run_dir = (output_dir_root / run_dir_name).resolve()
    artifact_run_dir = output_base_path / run_dir_name
    # ──────────────────────────────────────────────────────────

    suggest_cpu_threads, error = await sd_scripts_preflight.check_input_files(config, model_train_type)
    if error is not None:
        return error

    cache_files, error = await prepare_cache_choice(cache_action, sd_scripts_cache_files, config, profile.id)
    if error is not None:
        return error

    prompt_file = str(config.get("sample_prompts") or "").strip()
    scheduled_moss = model_train_type == "moss-image-lora" and any(
        config.get(key) for key in ("sample_at_first", "sample_every_n_steps", "sample_every_n_epochs")
    )
    sample_prompts_arg = ""
    try:
        if prompt_file:
            resolved_prompt_file = resolve_training_path(prompt_file)
            entries = await _settled_to_thread(read_prompt_entries, resolved_prompt_file, moss=model_train_type == "moss-image-lora")
            if scheduled_moss:
                require_scheduled_prompt(entries)
            if (model_train_type in ("anima-lora", "moss-image-lora")
                    and (config.get("cache_text_encoder_outputs") or config.get("cache_text_encoder_outputs_to_disk"))):
                sample_prompts_arg = json.dumps(entries, ensure_ascii=False, allow_nan=False)
            else:
                config["sample_prompts"] = normalize_training_path(prompt_file, posix=True)
        else:
            sample_prompts_arg = await _settled_to_thread(get_sample_prompts, settings.ui_config, require_scheduled=scheduled_moss)
    except FileNotFoundError as exc:
        if prompt_file:
            return _training_error(message=str(exc), code="samplePromptNotFound", params={"path": prompt_file})
        return _training_error(message=str(exc), code="previewConfigInvalid", details=str(exc))
    except (OSError, ValueError, TypeError) as exc:
        return _training_error(message=str(exc), code="previewConfigInvalid", details=str(exc))

    try:
        # 优先检查用户产物目录；磁盘 I/O 放入线程，避免离线盘阻塞 API。
        await _settled_to_thread(
            run_files.prepare_run_directories,
            artifact_run_dir,
            internal_run_dir,
            owned=reserved_task.owned_run_paths,
        )
    except OSError as exc:
        log.warning("Output directory unavailable / 输出目录不可用: %s", exc)
        return _training_error(
            message=f"Output directory is unavailable or not writable / 输出目录不可用或无法写入: {exc}",
            data={
                "outputPath": str(artifact_run_dir),
            },
            code="outputDirectoryUnavailable", params={"path": str(artifact_run_dir)}, details=str(exc),
        )

    config["output_dir"] = str(artifact_run_dir)
    config["run_control"] = True
    config["logging_dir"] = str(internal_run_dir / "log")

    if sample_prompts_arg:
        prompts_path = internal_run_dir / ("prompts.json" if prompt_file or model_train_type == "moss-image-lora" else "prompts.txt")
        config["sample_prompts"] = str(prompts_path)
    elif (not config.get("sample_prompts") and model_train_type in ("anima-lora", "moss-image-lora")
          and len(gpu_ids or []) <= 1
          and (config.get("cache_text_encoder_outputs") or config.get("cache_text_encoder_outputs_to_disk"))):
        config["sample_prompts"] = str(write_manual_preview_cache(internal_run_dir / "log" / ".run-control", settings.ui_config))

    # ── A: autosave — 保留最近 50 个，清理旧文件 ────────────
    autosave_dir = _constants.AUTOSAVE_DIR
    autosave_dir.mkdir(parents=True, exist_ok=True)
    run_files.cleanup_autosave(str(autosave_dir), keep=50)

    toml_file = str(autosave_dir / f"{timestamp}_{reserved_task.task_id[:12]}.toml")
    reserved_task.owned_autosave = Path(toml_file)
    toml_content = toml_writer.dumps(config)
    training_document = build_training_config(
        form_snapshot,
        profile_id=profile.id,
    )
    dataset_config_file: Path | None = None
    dataset_toml = ""
    if settings.subset_timestep_offsets:
        try:
            dataset_config = build_sd_scripts_dataset_config(config, settings.subset_timestep_offsets)
        except ValueError as exc:
            return _training_error(message=str(exc), code="invalidSubsetOffsets", details=str(exc))
        dataset_config_file = internal_run_dir / "dataset.toml"
        dataset_toml = toml_writer.dumps(dataset_config)

    def _write_run_files():
        if sample_prompts_arg:
            prompts_path.write_text(sample_prompts_arg, encoding="utf-8")
            log.info(f"Sample prompts written / 采样 prompt 已写入: {prompts_path}")
        with open(toml_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        run_config_file = str(internal_run_dir / "config.toml")
        with open(run_config_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        write_training_config(internal_run_dir / TRAINING_CONFIG_NAME, training_document)
        if preview_config is not None:
            (internal_run_dir / CONFIG_NAME).write_text(
                json.dumps(preview_config, ensure_ascii=False, indent=2), encoding="utf-8")
        if dataset_config_file is not None:
            dataset_config_file.write_text(dataset_toml, encoding="utf-8")

        run_files.write_run_info(str(internal_run_dir), config, model_train_type, timestamp, is_resume)
        write_output_dir_reference(str(internal_run_dir), str(artifact_run_dir))

    await _settled_to_thread(_write_run_files)
    # ──────────────────────────────────────────────────────────

    error = await clear_cache_files(cache_files)
    if error is not None:
        return error

    extra_args = ["--dataset_config", str(dataset_config_file)] if dataset_config_file is not None else None
    result = reserved_task.launch(
        toml_file,
        profile.trainer_file,
        gpu_ids,
        suggest_cpu_threads,
        extra_args=extra_args,
        run_dir=str(internal_run_dir),
        artifact_dir=str(artifact_run_dir),
        output_base_dir=requested_output_dir,
        preview_enabled=bool(settings.ui_config.get("enable_preview", False)),
        engine_id=profile.engine_id,
        run_metadata={
            "profile_id": profile.id,
            "adapter_id": settings.adapter_id,
        },
        extra_env={
            "ANIMA_RUN_CONTROL_DIR": str(internal_run_dir / "log" / ".run-control"),
            "ANIMA_RESUME_TRAINING": "1" if is_resume else "",
            "ANIMA_MANUAL_PREVIEW_STEPS": str(settings.ui_config.get("sample_steps") or ""),
            ENV_KEY: str(internal_run_dir / CONFIG_NAME) if preview_config is not None else "",
            **training_metrics_environment(settings.ui_config),
            "ANIMA_ENABLE_FLASH_ATTN": "1" if config.get("attn_mode") == "flash" else "0",
            **({"LYCORIS_KERNEL_BACKEND": settings.lycoris_kernel_backend} if settings.lycoris_kernel_backend else {}),
        },
    )

    # 将适配器警告附加到返回结果中（前端弹窗展示）
    if settings.lycoris_kernel_warning:
        settings.warnings.append(settings.lycoris_kernel_warning)
    if result["status"] == "success" and settings.warnings:
        result["data"]["warnings"] = settings.warnings

    return result
