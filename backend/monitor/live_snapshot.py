"""Assemble monitor snapshots independently of HTTP and WebSocket routes."""
from __future__ import annotations

import asyncio
from pathlib import Path

from backend.monitor.artifacts import newest_previews, read_output_summary
from backend.monitor.dataset_diagnostics import has_dataset_diagnostics
from backend.monitor.log_files import find_run_log_path, read_log_slice
from backend.monitor.run_control import read_object, reported_progress
from backend.monitor.run_registry import find_run_record_by_task_id, read_run_config
from backend.monitor.training import extract_train_params, parse_log_progress, read_tensorboard_loss


STATE_LABELS = {
    "RUNNING": "Training / 训练中",
    "FINISHED": "Finished / 已完成",
    "TERMINATED": "Terminated / 已终止",
    "CREATED": "Pending / 等待启动",
}


def read_run_log_progress(run_path: Path, limit: int) -> dict:
    """Share normalized tail rows and progress between live and historical detail."""
    page = read_log_slice(find_run_log_path(run_path), limit=limit, tail=True)
    native = reported_progress(read_object(run_path / "log" / ".run-control" / "status.json"))
    return {"log_total": page["total"], "log_lines": page["lines"],
            **parse_log_progress(page["lines"], native)}


async def build_live_monitor_snapshot(
    *,
    tasks: list[dict],
    detail: bool = True,
    preview_limit: int = 36,
) -> dict:
    """Bootstrap live state; compact snapshots skip disk-heavy detail reads."""
    active_statuses = {"CREATED", "RUNNING"}
    active = next((item for item in reversed(tasks) if item.get("status") in active_statuses), None)
    active_task_id = active.get("id", "") if active else ""
    record = await asyncio.to_thread(find_run_record_by_task_id, active_task_id) if active_task_id else None
    run_path = Path(record["run_path"]) if record else None
    artifact_path = Path(record["artifact_path"]) if record else None

    # A restarted backend must not revive an unowned run from disk.
    tb_loss = await asyncio.to_thread(
        read_tensorboard_loss,
        downsample_to=500,
        run_dir=str(run_path),
    ) if detail and run_path else []
    result = {
        "gpu": None, "system": None, "tensorboard_loss": tb_loss, "detail": detail,
        "state": "IDLE", "state_label": "Idle / 空闲",
        "step": 0, "total_steps": 0, "percent": 0, "loss": None, "lr": None,
        "epoch": None, "eta": None, "speed": None, "has_error": False, "error_msg": None,
        "run_dir": record["run_dir"] if record else "",
        "gpu_processes": record.get("gpu_processes") if record else None,
        "output_dir": record["run_dir"] if record else "",
        "artifact_dir": record["artifact_dir"] if record else "",
        "artifact_available": bool(record and record["artifact_available"]),
        "artifact_external": bool(record and record["artifact_external"]),
        "preview_enabled": record["preview_enabled"] if record else None,
        "log_timestep_loss": (record.get("extra") or {}).get("log_timestep_loss") if record else None,
        "has_dataset_diagnostics": await asyncio.to_thread(has_dataset_diagnostics, run_path) if detail and run_path else False,
        "log_total": 0, "output_count": 0,
    }
    if not active:
        return result

    active_status = active.get("status", "UNKNOWN")
    result["active_task"] = active
    result["state"] = active_status
    result["state_label"] = STATE_LABELS.get(active_status, active_status)
    result["all_tasks"] = [task for task in tasks if task.get("status") in active_statuses]
    if not detail:
        return result

    if record and record["artifact_available"]:
        result["output_count"] = (await asyncio.to_thread(read_output_summary, str(artifact_path)))["count"]
    train_config = await asyncio.to_thread(read_run_config, run_path) if run_path else {}
    # Zero explicitly requests all compact metadata; image bytes load separately.
    effective_preview_limit = 0 if preview_limit == 0 else max(1, min(preview_limit, 300))
    result["previews"] = await asyncio.to_thread(
        newest_previews,
        str(artifact_path) if record and record["artifact_available"] else None,
        effective_preview_limit, False, record["run_dir"] if record else "",
    )
    result["training_profile"] = train_config.get("model_train_type") or ((record or {}).get("extra") or {}).get("profile_id", "")
    result["train_params"] = extract_train_params(train_config, result["training_profile"])
    if active_status == "RUNNING" and run_path:
        result.update(await asyncio.to_thread(read_run_log_progress, run_path, 500))
    return result
