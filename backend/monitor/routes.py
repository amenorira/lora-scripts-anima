"""
训练监控 API 路由

  GET  /api/monitor/history        — 历史训练记录
  GET  /api/monitor/run-detail     — 指定训练的图表 + 日志 + 配置
  GET  /api/monitor/log-slice      — 完整训练日志分页读取
  GET  /api/monitor/log-download   — 下载完整训练日志
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, Query, Request

from backend.monitor.training import (
    read_tensorboard_loss, parse_log_progress,
    latest_train_config, extract_train_params,
)
from backend.monitor.artifacts import (
    newest_previews, scan_history, read_train_log, _parse_toml_config,
    list_output_files, enrich_model_files_with_loss, read_clean_log_lines,
    find_run_log_path, find_train_log_path, read_log_slice,
)
from backend.monitor.monitor import _PROGRESS_FIELDS
from backend.monitor.run_registry import (
    find_run_record_by_task_id,
    load_run_record,
    mark_run_deleted,
    resolve_artifact_file,
)
from backend.training.training_config import (
    TRAINING_CONFIG_NAME,
    TrainingConfigError,
    extract_training_form,
    load_training_config,
)
from backend.tasks import tm

router = APIRouter()

# run-detail 仅回传日志尾部行数（与前端 LOG.MAX_LINES 对齐）；完整日志经
# /monitor/log-slice 分页拉取，避免大日志全量回传撑爆响应。
_LOG_DETAIL_TAIL_LINES = 5000

STATE_LABELS = {
    "RUNNING": "Training / 训练中",
    "FINISHED": "Finished / 已完成",
    "TERMINATED": "Terminated / 已终止",
    "CREATED": "Pending / 等待启动",
}


def _read_train_result(run_dir_path: Path) -> dict | None:
    """读取 run 目录的 result.json；缺失或损坏时返回 None。"""
    result_file = run_dir_path / "result.json"
    if not result_file.exists():
        return None
    try:
        return json.loads(result_file.read_text(encoding="utf-8"))
    except Exception:
        return None


def _resolve_run_record(run_dir: str = "", task_id: str = "") -> dict | None:
    if run_dir:
        return load_run_record(run_dir)
    if task_id:
        return find_run_record_by_task_id(task_id)
    return None


def _resolve_monitor_log_path(run_dir: str = "", task_id: str = "") -> Path | None:
    """仅通过已登记的内部运行目录定位日志。"""
    record = _resolve_run_record(run_dir, task_id)
    if not record:
        return None
    run_path = Path(record["run_path"])
    if task_id:
        return find_train_log_path(task_id, run_path)
    return find_run_log_path(run_path)


async def build_live_monitor_snapshot(
    task_id: str = "",
    *,
    tasks: list[dict] | None = None,
    gpu: dict | None = None,
    system: dict | None = None,
    detail: bool = True,
    preview_limit: int = 36,
    curve_points: int = 500,
    log_tail_lines: int = 500,
) -> dict:
    """Build the live-monitor section of a realtime bootstrap snapshot.

    This is intentionally not an HTTP route. Live state is bootstrapped only
    through ``/api/realtime/snapshot`` and then updated by ``/ws/realtime``.
    A compact bootstrap skips disk-heavy curves/logs/preview metadata so the
    connection indicator is not held hostage by a slow remote link; the
    dashboard explicitly asks that same snapshot endpoint for ``detail``.
    """
    tasks = tm.dump() if tasks is None else tasks
    active = next((item for item in tasks if task_id and item.get("id") == task_id), None)
    if not active:
        active = next((item for item in reversed(tasks) if item.get("status") == "RUNNING"), None)
    if not active and tasks:
        active = tasks[-1]
    active_task_id = active.get("id", "") if active else ""
    record = await asyncio.to_thread(find_run_record_by_task_id, active_task_id) if active_task_id else None
    run_path = Path(record["run_path"]) if record else None
    artifact_path = Path(record["artifact_path"]) if record else None

    # Never revive a previous run's curves when this backend has no managed
    # live task.  After a restart, that would falsely make an untracked
    # process look like a task this server still owns.
    tb_loss = await asyncio.to_thread(
        read_tensorboard_loss,
        downsample_to=max(64, min(int(curve_points or 500), 2000)),
        run_dir=str(run_path),
    ) if detail and run_path else []
    result = {
        "gpu": gpu,
        "system": system,
        "tensorboard_loss": tb_loss,
        "detail": detail,
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
        "run_dir": record["run_dir"] if record else "",
        # output_dir is an internal run identifier, never an arbitrary local path.
        "output_dir": record["run_dir"] if record else "",
        "artifact_dir": record["artifact_dir"] if record else "",
        "artifact_available": bool(record and record["artifact_available"]),
        "artifact_external": bool(record and record["artifact_external"]),
        "preview_enabled": record["preview_enabled"] if record else None,
    }
    if not detail:
        if active:
            result["active_task"] = active
            active_status = active.get("status", "UNKNOWN")
            result["state"] = active_status
            result["state_label"] = STATE_LABELS.get(active_status, active_status)
        return result

    train_config = await asyncio.to_thread(latest_train_config, active_task_id or None)

    # 预览只读取当前记录登记的产物目录，磁盘离线时返回空并保留明确状态。
    # ``0`` 是完整列表的显式约定；详细仪表盘只传轻量元数据，缩略图仍由
    # 浏览器按需单独读取。正数调用方保留上限，以兼容需要小型快照的场景。
    effective_preview_limit = (
        0 if preview_limit == 0 else max(1, min(preview_limit, 300))
    )
    result["previews"] = await asyncio.to_thread(
        newest_previews,
        str(artifact_path) if record and record["artifact_available"] else None,
        effective_preview_limit,
        False,
        record["run_dir"] if record else "",
    )
    result["train_params"] = await asyncio.to_thread(
        _extract_train_params_for_run, run_path, train_config
    )
    result["all_tasks"] = [t for t in tasks if t.get("status") == "RUNNING"]

    if not tasks:
        return result

    result["active_task"] = active
    active_status = active.get("status", "UNKNOWN")
    result["state"] = active_status
    result["state_label"] = STATE_LABELS.get(active_status, active_status)

    # 从内部 run 目录读取日志 + 进度。
    def _read_run_log_and_progress(run_dir_path: Path) -> tuple[list[str], dict]:
        latest_log = find_run_log_path(run_dir_path)
        if not latest_log:
            return [], {}
        lines = read_train_log(active_task_id, run_dir_path)
        if not lines:
            return [], {}
        return lines[-log_tail_lines:], parse_log_progress(lines)

    if active_status == "RUNNING" and run_path:
        log_lines, progress = await asyncio.to_thread(_read_run_log_and_progress, run_path)
        if log_lines:
            for key in _PROGRESS_FIELDS:
                if key in progress and progress[key] is not None:
                    result[key] = progress[key]
            result["log_lines"] = log_lines

    if active_status != "RUNNING":
        if run_path:
            run_cfg = await asyncio.to_thread(_resolve_run_config_params, run_path)
            if run_cfg:
                result["last_config"] = run_cfg
            elif train_config:
                result["last_config"] = _last_config_from_autosave(train_config)
        elif train_config:
            result["last_config"] = _last_config_from_autosave(train_config)

        if run_path:
            train_result = _read_train_result(run_path)
            if train_result is not None:
                result["train_result"] = train_result
            log_lines, _ = await asyncio.to_thread(_read_run_log_and_progress, run_path)
            if log_lines:
                result["log_lines"] = log_lines

    return result


def _fmt_summary_lr(v) -> str:
    """格式化摘要中的学习率：小量值用科学计数法，其余去尾零。"""
    if v is None or v == "" or v == "?":
        return "?"
    try:
        n = float(v)
    except (TypeError, ValueError):
        return str(v)
    if 0 < abs(n) < 0.001:
        return f"{n:.2e}"
    return str(n)


def _last_config_from_autosave(train_config: dict) -> dict:
    """从 autosave TOML 提取上次训练摘要（回退路径）"""
    return {
        "name": train_config.get("output_name", ""),
        "model": Path(
            train_config.get("pretrained_model_name_or_path", "")
        ).name or "Unknown",
        "lr": _fmt_summary_lr(train_config.get("learning_rate", "?")),
        "dim": train_config.get("network_dim", "?"),
        "epochs": train_config.get("max_train_epochs", "?"),
    }


def _resolve_run_config_params(run_dir: Path) -> dict | None:
    """从 run_dir/config.toml 提取上次训练摘要（真实来源，优于 autosave）"""
    config_file = run_dir / "config.toml"
    if not config_file.exists():
        return None
    params = _parse_toml_config(config_file)
    if not params:
        return None
    model_path = params.get("pretrained_model_name_or_path", "")
    return {
        "name": params.get("output_name", run_dir.name),
        "model": Path(model_path).name if model_path else "Unknown",
        "lr": _fmt_summary_lr(params.get("learning_rate", "?")),
        "dim": params.get("network_dim", "?"),
        "epochs": params.get("max_train_epochs", "?"),
    }


def _extract_train_params_for_run(run_dir: Path | None, autosave_config: dict) -> list[dict]:
    """优先从 run_dir/config.toml 提取训练参数，回退到 autosave TOML"""
    if run_dir is not None:
        config_file = run_dir / "config.toml"
        if config_file.exists():
            params = _parse_toml_config(config_file)
            if params:
                return extract_train_params(params)
    return extract_train_params(autosave_config)


@router.get("/monitor/loss")
async def monitor_loss(run_dir: str = Query("")):
    record = await asyncio.to_thread(load_run_record, run_dir) if run_dir else None
    data = await asyncio.to_thread(
        read_tensorboard_loss,
        run_dir=str(record["run_path"]) if record else None,
    )
    return {"status": "success", "data": data}


@router.get("/monitor/previews")
async def monitor_previews(
    task_id: str = Query(""),
    run_dir: str = Query(""),
    refresh: int = Query(0),
    # 0 means the complete metadata list. Media bytes are never included here.
    limit: int = Query(0, ge=0),
):
    record = await asyncio.to_thread(_resolve_live_record, task_id, run_dir)
    output_dir = str(record["artifact_path"]) if record and record["artifact_available"] else None
    data = await asyncio.to_thread(
        newest_previews,
        output_dir,
        limit,
        bool(refresh),
        record["run_dir"] if record else "",
    )
    return {
        "status": "success",
        "data": data,
        "meta": {
            "artifact_dir": record["artifact_dir"] if record else "",
            "artifact_available": bool(record and record["artifact_available"]),
            "preview_enabled": record["preview_enabled"] if record else None,
        },
    }


@router.get("/monitor/config")
async def monitor_config():
    train_config = await asyncio.to_thread(latest_train_config)
    data = await asyncio.to_thread(extract_train_params, train_config)
    return {"status": "success", "data": data}


def _resolve_live_record(task_id: str = "", run_dir: str = "") -> dict | None:
    """通过内部 run_dir 或活动 task_id 定位运行记录。"""
    if run_dir:
        return load_run_record(run_dir)
    tid = task_id or ""
    if not tid:
        tasks = tm.dump()
        for t in reversed(tasks):
            if t.get("status") == "RUNNING":
                tid = t.get("id", "")
                break
    return find_run_record_by_task_id(tid) if tid else None


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
        record = await asyncio.to_thread(find_run_record_by_task_id, running.get("id", ""))
        running["name"] = train_config.get("output_name", "")
        running["model"] = train_config.get("pretrained_model_name_or_path", "")
        running["lr"] = train_config.get("learning_rate", "?")
        running["dim"] = train_config.get("network_dim", "?")
        running["epochs"] = train_config.get("max_train_epochs", "?")
        running["run_dir"] = record["run_dir"] if record else ""
        running["artifact_dir"] = record["artifact_dir"] if record else train_config.get("output_dir", "")
        running["artifact_available"] = bool(record and record["artifact_available"])
        running["artifact_external"] = bool(record and record["artifact_external"])
        running["preview_enabled"] = record["preview_enabled"] if record else None
        running["dataset"] = train_config.get("train_data_dir", "")
    elif running and running.get("status") != "RUNNING":
        running = None  # 已完成/终止的任务不算运行中

    return {"status": "success", "data": {"running": running, "history": history}}


@router.post("/monitor/history/delete")
async def delete_history_run(request: Request):
    """删除内部历史/日志，始终保留模型、断点和 sample/。"""
    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "Invalid request body"}
    run_dir = (body or {}).get("run_dir", "")
    if not run_dir:
        return {"status": "error", "message": "run_dir is required"}

    record = await asyncio.to_thread(load_run_record, run_dir, include_deleted=True)
    if not record:
        return {"status": "error", "message": "Run directory not found / 目录不存在"}
    tid = record.get("task_id")
    if tid and any(t.get("id") == tid and t.get("status") == "RUNNING" for t in tm.dump()):
        return {"status": "error", "message": "Cannot delete a running task / 无法删除运行中的任务"}
    if not await asyncio.to_thread(mark_run_deleted, run_dir):
        return {"status": "error", "message": "Failed to delete history / 删除历史失败"}

    # 失效历史缓存
    from backend.monitor.artifacts import invalidate_history_cache
    invalidate_history_cache()
    return {
        "status": "success",
        "message": "History deleted; artifacts preserved / 历史已删除，模型产物已保留",
        "data": {"artifact_dir": record["artifact_dir"], "artifacts_preserved": True},
    }


@router.get("/monitor/run-detail")
async def monitor_run_detail(run_dir: str = Query("")):
    """获取指定历史训练的详情：Loss/LR 图表 + 日志 + 配置参数 + 预览样本。
    run_dir 为相对于项目根的路径（如 output/my_lora_20260527-143021）"""
    if not run_dir:
        return {"status": "error", "message": "run_dir is required"}

    record = await asyncio.to_thread(load_run_record, run_dir)
    if not record:
        return {"status": "error", "message": "Run directory not found / 训练目录不存在"}
    abs_run_dir = Path(record["run_path"])
    artifact_dir = Path(record["artifact_path"])

    result: dict = {
        "run_dir": record["run_dir"],
        "artifact_dir": record["artifact_dir"],
        "artifact_available": record["artifact_available"],
        "artifact_external": record["artifact_external"],
        "preview_enabled": record["preview_enabled"],
        "imported": record["imported"],
    }

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
    result["previews"] = await asyncio.to_thread(
        newest_previews,
        str(artifact_dir) if record["artifact_available"] else None,
        0,
        False,
        record["run_dir"],
    )

    # ── 输出文件计数（轻量目录扫描；让前端 tab 徽标与日志/样本计数一样
    #    首屏即有，避免懒加载完成后按钮宽度变化引起指示条错位）──
    if record["artifact_available"]:
        result["output_count"] = len(await asyncio.to_thread(list_output_files, str(artifact_dir)))

    # ── 训练日志 ──
    # 历史记录：用全文解析进度（total_steps/percent 等常出现在早期行），
    # 但只回传尾部 _LOG_DETAIL_TAIL_LINES 行；完整日志由前端「完整日志」模式
    # 经 /monitor/log-slice 分页拉取，避免大日志全量回传。
    def _read_log_and_progress(run_dir_path: Path) -> tuple[list[str] | None, dict]:
        latest_log = find_run_log_path(run_dir_path)
        if latest_log:
            try:
                log_lines = read_clean_log_lines(latest_log)
                if log_lines:
                    progress = parse_log_progress(log_lines)
                    return log_lines, progress
            except Exception:
                pass
        return None, {}

    log_lines, progress = await asyncio.to_thread(_read_log_and_progress, abs_run_dir)
    if log_lines:
        result["log_total"] = len(log_lines)
        result["log_lines"] = log_lines[-_LOG_DETAIL_TAIL_LINES:]
        for key in _PROGRESS_FIELDS:
            if key in progress and progress[key] is not None:
                result[key] = progress[key]

    # ── result.json（训练结果）──
    def _read_meta_files(run_dir_path: Path) -> tuple[dict | None, str | None]:
        train_result = _read_train_result(run_dir_path)
        run_info = None
        info_file = run_dir_path / "run_info.txt"
        if info_file.exists():
            try:
                run_info = info_file.read_text(encoding="utf-8")
            except Exception:
                pass
        return train_result, run_info

    train_result, run_info = await asyncio.to_thread(_read_meta_files, abs_run_dir)
    if train_result is not None:
        result["train_result"] = train_result
    if run_info is not None:
        result["run_info"] = run_info

    return {"status": "success", "data": result}


@router.get("/monitor/log-slice")
async def monitor_log_slice(
    run_dir: str = Query(""),
    task_id: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(1000, ge=1, le=2000),
    q: str = Query(""),
    tail: bool = Query(False),
):
    """完整日志分页 / 搜索（前端「完整日志」模式用）。

    run_dir（历史训练目录，相对路径）或 task_id（实时任务）二选一定位日志文件。
    返回磁盘日志的指定行区间 + 可选全文件搜索匹配行号，使前端可在不把整文件
    载入 DOM 的前提下浏览/搜索任意位置。文件为训练期间的快照，前端按需手动刷新。
    tail=True 时定位到文件末尾（实时任务首次进入、未知 total 时用）。
    """
    if not run_dir and not task_id:
        return {"status": "error", "message": "run_dir or task_id is required"}

    log_path = _resolve_monitor_log_path(run_dir, task_id)
    if not log_path:
        return {"status": "error", "message": "Log file not found / 日志文件未找到"}

    data = await asyncio.to_thread(read_log_slice, log_path, offset, limit, q, tail)
    return {"status": "success", "data": data}


@router.get("/monitor/log-download")
async def monitor_log_download(run_dir: str = Query(""), task_id: str = Query("")):
    """下载完整训练日志（实时任务或历史 run 均可）。"""
    from fastapi.responses import FileResponse

    if not run_dir and not task_id:
        return {"status": "error", "message": "run_dir or task_id is required"}

    log_path = await asyncio.to_thread(_resolve_monitor_log_path, run_dir, task_id)
    if not log_path or not log_path.is_file():
        return {"status": "error", "message": "Log file not found / 日志文件未找到"}

    return FileResponse(
        log_path,
        media_type="text/plain",
        filename=log_path.name,
    )


@router.get("/monitor/preview-metadata")
async def monitor_preview_metadata(
    run_dir: str = Query(""),
    path: str = Query(""),
    request: Request = None,
):
    """Read display-safe PNG text/EXIF metadata without loading the original image."""
    import hashlib
    import urllib.parse
    from fastapi.responses import JSONResponse, Response

    if not run_dir or not path:
        return {"status": "error", "message": "run_dir and path are required"}
    decoded = urllib.parse.unquote(path)
    p = await asyncio.to_thread(resolve_artifact_file, run_dir, decoded)
    if not p or not p.is_file():
        return {"status": "error", "message": "File not found / 文件不存在"}
    stat = p.stat()
    etag = hashlib.sha1(
        f"{p}|{stat.st_mtime_ns}|{stat.st_size}|metadata".encode("utf-8", errors="ignore")
    ).hexdigest()
    headers = {
        "Cache-Control": "private, max-age=86400, immutable",
        "ETag": f'"{etag}"',
    }
    if request and request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)

    def _read_metadata() -> dict:
        from PIL import Image

        with Image.open(p) as image:
            png_text: dict[str, str] = {}
            for key, value in image.info.items():
                if key in {"icc_profile", "exif", "gamma", "dpi"}:
                    continue
                if isinstance(value, (str, int, float, bool)):
                    text = str(value)
                    png_text[str(key)] = text[:8192]
            exif: dict[str, str] = {}
            try:
                for key, value in image.getexif().items():
                    exif[str(key)] = str(value)[:8192]
            except Exception:
                pass
            return {
                "format": image.format,
                "width": image.width,
                "height": image.height,
                "mode": image.mode,
                "png_text": png_text,
                "exif": exif,
            }

    try:
        data = await asyncio.to_thread(_read_metadata)
    except Exception as exc:
        return {"status": "error", "message": f"Metadata read failed: {exc}"}
    return JSONResponse({"status": "success", "data": data}, headers=headers)


@router.get("/monitor/outputs")
async def monitor_outputs(run_dir: str = Query(""), task_id: str = Query("")):
    """获取训练运行的输出文件列表。

    优先按 run_dir 解析（live 模式前端传 monitorData.output_dir，历史模式传 selectedRunDir）；
    若仅提供 task_id，则通过 task_meta.json 反查 run 目录。
    """
    record = await asyncio.to_thread(_resolve_run_record, run_dir, task_id)
    if not record:
        return {"status": "error", "message": "Run directory not found / 运行目录不存在"}
    if not record["artifact_available"]:
        return {
            "status": "error",
            "message": "Artifact directory unavailable / 产物目录不可用",
            "data": {"artifact_dir": record["artifact_dir"], "artifact_available": False},
        }
    artifact_dir = Path(record["artifact_path"])
    internal_dir = Path(record["run_path"])
    # 并发读取文件列表 + TensorBoard loss series，再合并给模型文件注入 ckpt_loss
    files, tb_series = await asyncio.gather(
        asyncio.to_thread(list_output_files, str(artifact_dir)),
        asyncio.to_thread(read_tensorboard_loss, run_dir=str(internal_dir)),
    )
    enrich_model_files_with_loss(files, tb_series, str(internal_dir))
    return {
        "status": "success",
        "data": files,
        "meta": {
            "artifact_dir": record["artifact_dir"],
            "artifact_available": True,
        },
    }


@router.get("/monitor/outputs/download")
async def download_outputs(run_dir: str = Query(""), task_id: str = Query(""), files: str = Query("")):
    """下载输出文件（zip 格式，流式传输）。files 为逗号分隔的相对路径列表，为空则下载全部。"""
    import tempfile
    import zipfile
    import urllib.parse
    record = await asyncio.to_thread(_resolve_run_record, run_dir, task_id)
    if not record:
        return {"status": "error", "message": "Run directory not found / 运行目录不存在"}
    if not record["artifact_available"]:
        return {"status": "error", "message": "Artifact directory unavailable / 产物目录不可用"}
    rd = Path(record["artifact_path"])

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

    zip_name = f"{rd.name}_outputs.zip"

    # 打包 ZIP 到临时文件（在独立线程池中，不阻塞事件循环）
    # 使用 ZIP_STORED（不压缩）：模型文件已高度优化，DEFLATE 几乎无效且耗时
    def _build_zip(run_dir_path: Path, paths: list[str]) -> Path:
        tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        tmp.close()
        dst = Path(tmp.name)
        try:
            with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
                for rel in paths:
                    abs_path = (run_dir_path / rel).resolve()
                    if not abs_path.resolve().is_relative_to(run_dir_path.resolve()):
                        continue
                    if abs_path.is_file():
                        zf.write(abs_path, rel)
        except Exception:
            dst.unlink(missing_ok=True)
            raise
        return dst

    try:
        tmp_path = await asyncio.to_thread(_build_zip, rd, file_list)
    except Exception as e:
        return {"status": "error", "message": f"Failed to create zip: {str(e)}"}

    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=zip_name,
        background=BackgroundTask(lambda p=tmp_path: p.unlink(missing_ok=True)),
    )


@router.get("/monitor/outputs/download-file")
async def download_single_output(run_dir: str = Query(""), path: str = Query("")):
    """下载单个输出文件（直接返回原始文件，无需打包 zip）。"""
    import mimetypes
    import urllib.parse
    from fastapi.responses import FileResponse

    if not run_dir or not path:
        return {"status": "error", "message": "run_dir and path are required"}

    decoded = urllib.parse.unquote(path)
    p = await asyncio.to_thread(resolve_artifact_file, run_dir, decoded)
    if not p:
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
    
    record = await asyncio.to_thread(load_run_record, run_dir)
    if not record:
        return {"status": "error", "message": "Run directory not found"}
    abs_run_dir = Path(record["run_path"])
    
    config_file = abs_run_dir / "config.toml"
    if not config_file.exists():
        return {"status": "error", "message": "Config file not found"}
    
    try:
        training_file = abs_run_dir / TRAINING_CONFIG_NAME
        config_format = "toml"
        schema_version = None
        yaml_warning = None
        if training_file.exists():
            try:
                document = await asyncio.to_thread(load_training_config, training_file)
                content = training_file.read_text(encoding="utf-8")
                params = extract_training_form(document)
                config_format = "yaml"
                schema_version = document["schema_version"]
            except TrainingConfigError as exc:
                yaml_warning = str(exc)
                content = config_file.read_text(encoding="utf-8")
                params = _parse_toml_config(config_file)
        else:
            content = config_file.read_text(encoding="utf-8")
            params = _parse_toml_config(config_file)
        reusable_params = dict(params or {})
        # 非续训复用时恢复用户填写的输出根目录，避免继续嵌套上次时间戳目录。
        if not reusable_params.get("resume") and (
            config_format == "toml" or not reusable_params.get("output_dir")
        ):
            reusable_params["output_dir"] = record["output_base_dir"]
        return {
            "status": "success",
            "data": {
                "content": content,
                "params": reusable_params,
                "config_format": config_format,
                "schema_version": schema_version,
                "config_warning": yaml_warning,
                "run_dir": record["run_dir"],
                "artifact_dir": record["artifact_dir"],
                "artifact_available": record["artifact_available"],
                "artifact_external": record["artifact_external"],
                "preview_enabled": record["preview_enabled"],
            }
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
