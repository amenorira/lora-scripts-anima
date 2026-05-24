"""
训练监控 API 路由

  GET  /api/monitor/status        — 聚合监控状态
  GET  /api/monitor/history        — 历史训练记录
  GET  /api/monitor/preview-image  — 预览图片代理
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Query

from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import (
    read_tensorboard_loss, parse_log_progress,
    latest_train_config, extract_train_params,
)
from backend.monitor.artifacts import newest_previews, scan_history, read_train_log
from backend.tasks import tm

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "output"
LOG_DIR = REPO_ROOT / "logs"

STATE_LABELS = {
    "RUNNING": "Training / 训练中",
    "FINISHED": "Finished / 已完成",
    "TERMINATED": "Terminated / 已终止",
    "CREATED": "Pending / 等待启动",
}


@router.get("/monitor/status")
async def monitor_status(task_id: str = Query("")):
    """聚合监控端点：GPU + CPU + 训练进度 + Loss 曲线 + 预览样本 + 训练参数"""
    result = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "gpu": gpu_info(),
        "system": system_info(),
        "tensorboard_loss": read_tensorboard_loss(),
        "state": "IDLE",
        "state_label": "Idle / 空闲",
        "step": 0,
        "total_steps": 0,
        "percent": 0,
        "loss": None,
        "lr": None,
        "epoch": None,
        "eta": None,
        "speed": None,
        "has_error": False,
        "error_msg": None,
    }

    train_config = latest_train_config()
    result["train_params"] = extract_train_params(train_config)
    result["previews"] = newest_previews(train_config.get("output_dir"))

    tasks = tm.dump()
    result["all_tasks"] = tasks

    if not tasks:
        return {"status": "success", "data": result}

    active = None
    for t in reversed(tasks):
        if t.get("status") == "RUNNING":
            active = t
            break
    if not active:
        active = tasks[-1]

    result["active_task"] = active
    active_status = active.get("status", "UNKNOWN")
    result["state"] = active_status
    result["state_label"] = STATE_LABELS.get(active_status, active_status)

    if active_status == "RUNNING":
        # 从运行文件夹读取日志
        active_output_dir = train_config.get("output_dir", str(OUTPUT_DIR))
        log_lines = read_train_log(active.get("id", ""), Path(active_output_dir) if active_output_dir else None)
        if log_lines:
            progress = parse_log_progress(log_lines)
            for key in ("step", "total_steps", "percent", "loss",
                         "lr", "epoch", "eta", "speed",
                         "has_error", "error_msg"):
                if key in progress and progress[key] is not None:
                    result[key] = progress[key]
            result["log_lines"] = log_lines[-300:]

    if train_config.get("output_dir"):
        result["output_dir"] = train_config["output_dir"]
    else:
        result["output_dir"] = str(OUTPUT_DIR)

    if active_status != "RUNNING" and train_config:
        result["last_config"] = {
            "name": train_config.get("output_name", ""),
            "model": Path(
                train_config.get("pretrained_model_name_or_path", "")
            ).name or "Unknown",
            "lr": train_config.get("learning_rate", "?"),
            "dim": train_config.get("network_dim", "?"),
            "epochs": train_config.get("max_train_epochs", "?"),
        }
        log_lines = read_train_log(active.get("id", ""))
        if log_lines:
            result["log_lines"] = log_lines[-300:]

    return {"status": "success", "data": result}


@router.get("/monitor/history")
async def monitor_history():
    """训练记录：运行中任务 + 历史训练记录"""
    history = scan_history()

    # 获取当前运行中任务
    running = None
    tasks = tm.dump()
    for t in reversed(tasks):
        if t.get("status") == "RUNNING":
            running = t
            break
    if not running and tasks:
        running = tasks[-1]

    # 如果运行中任务状态为 RUNNING，补充训练参数
    if running and running.get("status") == "RUNNING":
        train_config = latest_train_config()
        params = extract_train_params(train_config)
        running["name"] = train_config.get("output_name", "")
        running["model"] = train_config.get("pretrained_model_name_or_path", "")
        running["lr"] = train_config.get("learning_rate", "?")
        running["dim"] = train_config.get("network_dim", "?")
        running["epochs"] = train_config.get("max_train_epochs", "?")
        running["run_dir"] = train_config.get("output_dir", "")
        running["dataset"] = train_config.get("train_data_dir", "")
    elif running and running.get("status") != "RUNNING":
        running = None  # 已完成/终止的任务不算运行中

    return {"status": "success", "data": {"running": running, "history": history}}


@router.get("/monitor/preview-image")
async def monitor_preview_image(path: str = Query("")):
    """预览图片代理"""
    import mimetypes
    import urllib.parse
    from fastapi.responses import FileResponse

    decoded = urllib.parse.unquote(path)
    p = (REPO_ROOT / decoded).resolve()

    allowed = [OUTPUT_DIR.resolve(), LOG_DIR.resolve()]
    if not any(p == root or root in p.parents for root in allowed):
        return {"status": "error", "message": "禁止访问"}

    if not p.is_file():
        return {"status": "error", "message": "文件不存在"}

    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mt)
