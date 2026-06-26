"""
训练监控 API 路由

  GET  /api/monitor/status        — 聚合监控状态
  GET  /api/monitor/history        — 历史训练记录
  GET  /api/monitor/run-detail     — 指定训练的图表 + 日志 + 配置
  GET  /api/monitor/preview-image  — 预览图片代理
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Query, Request

from backend.monitor.hardware import gpu_info, system_info
from backend.monitor.training import (
    read_tensorboard_loss, parse_log_progress,
    latest_train_config, extract_train_params,
)
from backend.monitor.artifacts import (
    newest_previews, scan_history, read_train_log, _parse_toml_config,
    list_output_files, enrich_model_files_with_loss,
)
from backend.monitor.snapshot import find_run_dir_by_task_id
from backend.tasks import tm

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "output"

STATE_LABELS = {
    "RUNNING": "Training / 训练中",
    "FINISHED": "Finished / 已完成",
    "TERMINATED": "Terminated / 已终止",
    "CREATED": "Pending / 等待启动",
}


@router.get("/monitor/status")
async def monitor_status(task_id: str = Query("")):
    """聚合监控端点：GPU + CPU + 训练进度 + Loss 曲线 + 预览样本 + 训练参数"""
    gpu, system, tb_loss = await asyncio.gather(
        asyncio.to_thread(gpu_info),
        asyncio.to_thread(system_info),
        asyncio.to_thread(read_tensorboard_loss),
    )
    result = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "gpu": gpu,
        "system": system,
        "tensorboard_loss": tb_loss,
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

    train_config = await asyncio.to_thread(latest_train_config)
    result["train_params"] = extract_train_params(train_config)
    result["previews"] = await asyncio.to_thread(newest_previews, train_config.get("output_dir"))

    tasks = tm.dump()
    # 只返回运行中的任务，避免暴露所有已完成/已终止任务
    result["all_tasks"] = [t for t in tasks if t.get("status") == "RUNNING"]

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
        log_lines = await asyncio.to_thread(read_train_log, active.get("id", ""), Path(active_output_dir) if active_output_dir else None)
        if log_lines:
            progress = await asyncio.to_thread(parse_log_progress, log_lines)
            for key in ("step", "total_steps", "percent", "loss",
                         "lr", "epoch", "eta", "elapsed", "speed",
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

        # 尝试读取 result.json 获取完成状态
        try:
            output_dir_path = Path(train_config.get("output_dir", str(OUTPUT_DIR)))
            result_file = output_dir_path / "result.json"
            if result_file.exists():
                result["train_result"] = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception:
            pass

        log_lines = await asyncio.to_thread(read_train_log, active.get("id", ""))
        if log_lines:
            result["log_lines"] = log_lines[-300:]

    return {"status": "success", "data": result}


@router.get("/monitor/loss")
async def monitor_loss(run_dir: str = Query("")):
    data = await asyncio.to_thread(read_tensorboard_loss, run_dir=run_dir or None)
    return {"status": "success", "data": data}


@router.get("/monitor/previews")
async def monitor_previews(task_id: str = Query("")):
    train_config = await asyncio.to_thread(latest_train_config)
    data = await asyncio.to_thread(newest_previews, train_config.get("output_dir"))
    return {"status": "success", "data": data}


@router.get("/monitor/config")
async def monitor_config():
    train_config = await asyncio.to_thread(latest_train_config)
    data = await asyncio.to_thread(extract_train_params, train_config)
    return {"status": "success", "data": data}


@router.post("/monitor/stop")
async def monitor_stop():
    """停止当前正在运行的训练任务"""
    tasks = tm.dump()
    running_task_id = None
    for t in tasks:
        if t.get("status") == "RUNNING":
            running_task_id = t.get("id")
            break
    if not running_task_id:
        return {"status": "error", "message": "No running task found / 没有正在运行的任务"}
    try:
        tm.terminate_task(running_task_id)
        return {"status": "success", "message": "Task stopped / 任务已停止"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/monitor/history")
async def monitor_history():
    """训练记录：运行中任务 + 历史训练记录"""
    history = await asyncio.to_thread(scan_history)

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
        train_config = await asyncio.to_thread(latest_train_config)
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


@router.post("/monitor/history/delete")
async def delete_history_run(request: Request):
    """删除一条历史训练记录（删除其 run 目录）。

    请求体: {"run_dir": "output/my_lora_20260625-171200"}
    安全约束：run_dir 必须位于 output/ 之下，且必须包含 config.toml（确认为训练目录）。
    运行中的任务目录禁止删除。
    """
    import shutil

    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "Invalid request body"}
    run_dir = (body or {}).get("run_dir", "")
    if not run_dir:
        return {"status": "error", "message": "run_dir is required"}

    abs_run_dir = (REPO_ROOT / run_dir).resolve()
    try:
        abs_run_dir.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return {"status": "error", "message": "Invalid run_dir / 无效路径"}

    if not abs_run_dir.is_dir():
        return {"status": "error", "message": "Run directory not found / 目录不存在"}

    # 确认是训练目录（含 config.toml 或 task_meta.json）
    if not (abs_run_dir / "config.toml").exists() and not (abs_run_dir / "task_meta.json").exists():
        return {"status": "error", "message": "Not a training directory / 非训练目录"}

    # 禁止删除运行中任务的目录
    task_meta = abs_run_dir / "task_meta.json"
    if task_meta.exists():
        try:
            meta = json.loads(task_meta.read_text(encoding="utf-8"))
            tid = meta.get("task_id")
            if tid:
                tasks = tm.dump()
                if any(t.get("id") == tid and t.get("status") == "RUNNING" for t in tasks):
                    return {"status": "error", "message": "Cannot delete a running task / 无法删除运行中的任务"}
        except (OSError, json.JSONDecodeError):
            pass

    try:
        await asyncio.to_thread(shutil.rmtree, abs_run_dir)
    except OSError as e:
        return {"status": "error", "message": f"Failed to delete: {e}"}

    # 失效历史缓存
    from backend.monitor.artifacts import invalidate_history_cache
    invalidate_history_cache()
    return {"status": "success", "message": "Deleted / 已删除"}


@router.get("/monitor/run-detail")
async def monitor_run_detail(run_dir: str = Query("")):
    """获取指定历史训练的详情：Loss/LR 图表 + 日志 + 配置参数 + 预览样本。
    run_dir 为相对于项目根的路径（如 output/my_lora_20260527-143021）"""
    if not run_dir:
        return {"status": "error", "message": "run_dir is required"}

    abs_run_dir = (REPO_ROOT / run_dir).resolve()

    # 安全检查：必须在 output/ 下
    try:
        abs_run_dir.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return {"status": "error", "message": "Invalid run_dir / 无效路径"}

    if not abs_run_dir.is_dir():
        return {"status": "error", "message": "Run directory not found / 训练目录不存在"}

    result: dict = {"run_dir": run_dir}

    # ── 配置参数 ──
    config_file = abs_run_dir / "config.toml"
    if config_file.exists():
        try:
            params = _parse_toml_config(config_file)
            if params:
                result["config"] = params
                result["train_params"] = extract_train_params(params)
        except Exception:
            pass

    # ── TensorBoard Loss/LR 图表 ──
    result["tensorboard_loss"] = await asyncio.to_thread(read_tensorboard_loss, run_dir=str(abs_run_dir))

    # ── 预览样本（扁平结构：run_dir/sample/，兼容旧 outputs/sample/）──
    result["previews"] = await asyncio.to_thread(newest_previews, str(abs_run_dir))

    # ── 训练日志 ──
    # 先尝试通过 task_id 日志文件
    log_files = list(abs_run_dir.glob("train_*.log"))
    if log_files:
        latest_log = max(log_files, key=lambda p: p.stat().st_mtime)
        try:
            from backend.monitor.artifacts import _tail_file
            log_lines = _tail_file(latest_log)
            if log_lines:
                result["log_lines"] = log_lines[-300:]
                progress = parse_log_progress(log_lines)
                for key in ("step", "total_steps", "percent", "loss",
                             "lr", "epoch", "eta", "elapsed", "speed",
                             "has_error", "error_msg"):
                    if key in progress and progress[key] is not None:
                        result[key] = progress[key]
        except Exception:
            pass

    # ── result.json（训练结果）──
    result_file = abs_run_dir / "result.json"
    if result_file.exists():
        try:
            result["train_result"] = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    # ── run_info.txt ──
    info_file = abs_run_dir / "run_info.txt"
    if info_file.exists():
        try:
            result["run_info"] = info_file.read_text(encoding="utf-8")
        except Exception:
            pass

    return {"status": "success", "data": result}


@router.get("/monitor/preview-image")
async def monitor_preview_image(path: str = Query("")):
    """预览图片代理 — 仅允许 output/ 和 logs/ 目录下的文件"""
    import mimetypes
    import urllib.parse
    from fastapi.responses import FileResponse

    decoded = urllib.parse.unquote(path)
    p = (REPO_ROOT / decoded).resolve()

    # 使用 relative_to 做安全的路径约束检查（禁止路径遍历）
    try:
        p.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return {"status": "error", "message": "禁止访问"}

    if not p.is_file():
        return {"status": "error", "message": "文件不存在"}

    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mt)


@router.get("/monitor/is-active")
async def is_training_active():
    """Check if there is an active training task."""
    tasks = tm.dump()
    active = any(t['status'] == 'RUNNING' for t in tasks)
    active_task = next((t for t in tasks if t['status'] == 'RUNNING'), None)
    return {
        "status": "success",
        "data": {
            "active": active,
            "task_id": active_task['id'] if active_task else None
        }
    }


def _resolve_run_dir(run_dir: str, task_id: str) -> Path | None:
    """解析 run 目录：优先 run_dir，回退用 task_id 反查 task_meta.json 映射。

    返回绝对路径（若合法且存在），否则 None。
    """
    if run_dir:
        rd = Path(run_dir)
        if not rd.is_absolute():
            rd = (REPO_ROOT / run_dir).resolve()
        try:
            rd.relative_to(OUTPUT_DIR.resolve())
        except ValueError:
            return None
        return rd if rd.is_dir() else None
    # 回退：用 task_id 在 output/*/task_meta.json 中反查
    mapped = find_run_dir_by_task_id(task_id) if task_id else None
    if mapped:
        rd = Path(mapped)
        return rd if rd.is_dir() else None
    return None


@router.get("/monitor/outputs")
async def monitor_outputs(run_dir: str = Query(""), task_id: str = Query("")):
    """获取训练运行的输出文件列表。

    优先按 run_dir 解析（live 模式前端传 monitorData.output_dir，历史模式传 selectedRunDir）；
    若仅提供 task_id，则通过 task_meta.json 反查 run 目录。
    """
    rd = await asyncio.to_thread(_resolve_run_dir, run_dir, task_id)
    if not rd:
        return {"status": "error", "message": "Run directory not found / 运行目录不存在"}
    # 并发读取文件列表 + TensorBoard loss series，再合并给模型文件注入 ckpt_loss
    files, tb_series = await asyncio.gather(
        asyncio.to_thread(list_output_files, str(rd)),
        asyncio.to_thread(read_tensorboard_loss, run_dir=str(rd)),
    )
    enrich_model_files_with_loss(files, tb_series)
    return {"status": "success", "data": files}


@router.get("/monitor/outputs/download")
async def download_outputs(run_dir: str = Query(""), task_id: str = Query(""), files: str = Query("")):
    """下载输出文件（zip 格式）。files 为逗号分隔的相对路径列表，为空则下载全部。"""
    import tempfile
    import zipfile
    import urllib.parse
    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask

    rd = await asyncio.to_thread(_resolve_run_dir, run_dir, task_id)
    if not rd:
        return {"status": "error", "message": "Run directory not found / 运行目录不存在"}

    # 解析要下载的文件列表
    if files:
        file_list = [urllib.parse.unquote(f.strip()) for f in files.split(",") if f.strip()]
    else:
        # 下载全部（跳过隐藏目录）
        file_list = []
        for p in rd.rglob("*"):
            if p.is_file():
                parts = p.relative_to(rd).parts
                if any(part.startswith(".") or part.startswith("__") for part in parts):
                    continue
                file_list.append(str(p.relative_to(rd)).replace("\\", "/"))

    if not file_list:
        return {"status": "error", "message": "No files to download / 无可下载文件"}

    def _is_safe_path(path: Path, allowed_dir: Path) -> bool:
        return path.resolve().is_relative_to(allowed_dir.resolve())

    # 创建临时文件（不占用内存）
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    tmp_path = Path(tmp.name)

    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for rel_path in file_list:
                abs_path = (rd / rel_path).resolve()
                if not _is_safe_path(abs_path, rd):
                    continue
                if abs_path.is_file():
                    zf.write(abs_path, rel_path)
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        return {"status": "error", "message": f"Failed to create zip: {str(e)}"}

    zip_name = f"{rd.name}_outputs.zip"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=zip_name,
        background=BackgroundTask(lambda: tmp_path.unlink(missing_ok=True)),
    )


@router.get("/monitor/outputs/download-file")
async def download_single_output(path: str = Query("")):
    """下载单个输出文件（直接返回原始文件，无需打包 zip）。"""
    import mimetypes
    import urllib.parse
    from fastapi.responses import FileResponse

    if not path:
        return {"status": "error", "message": "path is required"}

    decoded = urllib.parse.unquote(path)
    p = (REPO_ROOT / decoded).resolve()
    # 安全约束：必须在 output/ 之下
    try:
        p.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return {"status": "error", "message": "Invalid path / 无效路径"}
    if not p.is_file():
        return {"status": "error", "message": "File not found / 文件不存在"}

    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mt, filename=p.name)


@router.get("/monitor/snapshot")
async def get_snapshot(task_id: str = Query("")):
    """Get training config snapshot for a task."""
    from backend.monitor.snapshot import get_config_snapshot
    
    if not task_id:
        return {"status": "error", "message": "task_id required"}
    
    snapshot = get_config_snapshot(task_id)
    if snapshot:
        return {"status": "success", "data": snapshot}
    else:
        return {"status": "error", "message": "Snapshot not found"}


@router.get("/monitor/config-from-run")
async def get_config_from_run(run_dir: str = Query("")):
    """Get training config content from a run directory."""
    if not run_dir:
        return {"status": "error", "message": "run_dir required"}
    
    abs_run_dir = (REPO_ROOT / run_dir).resolve()
    
    # Safety check: must be under output/
    try:
        abs_run_dir.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return {"status": "error", "message": "Invalid run_dir"}
    
    if not abs_run_dir.is_dir():
        return {"status": "error", "message": "Run directory not found"}
    
    config_file = abs_run_dir / "config.toml"
    if not config_file.exists():
        return {"status": "error", "message": "Config file not found"}
    
    try:
        content = config_file.read_text(encoding="utf-8")
        params = _parse_toml_config(config_file)
        return {
            "status": "success",
            "data": {
                "content": content,
                "params": params or {},
                "run_dir": run_dir
            }
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
