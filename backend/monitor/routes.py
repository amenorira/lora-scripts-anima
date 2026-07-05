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
    list_output_files, enrich_model_files_with_loss, _clean_log_text,
    find_run_log_path, find_train_log_path, read_log_slice,
)
from backend.monitor.snapshot import find_run_dir_by_task_id
from backend.tasks import tm

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "output"
CACHE_DIR = REPO_ROOT / "cache"
PREVIEW_THUMB_DIR = CACHE_DIR / "preview-thumbs"

# run-detail 仅回传日志尾部行数（与前端 LOG.MAX_LINES 对齐）；完整日志经
# /monitor/log-slice 分页拉取，避免大日志全量回传撑爆响应。
_LOG_DETAIL_TAIL_LINES = 5000

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

    # 解析当前任务的真实运行目录：优先用活动任务的 task_id 反查
    # task_meta.json（目标值），autosave TOML 仅作回退（前端修改表单后
    # autosave 的 output_dir 可能指向尚未启动的新目录，此时用它取样本/日志
    # 会落到其它记录的样本上——Bug：样本显示成其它训练记录的样本）。
    tasks = tm.dump()

    active = None
    for t in reversed(tasks):
        if t.get("status") == "RUNNING":
            active = t
            break
    if not active and tasks:
        active = tasks[-1]

    active_task_id = active.get("id", "") if active else ""

    # 1) 活动/最后一项任务的真实 run_dir（task_meta.json 反查）
    resolved_run_dir: str | None = None
    if active_task_id:
        mapped = await asyncio.to_thread(find_run_dir_by_task_id, active_task_id)
        if mapped:
            resolved_run_dir = mapped

    # 2) autosave TOML（参数面板 + 缺失 task_meta 时的回退）
    train_config = await asyncio.to_thread(latest_train_config)
    autosave_output_dir = train_config.get("output_dir")

    # 若未反查到 run_dir，且 autosave output_dir 指向真实存在的 run 子目录，
    # 才回退使用它（避免指向尚未创建的新目录时误取全局样本）
    if resolved_run_dir is None and autosave_output_dir:
        ad = Path(autosave_output_dir)
        try:
            ad_rel = ad.resolve().relative_to(OUTPUT_DIR.resolve())
            # 必须是 output/<name>_<ts> 这种 run 子目录（至少 1 段），且确实存在
            if len(ad_rel.parts) >= 1 and ad.is_dir():
                resolved_run_dir = str(autosave_output_dir).replace("\\", "/")
        except (ValueError, OSError):
            pass

    # 产物目录：用真实 run_dir 取样本/日志；无则 None（前端展示空态）
    artifacts_dir: Path | None = None
    if resolved_run_dir:
        rd = Path(resolved_run_dir)
        if not rd.is_absolute():
            rd = (REPO_ROOT / rd).resolve()
        if rd.is_dir():
            artifacts_dir = rd

    # 预览样本：严格限定在该 run 目录下，避免漂移到其它记录
    result["previews"] = await asyncio.to_thread(
        newest_previews, str(artifacts_dir) if artifacts_dir else None, 300
    )
    # 训练参数：优先取该 run 的 config.toml，回退 autosave
    result["train_params"] = await asyncio.to_thread(
        _extract_train_params_for_run, artifacts_dir, train_config
    )

    # 只返回运行中的任务，避免暴露所有已完成/已终止任务
    result["all_tasks"] = [t for t in tasks if t.get("status") == "RUNNING"]

    if not tasks:
        if artifacts_dir:
            result["output_dir"] = str(artifacts_dir.relative_to(REPO_ROOT)).replace("\\", "/")
        else:
            result["output_dir"] = str(OUTPUT_DIR)
        return {"status": "success", "data": result}

    result["active_task"] = active
    active_status = active.get("status", "UNKNOWN")
    result["state"] = active_status
    result["state_label"] = STATE_LABELS.get(active_status, active_status)

    if artifacts_dir:
        result["output_dir"] = str(artifacts_dir.relative_to(REPO_ROOT)).replace("\\", "/")
    elif autosave_output_dir:
        result["output_dir"] = str(autosave_output_dir).replace("\\", "/")
    else:
        result["output_dir"] = str(OUTPUT_DIR)

    # 从真实 run 目录读取日志 + 进度
    def _read_run_log_and_progress(run_dir_path: Path) -> tuple[list[str], dict]:
        latest_log = find_run_log_path(run_dir_path)
        if not latest_log:
            return [], {}
        lines = read_train_log(active_task_id, run_dir_path)
        if not lines:
            return [], {}
        return lines, parse_log_progress(lines)

    if active_status == "RUNNING" and artifacts_dir:
        log_lines, progress = await asyncio.to_thread(_read_run_log_and_progress, artifacts_dir)
        if log_lines:
            for key in ("step", "total_steps", "percent", "loss",
                         "lr", "epoch", "eta", "elapsed", "speed",
                         "has_error", "error_msg"):
                if key in progress and progress[key] is not None:
                    result[key] = progress[key]
            result["log_lines"] = log_lines

    if active_status != "RUNNING":
        # 上一轮训练摘要：优先用真实 run_dir 的 config/result
        if artifacts_dir:
            run_cfg = await asyncio.to_thread(_resolve_run_config_params, artifacts_dir)
            if run_cfg:
                result["last_config"] = run_cfg
            elif train_config:
                result["last_config"] = _last_config_from_autosave(train_config)
        elif train_config:
            result["last_config"] = _last_config_from_autosave(train_config)

        # result.json + 尾部日志
        if artifacts_dir:
            result_file = artifacts_dir / "result.json"
            if result_file.exists():
                try:
                    result["train_result"] = json.loads(result_file.read_text(encoding="utf-8"))
                except Exception:
                    pass
            log_lines, _ = await asyncio.to_thread(_read_run_log_and_progress, artifacts_dir)
            if log_lines:
                result["log_lines"] = log_lines

    return {"status": "success", "data": result}


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
    data = await asyncio.to_thread(read_tensorboard_loss, run_dir=run_dir or None)
    return {"status": "success", "data": data}


@router.get("/monitor/previews")
async def monitor_previews(
    task_id: str = Query(""),
    run_dir: str = Query(""),
    refresh: int = Query(0),
    limit: int = Query(300, ge=1, le=1000),
):
    # 解析预览样本目录：
    #   task_id 非空 → 反查活动任务的真实 run_dir（实时模式）
    #   否则 run_dir 非空 → 直接用该 run_dir（历史模式）
    #   都为空 → 回退到活动任务 / autosave
    if task_id:
        output_dir = await asyncio.to_thread(_resolve_live_output_dir, task_id)
    elif run_dir:
        rd = Path(run_dir)
        if not rd.is_absolute():
            rd = (REPO_ROOT / rd).resolve()
        output_dir = str(rd) if rd.is_dir() else None
    else:
        output_dir = await asyncio.to_thread(_resolve_live_output_dir, "")
    data = await asyncio.to_thread(newest_previews, output_dir, limit, bool(refresh))
    return {"status": "success", "data": data}


@router.get("/monitor/config")
async def monitor_config():
    train_config = await asyncio.to_thread(latest_train_config)
    data = await asyncio.to_thread(extract_train_params, train_config)
    return {"status": "success", "data": data}


def _resolve_live_output_dir(task_id: str = "") -> str | None:
    """定位「当前活动训练」的真实产物目录。
    优先级：参数 task_id → 活动任务 task_id（反查 task_meta.json）→ autosave TOML。
    autosave 仅在其 output_dir 指向真实存在的子目录时才回退使用，避免漂移到全局样本。
    """
    tid = task_id or ""
    if not tid:
        tasks = tm.dump()
        for t in reversed(tasks):
            if t.get("status") == "RUNNING":
                tid = t.get("id", "")
                break
    if tid:
        mapped = find_run_dir_by_task_id(tid)
        if mapped and Path(mapped).is_dir():
            return mapped
    cfg = latest_train_config()
    autosave_od = cfg.get("output_dir")
    if autosave_od:
        ad = Path(autosave_od)
        try:
            ad_rel = ad.resolve().relative_to(OUTPUT_DIR.resolve())
            if len(ad_rel.parts) >= 1 and ad.is_dir():
                return autosave_od
        except (ValueError, OSError):
            pass
    return None


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
    result["previews"] = await asyncio.to_thread(newest_previews, str(abs_run_dir), 300)

    # ── 训练日志 ──
    # 历史记录：用全文解析进度（total_steps/percent 等常出现在早期行），
    # 但只回传尾部 _LOG_DETAIL_TAIL_LINES 行；完整日志由前端「完整日志」模式
    # 经 /monitor/log-slice 分页拉取，避免大日志全量回传。
    def _read_log_and_progress(run_dir_path: Path) -> tuple[list[str] | None, dict]:
        latest_log = find_run_log_path(run_dir_path)
        if latest_log:
            try:
                content = latest_log.read_text(encoding="utf-8", errors="replace")
                content = _clean_log_text(content)
                log_lines = content.split("\n")
                if log_lines and log_lines[-1] == "":
                    log_lines.pop()  # 文件以 \n 结尾产生的末尾空行
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
        for key in ("step", "total_steps", "percent", "loss",
                     "lr", "epoch", "eta", "elapsed", "speed",
                     "has_error", "error_msg"):
            if key in progress and progress[key] is not None:
                result[key] = progress[key]

    # ── result.json（训练结果）──
    def _read_meta_files(run_dir_path: Path) -> tuple[dict | None, str | None]:
        train_result = None
        run_info = None
        result_file = run_dir_path / "result.json"
        if result_file.exists():
            try:
                train_result = json.loads(result_file.read_text(encoding="utf-8"))
            except Exception:
                pass
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
    log_path: Path | None = None
    if run_dir:
        abs_run_dir = (REPO_ROOT / run_dir).resolve()
        try:
            abs_run_dir.relative_to(OUTPUT_DIR.resolve())
        except ValueError:
            return {"status": "error", "message": "Invalid run_dir / 无效路径"}
        if abs_run_dir.is_dir():
            log_path = find_run_log_path(abs_run_dir)
    elif task_id:
        train_config = latest_train_config(task_id)
        output_dir = train_config.get("output_dir")
        output_dir_path = Path(output_dir) if output_dir else None
        log_path = find_train_log_path(task_id, output_dir_path)
    else:
        return {"status": "error", "message": "run_dir or task_id is required"}

    if not log_path:
        return {"status": "error", "message": "Log file not found / 日志文件未找到"}

    data = await asyncio.to_thread(read_log_slice, log_path, offset, limit, q, tail)
    return {"status": "success", "data": data}


@router.get("/monitor/preview-image")
async def monitor_preview_image(path: str = Query(""), thumb: bool = Query(False)):
    """预览图片代理 — 仅允许 output/ 和 logs/ 目录下的文件"""
    import hashlib
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

    headers = {"Cache-Control": "public, max-age=86400"}

    if thumb:
        try:
            from PIL import Image, ImageOps

            st = p.stat()
            key_src = f"{p}|{st.st_mtime_ns}|{st.st_size}|320"
            key = hashlib.sha1(key_src.encode("utf-8", errors="ignore")).hexdigest()
            thumb_path = PREVIEW_THUMB_DIR / f"{key}.jpg"
            if not thumb_path.exists():
                PREVIEW_THUMB_DIR.mkdir(parents=True, exist_ok=True)
                with Image.open(p) as img:
                    img = ImageOps.exif_transpose(img)
                    img.thumbnail((320, 320))
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    img.save(thumb_path, format="JPEG", quality=82, optimize=True)
            return FileResponse(thumb_path, media_type="image/jpeg", headers=headers)
        except Exception:
            pass

    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mt, headers=headers)


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
    enrich_model_files_with_loss(files, tb_series, str(rd))
    return {"status": "success", "data": files}


@router.get("/monitor/outputs/download")
async def download_outputs(run_dir: str = Query(""), task_id: str = Query(""), files: str = Query("")):
    """下载输出文件（zip 格式，流式传输）。files 为逗号分隔的相对路径列表，为空则下载全部。"""
    import tempfile
    import zipfile
    import urllib.parse
    from fastapi.responses import StreamingResponse

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
