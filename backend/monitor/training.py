"""
训练状态解析 — 日志解析 + TensorBoard Event 读取 + TOML 配置解析
"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from backend.constants import REPO_ROOT, OUTPUT_DIR
from backend.constants import AUTOSAVE_DIR as CONFIG_AUTOSAVE

# ── TensorBoard Event 缓存 ─────────────────────────────────
# 缓存 EventAccumulator 实例，按 log_dir 索引
# 每次请求检查 event file mtime，仅在文件更新时重新 Reload
_tb_cache: dict[str, tuple[float, float, Any]] = {}   # {log_dir: (cache_time, event_mtime, EventAccumulator)}
_CACHE_TTL = 2.0  # 缓存有效期（秒），避免频繁 Reload

# 增量读取用：按 (log_dir_str, tag) 追踪已推送的最大 step
_last_seen_step: dict[tuple[str, str], int] = {}
_MAX_SEEN_ENTRIES = 200  # 防止无限增长


def _get_cached_accumulator(log_dir: Path) -> Any | None:
    """获取缓存的 EventAccumulator，若 event file 未变化则复用"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return None

    log_dir_str = str(log_dir)
    event_files = list(log_dir.rglob("events.out.tfevents.*"))
    if not event_files:
        _tb_cache.pop(log_dir_str, None)
        return None

    ef_with_mtime = [(p, p.stat().st_mtime) for p in event_files]
    ef_with_mtime.sort(key=lambda x: x[1], reverse=True)
    latest_mtime = ef_with_mtime[0][1]
    now = time.time()

    if log_dir_str in _tb_cache:
        cache_time, cached_mtime, cached_ea = _tb_cache[log_dir_str]
        if cached_mtime == latest_mtime and (now - cache_time) < _CACHE_TTL:
            return cached_ea

    # 缓存未命中或过期：创建新 accumulator
    try:
        ea = event_accumulator.EventAccumulator(
            log_dir_str,
            size_guidance={event_accumulator.SCALARS: 0},
        )
        ea.Reload()
        _tb_cache[log_dir_str] = (now, latest_mtime, ea)
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
        # 保证 bucket 内至少有一个点
        if bucket_start >= bucket_end:
            bucket_end = min(bucket_start + 1, n - 1)

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


def read_tensorboard_loss(
    limit: int = 50000,
    downsample_to: int = 2000,
    run_dir: str | None = None,
) -> list[dict]:
    """从 TensorBoard event 文件读取 Loss/LR scalar，自动降采样。
    若指定 run_dir，仅读取该目录下的 log/；否则扫描 output/*/log/（按 mtime 倒序取最新）。
    使用缓存避免高频轮询时重复解析 event 文件。"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return []

    # 扫描 per-run 文件夹下的 log/ 子目录
    log_dirs: list[Path] = []
    if run_dir:
        # 指定 run_dir：只读该目录
        rd = Path(run_dir)
        log_sub = rd / "log"
        if log_sub.is_dir():
            log_dirs.append(log_sub)
        # 兼容：run_dir 本身就是 checkpoints 父目录
        if not log_dirs:
            for candidate in [rd, rd.parent]:
                log_sub2 = candidate / "log"
                if log_sub2.is_dir():
                    log_dirs.append(log_sub2)
                    break
    elif OUTPUT_DIR.exists():
        for rd in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            log_sub = rd / "log"
            if log_sub.is_dir():
                log_dirs.append(log_sub)

    scalar_tags = (
        "loss/average", "loss/current", "loss/epoch_average", "loss/epoch",
        "lr/unet", "lr/textencoder", "lr/d*lr/unet", "lr/d*lr/textencoder",
    )

    for log_dir in (log_dirs[:1] if run_dir else log_dirs[:5]):
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


def read_tensorboard_incremental(run_dir: str | None = None) -> dict[str, list[dict]]:
    """从 TB event 文件读取自上次调用以来的新增 scalar 点。
    返回 {tag: [{"step": N, "value": V}, ...]}，无新数据时返回空 dict。
    """
    # 扫描 log 目录（复用 read_tensorboard_loss 的路径逻辑）
    log_dirs: list[Path] = []
    if run_dir:
        rd = Path(run_dir)
        for candidate in [rd / "log", rd, rd.parent]:
            log_sub = candidate / "log" if candidate.name != "log" else candidate
            if log_sub.is_dir():
                log_dirs.append(log_sub)
                break
    elif OUTPUT_DIR.exists():
        for rd in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            log_sub = rd / "log"
            if log_sub.is_dir():
                log_dirs.append(log_sub)

    scalar_tags = (
        "loss/average", "loss/current", "loss/epoch_average", "loss/epoch",
        "lr/unet", "lr/textencoder", "lr/d*lr/unet", "lr/d*lr/textencoder",
    )

    result: dict[str, list[dict]] = {}

    for log_dir in log_dirs[:1]:
        ea = _get_cached_accumulator(log_dir)
        if ea is None:
            continue

        log_dir_str = str(log_dir)
        try:
            available = set(ea.Tags().get("scalars", []))
        except Exception:
            continue

        for tag in scalar_tags:
            if tag not in available:
                continue
            try:
                events = ea.Scalars(tag)
            except Exception:
                continue

            last_step = _last_seen_step.get((log_dir_str, tag), -1)
            new_points = [
                {"step": int(e.step), "value": round(float(e.value), 6)}
                for e in events
                if int(e.step) > last_step
            ]
            if not new_points:
                continue

            result[tag] = new_points
            # 更新 last_seen_step
            max_step = max(p["step"] for p in new_points)
            _last_seen_step[(log_dir_str, tag)] = max_step

    # 清理过大的追踪字典（LRU 淘汰最旧的条目）
    if len(_last_seen_step) > _MAX_SEEN_ENTRIES:
        oldest_keys = sorted(
            _last_seen_step.keys(),
            key=lambda k: _last_seen_step[k],
        )[: len(_last_seen_step) - _MAX_SEEN_ENTRIES]
        for key in oldest_keys:
            del _last_seen_step[key]

    return result


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

    # 按优先级解析 loss：loss/current > loss/average > train_loss > avr_loss > loss
    loss_preference = ["loss/current", "loss/average", "train_loss", "avr_loss", r"\bloss\b(?!/(current|average|epoch))"]
    for loss_key in loss_preference:
        m = re.search(rf"{loss_key}\s*[=:]\s*([0-9.eE+-]+)", text)
        if m:
            info["loss"] = m.group(1)
            break

    lr_m = re.findall(r"(?:lr|learning_rate)\s*[=:]\s*([0-9.eE+-]+)", text)
    if lr_m:
        info["lr"] = lr_m[-1]

    ep_m = re.search(r"(?:epoch|Epoch)\s*[:= ]\s*(\d+)(?:\s*/\s*(\d+))?", text)
    if ep_m:
        info["epoch"] = f"{ep_m.group(1)}/{ep_m.group(2)}" if ep_m.group(2) else ep_m.group(1)

    speed_m = list(re.finditer(r"([0-9.]+)\s*(it/s|s/it)", text))
    if speed_m:
        last = speed_m[-1]
        info["speed"] = last.group(1) + last.group(2)

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

_latest_config_mtime: float = 0.0
_latest_config_cache: dict = {}


def latest_train_config() -> dict:
    """解析最新的 autosave TOML 配置"""
    if not CONFIG_AUTOSAVE.exists():
        return {}
    configs = sorted(
        CONFIG_AUTOSAVE.glob("*.toml"),
        key=lambda p: p.stat().st_mtime, reverse=True
    )
    if not configs:
        _latest_config_mtime = 0.0
        _latest_config_cache = {}
        return {}
    latest_mtime = configs[0].stat().st_mtime
    if _latest_config_mtime == latest_mtime and _latest_config_cache:
        return _latest_config_cache
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
            # 匹配引号字符串，支持转义引号和行内注释
            m = re.search(rf'^{key}\s*=\s*"(?P<v>(?:[^"\\]|\\.)*)"\s*(?:#.*)?$', text, re.MULTILINE)
            if not m:
                m = re.search(rf"^{key}\s*=\s*'(?P<v>(?:[^'\\]|\\.)*)'\s*(?:#.*)?$", text, re.MULTILINE)
            if m:
                params[key] = m.group("v")
        for key in num_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:#.*)?$', text, re.MULTILINE)
            if m:
                params[key] = m.group("v")
        for key in bool_keys:
            m = re.search(rf'^{key}\s*=\s*(?P<v>true|false)\s*$', text, re.MULTILINE | re.IGNORECASE)
            if m:
                params[key] = m.group("v").lower()

        if params:
            _latest_config_mtime = latest_mtime
            _latest_config_cache = params
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
