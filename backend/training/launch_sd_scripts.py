"""Prepare sd-scripts profiles under an existing task reservation."""
import os
from pathlib import Path

from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.constants import AUTOSAVE_DIR, OUTPUT_DIR
from backend.log import log
from backend.monitor.run_registry import resolve_user_path, write_output_dir_reference
from backend.training import run_files, sd_scripts_preflight, toml_writer
from backend.training.metrics_config import training_metrics_environment
from backend.training.preparation import training_error as _training_error
from backend.training.sd_dataset_config import build_sd_scripts_dataset_config
from backend.training.training_config import (
    TRAINING_CONFIG_NAME, build_training_config, write_training_config,
)


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
    settings, error = await sd_scripts_preflight.prepare_settings(config, gpu_ids, profile)
    if error is not None:
        return error
    config = settings.config
    model_train_type = profile.id

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

    suggest_cpu_threads, error = await sd_scripts_preflight.check_input_files(config, model_train_type)
    if error is not None:
        return error

    sample_prompts_arg = ""
    # Raw trainer TOMLs call the prompt file sample_prompts; the UI calls it prompt_file.
    prompt_file = str(settings.ui_config.get("prompt_file") or settings.ui_config.get("sample_prompts") or "").strip()
    if prompt_file:
        if not os.path.exists(prompt_file):
            return _training_error(message=f"Sample prompt file not found / 采样提示词文件不存在: {prompt_file}")
        config["sample_prompts"] = prompt_file
    else:
        try:
            sample_prompts_arg = await _settled_to_thread(get_sample_prompts, settings.ui_config)

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
    if settings.subset_timestep_offsets:
        try:
            dataset_config = build_sd_scripts_dataset_config(config, settings.subset_timestep_offsets)
        except ValueError as exc:
            return _training_error(message=str(exc))
        dataset_config_file = internal_run_dir / "dataset.toml"
        dataset_toml = toml_writer.dumps(dataset_config)

    def _write_run_files():
        with open(toml_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        run_config_file = str(internal_run_dir / "config.toml")
        with open(run_config_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        write_training_config(internal_run_dir / TRAINING_CONFIG_NAME, training_document)
        if dataset_config_file is not None:
            dataset_config_file.write_text(dataset_toml, encoding="utf-8")

        run_files.write_run_info(str(internal_run_dir), config, model_train_type, timestamp, is_resume)
        write_output_dir_reference(str(internal_run_dir), str(artifact_run_dir))

    await _settled_to_thread(_write_run_files)
    # ──────────────────────────────────────────────────────────

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
