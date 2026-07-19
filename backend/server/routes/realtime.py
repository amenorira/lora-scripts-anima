"""Same-origin WebSocket endpoint and realtime bootstrap snapshot."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.core.realtime import (
    PROTOCOL_VERSION,
    SERVER_INSTANCE_ID,
    SERVER_STARTED_AT,
    realtime_hub,
    realtime_tasks,
)
from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.routes import build_live_monitor_snapshot
from backend.tasks import tm

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_CONNECTION_QUEUE = 64
_ALLOWED_STATIC_TOPICS = {"server", "hardware"}


def _valid_topic(topic: Any) -> bool:
    return isinstance(topic, str) and (
        topic in _ALLOWED_STATIC_TOPICS or (topic.startswith("task:") and len(topic) > 5)
    )


async def _snapshot_payload(
    *,
    monitor_detail: bool = False,
    preview_limit: int = 36,
) -> dict[str, Any]:
    managed_tasks = tm.dump()
    # Capture cursors *before* reading disk-backed monitor state. Events
    # emitted while that snapshot is assembled will then have a later seq and
    # are replayed after subscribe instead of being accidentally skipped.
    cursors = await realtime_hub.cursors()
    gpu, system, tracked_tasks, monitor = await asyncio.gather(
        asyncio.to_thread(gpu_info, True),
        asyncio.to_thread(system_info, True),
        realtime_tasks.snapshot(),
        build_live_monitor_snapshot(
            tasks=managed_tasks,
            detail=monitor_detail,
            preview_limit=preview_limit,
        ),
    )
    sampled_at = time.time()
    monitor["gpu"] = gpu
    monitor["system"] = system
    active_statuses = {"CREATED", "RUNNING"}
    return {
        "server_instance_id": SERVER_INSTANCE_ID,
        "started_at": SERVER_STARTED_AT,
        "server": {
            "instance_id": SERVER_INSTANCE_ID,
            "started_at": SERVER_STARTED_AT,
            "training_active": any(task.get("status") in active_statuses for task in managed_tasks),
        },
        "hardware": {
            "gpu": gpu,
            "system": system,
            "sampled_at": sampled_at,
        },
        "tasks": {
            "managed": managed_tasks,
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


@router.websocket("/ws/realtime")
async def realtime_socket(websocket: WebSocket) -> None:
    """Serve small, replayable realtime JSON events over one same-origin socket."""
    await websocket.accept()
    outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_CONNECTION_QUEUE)
    subscriptions: dict[str, tuple[asyncio.Queue[dict[str, Any]], asyncio.Task]] = {}
    handshaken = False
    client_instance_id: str | None = None

    def enqueue(message: dict[str, Any]) -> None:
        """Bound connection memory and make every overflow recoverable.

        The connection queue multiplexes topics, so dropping only its oldest
        item can silently discard the first event of a sequence.  Clear the
        stale batch and put one global resync marker ahead of the newest
        message instead.  A snapshot is cheaper and more correct than trying
        to guess which topic(s) were lost.
        """
        if outbound.full():
            while True:
                try:
                    outbound.get_nowait()
                except asyncio.QueueEmpty:
                    break
            try:
                outbound.put_nowait({
                    "op": "resync_required",
                    "topics": [],
                    "reason": "slow_consumer",
                    "server_instance_id": SERVER_INSTANCE_ID,
                })
            except asyncio.QueueFull:
                logger.debug("Realtime outbound queue could not accept resync marker")
        try:
            outbound.put_nowait(message)
        except asyncio.QueueFull:
            logger.debug("Realtime outbound queue remained full")

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
        for event in replay:
            enqueue(event)
        if resync_required:
            enqueue({
                "op": "resync_required",
                "topics": [topic],
                "server_instance_id": SERVER_INSTANCE_ID,
            })

        async def forward() -> None:
            while True:
                enqueue(await queue.get())

        subscriptions[topic] = (queue, asyncio.create_task(forward()))

    async def receive_loop() -> None:
        nonlocal handshaken, client_instance_id
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            op = message.get("op")
            if op == "hello":
                handshaken = True
                incoming_instance_id = message.get("server_instance_id")
                client_instance_id = incoming_instance_id if isinstance(incoming_instance_id, str) else None
                enqueue({
                    "op": "ready",
                    "protocol": PROTOCOL_VERSION,
                    "server_instance_id": SERVER_INSTANCE_ID,
                    "started_at": SERVER_STARTED_AT,
                })
                if client_instance_id and client_instance_id != SERVER_INSTANCE_ID:
                    # Do not replay a cursor from another in-memory backend
                    # instance.  The client must bootstrap a fresh snapshot.
                    enqueue({
                        "op": "resync_required",
                        "topics": [],
                        "reason": "server_instance_changed",
                        "server_instance_id": SERVER_INSTANCE_ID,
                    })
                    # The ready message already establishes this instance for
                    # the rest of this socket's lifetime.  The browser clears
                    # its cursors before it subscribes again.
                    client_instance_id = SERVER_INSTANCE_ID
                continue
            if not handshaken:
                enqueue({"op": "error", "code": "hello_required"})
                continue
            if op == "subscribe":
                resume = message.get("resume") or {}
                if client_instance_id and client_instance_id != SERVER_INSTANCE_ID:
                    enqueue({
                        "op": "resync_required",
                        "topics": list(message.get("topics") or []),
                        "reason": "server_instance_changed",
                        "server_instance_id": SERVER_INSTANCE_ID,
                    })
                    continue
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
            await websocket.send_json(await outbound.get())

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
