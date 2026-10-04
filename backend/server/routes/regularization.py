"""Anima regularization API; WebSocket carries only compact task summaries."""
import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend.core.realtime import realtime_tasks
from backend.regularization import service
from backend.regularization.planning import metadata
from backend.server.models import APIResponseFail, APIResponseSuccess
from backend.server.routes.image_preview import serve_preview_file

router = APIRouter(prefix="/regularization")


@router.get("/metadata")
async def settings_metadata():
    return APIResponseSuccess(data=metadata())


async def invoke(function, *args, register=False):
    try:
        result = await asyncio.to_thread(function, *args)
        if register and result.get("task_id"):
            task_id = result["task_id"]
            await realtime_tasks.register(task_id, "regularization", lambda: service.task_snapshot(task_id))
        return APIResponseSuccess(data=result)
    except service.PlanChanged as exc:
        return JSONResponse(status_code=409, content={"status": "changed", "message": str(exc), "data": exc.plan})
    except Exception as exc:
        return APIResponseFail(message=str(exc))


@router.post("/plans")
async def preview(request: Request):
    return await invoke(service.preview, await request.json())


@router.get("/plans/{token}/items")
async def plan_items(token: str, offset: int = 0, limit: int = 30):
    return await invoke(service.plan_items, token, offset, limit)


@router.get("/plans/{token}/preview/{index}")
async def source_preview(token: str, index: int, request: Request, variant: str = "thumb"):
    try:
        source = await asyncio.to_thread(service.source_preview, token, index)
        return await serve_preview_file(source, variant=variant, request=request)
    except (ValueError, OSError):
        return JSONResponse(status_code=404, content={"status": "fail"})


@router.post("/tasks")
async def start(request: Request):
    body = await request.json()
    return await invoke(service.start, str(body.get("token", "")), register=True)


@router.get("/tasks/{task_id}")
async def status(task_id: str):
    return await invoke(service.task_snapshot, task_id)


@router.post("/tasks/{task_id}/cancel")
async def cancel(task_id: str):
    return await invoke(service.cancel, task_id)


@router.get("/runs")
async def runs():
    return await invoke(service.runs)


@router.get("/runs/{key}/items")
async def results(key: str, offset: int = 0, limit: int = 30, status: str = "all"):
    return await invoke(service.results, key, offset, limit, status)


@router.get("/runs/{key}/logs")
async def logs(key: str):
    return await invoke(service.logs, key)


@router.get("/runs/{key}/settings")
async def saved_settings(key: str):
    return await invoke(service.run_settings, key)


@router.get("/runs/{key}/plan")
async def saved_plan(key: str):
    return await invoke(service.run_plan, key)


@router.get("/runs/{key}/preview/{index}")
async def result_preview(key: str, index: int, request: Request, variant: str = "thumb"):
    try:
        source = await asyncio.to_thread(service.result_image, key, index)
        return await serve_preview_file(source, variant=variant, request=request)
    except (ValueError, OSError):
        return JSONResponse(status_code=404, content={"status": "fail"})


@router.post("/runs/{key}/resume")
async def resume(key: str, request: Request):
    body = await request.json()
    return await invoke(service.resume, key, bool(body.get("failed_only", False)), register=True)


@router.post("/runs/{key}/items/{index}/{action}")
async def mutate(key: str, index: int, action: str):
    return await invoke(service.mutate, key, index, action, register=action == "regenerate")
