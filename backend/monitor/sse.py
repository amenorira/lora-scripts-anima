"""
训练监控 SSE 端点 — 实时推送训练状态、进度、日志

  GET /api/monitor/stream?task_id=xxx

事件类型:
  - status_change: 任务状态变更（RUNNING/FINISHED/TERMINATED）
  - progress:      训练进度（step/loss/lr/epoch/eta/speed）
  - log_update:    日志增量更新
  - hardware:      GPU/系统信息
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import AsyncGenerator

from sse_starlette.sse import EventSourceResponse
from fastapi import APIRouter, Query

from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import parse_log_progress, latest_train_config
from backend.monitor.artifacts import read_train_log
from backend.tasks import tm, TaskStatus

router = APIRouter()

# SSE 推送间隔（秒）
_HARDWARE_INTERVAL = 2.0
_PROGRESS_INTERVAL = 1.0
_LOG_INTERVAL = 1.0


async def _get_hardware() -> dict:
    """异步获取 GPU/系统信息"""
    gpu, sys = await asyncio.gather(
        asyncio.to_thread(gpu_info),
        asyncio.to_thread(system_info),
    )
    return {"gpu": gpu, "system": sys}


async def _get_progress(task_id: str) -> dict | None:
    """获取训练进度"""
    task = tm.get_task(task_id)
    if not task or task.status != TaskStatus.RUNNING:
        return None

    train_config = await asyncio.to_thread(latest_train_config)
    output_dir = train_config.get("output_dir")
    log_lines = await asyncio.to_thread(
        read_train_log, task_id,
        Path(output_dir) if output_dir else None,
    )
    if not log_lines:
        return None

    progress = await asyncio.to_thread(parse_log_progress, log_lines)
    return {
        "step": progress.get("step", 0),
        "total_steps": progress.get("total_steps", 0),
        "percent": progress.get("percent", 0),
        "loss": progress.get("loss"),
        "lr": progress.get("lr"),
        "epoch": progress.get("epoch"),
        "eta": progress.get("eta"),
        "speed": progress.get("speed"),
        "has_error": progress.get("has_error", False),
        "error_msg": progress.get("error_msg"),
    }


async def _get_log_tail(task_id: str, last_line_count: int) -> tuple[list[str], int]:
    """获取日志增量，返回 (新行列表, 当前总行数)"""
    task = tm.get_task(task_id)
    if not task or task.status != TaskStatus.RUNNING:
        return [], last_line_count

    train_config = await asyncio.to_thread(latest_train_config)
    output_dir = train_config.get("output_dir")
    log_lines = await asyncio.to_thread(
        read_train_log, task_id,
        Path(output_dir) if output_dir else None,
    )
    if not log_lines:
        return [], last_line_count

    current_count = len(log_lines)
    if current_count > last_line_count:
        new_lines = log_lines[last_line_count:]
        return new_lines, current_count
    return [], last_line_count


async def _event_generator(task_id: str) -> AsyncGenerator[dict, None]:
    """SSE 事件生成器"""
    last_status = None
    last_log_line_count = 0
    last_hw_time = 0.0
    last_progress_time = 0.0
    last_log_time = 0.0

    # 首次连接时发送当前状态
    task = tm.get_task(task_id) if task_id else None
    if task:
        last_status = task.status.name
        yield {
            "event": "status_change",
            "data": json.dumps({
                "task_id": task_id,
                "status": last_status,
            }),
        }

    while True:
        now = time.time()

        # 检查任务状态变更
        task = tm.get_task(task_id) if task_id else None
        current_status = task.status.name if task else None

        if current_status != last_status:
            last_status = current_status
            yield {
                "event": "status_change",
                "data": json.dumps({
                    "task_id": task_id,
                    "status": current_status,
                }),
            }
            # 任务结束时关闭连接
            if current_status in ("FINISHED", "TERMINATED"):
                break

        # 推送硬件信息
        if now - last_hw_time >= _HARDWARE_INTERVAL:
            last_hw_time = now
            try:
                hw = await _get_hardware()
                yield {
                    "event": "hardware",
                    "data": json.dumps(hw),
                }
            except Exception:
                pass

        # 推送训练进度
        if task_id and current_status == "RUNNING" and now - last_progress_time >= _PROGRESS_INTERVAL:
            last_progress_time = now
            try:
                progress = await _get_progress(task_id)
                if progress:
                    yield {
                        "event": "progress",
                        "data": json.dumps(progress),
                    }
            except Exception:
                pass

        # 推送日志增量
        if task_id and current_status == "RUNNING" and now - last_log_time >= _LOG_INTERVAL:
            last_log_time = now
            try:
                new_lines, last_log_line_count = await _get_log_tail(task_id, last_log_line_count)
                if new_lines:
                    yield {
                        "event": "log_update",
                        "data": json.dumps({
                            "lines": new_lines[-50:],  # 每次最多推送 50 行
                            "total": last_log_line_count,
                        }),
                    }
            except Exception:
                pass

        await asyncio.sleep(0.5)


@router.get("/monitor/stream")
async def monitor_stream(task_id: str = Query("")):
    """SSE 端点：实时训练监控流"""
    if not task_id:
        # 无 task_id 时只推送硬件信息
        async def _hw_only():
            while True:
                try:
                    hw = await _get_hardware()
                    yield {
                        "event": "hardware",
                        "data": json.dumps(hw),
                    }
                except Exception:
                    pass
                await asyncio.sleep(_HARDWARE_INTERVAL)

        return EventSourceResponse(_hw_only())

    return EventSourceResponse(_event_generator(task_id))
