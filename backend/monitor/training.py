"""
训练状态解析 — 日志解析 + TensorBoard Event 读取 + TOML 配置解析
"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "output"
CONFIG_AUTOSAVE = REPO_ROOT / "config" / "autosave"

# ── TensorBoard Event 缓存 ─────────────────────────────────
# 缓存 EventAccumulator 实例，按 log_dir 索引
# 每次请求检查 event file mtime，仅在文件更新时重新 Reload
_tb_cache: dict[str, tuple[float, Any]] = {}   # {log_dir: (event_mtime, EventAccumulator)}
_CACHE_TTL = 5.0  # 缓存有效期（秒），避免频繁 Reload


def _get_cached_accumulator(log_dir: Path) -> Any | None:
    """获取缓存的 EventAccumulator，若 event file 未变化则复用"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return None

    log_dir_str = str(log_dir)
    event_files = sorted(log_dir.rglob("events.out.tfevents.*"),
                         key=lambda p: p.stat().st_mtime, reverse=True)
    if not event_files:
        _tb_cache.pop(log_dir_str, None)
        return None

    latest_mtime = max(ef.stat().st_mtime for ef in event_files)
    now = time.time()

    if log_dir_str in _tb_cache:
        cached_mtime, cached_ea = _tb_cache[log_dir_str]
        if cached_mtime == latest_mtime and (now - cached_mtime) < _CACHE_TTL:
            return cached_ea

    # 缓存未命中或过期：创建新 accumulator
    try:
        ea = event_accumulator.EventAccumulator(
            log_dir_str,
            size_guidance={event_accumulator.SCALARS: 0},
        )
        ea.Reload()
        _tb_cache[log_dir_str] = (latest_mtime, ea)
        # 清理过大的缓存（保留最近 3 个）
        if len(_tb_cache) > 3:
            oldest = min(_tb_cache.keys(), key=lambda k: _tb_cache[k][0])
            del _tb_cache[oldest]
        return ea
    except Exception:
        return None


# ── TensorBoard Event 降采样 (LTTB) ────────────────────────

def _lttb_downsample(points: list[dict], target: int) -> list[dict]:
    """Largest Triangle Three Buckets 降采样，保留曲线视觉特征"""
    n = len(points)
    if n <= target or target < 3:
        return points[:]

    result = [points[0]]
    bucket_size = (n - 2) / (target - 2)
    a = 0

    for i in range(target - 2):
        bucket_start = 1 + int(i * bucket_size)
        bucket_end = 1 + int((i + 1) * bucket_size)
        bucket_end = min(bucket_end, n - 1)

        max_area = -1.0
        max_idx = bucket_start
        pa_x = points[a]["step"]
        pa_y = points[a]["value"]

        for j in range(bucket_start, bucket_end):
            area = abs(
                (points[j]["step"] - pa_x) * (points[n - 1]["value"] - pa_y)
                - (points[n - 1]["step"] - pa_x) * (points[j]["value"] - pa_y)
            )
            if area > max_area:
                max_area = area
                max_idx = j

        result.append(points[max_idx])
        a = max_idx

    result.append(points[-1])
    return result


def read_tensorboard_loss(limit: int = 50000, downsample_to: int = 2000) -> list[dict]:
    """从 TensorBoard event 文件读取 Loss/LR scalar，自动降采样。
    扫描 output/*/log/（运行文件夹）中的 TensorBoard 事件。
    使用缓存避免高频轮询时重复解析 event 文件。"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return []

    # 扫描 per-run 文件夹下的 log/ 子目录
    log_dirs = []
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            log_sub = run_dir / "log"
            if log_sub.is_dir():
                log_dirs.append(log_sub)

    scalar_tags = (
        "loss/average", "loss/current", "loss/epoch_average", "loss/epoch",
        "lr/unet", "lr/textencoder", "lr/d*lr/unet", "lr/d*lr/textencoder",
    )

    for log_dir in log_dirs[:5]:  # 最多检查 5 个日志目录
        ea = _get_cached_accumulator(log_dir)
        if ea is None:
            continue

        try:
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
            if len(points) > downsample_to:
                points = _lttb_downsample(points, downsample_to)
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

def parse_log_progress(lines: list[str]) -> dict:
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

    loss_m = re.findall(r"(?:loss|train_loss|avr_loss)\s*[=:]\s*([0-9.eE+-]+)", text)
    if loss_m:
        info["loss"] = loss_m[-1]

    lr_m = re.findall(r"(?:lr|learning_rate)\s*[=:]\s*([0-9.eE+-]+)", text)
    if lr_m:
        info["lr"] = lr_m[-1]

    ep_m = re.search(r"(?:epoch|Epoch)\s*[:= ]\s*(\d+)(?:\s*/\s*(\d+))?", text)
    if ep_m:
        info["epoch"] = f"{ep_m.group(1)}/{ep_m.group(2)}" if ep_m.group(2) else ep_m.group(1)

    speed_m = re.findall(r"([0-9.]+)\s*(?:it/s|s/it)", text)
    if speed_m:
        info["speed"] = speed_m[-1] + ("it/s" if "it/s" in text else "s/it")

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


# ── 训练配置解析 (TOML) ────────────────────────────────────

def latest_train_config() -> dict:
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
            if m:
                params[key] = m.group("v")
        for key in num_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>[0-9.eE+-]+)\s*$', text, re.MULTILINE)
            if m:
                params[key] = m.group("v")
        for key in bool_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>true|false)\s*$', text, re.MULTILINE | re.IGNORECASE)
            if m:
                params[key] = m.group("v").lower()

        if params:
            return params
    return {}


def extract_train_params(config: dict) -> list[dict]:
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

    _add("Learning Rate / 学习率", "learning_rate", "lr")
    _add("UNet LR", "unet_lr", "lr")
    _add("Optimizer / 优化器", "optimizer_type")
    _add("Scheduler / 调度器", "lr_scheduler")
    _add("Rank (dim) / 维度", "network_dim")
    _add("Alpha", "network_alpha")
    _add("Epochs / 轮数", "max_train_epochs")
    _add("Resolution / 分辨率", "resolution")
    _add("Seed / 种子", "seed")

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
