"""Shared Tagger registries, locks and retention policy.

Source browsing and task execution use these same objects; neither owns a
second registry or acquires the source lock while holding the task lock.
"""
from __future__ import annotations

import threading
import time
from typing import Any


_IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif",
}

_SOURCE_TTL = 3600

_TASK_TTL = 3600

_TASK_KEEP_MAX = 8

_MAX_LOGS = 200

_MAX_RECENT_ITEMS = 120

_ACTIVE_TASK_STATUSES = frozenset({"created", "running", "cancelling"})

_sources: dict[str, dict[str, Any]] = {}

_sources_lock = threading.Lock()

_tasks: dict[str, dict[str, Any]] = {}

_tasks_lock = threading.Lock()

_direct_tagger: dict[str, Any] = {}

def _cleanup() -> None:
    now = time.time()
    with _tasks_lock:
        for task_id, task in list(_tasks.items()):
            if task.get("status") in {"done", "cancelled", "error"} and now - task.get("updated_at", now) > _TASK_TTL:
                _tasks.pop(task_id, None)
        terminal = sorted(
            ((task_id, task) for task_id, task in _tasks.items()
             if task.get("status") in {"done", "cancelled", "error"}),
            key=lambda entry: entry[1].get("updated_at", 0),
        )
        for task_id, _ in terminal[:-_TASK_KEEP_MAX]:
            _tasks.pop(task_id, None)
        retained_tokens = {token for task in _tasks.values() for token in (task["source_token"], task.get("overview_source_token"))}
    with _sources_lock:
        for token, source in list(_sources.items()):
            if token not in retained_tokens and now - source.get("created_at", now) > _SOURCE_TTL:
                _sources.pop(token, None)
