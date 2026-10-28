"""Tagger task results, snapshots, cancellation and resource release."""
from __future__ import annotations

import time
from pathlib import Path

from backend.tasks import tm
from backend.tagger.workspace_state import (
    _ACTIVE_TASK_STATUSES, _sources, _sources_lock, _tasks, _tasks_lock,
)


def _task_log(task: dict, event: str, level: str = "info", **data) -> None:
    with task["lock"]:
        task["logs"].append({"time": time.strftime("%H:%M:%S"), "event": event, "level": level, **data})
        task["updated_at"] = time.time()

def _record_task_item(task: dict, index: int, outcome: dict) -> None:
    with task["lock"]:
        status = outcome["status"]
        task[status] += 1
        task["current"] += 1
        item = task["items"][index]
        item.update({key: outcome[key] for key in ("status", "tag_count", "error", "event", "planned_action") if key in outcome})
        task["current_file"] = item["name"]
        if "result" in outcome:
            task["current_result"] = task["results"][index] = outcome["result"]
        event = outcome.get("event") or ("written" if status == "success" and task["write_captions"] else status)
        if event in {"caption_written", "reused", "written"}:
            task["written"] += 1
        if event == "reused":
            task["reused"] += 1
        action = outcome.get("planned_action")
        if action:
            task["plan"][{"request": "requests", "reuse": "reused", "skip": "skipped"}[action]] += 1
            task["plan"]["writes"] += action != "skip"
        if outcome.get("prompt") and not task.get("check_prompt"):
            task["check_prompt"] = outcome["prompt"]
            task["check_prompt_image"] = item["path"]
        _task_log(task, event, {"skipped": "warning", "failed": "error"}.get(status, "info"),
                  current=task["current"], total=task["total"], name=item["name"],
                  count=outcome.get("tag_count", 0), error=outcome.get("error", ""),
                  reference=outcome.get("reference", False), knowledge=outcome.get("knowledge", 0))
    # Do not take annotation locks while holding the task lock: overview reads
    # acquire them in the opposite order. External edits are rechecked within 5s.
    path = Path(item["path"])
    with _sources_lock:
        sources = list(_sources.values())
    for source in sources:
        if path.is_relative_to(Path(source["root"])):
            with source["annotation_lock"]:
                source["annotation_cache"].pop(str(path), None)

def _finish_task(task: dict, status: str, error: str = "") -> None:
    for key, release in (("resource_claim", tm.release_external), ("dataset_claim", tm.release_dataset_reader)):
        if task.get(key):
            release(task[key])
    with task["lock"]:
        if status in {"cancelled", "error"}:
            for item in task["items"]:
                if item["status"] in {"pending", "running"}:
                    item.update(status="cancelled", event="cancelled")
        task.update(status=status, phase={"done": "completed", "cancelled": "cancelled", "error": "error"}[status],
                    error_detail=error or None)
        level = ("error" if status == "error" or task["failed"] == task["total"] else
                 "warning" if task["failed"] or status == "cancelled" else "success")
        _task_log(task, status, level, elapsed=f"{max(0.0, time.time() - task['started_at']):.1f}",
                  success=task["success"], skipped=task["skipped"], failed=task["failed"],
                  checked=task["checked"], written=task["written"], reused=task["reused"], error=error)

def _task_snapshot_unlocked(task: dict) -> dict:
    elapsed = max(0.0, time.time() - task["started_at"]) if task.get("started_at") else 0.0
    current = task["current"]
    speed = current / elapsed if elapsed > 0 else 0.0
    remaining = max(0, task["total"] - current)
    return {
        "status": task["status"],
        "phase": task["phase"],
        "current": current,
        "total": task["total"],
        "current_file": task.get("current_file", ""),
        "success": task["success"],
        "skipped": task["skipped"],
        "failed": task["failed"],
        "written": task["written"],
        "reused": task["reused"],
        "checked": task["checked"],
        "plan": task["plan"],
        "has_check_prompt": bool(task.get("check_prompt")),
        "speed": round(speed, 2),
        "eta_seconds": round(remaining / speed) if speed > 0 else None,
        "source_token": task["source_token"],
        "source_kind": task["source_kind"],
        "source_root": task["source_root"],
        "overview_source_token": task.get("overview_source_token", task["source_token"]),
        "model_id": task["model_id"],
        "engine": task.get("engine", "onnx"),
        "caption_options": (task.get("options") or {}).get("captioning"),
        "logs": list(task["logs"]),
        "error_detail": task.get("error_detail"),
        **({"current_result": task.get("current_result")} if task["engine"] != "api" else {}),
        "updated_at": task["updated_at"],
    }

def task_snapshot(task_id: str) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return {"status": "error", "error_detail": "Task not found / 任务不存在", "logs": []}
    with task["lock"]:
        return _task_snapshot_unlocked(task)

def task_items(task_id: str, offset: int = 0, limit: int = 120, failed_only: bool = False) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        raise KeyError("Task not found / 任务不存在")
    with task["lock"]:
        items = task["items"]
        start = max(0, offset)
        page_size = max(1, min(limit, 500))
        if failed_only:
            indexed = [(idx, item) for idx, item in enumerate(items) if item.get("status") == "failed"]
            total = len(indexed)
            page = indexed[start:start + page_size]
        else:
            total = len(items)
            page = enumerate(items[start:start + page_size], start=start)
        return {
            "total": total,
            "offset": start,
            "items": [
                dict(item, index=index, **({"result": task["results"].get(index)} if task["engine"] != "api" else {}))
                for index, item in page
            ],
        }

def task_check_prompt(task_id: str) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        raise KeyError("Task not found / 任务不存在")
    with task["lock"]:
        return {"prompt": task.get("check_prompt", ""), "path": task.get("check_prompt_image", "")}

def cancel_task(task_id: str) -> bool:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return False
    with task["lock"]:
        if task["status"] in {"created", "running"}:
            task["status"] = "cancelling"
            task["phase"] = "cancelling"
            task["updated_at"] = time.time()
        task["cancel_event"].set()
    return True

def latest_active_task_id() -> str | None:
    with _tasks_lock:
        active = [task for task in _tasks.values() if task["status"] in _ACTIVE_TASK_STATUSES]
    if not active:
        return None
    return max(active, key=lambda task: task["updated_at"])["id"]
