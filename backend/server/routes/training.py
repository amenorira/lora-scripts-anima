"""
Training routes — POST /run, POST /run_script
"""
import asyncio
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

import toml
from fastapi import APIRouter, BackgroundTasks, Query, Request

from backend.constants import OUTPUT_DIR
from backend.monitor.run_registry import resolve_user_path, write_output_dir_reference
from backend.training import run_train
from backend.training.core_registry import (
    TrainingProfileError,
    profile_payload,
    resolve_training_profile,
)
from backend.training.musubi_krea2 import (
    KREA2_CACHE_RUNNER_FILE,
    KREA2_PROFILE_ID,
    KREA2_TRAINER_FILE,
    MUSUBI_TUNER_DIR,
    build_krea2_dataset_config,
    build_krea2_train_config,
    get_krea2_cache_status,
    krea2_preflight,
    mark_cache_manifest,
    prepare_cache_manifest,
    validate_krea2_config,
)
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.training_config import (
    TRAINING_CONFIG_NAME,
    TrainingConfigError,
    build_training_config,
    dump_training_config,
    extract_training_form,
    parse_training_config_text,
    write_training_config,
)
from backend.training.sd_dataset_config import (
    SUBSET_TIMESTEP_OFFSETS_KEY,
    build_sd_scripts_dataset_config,
    normalize_subset_timestep_offsets,
)
from backend import launch_utils
from backend.server.models import APIResponseFail, APIResponseSuccess, TrainingTomlParseRequest
from backend.log import log
from backend.utils import train_utils

router = APIRouter()


@router.post("/training/export-config")
async def export_training_config(request: Request):
    """Serialize the current form into the application-level YAML format."""
    try:
        payload = await request.json()
    except (UnicodeDecodeError, json.JSONDecodeError):
        return APIResponseFail(message="Invalid JSON request / 请求 JSON 格式无效")
    if not isinstance(payload, dict) or not isinstance(payload.get("form"), dict):
        return APIResponseFail(message="Training form must be an object / 训练表单必须是对象")
    form = dict(payload["form"])
    try:
        profile = resolve_training_profile(form)
    except TrainingProfileError as exc:
        return APIResponseFail(message=str(exc))
    document = build_training_config(
        form,
        profile_id=profile.id,
        document_id=payload.get("document_id"),
    )
    filename = f"{_safe_output_name(str(form.get('output_name') or 'training'))}.yaml"
    return APIResponseSuccess(
        data={
            "content": dump_training_config(document),
            "filename": filename,
            "format": "yaml",
            "document_id": document["document_id"],
        }
    )


@router.post("/training/parse-config")
async def parse_training_toml(req: TrainingTomlParseRequest):
    """Parse a YAML application config or a legacy flat TOML config."""
    first_content_line = next(
        (
            line.strip()
            for line in req.content.splitlines()
            if line.strip() and not line.lstrip().startswith("#") and line.strip() != "---"
        ),
        "",
    )
    if first_content_line.startswith("kind:"):
        try:
            document = parse_training_config_text(req.content, allowed_kinds={"training", "preset"})
            form = extract_training_form(document)
            return APIResponseSuccess(
                data={
                    "data": form,
                    "format": "yaml",
                    "kind": document["kind"],
                    "document_id": document.get("document_id"),
                }
            )
        except TrainingConfigError as exc:
            return APIResponseFail(message=f"Invalid YAML / YAML 解析失败: {exc}")
    try:
        parsed = toml.loads(req.content)
    except toml.TomlDecodeError as exc:
        return APIResponseFail(message=f"Invalid TOML / TOML 解析失败: {exc}")
    if not isinstance(parsed, dict):
        return APIResponseFail(message="Invalid training config / 训练配置结构无效")
    if "metadata" in parsed or "data" in parsed:
        return APIResponseFail(
            message=(
                "Structured preset files are no longer supported; import a flat training TOML instead / "
                "不再支持结构化预设文件，请导入扁平训练 TOML"
            )
        )
    return APIResponseSuccess(data={"data": parsed})

available_scripts = [
    "networks/extract_lora_from_models.py",
    "networks/extract_lora_from_dylora.py",
    "networks/merge_lora.py",
    "tools/merge_models.py",
]


def _safe_output_name(output_name: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in output_name).strip("._-") or "my_lora"


def _nearest_existing_parent(path: Path) -> Path | None:
    candidate = path
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate if candidate.exists() else None


def _prepare_writable_directory(path: Path) -> bool:
    """创建目录并进行一次真实写入探针，尽早给出可操作的路径错误。"""
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    try:
        fd, probe = tempfile.mkstemp(prefix=".anima-write-test-", dir=path)
        os.close(fd)
        Path(probe).unlink(missing_ok=True)
    except OSError:
        if not existed:
            try:
                path.rmdir()
            except OSError:
                pass
        raise
    return not existed


def _prepare_output_directories(*directories: Path) -> None:
    """依次探测产物与内部目录；失败时回收本次新建的空目录。"""
    prepared: set[Path] = set()
    created: list[Path] = []
    try:
        for directory in directories:
            resolved = directory.resolve()
            if resolved in prepared:
                continue
            if _prepare_writable_directory(resolved):
                created.append(resolved)
            prepared.add(resolved)
    except OSError:
        for directory in reversed(created):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise


def _inspect_output_path(path: str, output_name: str, resume: bool) -> dict:
    """同步检查路径；由 API 放入工作线程，避免离线盘阻塞事件循环。"""
    base = resolve_user_path(path or "./output")
    parent = _nearest_existing_parent(base)
    available = bool(parent and parent.is_dir())
    writable = bool(available and parent and os.access(parent, os.W_OK))
    free_bytes = None
    if available and parent:
        try:
            free_bytes = shutil.disk_usage(parent).free
        except OSError:
            pass
    run_name = f"{_safe_output_name(output_name)}_时间戳"
    artifact_preview = base if resume else base / run_name
    monitor_preview = OUTPUT_DIR.resolve() / run_name
    return {
        "base_dir": str(base),
        "preview_dir": str(artifact_preview),
        "monitor_dir": str(monitor_preview),
        "is_default": base == OUTPUT_DIR.resolve(),
        "is_resume": resume,
        "same_location": artifact_preview == monitor_preview,
        "path_exists": base.exists(),
        "path_is_directory": base.is_dir() if base.exists() else None,
        "available": available,
        "writable": writable,
        "free_bytes": free_bytes,
    }


@router.get("/training/output-path-info")
async def output_path_info(
    path: str = Query("./output"),
    output_name: str = Query("my_lora"),
    resume: bool = Query(False),
):
    """返回输出路径预览、盘符状态和剩余空间，不创建目录。"""
    try:
        data = await asyncio.to_thread(_inspect_output_path, path, output_name, resume)
    except (OSError, ValueError) as exc:
        return APIResponseFail(
            message=f"Invalid output path / 输出路径无效: {exc}",
            data={"errorCode": "invalidOutputPath"},
        )
    return APIResponseSuccess(data=data)


@router.post("/training/estimate")
async def estimate_steps(request: Request):
    try:
        config = await request.json()
    except (UnicodeDecodeError, json.JSONDecodeError):
        return APIResponseFail(
            message="Invalid JSON request / 请求 JSON 格式无效",
            data={"errorCode": "invalidJson", "errorParams": {}},
        )
    if not isinstance(config, dict):
        return APIResponseFail(
            message="Training configuration must be an object / 训练参数必须是对象",
            data={"errorCode": "invalidConfig", "errorParams": {}},
        )

    try:
        estimate = await asyncio.to_thread(estimate_training_steps, config)
    except StepEstimateError as exc:
        return APIResponseFail(
            message=str(exc),
            data={"errorCode": exc.code, "errorParams": exc.params},
        )
    except Exception as exc:
        log.exception("Failed to estimate training steps / 训练步数预估失败")
        return APIResponseFail(
            message=f"Failed to estimate training steps / 训练步数预估失败: {exc}",
            data={"errorCode": "failed", "errorParams": {}},
        )
    return APIResponseSuccess(data=estimate)


def get_sample_prompts(config: dict):
    """Extract and format sample prompt configuration."""
    import random
    from glob import glob

    # backward compatibility
    if "sample_prompts" in config and "positive_prompts" not in config:
        return None, config["sample_prompts"]

    train_data_dir = config["train_data_dir"]
    sub_dir = [dir for dir in glob(os.path.join(train_data_dir, '*')) if os.path.isdir(dir)]

    positive_prompts = config.get('positive_prompts', None)
    negative_prompts = config.get('negative_prompts', '')
    sample_width = config.get('sample_width', 512)
    sample_height = config.get('sample_height', 512)
    sample_cfg = config.get('sample_cfg', 7)
    sample_seed = config.get('sample_seed', 2333)
    sample_steps = config.get('sample_steps', 24)
    sample_flow_shift = config.get('sample_flow_shift', 3.0)
    randomly_choice_prompt = config.get('randomly_choice_prompt', False)

    if randomly_choice_prompt:
        if len(sub_dir) != 1:
            raise ValueError(
                'Multiple subdirectories found / 多子文件夹; '
                'random prompt selection requires a single subdirectory / 随机选取 Prompt 需要单一子文件夹'
            )

        txt_files = glob(os.path.join(sub_dir[0], '*.txt'))
        if not txt_files:
            raise ValueError('No .txt files found in dataset directory / 数据集路径没有 txt 文件')
        try:
            seed_val = config.get("seed", 2333)
            sample_prompt_file = random.Random(int(seed_val)).choice(txt_files)
            with open(sample_prompt_file, 'r', encoding='utf-8') as f:
                positive_prompts = f.read()
        except IOError:
            log.error(f"Failed to read prompt file / 读取失败: {sample_prompt_file}")

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

    if positive_prompts and not positive_prompts.strip():
        positive_prompts = None

    return positive_prompts, sample_prompts_arg


def _cleanup_autosave(autosave_dir: str, keep: int = 50) -> None:
    """清理 autosave 目录，仅保留最近 N 个 TOML 文件"""
    try:
        files = sorted(
            [f for f in os.listdir(autosave_dir) if f.endswith(".toml")],
            key=lambda f: os.path.getmtime(os.path.join(autosave_dir, f)),
            reverse=True,
        )
        for old_file in files[keep:]:
            try:
                os.remove(os.path.join(autosave_dir, old_file))
            except OSError:
                pass
    except OSError:
        pass


def _write_run_info(run_dir: str, config: dict, train_type: str, timestamp: str, is_resume: bool) -> None:
    """写入人类可读的训练摘要 run_info.txt"""
    try:
        model_path = config.get("pretrained_model_name_or_path") or config.get("dit", "?")
        model_name = os.path.basename(model_path) if model_path else "?"
        dataset = config.get("train_data_dir") or config.get("dataset_config", "?")
        lines = [
            f"Training Run: {os.path.basename(run_dir)}",
            f"Started:      {timestamp}",
            f"Type:         {train_type}",
            f"Resume:       {'yes' if is_resume else 'no'}",
            f"Model:        {model_name}",
            f"Dataset:      {dataset}",
            f"Output Name:  {config.get('output_name', '?')}",
            f"Resolution:   {config.get('resolution', '?')}",
            f"Batch Size:   {config.get('train_batch_size', '?')}",
            f"LR:           {config.get('learning_rate', '?')}"
            + (f"  (unet={config['unet_lr']})" if config.get('unet_lr') else "")
            + (f"  (te={config['text_encoder_lr']})" if config.get('text_encoder_lr') else ""),
            f"Optimizer:    {config.get('optimizer_type', '?')}",
            f"Network Dim:  {config.get('network_dim', '?')}",
            f"Network Alpha:{config.get('network_alpha', '?')}",
            f"Epochs:       {config.get('max_train_epochs', '?')}",
            f"Mixed Prec:   {config.get('mixed_precision', '?')}",
            f"Seed:         {config.get('seed', '?')}",
            "",
            f"Full config:  config.toml",
            f"Training log: train_*.log",
            f"TensorBoard:  {os.path.join(run_dir, 'log')}",
            f"Artifacts:    {config.get('output_dir', run_dir)}",
            f"Model files:  {os.path.join(str(config.get('output_dir', run_dir)), '*.safetensors')}",
            f"Samples:      {os.path.join(str(config.get('output_dir', run_dir)), 'sample')}",
        ]
        info_path = os.path.join(run_dir, "run_info.txt")
        with open(info_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except OSError as e:
        log.warning(f"Failed to write run_info.txt / 写入失败: {e}")


def _krea2_error(errors: list[str], error_code: str = "krea2PreflightFailed"):
    return APIResponseFail(
        message="Krea 2 configuration is not ready / Krea 2 配置尚未就绪:\n" + "\n".join(errors),
        data={"errorCode": error_code, "errors": errors},
    )


async def _create_krea2_run(
    config: dict,
    gpu_ids: list | None,
    timestamp: str,
    form_snapshot: dict | None = None,
):
    """Launch the musubi Krea 2 training profile without touching sd-scripts."""

    snapshot_form = dict(form_snapshot) if isinstance(form_snapshot, dict) else dict(config)
    snapshot_form["model_train_type"] = KREA2_PROFILE_ID

    validation_errors = validate_krea2_config(config)
    if validation_errors:
        return _krea2_error(validation_errors, "invalidKrea2Config")

    preflight = await asyncio.to_thread(krea2_preflight, config, True)
    if not preflight["ok"]:
        code = "krea2CacheRequired" if not preflight["cache"]["ready"] else "krea2PreflightFailed"
        return _krea2_error(preflight["errors"], code)

    output_name = config.get("output_name", "krea2_lora")
    safe_name = _safe_output_name(str(output_name))
    run_dir_name = f"{safe_name}_{timestamp}"
    is_resume = bool(str(config.get("resume") or "").strip())
    requested_output_dir = str(config.get("output_dir", "./output") or "./output").strip()
    try:
        output_base_path = await asyncio.to_thread(resolve_user_path, requested_output_dir)
    except (OSError, ValueError) as exc:
        return APIResponseFail(
            message=f"Invalid output path / 输出路径无效: {exc}",
            data={"errorCode": "invalidOutputPath"},
        )

    internal_run_dir = (OUTPUT_DIR / run_dir_name).resolve()
    artifact_run_dir = output_base_path if is_resume else output_base_path / run_dir_name
    try:
        await asyncio.to_thread(_prepare_output_directories, artifact_run_dir, internal_run_dir)
    except OSError as exc:
        return APIResponseFail(
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

    autosave_dir = Path(os.getcwd()) / "config" / "autosave"
    autosave_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_autosave(str(autosave_dir), keep=50)
    toml_file = autosave_dir / f"{timestamp}-krea2.toml"
    train_toml = toml.dumps(train_config)
    dataset_toml = toml.dumps(dataset_config)
    training_document = build_training_config(
        snapshot_form,
        profile_id=KREA2_PROFILE_ID,
    )

    def _write_configs():
        toml_file.write_text(train_toml, encoding="utf-8")
        (internal_run_dir / "config.toml").write_text(train_toml, encoding="utf-8")
        write_training_config(internal_run_dir / TRAINING_CONFIG_NAME, training_document)
        dataset_config_file.write_text(dataset_toml, encoding="utf-8")
        if sample_prompts_file is not None:
            prompts = str(config["krea_sample_prompts"]).replace("\r\n", "\n").replace("\r", "\n").rstrip()
            sample_prompts_file.write_text(prompts + "\n", encoding="utf-8")

    await asyncio.gather(
        asyncio.to_thread(_write_configs),
        asyncio.to_thread(
            _write_run_info,
            str(internal_run_dir),
            config,
            KREA2_PROFILE_ID,
            timestamp,
            is_resume,
        ),
        asyncio.to_thread(write_output_dir_reference, str(internal_run_dir), str(artifact_run_dir)),
    )

    return run_train(
        str(toml_file),
        KREA2_TRAINER_FILE,
        gpu_ids,
        2,
        run_dir=str(internal_run_dir),
        artifact_dir=str(artifact_run_dir),
        output_base_dir=requested_output_dir,
        preview_enabled=False,
        engine_id="musubi_tuner",
        run_metadata={
            "profile_id": KREA2_PROFILE_ID,
            "adapter_id": "musubi_lora",
            "dataset_config": str(dataset_config_file),
            "sample_prompts": str(sample_prompts_file) if sample_prompts_file is not None else None,
        },
    )


@router.get("/training/cores")
async def training_cores():
    """Expose installed runtime/profile capabilities for environment and UI pages."""

    # The first full runtime check imports torch, torchvision, and the Krea 2
    # dependency set. On Windows that can take several seconds, so never run it
    # on FastAPI's event-loop thread where it would stall realtime updates.
    payload = await asyncio.to_thread(profile_payload)
    return APIResponseSuccess(data=payload)


@router.post("/training/krea2/cache-status")
async def krea2_cache_status(request: Request):
    try:
        config = await request.json()
    except (UnicodeDecodeError, json.JSONDecodeError):
        return APIResponseFail(message="Invalid JSON request / 请求 JSON 格式无效")
    if not isinstance(config, dict):
        return APIResponseFail(message="Training configuration must be an object / 训练参数必须是对象")
    try:
        profile = resolve_training_profile(config)
    except TrainingProfileError as exc:
        return APIResponseFail(message=str(exc))
    if profile.id != KREA2_PROFILE_ID:
        return APIResponseFail(message="Krea 2 profile required / 此接口仅支持 Krea 2 配置档")
    return APIResponseSuccess(data=await asyncio.to_thread(get_krea2_cache_status, config))


@router.post("/training/krea2/cache")
async def create_krea2_cache(request: Request):
    """Start the required latent and Qwen3-VL cache pipeline as one task."""

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        config = await request.json()
    except (UnicodeDecodeError, json.JSONDecodeError):
        return APIResponseFail(message="Invalid JSON request / 请求 JSON 格式无效")
    if not isinstance(config, dict):
        return APIResponseFail(message="Training configuration must be an object / 训练参数必须是对象")

    gpu_ids = config.pop("gpu_ids", None)
    try:
        profile = resolve_training_profile(config)
    except TrainingProfileError as exc:
        return APIResponseFail(message=str(exc))
    if profile.id != KREA2_PROFILE_ID:
        return APIResponseFail(message="Krea 2 profile required / 此接口仅支持 Krea 2 配置档")

    validation_errors = validate_krea2_config(config)
    if validation_errors:
        return _krea2_error(validation_errors, "invalidKrea2Config")
    preflight = await asyncio.to_thread(krea2_preflight, config, False)
    if not preflight["ok"]:
        return _krea2_error(preflight["errors"], "krea2PreflightFailed")

    safe_name = _safe_output_name(str(config.get("output_name", "krea2_lora")))
    run_dir = (OUTPUT_DIR / f"{safe_name}_krea2_cache_{timestamp}").resolve()
    cache_dir = Path(str(config["dataset_cache_dir"])).resolve()
    try:
        await asyncio.to_thread(_prepare_output_directories, run_dir, cache_dir)
    except OSError as exc:
        return APIResponseFail(
            message=f"Cache directory is unavailable or not writable / 缓存目录不可用或无法写入: {exc}",
            data={"errorCode": "cacheDirectoryUnavailable", "cachePath": str(cache_dir)},
        )

    dataset_config_file = run_dir / "dataset.toml"
    dataset_toml = toml.dumps(build_krea2_dataset_config(config))
    try:
        await asyncio.to_thread(prepare_cache_manifest, config)
        await asyncio.gather(
            asyncio.to_thread(dataset_config_file.write_text, dataset_toml, "utf-8"),
            asyncio.to_thread(
                _write_run_info,
                str(run_dir),
                config,
                "krea2-cache",
                timestamp,
                False,
            ),
            asyncio.to_thread(write_output_dir_reference, str(run_dir), str(cache_dir)),
        )
    except OSError as exc:
        return APIResponseFail(message=f"Failed to initialize Krea 2 cache / 初始化 Krea 2 缓存失败: {exc}")

    def _cache_finished(status: str) -> None:
        mark_cache_manifest(config, status)

    result = run_train(
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
        on_complete=_cache_finished,
    )
    if result.get("status") != "success":
        await asyncio.to_thread(mark_cache_manifest, config, "failed")
        return result
    result.setdefault("data", {})["operation"] = "krea2_cache"
    return result


@router.post("/run")
async def create_toml_file(request: Request):
    from backend.tagger.workspace import has_active_tagger_task

    if has_active_tagger_task():
        return APIResponseFail(
            message="Tagger is using the GPU. Stop tagging before training / 反推任务正在使用 GPU，请停止后再训练"
        )
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_data = await request.body()

    try:
        config: dict = json.loads(json_data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return APIResponseFail(message="Invalid JSON request / 请求 JSON 格式无效")
    if not isinstance(config, dict):
        return APIResponseFail(message="Training configuration must be an object / 训练参数必须是对象")

    form_snapshot = config.pop("_form_state", None)
    if not isinstance(form_snapshot, dict):
        form_snapshot = {key: value for key, value in config.items() if not key.startswith("_")}
    gpu_ids = config.pop("gpu_ids", None)

    try:
        profile = resolve_training_profile(config)
    except TrainingProfileError as exc:
        return APIResponseFail(message=str(exc))
    form_snapshot["model_train_type"] = profile.id
    if profile.id == KREA2_PROFILE_ID:
        return await _create_krea2_run(config, gpu_ids, timestamp, form_snapshot)

    try:
        subset_timestep_offsets = normalize_subset_timestep_offsets(
            config.pop(SUBSET_TIMESTEP_OFFSETS_KEY, None)
        )
    except ValueError as exc:
        return APIResponseFail(message=str(exc))
    if profile.id != "anima-lora":
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
    try:
        from backend.training import adapt_config, detect_attention_backend, validate_training_config
    except ImportError as e:
        log.error(f"[Adapter] Failed to import training adapter / 训练适配器导入失败: {e}")
        return APIResponseFail(message=f"Training adapter import error / 训练适配器导入错误: {e}")

    validation_errors = validate_training_config(config, gpu_ids=gpu_ids)
    if validation_errors:
        return APIResponseFail(
            message="Invalid training configuration / 训练参数无效:\n" + "\n".join(validation_errors)
        )
    try:
        train_utils.fix_config_types(config)
    except (TypeError, ValueError) as e:
        return APIResponseFail(message=f"Invalid numeric value / 数字参数无效: {e}")

    if gpu_ids is None:
        adapted_config, adapter_warnings = adapt_config(config)
    else:
        adapted_config, adapter_warnings = adapt_config(config, gpu_ids=gpu_ids)
    for w in adapter_warnings:
        log.warning(f"[Adapter] {w}")
    config = adapted_config

    estimate_config = dict(config)
    if gpu_ids is not None:
        estimate_config["gpu_ids"] = gpu_ids
    try:
        await asyncio.to_thread(estimate_training_steps, estimate_config)
    except StepEstimateError as exc:
        return APIResponseFail(message=f"Training step calculation failed / 训练步数计算失败: {exc}")
    except Exception as exc:
        log.exception("Failed to estimate training steps before launch / 启动前训练步数计算失败")
        return APIResponseFail(message=f"Training step calculation failed / 训练步数计算失败: {exc}")

    if "attn_mode" in config:
        attn_requested = config.get("attn_mode", "torch")
        attn_actual, attn_warning = detect_attention_backend(attn_requested)
        if attn_warning:
            log.warning(f"[Attn] {attn_warning}")
            config["attn_mode"] = attn_actual
    # ──────────────────────────────────────────────────────────

    # ── Per-run folder: internal control data + user-selected artifacts ──
    output_name = config.get("output_name", "my_lora")
    safe_name = _safe_output_name(str(output_name))
    run_dir_name = f"{safe_name}_{timestamp}"
    is_resume = bool(config.get("resume", "").strip())

    # 用户设置的路径仅决定模型/断点/sample 的位置；日志、配置、TB 均保存在内部 run_dir。
    requested_output_dir = str(config.get("output_dir", "./output") or "./output").strip()
    try:
        output_base_path = await asyncio.to_thread(resolve_user_path, requested_output_dir)
    except (OSError, ValueError) as exc:
        return APIResponseFail(
            message=f"Invalid output path / 输出路径无效: {exc}",
            data={"errorCode": "invalidOutputPath"},
        )
    internal_run_dir = (OUTPUT_DIR / run_dir_name).resolve()
    artifact_run_dir = output_base_path if is_resume else output_base_path / run_dir_name
    # ──────────────────────────────────────────────────────────

    if not train_utils.validate_data_dir(config["train_data_dir"]):
        return APIResponseFail(message="Dataset directory not found or no images / 数据集路径不存在或无图片")

    # 正则化数据目录：填了但不存在时直接报错，避免 sd-scripts 静默忽略导致用户以为有正则数据。
    # 目录存在但没有任何"数字_类名"子目录时同样报错——sd-scripts 只扫描子目录（子目录缺失时
    # 生成空子集并仅打警告，训练照常跑但没有正则化）。
    reg_data_dir = str(config.get("reg_data_dir") or "").strip()
    if reg_data_dir:
        if not os.path.isdir(reg_data_dir):
            return APIResponseFail(
                message=f"Regularization data directory not found: {reg_data_dir} / 正则化数据目录不存在: {reg_data_dir}",
                data={"errorCode": "regDataDirNotFound"},
            )
        reg_subdirs = [
            name
            for name in os.listdir(reg_data_dir)
            if os.path.isdir(os.path.join(reg_data_dir, name)) and name.split("_")[0].isdigit()
        ]
        if not reg_subdirs:
            return APIResponseFail(
                message=(
                    f"No valid subfolders (e.g. 10_face) found in regularization data directory: {reg_data_dir}"
                    " / 正则化数据目录中未找到有效子文件夹（如 10_face）：{reg_data_dir}"
                ),
                data={"errorCode": "regDataDirNoSubfolders"},
            )

    image_count = await asyncio.to_thread(
        train_utils.count_images, config["train_data_dir"], True, 201
    )
    suggest_cpu_threads = 8 if image_count > 200 else 2

    validated, message = await asyncio.to_thread(
        train_utils.validate_model, config["pretrained_model_name_or_path"], model_train_type
    )
    if not validated:
        return APIResponseFail(message=message)

    # ── Anima: qwen3 编码器路径必填校验 ─────────────────
    if model_train_type == "anima-lora":
        qwen3_path = config.get("qwen3", "").strip()
        if not qwen3_path:
            return APIResponseFail(
                message="Qwen3 path is required for Anima LoRA training / "
                "Anima LoRA 训练需要填写 Qwen3 编码器路径"
            )
        if not os.path.exists(qwen3_path):
            return APIResponseFail(message=f"Qwen3 model not found / Qwen3 模型不存在: {qwen3_path}")
        vae_path = config.get("vae", "").strip()
        if not os.path.exists(vae_path):
            return APIResponseFail(message=f"VAE model not found / VAE 模型不存在: {vae_path}")

    sample_prompts_arg = ""
    if "prompt_file" in _ui_config and _ui_config["prompt_file"].strip() != "":
        prompt_file = _ui_config["prompt_file"].strip()
        if not os.path.exists(prompt_file):
            return APIResponseFail(message=f"Prompt file not found / 文件不存在: {prompt_file}")
        config["sample_prompts"] = prompt_file
    else:
        try:
            positive_prompt, sample_prompts_arg = get_sample_prompts(config=_ui_config)
            if not positive_prompt or not train_utils.is_prompt_like(sample_prompts_arg):
                sample_prompts_arg = ""

        except ValueError as e:
            log.error(f"Error while processing prompts: {e}")
            return APIResponseFail(message=str(e))

    try:
        # 优先检查用户产物目录；磁盘 I/O 放入线程，避免离线盘阻塞 API。
        await asyncio.to_thread(
            _prepare_output_directories,
            artifact_run_dir,
            internal_run_dir,
        )
    except OSError as exc:
        log.warning("Output directory unavailable / 输出目录不可用: %s", exc)
        return APIResponseFail(
            message=f"Output directory is unavailable or not writable / 输出目录不可用或无法写入: {exc}",
            data={
                "errorCode": "outputDirectoryUnavailable",
                "outputPath": str(artifact_run_dir),
            },
        )

    config["output_dir"] = str(artifact_run_dir)
    config["logging_dir"] = str(internal_run_dir / "log")

    if sample_prompts_arg:
        sample_prompts_file = str(internal_run_dir / "prompts.txt")
        with open(sample_prompts_file, "w", encoding="utf-8") as f:
            f.write(sample_prompts_arg)
        config["sample_prompts"] = sample_prompts_file
        log.info(f"Wrote prompts to file {sample_prompts_file}")

    # ── A: autosave — 保留最近 50 个，清理旧文件 ────────────
    autosave_dir = os.path.join(os.getcwd(), "config", "autosave")
    os.makedirs(autosave_dir, exist_ok=True)
    _cleanup_autosave(autosave_dir, keep=50)

    toml_file = os.path.join(autosave_dir, f"{timestamp}.toml")
    toml_content = toml.dumps(config)
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
            return APIResponseFail(message=str(exc))
        dataset_config_file = internal_run_dir / "dataset.toml"
        dataset_toml = toml.dumps(dataset_config)

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
    await asyncio.gather(
        asyncio.to_thread(_write_configs),
        asyncio.to_thread(_write_run_info, str(internal_run_dir), config, model_train_type, timestamp, is_resume),
        asyncio.to_thread(write_output_dir_reference, str(internal_run_dir), str(artifact_run_dir)),
    )
    # ──────────────────────────────────────────────────────────

    extra_args = ["--dataset_config", str(dataset_config_file)] if dataset_config_file is not None else None
    result = run_train(
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
    )

    # 将适配器警告附加到返回结果中（前端弹窗展示）
    if result.get("status") == "success" and adapter_warnings:
        if "data" not in result or not isinstance(result["data"], dict):
            result["data"] = {}
        result["data"]["warnings"] = adapter_warnings

    return result


@router.post("/run_script")
async def run_script(request: Request, background_tasks: BackgroundTasks):
    from pathlib import Path

    paras = await request.body()
    j = json.loads(paras.decode("utf-8"))
    script_name = j["script_name"]
    if script_name not in available_scripts:
        return APIResponseFail(message="Script not found")
    del j["script_name"]
    result = []
    for k, v in j.items():
        result.append(f"--{k}")
        if not isinstance(v, bool):
            result.append(str(v))
    script_path = Path(os.getcwd()) / "vendor" / "sd-scripts" / script_name
    if not script_path.exists():
        return APIResponseFail(message=f"Script not found / 脚本不存在: {script_name}")
    cmd_list = [launch_utils.python_bin, str(script_path)] + result
    background_tasks.add_task(launch_utils.run, cmd_list)
    return APIResponseSuccess()
