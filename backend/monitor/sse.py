"""
SSE 端点：使用事件总线接收事件并推送到前端。

事件类型：
- status_change: 任务状态变更
- progress: 训练进度
- log_update: 日志增量更新
- hardware: GPU/系统信息
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from backend.core.event_bus import event_bus

logger = logging.getLogger(__name__)

router = APIRouter()

# 心跳间隔（秒）
_KEEPALIVE_INTERVAL = 15.0


@router.get("/monitor/stream")
async def monitor_stream(task_id: str = Query(""), request: Request = None):
    """SSE 端点：实时训练监控流"""
    if not task_id:
        # 无 task_id 时只推送硬件信息
        return await _hardware_only_stream(request)
    
    return await _task_stream(task_id, request)


async def _task_stream(task_id: str, request: Request) -> StreamingResponse:
    """任务监控流"""
    queue = await event_bus.subscribe(task_id)
    
    async def generate() -> AsyncIterator[bytes]:
        try:
            # 发送连接成功消息
            yield b": connected\n\n"
            
            while True:
                # 检查客户端断开
                if await request.is_disconnected():
                    break
                
                try:
                    # 等待事件，超时发送心跳
                    event = await asyncio.wait_for(
                        queue.get(), timeout=_KEEPALIVE_INTERVAL
                    )
                    
                    # 格式化为 SSE
                    event_type = event.get("type", "message")
                    data = json.dumps(event)
                    yield f"event: {event_type}\ndata: {data}\n\n".encode("utf-8")
                    
                except asyncio.TimeoutError:
                    # 发送心跳
                    yield b": keepalive\n\n"
                    
        finally:
            # 清理订阅
            event_bus.unsubscribe(task_id, queue)
            logger.debug(f"SSE 连接断开: task_id={task_id}")
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 Nginx 缓冲
        }
    )


async def _hardware_only_stream(request: Request) -> StreamingResponse:
    """仅硬件信息流（无 task_id）"""
    queue = await event_bus.subscribe("hardware")
    
    async def generate() -> AsyncIterator[bytes]:
        try:
            yield b": connected\n\n"
            
            while True:
                if await request.is_disconnected():
                    break
                
                try:
                    event = await asyncio.wait_for(
                        queue.get(), timeout=_KEEPALIVE_INTERVAL
                    )
                    
                    # 只推送硬件事件
                    if event.get("type") == "hardware":
                        data = json.dumps(event)
                        yield f"event: hardware\ndata: {data}\n\n".encode("utf-8")
                    
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"
                    
        finally:
            event_bus.unsubscribe("hardware", queue)
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )