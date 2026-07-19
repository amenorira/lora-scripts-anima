"""In-memory realtime transport shared by WebSocket clients.

The application deliberately keeps this layer independent from deployment
topology.  It only deals with small JSON events produced inside this FastAPI
process; files and all request/response operations stay on HTTP.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = 1
SERVER_INSTANCE_ID = uuid.uuid4().hex
SERVER_STARTED_AT = time.time()

_MAX_HISTORY_EVENTS = 256
_MAX_HISTORY_BYTES = 5 * 1024 * 1024
_MAX_SUBSCRIBER_QUEUE = 64
_TERMINAL_TASK_TTL = 600.0
_MAX_TASK_LOG_ITEMS = 100
_MAX_TASK_LOG_CHARS = 48 * 1024
_MAX_TASK_PAYLOAD_BYTES = 64 * 1024


def task_topic(task_id: str) -> str:
    """Return the canonical realtime topic for any long-running task."""
    return f"task:{task_id}"


def _json_size(value: dict[str, Any]) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))
    except Exception:
        return 0


def _compact_task_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Keep third-party task snapshots safe for a small JSON realtime frame.

    Existing job implementations keep their useful in-memory logs unchanged;
    this transport adapter sends only their newest bounded tail.  It applies to
    both WebSocket events and the bootstrap snapshot so a stalled remote link
    never receives an unbounded installation/tagging log in one response.
    """
    result = dict(snapshot)
    truncated = False
    for key in ("log", "logs", "lines"):
        value = result.get(key)
        if isinstance(value, list):
            values = value[-_MAX_TASK_LOG_ITEMS:]
            compacted = []
            for item in values:
                text = str(item)
                if len(text) > 4096:
                    text = text[-4096:]
                    truncated = True
                compacted.append(text)
            if len(value) != len(compacted):
                truncated = True
            result[key] = compacted
        elif isinstance(value, str) and len(value) > _MAX_TASK_LOG_CHARS:
            result[key] = value[-_MAX_TASK_LOG_CHARS:]
            truncated = True
    if _json_size(result) > _MAX_TASK_PAYLOAD_BYTES:
        # A provider may include arbitrary nested diagnostics. Retain task
        # identity/progress-like scalar fields and mark the omission instead
        # of permitting a multi-megabyte realtime message.
        retained: dict[str, Any] = {}
        for key, value in result.items():
            if isinstance(value, (str, int, float, bool)) or value is None:
                text = value[-4096:] if isinstance(value, str) and len(value) > 4096 else value
                retained[key] = text
            elif key in {"progress", "error", "error_detail"} and isinstance(value, dict):
                retained[key] = {
                    nested_key: nested_value
                    for nested_key, nested_value in value.items()
                    if isinstance(nested_value, (str, int, float, bool)) or nested_value is None
                }
        result = retained
        truncated = True
    if truncated:
        result["realtime_truncated"] = True
    return result


class RealtimeHub:
    """Topic fan-out with bounded event replay.

    Events remain process-local by design.  A new backend instance receives a
    new ``SERVER_INSTANCE_ID``; clients must then request a fresh snapshot
    instead of attempting to replay cursors from the old process.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._history: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
        self._history_bytes: dict[str, int] = defaultdict(int)
        self._next_seq: dict[str, int] = defaultdict(int)

    async def publish(self, topic: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Publish one canonical event without ever blocking a producer."""
        emitted_at = time.time()
        async with self._lock:
            self._next_seq[topic] += 1
            event: dict[str, Any] = {
                "op": "event",
                "topic": topic,
                "seq": self._next_seq[topic],
                "type": event_type,
                "emitted_at": emitted_at,
                "payload": payload,
            }
            history = self._history[topic]
            history.append(event)
            self._history_bytes[topic] += _json_size(event)
            while history and (
                len(history) > _MAX_HISTORY_EVENTS
                or self._history_bytes[topic] > _MAX_HISTORY_BYTES
            ):
                self._history_bytes[topic] -= _json_size(history.popleft())

            subscribers = list(self._subscribers.get(topic, ()))

        for queue in subscribers:
            self._offer(queue, event)
        return event

    @staticmethod
    def _offer(queue: asyncio.Queue[dict[str, Any]], event: dict[str, Any]) -> None:
        """Offer an event without letting one slow subscriber grow memory.

        Keeping merely the latest 256 events is not sufficient: a client that
        lost the beginning of that range cannot infer the gap when its cursor
        was zero.  On overflow we therefore discard the stale batch and put a
        protocol-level resync marker before the newest event.  The WebSocket
        forwarder passes that marker through unchanged and the browser obtains
        an HTTP snapshot before it trusts subsequent incremental data.
        """
        if queue.full():
            while True:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            topic = event.get("topic")
            marker = {
                "op": "resync_required",
                "topics": [topic] if isinstance(topic, str) else [],
                "reason": "slow_consumer",
                "server_instance_id": SERVER_INSTANCE_ID,
            }
            try:
                queue.put_nowait(marker)
            except asyncio.QueueFull:
                # This should be impossible after draining, but producer
                # safety matters more than an individual notification.
                logger.debug("Realtime subscriber queue could not accept resync marker")
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # Another consumer raced us.  The resync marker above already
            # tells this client to rebuild from a snapshot.
            logger.debug("Realtime subscriber queue stayed full for topic=%s", event.get("topic"))

    async def subscribe(
        self,
        topic: str,
        resume_seq: int = 0,
    ) -> tuple[asyncio.Queue[dict[str, Any]], list[dict[str, Any]], bool]:
        """Subscribe and return ``(queue, replay, resync_required)``."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_MAX_SUBSCRIBER_QUEUE)
        try:
            resume_seq = max(0, int(resume_seq))
        except (TypeError, ValueError):
            resume_seq = 0

        async with self._lock:
            history = self._history.get(topic, deque())
            latest_seq = self._next_seq.get(topic, 0)
            replay: list[dict[str, Any]] = []
            resync_required = False

            if latest_seq:
                if resume_seq > latest_seq:
                    resync_required = True
                elif history:
                    oldest_seq = history[0]["seq"]
                    if resume_seq < oldest_seq - 1:
                        resync_required = True
                    else:
                        replay = [event for event in history if event["seq"] > resume_seq]
                elif latest_seq > resume_seq:
                    resync_required = True

            self._subscribers[topic].add(queue)
        return queue, replay, resync_required

    async def unsubscribe(self, topic: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(topic)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(topic, None)

    async def subscriber_count(self, topic: str) -> int:
        async with self._lock:
            return len(self._subscribers.get(topic, ()))

    async def cursors(self) -> dict[str, int]:
        """Return the latest sequence for every topic in this process.

        A bootstrap snapshot represents state through this instant.  Giving
        the browser these cursors lets its first subscription replay only
        events created after that snapshot, rather than re-appending old logs
        or metric points that are already in it.
        """
        async with self._lock:
            return dict(self._next_seq)


def _normalize_status(snapshot: dict[str, Any]) -> str:
    """Map heterogeneous in-process job state fields to one task status set."""
    raw = str(snapshot.get("status") or "").strip().lower()
    if raw in {"running", "installing", "downloading", "loading"}:
        return "RUNNING"
    if raw in {"created", "pending", "queued", "idle", ""}:
        if snapshot.get("done"):
            raw = "done"
        else:
            return "CREATED"
    if raw in {"done", "finished", "success", "completed"}:
        return "FINISHED"
    if raw in {"cancelled", "terminated", "stopped"}:
        return "TERMINATED"
    if raw in {"error", "failed", "failure"}:
        return "FAILED"
    if snapshot.get("done"):
        if snapshot.get("success") is False or snapshot.get("returncode") not in (None, 0):
            return "FAILED"
        return "FINISHED"
    return "RUNNING"


@dataclass
class _TrackedTask:
    task_id: str
    kind: str
    snapshot_provider: Callable[[], dict[str, Any]]
    last_status: str | None = None
    last_signature: str | None = None
    terminal_at: float | None = None


class RealtimeTaskRegistry:
    """Bridges existing in-memory long-job progress objects into realtime.

    Job implementations remain unchanged and do not need to know how clients
    are connected.  The monitor polls their already-existing in-memory status
    once per second and emits only changed snapshots.
    """

    def __init__(self, hub: RealtimeHub) -> None:
        self._hub = hub
        self._lock = asyncio.Lock()
        self._tasks: dict[str, _TrackedTask] = {}

    async def register(
        self,
        task_id: str,
        kind: str,
        snapshot_provider: Callable[[], dict[str, Any]],
    ) -> None:
        tracked = _TrackedTask(task_id=task_id, kind=kind, snapshot_provider=snapshot_provider)
        async with self._lock:
            self._tasks[task_id] = tracked
        await self._hub.publish(
            task_topic(task_id),
            "task.status",
            {"task_id": task_id, "kind": kind, "status": "CREATED", "data": {}},
        )

    async def poll(self) -> None:
        async with self._lock:
            tasks = list(self._tasks.values())

        now = time.time()
        for tracked in tasks:
            try:
                snapshot = await asyncio.to_thread(tracked.snapshot_provider)
                if not isinstance(snapshot, dict):
                    snapshot = {"status": "error", "error": "Invalid realtime task snapshot"}
            except Exception as exc:
                logger.debug("Realtime task snapshot failed: %s", tracked.task_id, exc_info=True)
                snapshot = {"status": "error", "error": str(exc)}

            snapshot = _compact_task_snapshot(snapshot)
            status = _normalize_status(snapshot)
            payload = {
                "task_id": tracked.task_id,
                "kind": tracked.kind,
                "status": status,
                "data": snapshot,
            }
            signature = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)

            status_changed = status != tracked.last_status
            if status_changed:
                await self._hub.publish(task_topic(tracked.task_id), "task.status", payload)
                if status in {"FINISHED", "FAILED", "TERMINATED"}:
                    await self._hub.publish(task_topic(tracked.task_id), "task.result", payload)
                tracked.last_status = status
            if signature != tracked.last_signature and (
                status not in {"FINISHED", "FAILED", "TERMINATED"} or status_changed
            ):
                await self._hub.publish(task_topic(tracked.task_id), "task.progress", payload)
            tracked.last_signature = signature

            if status in {"FINISHED", "FAILED", "TERMINATED"}:
                tracked.terminal_at = tracked.terminal_at or now
            elif tracked.terminal_at is not None:
                tracked.terminal_at = None

        async with self._lock:
            for task_id, tracked in list(self._tasks.items()):
                if tracked.terminal_at and now - tracked.terminal_at > _TERMINAL_TASK_TTL:
                    self._tasks.pop(task_id, None)

    async def snapshot(self) -> list[dict[str, Any]]:
        async with self._lock:
            tasks = list(self._tasks.values())

        result: list[dict[str, Any]] = []
        for tracked in tasks:
            try:
                data = await asyncio.to_thread(tracked.snapshot_provider)
                if not isinstance(data, dict):
                    data = {"status": "error", "error": "Invalid realtime task snapshot"}
            except Exception as exc:
                data = {"status": "error", "error": str(exc)}
            data = _compact_task_snapshot(data)
            result.append({
                "task_id": tracked.task_id,
                "kind": tracked.kind,
                "status": _normalize_status(data),
                "data": data,
            })
        return result


realtime_hub = RealtimeHub()
realtime_tasks = RealtimeTaskRegistry(realtime_hub)
