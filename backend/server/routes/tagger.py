"""Tagger API routes."""

import asyncio
import os
import uuid
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from PIL import Image, UnidentifiedImageError

from backend.async_utils import settled_to_thread
from backend.constants import TAGGER_CACHE_DIR
from backend.core.realtime import realtime_tasks
from backend.log import log
from backend.server.models import APIResponseFail, APIResponseSuccess, TaggerInterrogateRequest
from backend.tagger.interrogator import (
    available_interrogators,
    cancel_tagger_task,
    get_tagger_task_snapshot,
    gpu_inference_lock,
    on_interrogate,
)
from backend.tagger.interrogators.base import CATEGORY_LABELS
from backend.tagger import captioning, api_engine
from backend.tagger import workspace
from backend.tagger.registry import DEFAULT_MODEL_ID, MODEL_SPEC_BY_ID, model_payload
from backend.tagger.workspace import (
    cancel_task as cancel_workspace_task,
    create_task as create_workspace_task,
    latest_active_task_id,
    register_upload,
    retry_failed_task,
    scan_source,
    source_item,
    source_items,
    task_items,
    task_snapshot,
    training_active,
)

router = APIRouter()


@router.get("/tagger/api/caption-template")
async def caption_template():
    return APIResponseSuccess(data={"prompt": captioning.upstream.DEFAULT_PROMPT})


def _copy_upload(stream, target: Path) -> None:
    written = 0
    with target.open("wb") as output:
        while chunk := stream.read(1024 * 1024):
            written += len(chunk)
            if written > 100 * 1024 * 1024:
                raise ValueError("Image exceeds the 100 MB upload limit / 图片超过 100 MB 限制")
            output.write(chunk)


def _verify_image(path: Path) -> None:
    with Image.open(path) as image:
        image.verify()

_MODEL_DISPLAY_NAMES = {key: spec.name for key, spec in MODEL_SPEC_BY_ID.items()}


@router.post("/interrogate")
async def run_interrogate(req: TaggerInterrogateRequest):
    task_id = str(uuid.uuid4())[:8]
    owner = f"legacy-tagger:{task_id}"
    try:
        workspace.claim_direct_tagger(owner)
    except RuntimeError as exc:
        return APIResponseFail(message=str(exc))
    interrogator = available_interrogators.get(
        req.interrogator_model,
        available_interrogators[DEFAULT_MODEL_ID],
    )
    spec = MODEL_SPEC_BY_ID[interrogator.name]
    explicit_threshold = {"threshold", "character_threshold"} & req.model_fields_set
    category_thresholds = {} if explicit_threshold else dict(spec.threshold_presets.get("macro", {}))
    category_thresholds.update(req.category_thresholds or {})
    batch_options = {
        "batch_input_recursive": req.batch_input_recursive,
        "batch_output_dir": req.batch_output_dir,
        "batch_output_filename_format": "[name].[output_extension]",
        "batch_output_action_on_conflict": req.batch_output_action_on_conflict,
        "batch_remove_duplicated_tag": req.batch_remove_duplicated_tag,
        "batch_output_save_json": req.batch_output_save_json,
    }
    postprocess_options = {
        "threshold": req.threshold,
        "character_threshold": req.character_threshold,
        "category_thresholds": category_thresholds,
        "add_rating_tag": req.add_rating_tag,
        "add_model_tag": req.add_model_tag,
        "additional_tags": req.additional_tags,
        "exclude_tags": req.exclude_tags,
        "sort_by_alphabetical_order": req.sort_by_alphabetical_order,
        "add_confident_as_weight": req.add_confident_as_weight,
        "replace_underscore": req.replace_underscore,
        "replace_underscore_excludes": req.replace_underscore_excludes,
        "escape_tag": req.escape_tag,
        "unload_model_after_running": True,
    }
    async def _run_claimed():
        try:
            await settled_to_thread(
                on_interrogate,
                task_id=task_id,
                image=None,
                batch_input_glob=req.path,
                interrogator=interrogator,
                **batch_options,
                **postprocess_options,
            )
        finally:
            workspace.release_direct_tagger(owner)

    try:
        asyncio.create_task(_run_claimed())
    except Exception:
        workspace.release_direct_tagger(owner)
        raise
    await realtime_tasks.register(
        task_id,
        "tagger",
        lambda task_id=task_id: get_tagger_task_snapshot(task_id),
    )
    return APIResponseSuccess(data={"task_id": task_id})


@router.post("/interrogate/stop")
async def stop_interrogate(task_id: str):
    """Cancel a running tagger task."""
    if cancel_tagger_task(task_id):
        return APIResponseSuccess(data={"message": "Task cancelled / 任务已取消"})
    return APIResponseFail(message="Task not found / 任务不存在")


@router.get("/tagger/models")
async def list_tagger_models():
    """List local model capabilities and installation state."""
    return APIResponseSuccess(data=await asyncio.to_thread(model_payload))


@router.post("/tagger/source/scan")
async def tagger_scan_source(request: Request):
    try:
        body = await request.json()
        result = await asyncio.to_thread(
            scan_source,
            str(body.get("path") or ""),
            bool(body.get("recursive", True)),
            str(body.get("caption_extension") or ".txt"),
            body.get("caption_options"),
        )
        return APIResponseSuccess(data=result)
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.post("/tagger/uploads")
async def tagger_upload(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("image/"):
        return APIResponseFail(message="File is not an image / 文件不是图片")
    suffix = Path(file.filename or "upload.png").suffix.lower() or ".png"
    upload_dir = TAGGER_CACHE_DIR / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / f"{uuid.uuid4().hex}{suffix}"
    temporary = target.with_suffix(target.suffix + ".partial")
    try:
        await asyncio.to_thread(_copy_upload, file.file, temporary)
        await asyncio.to_thread(os.replace, temporary, target)
        await asyncio.to_thread(_verify_image, target)
        result = await asyncio.to_thread(register_upload, target)
        return APIResponseSuccess(data=result)
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        return APIResponseFail(message=f"Upload failed / 上传失败: {str(exc)[:240]}")


@router.get("/tagger/source/{source_token}/items")
async def list_tagger_source_items(source_token: str, offset: int = 0, limit: int = 120):
    try:
        return APIResponseSuccess(data=await asyncio.to_thread(source_items, source_token, offset, limit))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


def annotation_options(caption_extension: str = ".txt", reference_extension: str = ".txt",
                       sidecar_suffix: str = "_caption.json", separator: str = "---===---") -> dict:
    return dict(caption_extension=caption_extension, reference_extension=reference_extension,
                sidecar_suffix=sidecar_suffix, separator=separator)


@router.get("/tagger/source/{source_token}/annotations")
async def list_annotations(source_token: str, offset: int = 0, limit: int = 60, status: str = "all", q: str = "",
                           refresh: bool = False, task_id: str = "", options: dict = Depends(annotation_options)):
    try:
        return APIResponseSuccess(data=await asyncio.to_thread(workspace.annotations, source_token, offset, limit, status, q, refresh, options, task_id))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/source/{source_token}/annotations/{index}")
async def get_annotation(source_token: str, index: int, options: dict = Depends(annotation_options)):
    try:
        return APIResponseSuccess(data=await asyncio.to_thread(workspace.annotation_detail, source_token, index, options))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.post("/tagger/source/{source_token}/caption-plan")
async def get_caption_plan(source_token: str, request: Request):
    try:
        options = await request.json()
        return APIResponseSuccess(data=await asyncio.to_thread(workspace.caption_plan, source_token, options))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/caption/preview-state")
async def caption_preview_state():
    return APIResponseSuccess(data=workspace.preview_state())


@router.post("/tagger/caption/preview-cancel")
async def cancel_caption_preview(request: Request):
    body = await request.json()
    return APIResponseSuccess(data={"cancelling": workspace.cancel_preview(str(body.get("request_id") or ""))})


@router.post("/tagger/caption/preview")
async def caption_preview(request: Request):
    body = await request.json()
    preview = None
    try:
        preview = workspace.prepare_preview(body)
        return APIResponseSuccess(data=await settled_to_thread(workspace.preview_caption, body, preview))
    except InterruptedError:
        return APIResponseFail(message="Preview cancelled / 预览已取消")
    except Exception as exc:
        message = str(exc)
        key = str((body.get("api") or {}).get("api_key") or "")
        if key:
            message = message.replace(key, "[redacted]")
        return APIResponseFail(message=message[:2000])
    finally:
        # settled_to_thread waits for the worker's HTTP client before releasing.
        if preview is not None:
            workspace.release_direct_tagger(preview["request_id"])


@router.post("/tagger/tasks")
async def start_tagger_workspace_task(request: Request):
    try:
        body = await request.json()
        task_id = await asyncio.to_thread(create_workspace_task, body)
        await realtime_tasks.register(
            task_id,
            "tagger",
            lambda task_id=task_id: task_snapshot(task_id),
        )
        return APIResponseSuccess(data={"task_id": task_id})
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/tasks/{task_id}/status")
async def get_tagger_workspace_task(task_id: str):
    snapshot = await asyncio.to_thread(task_snapshot, task_id)
    if snapshot.get("status") == "error" and snapshot.get("error_detail", "").startswith("Task not found"):
        return APIResponseFail(message=snapshot["error_detail"])
    return APIResponseSuccess(data=snapshot)


@router.post("/tagger/tasks/{task_id}/cancel")
async def stop_tagger_workspace_task(task_id: str):
    if cancel_workspace_task(task_id):
        return APIResponseSuccess(data={"message": "Task cancellation requested"})
    return APIResponseFail(message="Task not found / 任务不存在")


@router.post("/tagger/tasks/{task_id}/retry")
async def retry_tagger_workspace_task(task_id: str):
    try:
        new_task_id = await asyncio.to_thread(retry_failed_task, task_id)
        await realtime_tasks.register(
            new_task_id,
            "tagger",
            lambda task_id=new_task_id: task_snapshot(task_id),
        )
        return APIResponseSuccess(data={"task_id": new_task_id})
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/tasks/{task_id}/items")
async def list_tagger_workspace_items(task_id: str, offset: int = 0, limit: int = 120, failed_only: bool = False):
    try:
        return APIResponseSuccess(data=await asyncio.to_thread(task_items, task_id, offset, limit, failed_only))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/tasks/{task_id}/check-prompt")
async def get_check_prompt(task_id: str):
    try:
        return APIResponseSuccess(data=workspace.task_check_prompt(task_id))
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.get("/tagger/tasks/active")
async def active_tagger_workspace_task():
    return APIResponseSuccess(data={"task_id": latest_active_task_id()})



@router.post("/tagger/single")
async def tagger_single_image(
    file: UploadFile = File(...),
    interrogator_model: str = Form(...),
):
    """Single-image tag inference. Returns all categories with raw confidence scores."""
    if not file.content_type or not file.content_type.startswith("image/"):
        return APIResponseFail(message="File is not an image / 文件不是图片")

    try:
        contents = await file.read()
        image = Image.open(BytesIO(contents))
    except UnidentifiedImageError:
        return APIResponseFail(message="Cannot identify image format / 无法识别图片格式")
    except Exception as exc:
        return APIResponseFail(message=f"Failed to read image / 图片读取失败: {str(exc)[:200]}")

    interrogator = available_interrogators.get(interrogator_model)
    if interrogator is None:
        image.close()
        return APIResponseFail(message=f"Unknown model: {interrogator_model} / 未知模型: {interrogator_model}")

    owner = f"single-tagger:{uuid.uuid4().hex}"
    try:
        workspace.claim_direct_tagger(owner)
    except RuntimeError as exc:
        image.close()
        return APIResponseFail(message=str(exc))

    try:
        def _infer():
            with gpu_inference_lock:
                return interrogator.interrogate(image)

        tags = await settled_to_thread(_infer)
    except Exception as exc:
        log.exception("Single-image inference failed / 单张推理失败")
        return APIResponseFail(message=f"Inference failed / 推理失败: {str(exc)[:200]}")
    finally:
        workspace.release_direct_tagger(owner)
        image.close()

    categories = {
        category: [[tag_name, round(confidence, 4)] for tag_name, confidence in tag_list if confidence >= 0.01]
        for category, tag_list in tags.items()
    }
    categories = {category: tag_list for category, tag_list in categories.items() if tag_list}
    labels = {category: CATEGORY_LABELS.get(category, category) for category in categories}
    return APIResponseSuccess(data={
        "model": interrogator_model,
        "categories": categories,
        "labels": labels,
    })


@router.post("/tagger/api/test")
async def tagger_api_test(request: Request):
    """Verify connectivity and fetch models using the selected API protocol."""
    body = await request.json()
    try:
        models = await asyncio.to_thread(
            api_engine.list_models,
            str(body.get("base_url") or ""),
            str(body.get("api_key") or os.environ.get("OPENAI_API_KEY") or "none"),
            str(body.get("protocol") or api_engine.PROTOCOL_CHAT),
        )
        return APIResponseSuccess(data={"models": models[:100], "count": len(models)})
    except Exception as exc:
        return APIResponseFail(message=str(exc))
