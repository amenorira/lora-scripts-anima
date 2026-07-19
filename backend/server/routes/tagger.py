"""Tagger API routes."""

import asyncio
import uuid
from io import BytesIO

from fastapi import APIRouter, File, Form, UploadFile
from PIL import Image, UnidentifiedImageError

from backend.log import log
from backend.server.models import APIResponseFail, APIResponseSuccess, TaggerInterrogateRequest
from backend.tagger.interrogator import (
    available_interrogators,
    cancel_tagger_task,
    get_tagger_progress,
    on_interrogate,
)
from backend.tagger.interrogators.base import CATEGORY_LABELS

router = APIRouter()

_MODEL_DISPLAY_NAMES = {
    "wd-eva02-large-tagger-v3": "WD EVA02 Large v3",
    "wd-vit-large-tagger-v3": "WD ViT Large v3",
    "cl_tagger_1_02": "CL Tagger v1.02",
    "camie-tagger-v2": "Camie Tagger v2",
}


@router.post("/interrogate")
async def run_interrogate(req: TaggerInterrogateRequest):
    task_id = str(uuid.uuid4())[:8]
    interrogator = available_interrogators.get(
        req.interrogator_model,
        available_interrogators["wd-eva02-large-tagger-v3"],
    )
    asyncio.create_task(asyncio.to_thread(
        on_interrogate,
        task_id=task_id,
        image=None,
        batch_input_glob=req.path,
        batch_input_recursive=req.batch_input_recursive,
        batch_output_dir=req.batch_output_dir,
        batch_output_filename_format="[name].[output_extension]",
        batch_output_action_on_conflict=req.batch_output_action_on_conflict,
        batch_remove_duplicated_tag=req.batch_remove_duplicated_tag,
        batch_output_save_json=req.batch_output_save_json,
        interrogator=interrogator,
        threshold=req.threshold,
        character_threshold=req.character_threshold,
        category_thresholds=req.category_thresholds,
        add_rating_tag=req.add_rating_tag,
        add_model_tag=req.add_model_tag,
        additional_tags=req.additional_tags,
        exclude_tags=req.exclude_tags,
        sort_by_alphabetical_order=req.sort_by_alphabetical_order,
        add_confident_as_weight=req.add_confident_as_weight,
        replace_underscore=req.replace_underscore,
        replace_underscore_excludes=req.replace_underscore_excludes,
        escape_tag=req.escape_tag,
        unload_model_after_running=True,
    ))
    return APIResponseSuccess(data={"task_id": task_id})


@router.get("/interrogate/progress")
async def tagger_progress(task_id: str):
    """Poll tagger task progress."""
    return APIResponseSuccess(data=get_tagger_progress(task_id))


@router.post("/interrogate/stop")
async def stop_interrogate(task_id: str):
    """Cancel a running tagger task."""
    if cancel_tagger_task(task_id):
        return APIResponseSuccess(data={"message": "Task cancelled"})
    return APIResponseFail(message="Task not found")


@router.get("/tagger/models")
async def list_tagger_models():
    """List available tagger/interrogator models."""
    return APIResponseSuccess(data=[
        {"id": key, "name": _MODEL_DISPLAY_NAMES.get(key, key)}
        for key in available_interrogators
    ])


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
        return APIResponseFail(message=f"Failed to read image: {str(exc)[:200]}")

    interrogator = available_interrogators.get(interrogator_model)
    if interrogator is None:
        return APIResponseFail(message=f"Unknown model: {interrogator_model} / 未知模型: {interrogator_model}")

    try:
        tags = await asyncio.to_thread(interrogator.interrogate, image)
    except Exception as exc:
        log.exception("Single-image inference failed")
        return APIResponseFail(message=f"Inference failed: {str(exc)[:200]}")

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
