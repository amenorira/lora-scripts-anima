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
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from backend.monitor.run_control import ControlRequest, saved_training_state

from backend.monitor.training import (
    read_tensorboard_loss,
    extract_train_params,
)
from backend.monitor.artifacts import (
    newest_previews, list_output_files, read_output_summary,
)
from backend.monitor.checkpoints import enrich_model_files_with_loss
from backend.monitor.dataset_diagnostics import (
    analyze_dataset_diagnostics,
    has_dataset_diagnostics,
    read_dataset_diagnostic_image,
)
from backend.training.checkpoint_state import is_distributed_state_member
from backend.monitor.history import scan_history
from backend.monitor.log_files import find_run_log_path, find_train_log_path, read_log_slice
from backend.monitor.live_snapshot import read_run_log_progress
from backend.monitor.run_registry import (
    read_run_config,
    find_run_record_by_task_id,
    load_run_record,
    mark_run_deleted,
    RunDeletionError,
    normalize_run_status,
    resolve_artifact_file,
    reusable_prompt_file,
)
from backend.training.config.training_config import (
    TRAINING_CONFIG_NAME,
    TrainingConfigError,
    extract_training_form,
    load_training_config,
)
from backend.tasks import tm
from backend.training.config.config_import import infer_training_profile, import_native_training_form

router = APIRouter()

# run-detail 仅回传日志尾部行数（与前端 LOG.MAX_LINES 对齐）；完整日志经
# /monitor/log-slice 分页拉取，避免大日志全量回传撑爆响应。
_LOG_DETAIL_TAIL_LINES = 5000


def _read_train_result(run_dir_path: Path, *, allow_mtime_fallback: bool = True) -> dict | None:
    """读取 run 目录的 result.json；缺失或损坏时返回 None。"""
    result_file = run_dir_path / "result.json"
    if not result_file.exists():
        return None
    try:
        result = json.loads(result_file.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            return None
        if (
            allow_mtime_fallback
            and not result.get("ended_at")
            and normalize_run_status(result.get("status")) != "unknown"
        ):
            result["ended_at"] = datetime.fromtimestamp(
                result_file.stat().st_mtime, timezone.utc
            ).isoformat(timespec="seconds")
        return result
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


@router.get("/monitor/loss")
async def monitor_loss(run_dir: str = Query("")):
    record = await asyncio.to_thread(load_run_record, run_dir) if run_dir else None
    if run_dir and record is None:
        return {"status": "success", "data": []}
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


def _resolve_live_record(task_id: str = "", run_dir: str = "") -> dict | None:
    """通过内部 run_dir 或活动 task_id 定位运行记录。"""
    if run_dir:
        return load_run_record(run_dir)
    tid = task_id or ""
    if not tid:
        tasks = tm.training_dump()
        for t in reversed(tasks):
            if t.get("status") == "RUNNING":
                tid = t.get("id", "")
                break
    return find_run_record_by_task_id(tid) if tid else None


@router.get("/monitor/control/{task_id}")
async def training_control_state(task_id: str, prompts: bool = False):
    task = tm.get_task(task_id)
    if task is None or task.control is None:
        return {"state": None, "allowed": [], "command": None}
    return await asyncio.to_thread(task.control.view, prompts=prompts)


@router.post("/monitor/control/{task_id}")
async def training_control_command(task_id: str, request: ControlRequest):
    task = tm.get_task(task_id)
    item = task.snapshot() if task else {}
    if item.get("kind", "training") != "training" or item.get("status") not in ("CREATED", "RUNNING"):
        raise HTTPException(409, "unavailable")
    if request.action == "force":
        await asyncio.to_thread(task.terminate)
        return {"state": "terminating", "allowed": [], "command": None}
    if not task.control or task.stop_requested or item["status"] != "RUNNING":
        raise HTTPException(409, "unavailable")
    try:
        return await asyncio.to_thread(task.control.submit, request, task.environ)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/monitor/history")
async def monitor_history(refresh: bool = False):
    """训练记录：运行中任务 + 历史训练记录"""
    history = await asyncio.to_thread(scan_history, refresh=refresh)

    # 获取当前运行中任务
    tasks = tm.training_dump()
    active_ids = {task.get("id") for task in tasks if task.get("status") in {"CREATED", "RUNNING"}}
    history = [item for item in history if not item.get("task_id") or item["task_id"] not in active_ids]
    running = next(
        (task for task in reversed(tasks) if task.get("status") in {"CREATED", "RUNNING"}),
        None,
    )

    # 仅为当前活跃任务补充训练参数；终态任务由 history 列表负责展示。
    if running:
        record = await asyncio.to_thread(find_run_record_by_task_id, running.get("id", ""))
        train_config = await asyncio.to_thread(read_run_config, record["run_path"]) if record else {}
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
    return {"status": "success", "data": {"running": running, "history": history}}


@router.post("/monitor/history/delete")
async def delete_history_run(request: Request):
    """删除内部历史/日志，始终保留模型、断点和 sample/。"""
    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "Invalid request body"}
    run_dir = body.get("run_dir", "") if isinstance(body, dict) else ""
    if not isinstance(run_dir, str) or not run_dir:
        return {"status": "error", "message": "run_dir is required"}

    record = await asyncio.to_thread(load_run_record, run_dir, include_deleted=True, use_local_fallback=False)
    if not record:
        return {"status": "error", "message": "Run directory not found / 目录不存在", "error_code": "monitorRunNotFound"}
    tid = record.get("task_id")
    if tid and any(t.get("id") == tid and t.get("status") in {"CREATED", "RUNNING"} for t in tm.training_dump()):
        return {"status": "error", "message": "Cannot delete a running task / 无法删除运行中的任务", "error_code": "monitorRunActive"}
    try:
        if not await asyncio.to_thread(mark_run_deleted, run_dir):
            return {"status": "error", "message": "Failed to delete history / 删除历史失败", "error_code": "monitorDeleteFailed"}
    except RunDeletionError as exc:
        return {"status": "error", "message": str(exc), "error_code": "monitorCleanupFailed",
                "error_details": "\n".join(exc.failures), "data": {"retryable": True}}
    except OSError as exc:
        return {"status": "error", "message": str(exc), "error_code": "monitorDeleteFailed",
                "error_details": str(exc), "data": {"retryable": True}}

    # 失效历史缓存
    from backend.monitor.history import invalidate_history_cache
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
        return {"status": "error", "message": "Run directory not found / 训练目录不存在", "error_code": "monitorRunNotFound"}
    abs_run_dir = Path(record["run_path"])
    artifact_dir = Path(record["artifact_path"])

    result: dict = {
        "run_dir": record["run_dir"],
        "task_id": record.get("task_id"),
        "gpu_processes": record.get("gpu_processes"),
        "artifact_dir": record["artifact_dir"],
        "artifact_available": record["artifact_available"],
        "artifact_external": record["artifact_external"],
        "preview_enabled": record["preview_enabled"],
        "imported": record["imported"],
        "log_timestep_loss": (record.get("extra") or {}).get("log_timestep_loss"),
    }

    # ── 配置参数 ──
    params = await asyncio.to_thread(read_run_config, abs_run_dir)
    if params:
        result["config"] = params
        result["training_profile"] = params.get("model_train_type") or (record.get("extra") or {}).get("profile_id", "")
        result["train_params"] = extract_train_params(params, (record.get("extra") or {}).get("profile_id", ""))

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
        result["output_count"] = (await asyncio.to_thread(read_output_summary, str(artifact_dir)))["count"]
    result["has_dataset_diagnostics"] = await asyncio.to_thread(has_dataset_diagnostics, abs_run_dir)

    result.update(await asyncio.to_thread(read_run_log_progress, abs_run_dir, _LOG_DETAIL_TAIL_LINES))

    # ── result.json（训练结果）──
    def _read_meta_files(run_dir_path: Path) -> tuple[dict | None, str | None]:
        train_result = _read_train_result(run_dir_path, allow_mtime_fallback=not record["imported"])
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
    if record["artifact_available"]:
        task = tm.get_task(record["task_id"]) if record.get("task_id") else None
        if task is None or task.snapshot()["status"] not in {"CREATED", "RUNNING"}:
            result.update(await asyncio.to_thread(
                saved_training_state, abs_run_dir / "log" / ".run-control", artifact_dir, abs_run_dir
            ))
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

    log_path = await asyncio.to_thread(_resolve_monitor_log_path, run_dir, task_id)
    if not log_path:
        return {"status": "error", "message": "Log file not found / 日志文件未找到", "error_code": "monitorLogNotFound"}

    data = await asyncio.to_thread(read_log_slice, log_path, offset, limit, q, tail)
    return {"status": "success", "data": data}


@router.get("/monitor/log-download")
async def monitor_log_download(run_dir: str = Query(""), task_id: str = Query("")):
    """下载完整训练日志（实时任务或历史 run 均可）。"""
    from backend.monitor.log_download import snapshot_response
    from fastapi.responses import JSONResponse

    if not run_dir and not task_id:
        return JSONResponse(status_code=400, content={"status": "error", "message": "run_dir or task_id is required", "error_code": "monitorLogSourceMissing"})

    try:
        log_path = await asyncio.to_thread(_resolve_monitor_log_path, run_dir, task_id)
        if log_path is not None:
            return await asyncio.to_thread(snapshot_response, log_path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(exc),
                            "error_code": "monitorLogAccessFailed", "error_details": str(exc)})
    return JSONResponse(status_code=404, content={"status": "error", "message": "Log file not found / 日志文件未找到", "error_code": "monitorLogNotFound"})


@router.get("/monitor/preview-metadata")
async def monitor_preview_metadata(
    run_dir: str = Query(""),
    path: str = Query(""),
    request: Request = None,
):
    """Read display-safe PNG text/EXIF metadata without loading the original image."""
    import hashlib
    import stat as stat_module
    import urllib.parse
    from fastapi.responses import JSONResponse, Response

    if not run_dir or not path:
        return {"status": "error", "message": "run_dir and path are required"}
    decoded = urllib.parse.unquote(path)
    p = await asyncio.to_thread(resolve_artifact_file, run_dir, decoded)
    if not p:
        return {"status": "error", "message": "File not found / 文件不存在", "error_code": "monitorPreviewNotFound"}
    try:
        file_stat = await asyncio.to_thread(p.stat)
        if not stat_module.S_ISREG(file_stat.st_mode):
            return {"status": "error", "message": "File not found / 文件不存在", "error_code": "monitorPreviewNotFound"}
    except FileNotFoundError:
        return {"status": "error", "message": "File not found / 文件不存在", "error_code": "monitorPreviewNotFound"}
    except OSError as exc:
        return {"status": "error", "message": f"Metadata read failed: {exc}",
                "error_code": "monitorMetadataReadFailed", "error_details": str(exc)}
    etag = hashlib.sha1(
        f"{p}|{file_stat.st_mtime_ns}|{file_stat.st_size}|metadata".encode("utf-8", errors="ignore")
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
            if image.info.get("exif"):
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
    except FileNotFoundError:
        return {"status": "error", "message": "File not found / 文件不存在", "error_code": "monitorPreviewNotFound"}
    except Exception as exc:
        return {"status": "error", "message": f"Metadata read failed: {exc}",
                "error_code": "monitorMetadataReadFailed", "error_details": str(exc)}
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
        asyncio.to_thread(list_output_files, str(artifact_dir), internal_dir),
        asyncio.to_thread(read_tensorboard_loss, downsample_to=0, run_dir=str(internal_dir)),
    )
    await asyncio.to_thread(enrich_model_files_with_loss, files, tb_series, str(internal_dir))
    return {
        "status": "success",
        "data": files,
        "meta": {
            "artifact_dir": record["artifact_dir"],
            "artifact_available": True,
        },
    }


@router.get("/monitor/dataset-diagnostics")
async def monitor_dataset_diagnostics(
    run_dir: str = Query(""),
    task_id: str = Query(""),
    min_count: int = Query(3, ge=1, le=100),
    bins: int = Query(10, ge=2, le=30),
    run_id: str = Query(""),
    known_revision: str = Query("", max_length=128),
    refresh_local: bool = Query(False),
):
    """Per-sample loss diagnostics (residuals, slopes, groups, and per-image breakdown)."""
    record = await asyncio.to_thread(_resolve_live_record, task_id, run_dir)
    is_active = False
    if record and record.get("task_id"):
        tid = record["task_id"]
        is_active = any(
            t.get("id") == tid and t.get("status") in {"CREATED", "RUNNING"}
            for t in tm.training_dump()
        )
    data = await asyncio.to_thread(
        analyze_dataset_diagnostics,
        record,
        min_count=min_count,
        num_bins=bins,
        run_id=run_id,
        is_active=is_active,
        known_revision=known_revision,
        refresh_local=refresh_local,
    )
    return await asyncio.to_thread(JSONResponse, {"status": "success", "revision": data["revision"], "data": data})


@router.get("/monitor/dataset-diagnostics/image")
async def monitor_dataset_diagnostic_image(
    run_dir: str = Query(""),
    task_id: str = Query(""),
    image_id: str = Query(""),
    min_count: int = Query(3, ge=1, le=100),
    bins: int = Query(10, ge=2, le=30),
    run_id: str = Query(""),
    refresh_local: bool = Query(False),
):
    """Detailed per-epoch / per-timestep loss trace and local caption for a single training image."""
    record = await asyncio.to_thread(_resolve_live_record, task_id, run_dir)
    if not record or not image_id:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Image diagnostics not found", "error_code": "monitorDatasetImageNotFound"},
        )
    detail = await asyncio.to_thread(
        read_dataset_diagnostic_image,
        record,
        image_id=image_id,
        min_count=min_count,
        num_bins=bins,
        run_id=run_id,
        refresh_local=refresh_local,
    )
    if not detail:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "Image diagnostics not found", "error_code": "monitorDatasetImageNotFound"},
        )
    return {"status": "success", "data": detail}


def _output_archive_files(root: Path, selections: list[str]):
    root = root.resolve()
    seen = set()

    def visible_target(path, *, state_member=False):
        try:
            target = path.resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if not target.is_relative_to(root):
            return None
        parts = target.relative_to(root).parts
        if state_member and target == path:
            parts = parts[:-1]
        if not any(p.startswith((".", "__")) for p in parts):
            return target
        return None

    for selection in selections:
        rel = Path(selection)
        if rel.anchor or any(part.startswith((".", "__")) for part in rel.parts):
            continue
        target = visible_target(root / rel)
        if target is None:
            continue
        if target.is_file():
            if rel not in seen:
                seen.add(rel)
                yield target, rel
            continue
        for directory, dirs, names in os.walk(target):
            parent = Path(directory)
            # Prune hidden directories, symlinks and Windows junctions before descent.
            dirs[:] = [d for d in dirs if not d.startswith((".", "__")) and visible_target(parent / d) == parent / d]
            for name in names:
                child = parent / name
                hidden = name.startswith((".", "__"))
                if hidden and (child.is_symlink() or not is_distributed_state_member(child)):
                    continue
                member = rel / child.relative_to(target)
                source = visible_target(child, state_member=hidden)
                if source is not None and source.is_file() and member not in seen:
                    seen.add(member)
                    yield source, member


@router.get("/monitor/outputs/download")
async def download_outputs(run_dir: str = Query(""), task_id: str = Query(""), files: str = "",
                           path: Annotated[list[str] | None, Query()] = None):
    """下载全部或选定产物。每个 path 表示一条完整路径，files 兼容旧版客户端。"""
    import tempfile
    import zipfile
    import urllib.parse
    record = await asyncio.to_thread(_resolve_run_record, run_dir, task_id)
    if not record:
        return {"status": "error", "message": "Run directory not found / 运行目录不存在"}
    if not record["artifact_available"]:
        return {"status": "error", "message": "Artifact directory unavailable / 产物目录不可用"}
    rd = Path(record["artifact_path"])

    if path is not None:
        file_list = [item for item in path if item]
    else:
        file_list = [urllib.parse.unquote(f.strip()) for f in files.split(",") if f.strip()] if files else ["."]

    zip_name = f"{rd.name}_outputs.zip"

    # 打包 ZIP 到临时文件（在独立线程池中，不阻塞事件循环）
    # 使用 ZIP_STORED（不压缩）：模型文件已高度优化，DEFLATE 几乎无效且耗时
    def _build_zip(run_dir_path: Path, paths: list[str]) -> Path | None:
        from tools.runtime_paths import runtime_cache_dir

        # A historical artifact root can contain the download cache itself.
        tmp = tempfile.NamedTemporaryFile(prefix=".download-", suffix=".zip", delete=False,
                                          dir=runtime_cache_dir("downloads"))
        tmp.close()
        dst = Path(tmp.name)
        try:
            with zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
                for source, member in _output_archive_files(run_dir_path, paths):
                    zf.write(source, member)
                empty = not zf.filelist
            if empty:
                dst.unlink()
                return None
        except Exception:
            dst.unlink(missing_ok=True)
            raise
        return dst

    try:
        tmp_path = await asyncio.to_thread(_build_zip, rd, file_list)
        if tmp_path is None:
            return {"status": "error", "message": "No files to download / 无可下载文件"}
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
    from fastapi.responses import FileResponse

    if not run_dir or not path:
        return {"status": "error", "message": "run_dir and path are required"}

    p = await asyncio.to_thread(resolve_artifact_file, run_dir, path)
    if not p:
        return {"status": "error", "message": "Invalid path / 无效路径"}
    if not p.is_file():
        return {"status": "error", "message": "File not found / 文件不存在"}

    if p.suffix.lower() == '.log':
        from backend.monitor.log_download import snapshot_response
        return await asyncio.to_thread(snapshot_response, p)
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
        return {"status": "error", "message": "Run directory not found", "error_code": "monitorRunNotFound"}
    if record.get("deletion_pending"):
        return {"status": "error", "message": "Cleanup incomplete; retry deletion / 此记录已部分清理，请重试删除", "error_code": "monitorCleanupPending"}
    abs_run_dir = Path(record["run_path"])
    
    config_file = abs_run_dir / "config.toml"
    if not config_file.exists():
        return {"status": "error", "message": "Config file not found", "error_code": "monitorConfigNotFound"}
    
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
                params = read_run_config(config_file.parent)
        else:
            content = config_file.read_text(encoding="utf-8")
            params = read_run_config(config_file.parent)
        reuse_error = None
        reusable_params = None
        try:
            if config_format == "toml":
                reusable_params = import_native_training_form(params, profile_id=infer_training_profile(params, record))
            else:
                from backend.training.config.network_config import extract_network_form, validate_network_preset
                reusable_params = dict(params)
                if reusable_params.get("model_train_type") == "krea2-lora":
                    reusable_params = extract_network_form(reusable_params)
                validate_network_preset(reusable_params)
            prompt_key = "prompt_file" if str(reusable_params.get("prompt_file") or "").strip() else "sample_prompts"
            prompt_file = reusable_params.get(prompt_key)
            if isinstance(prompt_file, str) and prompt_file.strip():
                reusable_params[prompt_key] = await asyncio.to_thread(reusable_prompt_file, record, prompt_file)
            # Copy as a new run. Resuming is an explicit action on the training page.
            reusable_params["resume"] = ""
            if config_format == "toml" or params.get("resume") or not reusable_params.get("output_dir"):
                reusable_params["output_dir"] = record["output_base_dir"]
        except ValueError as exc:
            reusable_params = None
            reuse_error = str(exc)
        profile_id = params.get("model_train_type") or (record.get("extra") or {}).get("profile_id") or (reusable_params or {}).get("model_train_type", "")
        return {
            "status": "success",
            "data": {
                "content": content,
                "params": params,
                "training_profile": profile_id,
                "train_params": extract_train_params(params, profile_id),
                "reuse_params": reusable_params,
                "reuse_error": reuse_error,
                "name": params.get("output_name", abs_run_dir.name),
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
