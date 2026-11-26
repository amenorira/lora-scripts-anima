"""FlashAttention installation and status endpoints."""
import asyncio

from fastapi import APIRouter

from backend.core.install_jobs import InstallJobs
from tools import flash_attention

router = APIRouter()
install_jobs = InstallJobs("flash-attn")


@router.get("/flash-attn/status")
async def status() -> dict:
    return await asyncio.to_thread(flash_attention.current_status)


@router.post("/flash-attn/install")
async def install() -> dict:
    return await install_jobs.start(flash_attention.install)
