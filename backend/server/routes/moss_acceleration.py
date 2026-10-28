"""Optional MOSS encoder kernels, isolated from the managed venv."""
import asyncio

from fastapi import APIRouter, Request

from backend.core.install_jobs import InstallJobs
from tools import moss_acceleration

router = APIRouter()
install_jobs = InstallJobs("moss-acceleration")


@router.get("/moss-acceleration/status")
async def status() -> dict:
    return await asyncio.to_thread(moss_acceleration.current_status)


@router.post("/moss-acceleration/enabled")
async def enabled(request: Request) -> dict:
    try:
        body = await request.json()
        value = body.get("enabled") if isinstance(body, dict) else None
        if not isinstance(value, bool):
            raise ValueError("enabled must be boolean / enabled 必须为布尔值")
        result = await asyncio.to_thread(moss_acceleration.set_enabled, value)
        return {"success": True, "data": result}
    except (ValueError, RuntimeError, OSError) as exc:
        return {"success": False, "message": str(exc)}


@router.post("/moss-acceleration/install")
async def install() -> dict:
    return await install_jobs.start(moss_acceleration.install)
