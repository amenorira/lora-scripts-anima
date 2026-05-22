"""
训练监控 API 路由

提供：
  GET  /api/monitor/status        — 聚合监控状态（GPU + 训练进度 + Loss + 预览样本）
  GET  /api/monitor/logs/{task_id} — 训练日志
  GET  /api/monitor/history        — 历史训练记录
  GET  /api/monitor/presets        — 训练预设管理
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query

from mikazuki.app.models import APIResponseSuccess, APIResponseFail
from mikazuki.log import log
from mikazuki.tasks import tm

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_DIR = REPO_ROOT / "logs"
OUTPUT_DIR = REPO_ROOT / "output"
CONFIG_AUTOSAVE = REPO_ROOT / "config" / "autosave"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# ── GPU 监控 (pynvml) ──────────────────────────────────────
_nvml_ready = False


def _ensure_nvml() -> bool:
    global _nvml_ready
    if _nvml_ready:
        return True
    try:
        import pynvml
        pynvml.nvmlInit()
        _nvml_ready = True
        return True
    except Exception:
        return False


def _gpu_info() -> dict | None:
    if not _ensure_nvml():
        return None
    try:
        import pynvml
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode("utf-8", errors="replace")
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)

        try:
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        except Exception:
            temp = None

        try:
            power_mw = pynvml.nvmlDeviceGetPowerUsage(handle)
            power_w = round(power_mw / 1000, 1)
        except Exception:
            power_w = None

        return {
            "name": name,
            "vram_used_mb": round(mem.used / (1024 * 1024)),
            "vram_total_mb": round(mem.total / (1024 * 1024)),
            "gpu_load_pct": util.gpu,
            "mem_load_pct": util.memory,
            "temperature_c": temp,
            "power_w": power_w,
        }
    except Exception:
        return None


# ── TensorBoard Event 读取 ─────────────────────────────────
def _read_tensorboard_loss(limit: int = 5000) -> list[dict]:
    """从 TensorBoard event 文件读取 Loss/LR scalar"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return []

    event_files = sorted(
        [p for p in LOG_DIR.rglob("events.out.tfevents.*") if p.is_file()],
        key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not event_files:
        return []

    scalar_tags = ("loss/average", "loss/current", "loss/epoch_average", "lr/unet")

    for event_file in event_files[:3]:  # 最多尝试 3 个最新 run
        try:
            run_dir = event_file.parent
            ea = event_accumulator.EventAccumulator(
                str(run_dir),
                size_guidance={event_accumulator.SCALARS: 0},
            )
            ea.Reload()
            available = set(ea.Tags().get("scalars", []))
        except Exception:
            continue

        series_list = []
        for tag in scalar_tags:
            if tag not in available:
                continue
            try:
                events = ea.Scalars(tag)[-limit:]
            except Exception:
                continue
            points = [
                {"step": int(e.step), "value": round(float(e.value), 6)}
                for e in events
            ]
            if not points:
                continue
            values = [p["value"] for p in points]
            series_list.append({
                "tag": tag,
                "name": tag.replace("/", " ").replace("_", " "),
                "points": points,
                "latest": values[-1],
                "min": min(values),
                "max": max(values),
            })

        if series_list:
            return series_list

    return []


# ── 训练日志解析 ───────────────────────────────────────────
def _parse_log_progress(lines: list[str]) -> dict:
    """从训练日志中解析进度、Loss、LR"""
    text = "\n".join(lines[-3000:])
    info: dict[str, Any] = {}

    # 进度: "steps: 45%|████ | 450/1000 [02:30<03:03]"
    m = re.search(
        r"steps:\s*(?P<pct>\d{1,3})%\|.*?\|\s*(?P<step>\d+)\s*/\s*(?P<total>\d+)"
        r"(?:\s*\[(?P<elapsed>[^<,\]]+)(?:<(?P<eta>[^,\]]+))?[^\]]*\])?",
        text
    )
    if m:
        step = int(m.group("step"))
        total = int(m.group("total"))
        info["step"] = step
        info["total_steps"] = total
        info["percent"] = min(100.0, round(step * 100 / total, 2)) if total else 0
        info["eta"] = m.group("eta") or ""

    # Loss (最后出现的)
    loss_m = re.findall(r"(?:loss|train_loss|avr_loss)\s*[=:]\s*([0-9.eE+-]+)", text)
    if loss_m:
        info["loss"] = loss_m[-1]

    # LR
    lr_m = re.findall(r"(?:lr|learning_rate)\s*[=:]\s*([0-9.eE+-]+)", text)
    if lr_m:
        info["lr"] = lr_m[-1]

    # Epoch
    ep_m = re.search(r"(?:epoch|Epoch)\s*[:= ]\s*(\d+)(?:\s*/\s*(\d+))?", text)
    if ep_m:
        info["epoch"] = f"{ep_m.group(1)}/{ep_m.group(2)}" if ep_m.group(2) else ep_m.group(1)

    # 速度
    speed_m = re.findall(r"([0-9.]+)\s*(?:it/s|s/it)", text)
    if speed_m:
        info["speed"] = speed_m[-1] + ("it/s" if "it/s" in text else "s/it")

    # 错误检测
    error_patterns = [
        r"\btraceback\b", r"cuda out of memory",
        r"error executing job", r"exited with code [1-9]",
        r"failed to (?:load|initialize|open|import|download|start|create)",
    ]
    for pattern in error_patterns:
        if re.search(pattern, text, re.IGNORECASE):
            info["has_error"] = True
            m = re.search(pattern, text, re.IGNORECASE)
            info["error_msg"] = m.group(0) if m else ""
            break

    return info


# ── 训练配置解析 ──────────────────────────────────────────
def _latest_train_config() -> dict:
    """解析最新的 autosave TOML 配置"""
    if not CONFIG_AUTOSAVE.exists():
        return {}
    configs = sorted(
        CONFIG_AUTOSAVE.glob("*.toml"),
        key=lambda p: p.stat().st_mtime, reverse=True
    )
    for cfg_path in configs[:3]:
        try:
            text = cfg_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        params = {}
        str_keys = ["output_dir", "output_name", "optimizer_type", "lr_scheduler",
                     "network_module", "resolution", "mixed_precision"]
        num_keys = ["max_train_epochs", "max_train_steps", "learning_rate",
                     "network_dim", "network_alpha", "train_batch_size",
                     "gradient_accumulation_steps", "lr_warmup_steps", "seed"]
        bool_keys = ["gradient_checkpointing", "full_bf16", "full_fp16"]

        for key in str_keys:
            m = re.search(rf'^{key}\s*=\s*["\'](?P<v>.*?)["\']\s*$', text, re.MULTILINE)
            if m: params[key] = m.group("v")
        for key in num_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>[0-9.eE+-]+)\s*$', text, re.MULTILINE)
            if m: params[key] = m.group("v")
        for key in bool_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>true|false)\s*$', text, re.MULTILINE | re.IGNORECASE)
            if m: params[key] = m.group("v").lower()

        if params:
            return params
    return {}


def _extract_train_params(config: dict) -> list[dict]:
    """从 TOML 配置提取关键训练参数"""
    if not config:
        return []
    params = []

    def _add(label: str, key: str, fmt: str = ""):
        v = config.get(key)
        if v is None or v == "":
            return
        if fmt == "lr":
            try:
                n = float(v)
                v = f"{n:.2e}" if n < 0.001 else str(n)
            except ValueError:
                pass
        params.append({"label": label, "value": str(v)})

    _add("学习率", "learning_rate", "lr")
    _add("UNet LR", "unet_lr", "lr")
    _add("优化器", "optimizer_type")
    _add("调度器", "lr_scheduler")
    _add("Rank (dim)", "network_dim")
    _add("Alpha", "network_alpha")
    _add("Epochs", "max_train_epochs")
    _add("分辨率", "resolution")
    _add("Seed", "seed")

    warmup = config.get("lr_warmup_steps", "")
    if warmup and warmup not in ("0", "0.0"):
        params.append({"label": "Warmup", "value": f"{warmup} 步"})

    if config.get("full_bf16") == "true":
        params.append({"label": "精度", "value": "BF16"})
    elif config.get("full_fp16") == "true":
        params.append({"label": "精度", "value": "FP16"})
    elif config.get("mixed_precision"):
        params.append({"label": "精度", "value": config["mixed_precision"].upper()})

    return params


# ── 预览样本 ──────────────────────────────────────────────
def _newest_previews(output_dir: str | None = None, limit: int = 6) -> list[dict]:
    """扫描最新的训练样本图"""
    roots = []
    if output_dir:
        roots.extend([Path(output_dir) / "sample", Path(output_dir)])
    roots.extend([OUTPUT_DIR / "sample", OUTPUT_DIR])

    found: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*"), key=lambda x: x.stat().st_mtime if x.is_file() else 0, reverse=True):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
                if p not in found:
                    found.append(p)
                if len(found) >= limit * 2:
                    break
        if len(found) >= limit:
            break

    found.sort(key=lambda p: p.stat().st_mtime)
    selected = found[-limit:] if len(found) > limit else found

    result = []
    for p in selected:
        try:
            rel = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
        except ValueError:
            rel = str(p)
        result.append({
            "name": p.name,
            "url": f"/preview-image?path={rel}",
            "size": p.stat().st_size,
        })
    return result


# ── 历史记录 ──────────────────────────────────────────────
def _scan_history() -> list[dict]:
    """扫描历史训练记录"""
    history = []
    if not CONFIG_AUTOSAVE.exists():
        return history

    for cfg_path in sorted(CONFIG_AUTOSAVE.glob("*.toml"), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
        try:
            st = cfg_path.stat()
            params = {}
            text = cfg_path.read_text(encoding="utf-8", errors="replace")
            for key in ["output_name", "pretrained_model_name_or_path",
                         "learning_rate", "network_dim", "network_alpha",
                         "max_train_epochs", "model_train_type"]:
                m = re.search(rf'^{key}\s*=\s*["\']?(?P<v>[^"\'\n#]+)["\']?\s*$', text, re.MULTILINE)
                if m:
                    params[key] = m.group("v").strip().strip('"').strip("'")

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "config_file": cfg_path.name,
                "name": params.get("output_name", cfg_path.stem),
                "model": Path(params.get("pretrained_model_name_or_path", "")).name or "Unknown",
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
            })
        except (OSError, Exception):
            continue

    return history


# ═══════════════════════════════════════════════════════════
# API 路由
# ═══════════════════════════════════════════════════════════

@router.get("/monitor/status")
async def monitor_status(task_id: str = Query("")):
    """聚合监控端点：GPU + 训练进度 + Loss 曲线 + 预览样本 + 训练参数"""
    result = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "gpu": _gpu_info(),
        "tensorboard_loss": _read_tensorboard_loss(),
        "state": "空闲",
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

    # 训练配置
    train_config = _latest_train_config()
    result["train_params"] = _extract_train_params(train_config)
    result["previews"] = _newest_previews(train_config.get("output_dir"))

    # 任务状态
    tasks = tm.dump()
    result["all_tasks"] = tasks

    if not tasks:
        return APIResponseSuccess(data=result).model_dump() if hasattr(APIResponseSuccess, "model_dump") else {"status": "success", "data": result}

    active = None
    for t in reversed(tasks):
        if t.get("status") == "RUNNING":
            active = t
            break
    if not active:
        active = tasks[-1]

    result["active_task"] = active
    state_map = {"RUNNING": "训练中", "FINISHED": "已完成", "TERMINATED": "已终止", "CREATED": "等待启动"}
    result["state"] = state_map.get(active.get("status"), active.get("status", "未知"))

    # 如果有激活任务，尝试解析日志
    # 注意：这需要访问训练进程的 stdout，当前 Task 类的 process.stdout 可用于此
    # 作为轻量替代，这里返回基础信息；后续可在 api.py 中添加日志 tail 端点

    return {"status": "success", "data": result}


@router.get("/monitor/history")
async def monitor_history():
    """历史训练记录"""
    return {"status": "success", "data": _scan_history()}


@router.get("/monitor/preview-image")
async def monitor_preview_image(path: str = Query("")):
    """预览图片代理"""
    from fastapi.responses import FileResponse
    import urllib.parse

    decoded = urllib.parse.unquote(path)
    p = (REPO_ROOT / decoded).resolve()

    # 安全检查：只允许 output/ 和 logs/ 下的图片
    allowed = [OUTPUT_DIR.resolve(), LOG_DIR.resolve()]
    if not any(p == root or root in p.parents for root in allowed):
        return APIResponseFail(message="禁止访问").model_dump() if hasattr(APIResponseFail, "model_dump") else {"status": "error", "message": "禁止访问"}

    if not p.is_file():
        return APIResponseFail(message="文件不存在").model_dump() if hasattr(APIResponseFail, "model_dump") else {"status": "error", "message": "文件不存在"}

    import mimetypes
    mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mt)
