"""Prepare Krea 2 training and cache jobs under an existing task reservation."""
import json
from datetime import datetime
from pathlib import Path

from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.constants import AUTOSAVE_DIR, OUTPUT_DIR
from backend.monitor.run_registry import resolve_user_path, write_output_dir_reference
from backend.training import run_files, toml_writer
from backend.training.core_registry import TrainingProfileError, resolve_training_profile
from backend.training.krea2_cache import mark_cache_manifest
from backend.training.krea2_network import (
    KREA2_LYCORIS_MODULE, KREA2_PRESET_FILENAME, build_krea2_network_preset,
)
from backend.training.metrics_config import training_metrics_environment
from backend.training.musubi_krea2 import (
    KREA2_CACHE_RUNNER_FILE, KREA2_PROFILE_ID, KREA2_TRAINER_FILE, MUSUBI_TUNER_DIR,
    build_krea2_dataset_config, build_krea2_train_config, krea2_preflight, validate_krea2_config,
)
from backend.training.preparation import training_error as _training_error
from backend.training.supervisor import detect_lycoris_kernel_backend
from backend.training.training_config import (
    TRAINING_CONFIG_NAME, build_training_config, write_training_config,
)


def _krea2_error(errors: list[str], error_code: str = "krea2PreflightFailed"):
    return _training_error(
        message="Krea 2 configuration is not ready / Krea 2 配置尚未就绪:\n" + "\n".join(errors),
        data={"errorCode": error_code, "errors": errors},
    )


async def prepare_run(config, gpu_ids, timestamp, form_snapshot, reserved_task):
    """Prepare the musubi Krea 2 profile under the caller's reservation."""

    snapshot_form = dict(form_snapshot)
    snapshot_form["model_train_type"] = KREA2_PROFILE_ID

    config["gpu_ids"] = gpu_ids
    validation_errors = validate_krea2_config(config)
    if validation_errors:
        return _krea2_error(validation_errors, "invalidKrea2Config")

    preflight = await _settled_to_thread(krea2_preflight, config, True)
    if not preflight["ok"]:
        code = "krea2CacheRequired" if not preflight["cache"]["ready"] else "krea2PreflightFailed"
        return _krea2_error(preflight["errors"], code)

    output_name = config.get("output_name", "krea2_lora")
    safe_name = run_files.safe_output_name(str(output_name))
    run_dir_name = f"{safe_name}_{timestamp}_{reserved_task.task_id[:12]}"
    is_resume = bool(str(config.get("resume") or "").strip())
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
    try:
        await _settled_to_thread(
            run_files.prepare_run_directories, artifact_run_dir, internal_run_dir,
            resume=is_resume, owned=reserved_task.owned_run_paths,
        )
    except OSError as exc:
        return _training_error(
            message=f"Output directory is unavailable or not writable / 输出目录不可用或无法写入: {exc}",
            data={"errorCode": "outputDirectoryUnavailable", "outputPath": str(artifact_run_dir)},
        )

    config["output_dir"] = str(artifact_run_dir)
    config["logging_dir"] = str(internal_run_dir / "log")
    dataset_config = build_krea2_dataset_config(config)
    dataset_config_file = internal_run_dir / "dataset.toml"
    sample_prompts_file = (
        internal_run_dir / "sample_prompts.txt" if bool(config.get("enable_krea_samples", False)) else None
    )
    train_config = build_krea2_train_config(
        config,
        dataset_config_file,
        artifact_run_dir,
        internal_run_dir / "log",
        sample_prompts_file,
    )
    network_preset = None
    network_env = {"ANIMA_ENABLE_FLASH_ATTN": "1" if config.get("krea_attention_backend") == "flash_attn" else "0"}
    network_warning = ""
    if config["network_module"] == KREA2_LYCORIS_MODULE:
        network_preset = build_krea2_network_preset(config)
        kernel, network_warning = await _settled_to_thread(
            detect_lycoris_kernel_backend, str(config.get("lycoris_kernel_backend") or "auto")
        )
        network_env["LYCORIS_KERNEL_BACKEND"] = kernel

    AUTOSAVE_DIR.mkdir(parents=True, exist_ok=True)
    run_files.cleanup_autosave(str(AUTOSAVE_DIR), keep=50)
    toml_file = AUTOSAVE_DIR / f"{timestamp}_{reserved_task.task_id[:12]}-krea2.toml"
    reserved_task.owned_autosave = toml_file
    train_toml = toml_writer.dumps(train_config)
    dataset_toml = toml_writer.dumps(dataset_config)
    training_document = build_training_config(
        snapshot_form,
        profile_id=KREA2_PROFILE_ID,
    )

    def _write_configs():
        toml_file.write_text(train_toml, encoding="utf-8")
        (internal_run_dir / "config.toml").write_text(train_toml, encoding="utf-8")
        write_training_config(internal_run_dir / TRAINING_CONFIG_NAME, training_document)
        dataset_config_file.write_text(dataset_toml, encoding="utf-8")
        if network_preset is not None:
            (internal_run_dir / KREA2_PRESET_FILENAME).write_text(toml_writer.dumps(network_preset), encoding="utf-8")
        if sample_prompts_file is not None:
            prompts = str(config["krea_sample_prompts"]).replace("\r\n", "\n").replace("\r", "\n").rstrip()
            sample_prompts_file.write_text(prompts + "\n", encoding="utf-8")

    def _write_run_files():
        _write_configs()
        run_files.write_run_info(str(internal_run_dir), config, KREA2_PROFILE_ID, timestamp, is_resume)
        write_output_dir_reference(str(internal_run_dir), str(artifact_run_dir))

    await _settled_to_thread(_write_run_files)

    result = reserved_task.launch(
        str(toml_file),
        KREA2_TRAINER_FILE,
        gpu_ids,
        2,
        run_dir=str(internal_run_dir),
        artifact_dir=str(artifact_run_dir),
        output_base_dir=requested_output_dir,
        preview_enabled=False,
        engine_id="musubi_tuner",
        extra_env={**training_metrics_environment(config), **network_env},
        run_metadata={
            "profile_id": KREA2_PROFILE_ID,
            "adapter_id": config["adapter_id"],
            "dataset_config": str(dataset_config_file),
            "sample_prompts": str(sample_prompts_file) if sample_prompts_file is not None else None,
        },
    )
    if network_warning and result.get("status") == "success":
        result.setdefault("data", {}).setdefault("warnings", []).append(network_warning)
    return result


async def prepare_cache(config: dict, reserved_task):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    gpu_ids = config.pop("gpu_ids", None)
    try:
        profile = resolve_training_profile(config)
    except TrainingProfileError as exc:
        return _training_error(message=str(exc))
    if profile.id != KREA2_PROFILE_ID:
        return _training_error(message="Krea 2 profile required / 此接口仅支持 Krea 2 配置档")

    validation_errors = validate_krea2_config(config)
    if validation_errors:
        return _krea2_error(validation_errors, "invalidKrea2Config")
    preflight = await _settled_to_thread(krea2_preflight, config, False)
    if not preflight["ok"]:
        return _krea2_error(preflight["errors"], "krea2PreflightFailed")

    safe_name = run_files.safe_output_name(str(config.get("output_name", "krea2_lora")))
    run_dir = (OUTPUT_DIR / f"{safe_name}_krea2_cache_{timestamp}_{reserved_task.task_id[:12]}").resolve()
    cache_dir = Path(str(config["dataset_cache_dir"])).resolve()
    try:
        await _settled_to_thread(
            run_files.prepare_run_directories, cache_dir, run_dir,
            resume=True, owned=reserved_task.owned_run_paths,
        )
    except OSError as exc:
        return _training_error(
            message=f"Cache directory is unavailable or not writable / 缓存目录不可用或无法写入: {exc}",
            data={"errorCode": "cacheDirectoryUnavailable", "cachePath": str(cache_dir)},
        )

    dataset_config_file = run_dir / "dataset.toml"
    cache_request_file = run_dir / "cache-request.json"
    dataset_toml = toml_writer.dumps(build_krea2_dataset_config(config))
    try:
        await reserved_task.prepare_cache_manifest(config)
        def _write_cache_files():
            dataset_config_file.write_text(dataset_toml, encoding="utf-8")
            cache_request_file.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
            run_files.write_run_info(str(run_dir), config, "krea2-cache", timestamp, False)
            write_output_dir_reference(str(run_dir), str(cache_dir))
        await _settled_to_thread(_write_cache_files)
    except OSError as exc:
        return _training_error(message=f"Failed to initialize Krea 2 cache / 初始化 Krea 2 缓存失败: {exc}")

    def _finalize_cache(status: str) -> str | None:
        return mark_cache_manifest(config, status)

    result = reserved_task.launch(
        str(dataset_config_file),
        KREA2_CACHE_RUNNER_FILE,
        gpu_ids,
        2,
        extra_args=[
            "--musubi-root",
            str(MUSUBI_TUNER_DIR),
            "--dataset-config",
            str(dataset_config_file),
            "--vae",
            str(config["vae"]),
            "--text-encoder",
            str(config["text_encoder"]),
            "--text-cache-batch-size",
            str(config.get("text_cache_batch_size", 1)),
            "--latent-cache-batch-size",
            str(config.get("krea_latent_cache_batch_size", 1)),
            "--latent-device",
            str(config.get("krea_latent_cache_device", "auto")),
            "--text-device",
            str(config.get("krea_text_cache_device", "auto")),
            "--num-workers",
            str(config.get("krea_cache_num_workers", 2)),
            "--request-file",
            str(cache_request_file),
            *(["--vae-tiling"] if config.get("krea_cache_vae_tiling") else []),
        ],
        run_dir=str(run_dir),
        artifact_dir=str(run_dir),
        output_base_dir=str(cache_dir),
        preview_enabled=False,
        engine_id="musubi_tuner",
        config_argument=None,
        use_accelerate=False,
        run_metadata={
            "profile_id": KREA2_PROFILE_ID,
            "operation": "krea2_cache",
            "dataset_config": str(dataset_config_file),
            "cache_dir": str(cache_dir),
        },
        finalize_result=_finalize_cache,
    )
    if result.get("status") != "success":
        return result
    result.setdefault("data", {})["operation"] = "krea2_cache"
    return result

