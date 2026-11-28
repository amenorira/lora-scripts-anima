"""Same-origin WebSocket endpoint and realtime bootstrap snapshot."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.core.realtime import (
    offer_realtime,
    PROTOCOL_VERSION,
    SERVER_INSTANCE_ID,
    SERVER_STARTED_AT,
    realtime_hub,
    realtime_tasks,
)
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.live_snapshot import build_live_monitor_snapshot
from backend.tasks import tm

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_CONNECTION_QUEUE = 64
_ALLOWED_STATIC_TOPICS = {"server", "hardware", "artifacts"}
_HEARTBEAT_INTERVAL = 25.0


def _valid_topic(topic: Any) -> bool:
    return isinstance(topic, str) and (
        topic in _ALLOWED_STATIC_TOPICS or (topic.startswith("task:") and len(topic) > 5)
    )


def _managed_state() -> dict[str, Any]:
    tasks = tm.training_dump()
    return {
        "server_instance_id": SERVER_INSTANCE_ID,
        "started_at": SERVER_STARTED_AT,
        "server": {
            "instance_id": SERVER_INSTANCE_ID,
            "started_at": SERVER_STARTED_AT,
            "training_active": any(task.get("status") in {"CREATED", "RUNNING"} for task in tasks),
            "regularization_active": tm.regularization_active(),
        },
        "tasks": {"managed": tasks},
    }


@router.get("/api/realtime/state")
async def realtime_state(hardware: bool = False, task_id: str = "") -> dict[str, Any]:
    """Small lifecycle reconciliation; hardware is optional for disconnected clients."""
    data = _managed_state()
    for item in data["tasks"]["managed"]:
        if item["status"] == "RUNNING" or item["id"] == task_id:
            task = tm.get_task(item["id"])
            if task and task.control:
                item["control"] = await asyncio.to_thread(task.control.view)
    if hardware:
        gpu, system = await asyncio.gather(asyncio.to_thread(gpu_info), asyncio.to_thread(system_info))
        data["hardware"] = {"gpu": gpu, "system": system, "sampled_at": time.time()}
    return {"status": "success", "data": data}


async def _snapshot_payload(
    *,
    monitor_detail: bool = False,
    preview_limit: int = 36,
) -> dict[str, Any]:
    # Capture cursors before reading state. The task list includes changes up
    # to those cursors, and later events can be replayed after subscription.
    cursors = await realtime_hub.cursors()
    state = _managed_state()
    gpu, system, tracked_tasks, monitor = await asyncio.gather(
        asyncio.to_thread(gpu_info, True),
        asyncio.to_thread(system_info, True),
        realtime_tasks.snapshot(),
        build_live_monitor_snapshot(
            tasks=state["tasks"]["managed"],
            detail=monitor_detail,
            preview_limit=preview_limit,
        ),
    )
    sampled_at = time.time()
    monitor["gpu"] = gpu
    monitor["system"] = system
    return {
        **state,
        "hardware": {
            "gpu": gpu,
            "system": system,
            "sampled_at": sampled_at,
        },
        "tasks": {
            **state["tasks"],
            "tracked": tracked_tasks,
        },
        "cursors": cursors,
        "monitor": monitor,
    }


@router.get("/api/realtime/snapshot")
async def realtime_snapshot(
    detail: bool = False,
    preview_limit: int = 36,
) -> dict[str, Any]:
    """Return a coherent bootstrap after a WebSocket connect or resync."""
    return {
        "status": "success",
        "data": await _snapshot_payload(
            monitor_detail=detail,
            preview_limit=preview_limit,
        ),
    }


@router.get("/api/realtime/monitor-detail")
async def realtime_monitor_detail() -> dict[str, Any]:
    """Read disk-backed monitor data without rebuilding the transport snapshot."""
    tasks = tm.training_dump()
    monitor = await build_live_monitor_snapshot(tasks=tasks, detail=True, preview_limit=0)
    return {"status": "success", "data": {
        "server_instance_id": SERVER_INSTANCE_ID,
        "tasks": {"managed": tasks},
        "monitor": monitor,
    }}


@router.websocket("/ws/realtime")
async def realtime_socket(websocket: WebSocket) -> None:
    """Serve small, replayable realtime JSON events over one same-origin socket."""
    await websocket.accept()
    outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_CONNECTION_QUEUE)
    subscriptions: dict[str, tuple[asyncio.Queue[dict[str, Any]], asyncio.Task]] = {}
    handshaken = False

    def enqueue(message: dict[str, Any]) -> None:
        offer_realtime(outbound, message)

    async def close_subscription(topic: str) -> None:
        current = subscriptions.pop(topic, None)
        if current is None:
            return
        queue, task = current
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await realtime_hub.unsubscribe(topic, queue)

    async def open_subscription(topic: str, resume_seq: int = 0) -> None:
        if not _valid_topic(topic):
            enqueue({"op": "error", "code": "invalid_topic", "topic": topic})
            return
        await close_subscription(topic)
        queue, replay, resync_required = await realtime_hub.subscribe(topic, resume_seq)
        # Reserve one outbound slot for recovery while replay is enqueued.
        # The send loop drains the queue after this batch is enqueued.
        if resync_required or len(replay) > max(0, outbound.maxsize - outbound.qsize() - 1):
            enqueue({
                "op": "resync_required",
                "topics": [topic],
                "server_instance_id": SERVER_INSTANCE_ID,
            })
        else:
            for event in replay:
                enqueue(event)

        async def forward() -> None:
            while True:
                enqueue(await queue.get())

        subscriptions[topic] = (queue, asyncio.create_task(forward()))

    async def receive_loop() -> None:
        nonlocal handshaken
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            op = message.get("op")
            if op == "hello":
                handshaken = True
                enqueue({
                    "op": "ready",
                    "protocol": PROTOCOL_VERSION,
                    "server_instance_id": SERVER_INSTANCE_ID,
                    "started_at": SERVER_STARTED_AT,
                })
                continue
            if not handshaken:
                enqueue({"op": "error", "code": "hello_required"})
                continue
            if op == "subscribe":
                resume = message.get("resume") or {}
                for topic in message.get("topics") or []:
                    await open_subscription(topic, resume.get(topic, 0) if isinstance(resume, dict) else 0)
            elif op == "unsubscribe":
                for topic in message.get("topics") or []:
                    await close_subscription(topic)
            elif op == "resume":
                cursors = message.get("cursors") or {}
                if isinstance(cursors, dict):
                    for topic, seq in cursors.items():
                        await open_subscription(topic, seq)
            elif op == "ping":
                enqueue({
                    "op": "pong",
                    "server_instance_id": SERVER_INSTANCE_ID,
                    "emitted_at": time.time(),
                })
            else:
                enqueue({"op": "error", "code": "unknown_operation"})

    async def send_loop() -> None:
        while True:
            try:
                message = await asyncio.wait_for(outbound.get(), timeout=_HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                message = {"op": "heartbeat", "emitted_at": time.time()}
            await websocket.send_json(message)

    receiver = asyncio.create_task(receive_loop())
    sender = asyncio.create_task(send_loop())
    try:
        done, pending = await asyncio.wait({receiver, sender}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            try:
                task.result()
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
            except Exception:
                logger.debug("Realtime WebSocket ended", exc_info=True)
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    finally:
        for topic in list(subscriptions):
            await close_subscription(topic)
        try:
            await websocket.close()
        except Exception:
            pass
