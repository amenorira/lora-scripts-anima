"""
Training routes — POST /run, POST /run_script
"""
import asyncio
import json
import os
import shutil
from pathlib import Path

import toml
from fastapi import APIRouter, BackgroundTasks, Query, Request

from backend.constants import OUTPUT_DIR
from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.monitor.run_registry import resolve_user_path
from backend.training import run_train
from backend.training.execution import launch, launch_krea2, preparation, run_files
from backend.training.core_registry import (
    TrainingProfileError,
    profile_payload,
    resolve_training_profile,
)
from backend.training.datasets.dataset_repeat import DatasetRepeatError, apply_subset_repeats
from backend.training.cache.krea2_cache import get_krea2_cache_status
from backend.training.config.krea2_options import KREA2_PROFILE_ID
from backend.training.execution.krea2_preflight import inspect_krea2_checkpoint_format
from backend.training.datasets.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.cache.te_cache_check import delete_te_cache
from backend.training.config.training_config import (
    TrainingConfigError,
    build_training_config,
    dump_training_config,
    extract_training_form,
    parse_training_config_text,
)
from backend import launch_utils
from backend.server.models import (
    APIResponseFail,
    APIResponseSuccess,
    TeCacheDeleteRequest,
    TrainingTomlParseRequest,
)
from backend.tasks import tm
from backend.log import log

router = APIRouter()


@router.post("/training/shape-preview")
async def training_shape_preview(request: Request):
    from backend.training.shape_preview import inspect_network, preview_pool

    payload, error = await _read_json_object(request)
    if error is not None:
        return error
    try:
        result = await asyncio.get_running_loop().run_in_executor(preview_pool(), inspect_network, payload)
        return APIResponseSuccess(data=result)
    except Exception as exc:
        return APIResponseFail(message=str(exc) or type(exc).__name__)


async def _read_json_object(
    request: Request,
    *,
    with_error_code: bool = False,
    object_message: str = "Training configuration must be an object / 训练参数必须是对象",
) -> tuple[dict | None, APIResponseFail | None]:
    """解析请求体为 JSON 对象；失败时返回与原调用方一致的错误响应。"""
    try:
        payload = await request.json()
    except (UnicodeDecodeError, json.JSONDecodeError):
        if with_error_code:
            return None, APIResponseFail(
                message="Invalid JSON request / 请求 JSON 格式无效",
                data={"errorCode": "invalidJson", "errorParams": {}},
            )
        return None, APIResponseFail(message="Invalid JSON request / 请求 JSON 格式无效")
    if not isinstance(payload, dict):
        if with_error_code:
            return None, APIResponseFail(
                message=object_message,
                data={"errorCode": "invalidConfig", "errorParams": {}},
            )
        return None, APIResponseFail(message=object_message)
    return payload, None


@router.post("/training/export-config")
async def export_training_config(request: Request):
    """Serialize the current form into the application-level YAML format."""
    payload, error = await _read_json_object(
        request, object_message="Training form must be an object / 训练表单必须是对象"
    )
    if error:
        return error
    if not isinstance(payload.get("form"), dict):
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
    filename = f"{run_files.safe_output_name(str(form.get('output_name') or 'training'))}.yaml"
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
    from backend.training.config.network_config import extract_network_form, validate_network_preset

    content = req.content.lstrip("\ufeff")
    try:
        parsed = toml.loads(content)
    except toml.TomlDecodeError as toml_error:
        try:
            document = parse_training_config_text(content, allowed_kinds={"training", "preset"})
            form = extract_training_form(document)
            if form.get("model_train_type") == KREA2_PROFILE_ID:
                form = extract_network_form(form)
            validate_network_preset(form)
            return APIResponseSuccess(
                data={
                    "data": form,
                    "format": "yaml",
                    "kind": document["kind"],
                    "document_id": document.get("document_id"),
                }
            )
        except TrainingConfigError as exc:
            return APIResponseFail(message=f"Invalid TOML / YAML 配置解析失败: TOML: {toml_error}; YAML: {exc}")
        except ValueError as exc:
            return APIResponseFail(message=str(exc))
    if not isinstance(parsed, dict):
        return APIResponseFail(message="Invalid training config / 训练配置结构无效")
    if "metadata" in parsed or "data" in parsed:
        return APIResponseFail(
            message=(
                "Structured preset files are no longer supported; import a flat training TOML instead / "
                "不再支持结构化预设文件，请导入扁平训练 TOML"
            )
        )
    from backend.training.config.config_import import import_native_training_form
    try:
        parsed = import_native_training_form(parsed, profile_id=req.model_train_type or "anima-lora")
    except ValueError as exc:
        return APIResponseFail(message=str(exc))
    return APIResponseSuccess(data={"data": parsed})

available_scripts = [
    "networks/extract_lora_from_models.py",
    "networks/merge_lora.py",
    "tools/merge_models.py",
]


def _nearest_existing_parent(path: Path) -> Path | None:
    candidate = path
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate if candidate.exists() else None


def _training_response(result: dict):
    if result.get("status") != "success":
        return APIResponseFail(message=result.get("message"), data=result.get("data"))
    return result


async def _prepare_training(helper, *args):
    result = await preparation.prepare_training(helper, *args, task_manager=tm, launcher=run_train)
    return _training_response(result)


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
    run_name = f"{run_files.safe_output_name(output_name)}_时间戳"
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
    config, error = await _read_json_object(request, with_error_code=True)
    if error:
        return error

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


@router.post("/training/dataset-repeat")
async def update_dataset_repeat(request: Request):
    """按批次改训练集子目录的数字前缀（= sd-scripts 的 repeat），磁盘目录同步改名。"""
    payload, error = await _read_json_object(request, with_error_code=True)
    if error:
        return error

    raw_dir = str(payload.get("dir") or "").strip()
    if not raw_dir:
        return APIResponseFail(
            message="Select a training dataset directory / 请选择训练数据集目录",
            data={"errorCode": "datasetMissing", "errorParams": {"path": ""}},
        )

    if not tm.begin_dataset_mutation():
        return APIResponseFail(
            message="Cannot rename dataset folders while training / 训练进行中，无法重命名数据集目录",
            data={"errorCode": "trainingActive", "errorParams": {}},
        )

    try:
        result = await _settled_to_thread(
            apply_subset_repeats,
            resolve_user_path(raw_dir),
            payload.get("changes"),
        )
    except DatasetRepeatError as exc:
        return APIResponseFail(
            message=str(exc),
            data={"errorCode": exc.code, "errorParams": exc.params},
        )
    except Exception as exc:
        log.exception("Failed to rename dataset subset / 数据集子集改名失败")
        return APIResponseFail(
            message=f"Failed to rename dataset subset / 数据集子集改名失败: {exc}",
            data={"errorCode": "failed", "errorParams": {}},
        )
    finally:
        tm.end_dataset_mutation()

    if result.get("applied"):
        # 目录名变了，选择器缓存的还是旧名字（TTL 60s）。
        from backend.server.routes.system import invalidate_files_cache

        invalidate_files_cache()
    return APIResponseSuccess(data=result)


@router.get("/training/cores")
async def training_cores():
    """Expose installed runtime/profile capabilities for environment and UI pages."""

    # The first full runtime check imports torch, torchvision, and the Krea 2
    # dependency set. On Windows that can take several seconds, so never run it
    # on FastAPI's event-loop thread where it would stall realtime updates.
    payload = await asyncio.to_thread(profile_payload)
    return APIResponseSuccess(data=payload)


@router.post("/training/krea2/model-format")
async def krea2_model_format(request: Request):
    payload, error = await _read_json_object(request)
    if error:
        return error
    path = payload.get("path")
    if not isinstance(path, str) or not path.strip():
        return APIResponseFail(message="Model path required / 请指定模型路径")
    result = await asyncio.to_thread(inspect_krea2_checkpoint_format, Path(path.strip()))
    return APIResponseSuccess(data=result)


@router.post("/training/krea2/cache-status")
async def krea2_cache_status(request: Request):
    config, error = await _read_json_object(request)
    if error:
        return error
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
    config, error = await _read_json_object(request)
    if error:
        return error
    return await _prepare_training(launch_krea2.prepare_cache, config)


@router.post("/run")
async def create_toml_file(request: Request):
    config, error = await _read_json_object(request)
    if error:
        return error
    return await _prepare_training(launch.prepare_run, config)


@router.post("/run_script")
async def run_vendor_script(request: Request, background_tasks: BackgroundTasks):
    paras = await request.body()
    j = json.loads(paras.decode("utf-8"))
    script_name = j["script_name"]
    if script_name not in available_scripts:
        return APIResponseFail(message=f"Unknown script / 未登记的脚本: {script_name}")
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


@router.post("/training/te-cache/delete")
async def delete_te_cache_files(request: TeCacheDeleteRequest):
    """删除训练/正则数据集目录树下的 TE 输出缓存（各引擎 npz 后缀）。"""
    deleted, errors = await asyncio.to_thread(delete_te_cache, request.dirs)
    if errors:
        return APIResponseFail(
            message="Failed to delete some cache files / 部分缓存文件删除失败:\n" + "\n".join(errors),
            data={"deleted": deleted},
        )
    log.info(f"[TE cache] deleted {deleted} cache file(s) / 已删除 {deleted} 个缓存文件")
    return APIResponseSuccess(data={"deleted": deleted})
