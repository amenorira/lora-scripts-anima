"""FlashAttention installation and status endpoints."""
import asyncio
from collections import deque
import threading
import time
from uuid import uuid4

from fastapi import APIRouter, Request

from backend.core.realtime import realtime_tasks
from backend.tasks import tm
from tools import flash_attention

router = APIRouter()
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _snapshot(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return {"done": True, "success": False, "error": "Task expired / 任务已过期"}
        return {"done": job["done"], "success": job.get("success"),
                "status": ("finished" if job.get("success") else "error") if job["done"] else "running",
                "progress": dict(job["progress"]), "lines": "\n".join(job["log"]),
                "elapsed": time.time() - job["start"], "error": job.get("error")}


@router.get("/flash-attn/status")
async def status() -> dict:
    return await asyncio.to_thread(flash_attention.current_status)


async def _start(source: str = "auto") -> dict:
    job_id = uuid4().hex[:12]
    owner = "flash-attn:" + job_id
    if not tm.claim_external(owner):
        return {"success": False, "message": "Finish the active training or GPU task first / 请先结束正在运行的训练或 GPU 任务"}
    with _lock:
        for expired in [key for key, job in _jobs.items() if job["done"] and time.time() - job["start"] > 600]:
            del _jobs[expired]
        _jobs[job_id] = {"start": time.time(), "done": False, "progress": {}, "log": deque(maxlen=80)}

    def emit(**event):
        with _lock:
            job = _jobs[job_id]
            job["progress"].update({key: value for key, value in event.items() if key != "message"})
            if event.get("message"):
                job["log"].append(str(event["message"]))

    def work():
        try:
            flash_attention.install(emit, source=source)
            with _lock:
                _jobs[job_id]["success"] = True
        except Exception as exc:
            emit(stage="error", message=str(exc))
            with _lock:
                _jobs[job_id].update(success=False, error=str(exc))
        finally:
            tm.release_external(owner)
            with _lock:
                _jobs[job_id]["done"] = True

    try:
        await realtime_tasks.register(job_id, "flash-attn-install", lambda: _snapshot(job_id))
        threading.Thread(target=work, daemon=True).start()
    except BaseException:
        tm.release_external(owner)
        with _lock:
            _jobs.pop(job_id, None)
        raise
    return {"success": True, "job_id": job_id}


@router.post("/flash-attn/install")
async def install(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        body = {}
    source = body.get("source", "auto") if isinstance(body, dict) else None
    if source not in ("auto", "direct", "mirror"):
        return {"success": False, "message": "Invalid download source / 下载源无效"}
    return await _start(source)
