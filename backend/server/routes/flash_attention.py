"""FlashAttention installation and status endpoints."""
import asyncio

from fastapi import APIRouter, Request

from backend.core.install_jobs import InstallJobs
from tools import flash_attention

router = APIRouter()
install_jobs = InstallJobs("flash-attn")


@router.get("/flash-attn/status")
async def status() -> dict:
    return await asyncio.to_thread(flash_attention.current_status)


@router.post("/flash-attn/install")
async def install(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        body = {}
    source = body.get("source", "auto") if isinstance(body, dict) else None
    if source not in ("auto", "direct", "mirror"):
        return {"success": False, "message": "Invalid download source / 下载源无效"}
    return await install_jobs.start(flash_attention.install, source=source)
