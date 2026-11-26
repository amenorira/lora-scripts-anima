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
_MAX_TOTAL_HISTORY_BYTES = 32 * 1024 * 1024
_MAX_TERMINAL_TOPICS = 128
_MAX_SUBSCRIBER_QUEUE = 64
_TERMINAL_TASK_TTL = 600.0
_TERMINAL_TASK_STATUSES = {"FINISHED", "FAILED", "TERMINATED", "STOPPED"}
_MAX_TASK_LOG_ITEMS = 100
_MAX_TASK_LOG_CHARS = 48 * 1024
_MAX_TASK_PAYLOAD_BYTES = 64 * 1024


def task_topic(task_id: str) -> str:
    """Return the canonical realtime topic for any long-running task."""
    return f"task:{task_id}"


def offer_realtime(queue: asyncio.Queue, event: dict) -> None:
    """Replace an overflowed batch with a resync marker and the newest event."""
    # Both queue operations run synchronously on the owning event loop.
    if queue.full():
        dropped_topics: set[str] = set()
        global_resync = False
        while not queue.empty():
            dropped = queue.get_nowait()
            if dropped.get("op") == "event":
                dropped_topic = dropped.get("topic")
                if dropped_topic:
                    dropped_topics.add(dropped_topic)
                else:
                    global_resync = True
            elif dropped.get("op") == "resync_required":
                affected = dropped.get("topics") or []
                if affected:
                    dropped_topics.update(affected)
                else:
                    global_resync = True
        if global_resync or dropped_topics:
            queue.put_nowait({"op": "resync_required", "topics": [] if global_resync else sorted(dropped_topics),
                              "reason": "slow_consumer", "server_instance_id": SERVER_INSTANCE_ID})
    queue.put_nowait(event)


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
                if isinstance(item, dict):
                    compacted.append(item)
                    continue
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
        # Trim oversized diagnostics to scalar task identity and progress fields.
        # Mark that part of the payload was omitted.
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

    Events are process-local. When ``SERVER_INSTANCE_ID`` changes, clients
    must request a fresh snapshot. All state changes run without suspension
    on the server's event loop.
    """

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._history: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
        self._history_bytes: dict[str, int] = defaultdict(int)
        self._next_seq: dict[str, int] = defaultdict(int)
        self._terminal_topics: dict[str, float] = {}
        self._sequence_floor = 0

    def _prune(self) -> None:
        """Live subscriptions keep their sequence."""
        now = time.time()
        removable = [(topic, ended) for topic, ended in self._terminal_topics.items()
                     if not self._subscribers.get(topic)]
        removable.sort(key=lambda item: item[1])
        overflow = max(0, len(removable) - _MAX_TERMINAL_TOPICS)
        for index, (topic, ended) in enumerate(removable):
            if index >= overflow and now - ended <= _TERMINAL_TASK_TTL:
                continue
            self._sequence_floor = max(self._sequence_floor, self._next_seq.pop(topic, 0))
            self._history.pop(topic, None)
            self._history_bytes.pop(topic, None)
            self._terminal_topics.pop(topic, None)

    async def prune(self) -> None:
        self._prune()

    async def publish(self, topic: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Publish one canonical event without ever blocking a producer."""
        emitted_at = time.time()
        self._next_seq[topic] = self._next_seq.get(topic, self._sequence_floor) + 1
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
            len(history) > (1 if topic == "hardware" else _MAX_HISTORY_EVENTS)
            or self._history_bytes[topic] > _MAX_HISTORY_BYTES
        ):
            self._history_bytes[topic] -= _json_size(history.popleft())

        if topic.startswith("task:") and event_type in {"task.status", "task.result"}:
            if payload.get("status") in _TERMINAL_TASK_STATUSES:
                self._terminal_topics.setdefault(topic, emitted_at)
                if len(self._terminal_topics) > _MAX_TERMINAL_TOPICS:
                    self._prune()
            else:
                self._terminal_topics.pop(topic, None)

        # Enforce capacity at its only growth point; the monitor owns TTL scans.
        total = sum(self._history_bytes.values())
        if total > _MAX_TOTAL_HISTORY_BYTES:
            for oldest_topic in sorted(self._history, key=lambda key: self._history[key][0]["emitted_at"] if self._history[key] else emitted_at):
                history = self._history[oldest_topic]
                while history and total > _MAX_TOTAL_HISTORY_BYTES:
                    size = _json_size(history.popleft())
                    self._history_bytes[oldest_topic] -= size
                    total -= size

        subscribers = list(self._subscribers.get(topic, ()))

        for queue in subscribers:
            offer_realtime(queue, event)
        return event

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

        history = self._history.get(topic, deque())
        latest_seq = self._next_seq.get(topic, 0)
        replay: list[dict[str, Any]] = []
        resync_required = bool(resume_seq and not latest_seq)

        if latest_seq:
            if resume_seq > latest_seq:
                resync_required = True
            elif topic == "hardware" and history:
                # Hardware is a latest-value stream; intermediate samples
                # are not needed to reconstruct the current display.
                replay = [history[-1]] if latest_seq > resume_seq else []
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
        subscribers = self._subscribers.get(topic)
        if not subscribers:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(topic, None)

    async def subscriber_count(self, topic: str) -> int:
        return len(self._subscribers.get(topic, ()))

    async def cursors(self) -> dict[str, int]:
        """Return the latest sequence for every topic in this process.

        Bootstrap captures these cursors before reading state. The browser
        uses them to replay events with later sequence numbers.
        """
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
    on_expire: Callable[[], None] | None = None
    last_status: str | None = None
    last_signature: str | None = None
    terminal_at: float | None = None
    terminal_payload: dict[str, Any] | None = None

    async def read_payload(self) -> dict[str, Any] | None:
        if self.terminal_payload is not None:
            return self.terminal_payload
        try:
            data = _compact_task_snapshot(await asyncio.to_thread(self.snapshot_provider))
        except Exception:
            logger.debug("Realtime task snapshot failed: %s", self.task_id, exc_info=True)
            return None
        return {
            "task_id": self.task_id,
            "kind": self.kind,
            "status": _normalize_status(data),
            "data": data,
        }


class RealtimeTaskRegistry:
    """Bridges existing in-memory long-job progress objects into realtime.

    Job implementations remain unchanged and do not need to know how clients
    are connected.  The monitor polls their already-existing in-memory status
    once per second and emits only changed snapshots.
    """

    def __init__(self, hub: RealtimeHub) -> None:
        self._hub = hub
        self._tasks: dict[str, _TrackedTask] = {}

    async def register(
        self,
        task_id: str,
        kind: str,
        snapshot_provider: Callable[[], dict[str, Any]],
        *,
        on_expire: Callable[[], None] | None = None,
    ) -> None:
        tracked = _TrackedTask(task_id, kind, snapshot_provider, on_expire)
        self._tasks[task_id] = tracked
        await self._hub.publish(
            task_topic(task_id),
            "task.status",
            {"task_id": task_id, "kind": kind, "status": "CREATED", "data": {}},
        )

    async def poll(self) -> None:
        tasks = list(self._tasks.values())

        now = time.time()
        for tracked in tasks:
            if tracked.terminal_at is not None:
                if now - tracked.terminal_at > _TERMINAL_TASK_TTL:
                    if self._tasks.get(tracked.task_id) is not tracked:
                        continue
                    del self._tasks[tracked.task_id]
                    if tracked.on_expire:
                        await asyncio.to_thread(tracked.on_expire)
                continue
            payload = await tracked.read_payload()
            if payload is None:
                continue
            status = payload["status"]
            topic = task_topic(tracked.task_id)
            if status in _TERMINAL_TASK_STATUSES:
                tracked.terminal_at = now
                tracked.terminal_payload = payload
                await self._hub.publish(topic, "task.status", payload)
                continue
            signature = json.dumps(payload["data"], ensure_ascii=False, sort_keys=True, default=str)
            if status != tracked.last_status:
                await self._hub.publish(topic, "task.status", payload)
            elif signature != tracked.last_signature:
                await self._hub.publish(topic, "task.progress", payload)
            tracked.last_status = status
            tracked.last_signature = signature

    async def snapshot(self) -> list[dict[str, Any]]:
        tasks = list(self._tasks.values())

        result: list[dict[str, Any]] = []
        for tracked in tasks:
            payload = await tracked.read_payload()
            if payload is not None:
                result.append(payload)
        return result


realtime_hub = RealtimeHub()
realtime_tasks = RealtimeTaskRegistry(realtime_hub)
