"""
训练状态解析 — 日志解析 + TensorBoard Event 读取 + TOML 配置解析
"""
from __future__ import annotations

import ast
import logging
import math
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from backend.constants import OUTPUT_DIR
from backend.training.fields.field_registry import get_all_fields, field_applies_to_profile


_REGISTRY_FIELDS = get_all_fields()

# TensorBoard 的 DirectoryWatcher 会在每次读到当前 event 文件末尾时输出
# "No path found after ..."。这是正常增量读取状态，不应污染训练控制台。
logging.getLogger("tensorboard").setLevel(logging.WARNING)

# ── TensorBoard Event 缓存 ─────────────────────────────────
# 缓存 EventAccumulator 实例，按 log_dir 索引
# 每次请求检查 event file 的时间与大小；新 step 写入后立即 Reload。
_tb_cache: dict[str, tuple[float, tuple[str, int, int], str, Any]] = {}
_tb_cache_lock = threading.Lock()
# Foreign sample sources retain only their small epoch tables, so several
# resumed runs do not evict the current run's full step/LR accumulator.
_tb_epoch_cache: dict[str, tuple] = {}

# Live readers retain file cursors and new points, not the complete scalar history.
_tb_live_cache: dict[str, tuple] = {}
_tb_live_lock = threading.Lock()

# 监控面板采集的 TensorBoard scalar 标签（全量与增量读取共用）
_LOSS_TAGS = (
    "loss/average", "loss/current", "loss/epoch_average", "loss/epoch",
    "loss/timestep/epoch/low", "loss/timestep/epoch/mid", "loss/timestep/epoch/high",
)
_STEP_LOSS_TAGS = {"loss/average", "loss/current"}


def _is_epoch_loss_tag(tag: str) -> bool:
    return tag in {"loss/epoch", "loss/epoch_average"} or tag.startswith("loss/timestep/epoch/")


def _is_lr_tag(tag: str) -> bool:
    return tag.startswith("lr/") and tag != "lr/backbone"


def primary_learning_rate_tag(tags: Iterable[str]) -> str | None:
    """Select a native backbone group, preferring adaptive scalar metrics."""
    tags = tuple(tags)
    for prefix in ("lr/d*eff_lr/", "lr/d*lr/", "lr/"):
        matches = [tag for tag in tags if tag.startswith(prefix)
                   and re.match(r"(?:unet(?:$|[ _])|group\d+(?:$|[ _]))", tag[len(prefix):])]
        if matches:
            standard = prefix + "unet"
            return standard if standard in matches else matches[0]
    return None


def _get_cached_accumulator(log_dir: Path, *, incremental: bool = False, epoch_only: bool = False) -> Any | None:
    """获取缓存的 EventAccumulator，若 event file 未变化则复用"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return None

    cache = _tb_live_cache if incremental else _tb_epoch_cache if epoch_only else _tb_cache
    log_dir_str = str(log_dir)
    event_files = list(log_dir.rglob("events.out.tfevents.*"))
    if not event_files:
        with _tb_cache_lock:
            cache.pop(log_dir_str, None)
        return None

    # 使用最新 event file 的所在目录（EventAccumulator 不递归搜索子目录）
    ef_with_stat = [(p, p.stat()) for p in event_files]
    ef_with_stat.sort(key=lambda x: x[1].st_mtime_ns, reverse=True)
    latest_ef_path, latest_stat = ef_with_stat[0]
    stamp = (str(latest_ef_path), latest_stat.st_mtime_ns, latest_stat.st_size)
    event_dir = str(latest_ef_path.parent)  # 实际包含 event file 的目录
    now = time.time()

    with _tb_cache_lock:
        if log_dir_str in cache:
            _, cached_stamp, cached_event_dir, cached_ea = cache[log_dir_str]
            if cached_event_dir == event_dir and cached_stamp == stamp:
                cache[log_dir_str] = (now, stamp, cached_event_dir, cached_ea)
                return cached_ea

            if cached_event_dir == event_dir:
                try:
                    cached_ea.Reload()
                    cache[log_dir_str] = (now, stamp, event_dir, cached_ea)
                    return cached_ea
                except Exception:
                    cache.pop(log_dir_str, None)

    # 缓存未命中或日志目录切换：创建新 accumulator
    try:
        accumulator_type = event_accumulator.EventAccumulator
        if incremental:
            class LiveAccumulator(accumulator_type):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    self.pending = {}
                    self.last_steps = {}

                def _ProcessScalar(self, tag, wall_time, step, scalar):
                    if not math.isfinite(scalar):
                        return
                    if tag in _STEP_LOSS_TAGS:
                        # 同一步的修正可能在下一次轮询才写入。
                        point = {"step": step, "value": scalar}
                        if tag == "loss/current" and math.isfinite(wall_time):
                            point["wall_time"] = wall_time
                        self.pending.setdefault(tag, {})[step] = point
                    elif (tag in _LOSS_TAGS or _is_lr_tag(tag)) and step > self.last_steps.get(tag, -1):
                        self.pending.setdefault(tag, {})[step] = {"step": step, "value": scalar}
                        self.last_steps[tag] = step

            accumulator_type = LiveAccumulator
        elif epoch_only:
            class EpochAccumulator(accumulator_type):
                def _ProcessScalar(self, tag, wall_time, step, scalar):
                    if _is_epoch_loss_tag(tag):
                        super()._ProcessScalar(tag, wall_time, step, scalar)

            accumulator_type = EpochAccumulator
        ea = accumulator_type(
            event_dir,
            size_guidance={event_accumulator.SCALARS: 0},
        )
        ea.Reload()
        with _tb_cache_lock:
            cache[log_dir_str] = (now, stamp, event_dir, ea)
            # Epoch-only readers are much smaller than complete step histories.
            if len(cache) > (16 if epoch_only else 3):
                oldest = min(cache, key=lambda k: cache[k][0])
                del cache[oldest]
        return ea
    except Exception:
        return None


# ── TensorBoard Event 降采样 (LTTB) ────────────────────────

def _lttb_downsample(points, target: int):
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
        pa_x = points[a].step
        pa_y = points[a].value

        for j in range(bucket_start, bucket_end):
            area = abs(
                (points[j].step - pa_x) * (points[n - 1].value - pa_y)
                - (points[n - 1].step - pa_x) * (points[j].value - pa_y)
            )
            if area > max_area:
                max_area = area
                max_idx = j

        result.append(points[max_idx])
        a = max_idx

    result.append(points[-1])
    return result


def read_tensorboard_loss(
    limit: int | None = None,
    downsample_to: int = 2000,
    run_dir: str | None = None,
    *,
    epoch_only: bool = False,
) -> list[dict]:
    """从 TensorBoard event 文件读取 Loss/LR scalar，自动降采样。
    若指定 run_dir，仅读取该目录下的 log/；否则扫描 output/*/log/（按 mtime 倒序取最新）。
    使用缓存避免高频实时采样时重复解析 event 文件。"""
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
        # 兼容：run_dir 本身就是 outputs 父目录
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

    for log_dir in (log_dirs[:1] if run_dir else log_dirs[:5]):
        ea = _get_cached_accumulator(log_dir, epoch_only=epoch_only)
        if ea is None:
            continue

        try:
            available = ea.Tags().get("scalars", [])
        except Exception:
            continue

        scalar_tags = [tag for tag in _LOSS_TAGS if tag in available and (not epoch_only or _is_epoch_loss_tag(tag))]
        if not epoch_only:
            scalar_tags.extend(tag for tag in available if _is_lr_tag(tag))
        series_list = []
        for tag in scalar_tags:
            try:
                events = ea.Scalars(tag)
            except Exception:
                continue
            # Full step curves use every epoch. Keep the existing cap for raw
            # exports and epoch series, which are returned without downsampling.
            sample_curve = downsample_to >= 3 and not _is_epoch_loss_tag(tag)
            window = limit if limit is not None or sample_curve else 50000
            source = events[-window:] if window else events
            finite = [event for event in source if math.isfinite(event.value)]
            if not finite:
                continue
            primary = tag in _STEP_LOSS_TAGS
            extrema = finite
            if primary and len(source) < len(events):
                extrema = (e for e in events if math.isfinite(e.value))
            best = min(extrema, key=lambda e: e.value)
            curve = _lttb_downsample(finite, downsample_to) if sample_curve and len(finite) > downsample_to else finite
            if primary:
                by_step = {event.step: event for event in finite}
                tail = [by_step[step] for step in sorted(by_step)[-160:]]
            else:
                tail = finite[-40:]
            series_list.append({
                "tag": tag,
                "name": tag.replace("/", " ").replace("_", " "),
                "points": [{"step": int(e.step), "value": float(e.value)} for e in curve],
                "latest": float(finite[-1].value),
                "min": float(best.value),
                "min_step": int(best.step),
                "max": float(max(e.value for e in finite)),
                # 小图需要连续的最新原始点；全局 LTTB 曲线的尾部会随重采样改变。
                # 40 个诊断观测各需前置 120 点；参照图仍由前端截取最近 120 点。
                "diagnostic_points": [{"step": int(e.step), "value": float(e.value)} for e in tail],
                **({"latest_wall_time": tail[-1].wall_time} if tag == "loss/current" and math.isfinite(tail[-1].wall_time) else {}),
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

    with _tb_live_lock:
        for log_dir in log_dirs[:1]:
            ea = _get_cached_accumulator(log_dir, incremental=True)
            if ea is not None:
                pending, ea.pending = ea.pending, {}
                return {
                    tag: [values[step] for step in sorted(values)]
                    for tag, values in pending.items()
                }
    return {}


# ── 训练日志解析 ───────────────────────────────────────────

# ── 训练日志解析正则（模块级预编译，避免每次调用重复匹配） ──
_RE_PROGRESS = re.compile(
    r"steps:\s*(?P<pct>\d{1,3})%\|.*?\|\s*(?P<step>\d+)\s*/\s*(?P<total>\d+)"
    r"(?:\s*\[(?P<elapsed>[^<,\]]+)(?:<(?P<eta>[^,\]]+))?[^\]]*\])?"
)
_RE_LOSS_CURRENT = re.compile(r"loss/current\s*[=:]\s*([0-9.eE+-]+)")
_RE_LOSS_AVERAGE = re.compile(r"loss/average\s*[=:]\s*([0-9.eE+-]+)")
_RE_LOSS_TRAIN = re.compile(r"train_loss\s*[=:]\s*([0-9.eE+-]+)")
_RE_LOSS_AVR = re.compile(r"avr_loss\s*[=:]\s*([0-9.eE+-]+)")
_RE_LOSS_GENERIC = re.compile(r"\bloss\b(?!/(?:current|average|epoch))\s*[=:]\s*([0-9.eE+-]+)")
_RE_LR = re.compile(r"(?:lr|learning_rate)\s*[=:]\s*([0-9.eE+-]+)")
_RE_EPOCH = re.compile(r"(?:epoch|Epoch)\s*[:= ]\s*(\d+)(?:\s*/\s*(\d+))?")
_RE_SPEED = re.compile(r"([0-9.]+)\s*(it/s|s/it)")
_RE_ERROR_TRACEBACK = re.compile(r"\btraceback\b", re.IGNORECASE)
_RE_ERROR_CUDA = re.compile(r"cuda out of memory", re.IGNORECASE)
_RE_ERROR_EXEC = re.compile(r"error executing job", re.IGNORECASE)
_RE_ERROR_EXIT = re.compile(r"exited with code [1-9]", re.IGNORECASE)
_RE_ERROR_FAIL = re.compile(r"failed to (?:load|initialize|open|import|download|start|create)", re.IGNORECASE)


def parse_log_progress(lines: list[str], native: dict | None = None) -> dict:
    """从训练日志中解析进度、Loss、LR"""
    text = "\n".join(lines[-3000:])
    info = dict(native or {})
    if not info.get("error_msg"):
        for pattern in (_RE_ERROR_CUDA, _RE_ERROR_FAIL, _RE_ERROR_EXEC, _RE_ERROR_EXIT, _RE_ERROR_TRACEBACK):
            match = pattern.search(text)
            if match:
                info.update(has_error=True, error_msg=match.group(0))
                break
    if native:
        return info

    # 进度: "steps: 45%|████ | 450/1000 [02:30<03:03]"
    # 最后一条匹配记录是最新训练进度。
    progress_matches = list(_RE_PROGRESS.finditer(text))
    if progress_matches:
        m = progress_matches[-1]
        step = int(m.group("step"))
        total = int(m.group("total"))
        info["step"] = step
        info["total_steps"] = total
        info["percent"] = min(100.0, round(step * 100 / total, 2)) if total else 0
        info["eta"] = m.group("eta") or ""
        info["elapsed"] = m.group("elapsed") or ""

    # 按优先级解析 loss：loss/current > loss/average > train_loss > avr_loss > loss
    # 每个模式取最后一次匹配（最新值），避免取到日志开头的旧数据
    loss_matchers = [
        (_RE_LOSS_CURRENT, "loss/current"),
        (_RE_LOSS_AVERAGE, "loss/average"),
        (_RE_LOSS_TRAIN, "train_loss"),
        (_RE_LOSS_AVR, "avr_loss"),
        (_RE_LOSS_GENERIC, "loss"),
    ]
    for pattern, _name in loss_matchers:
        loss_matches = list(pattern.finditer(text))
        if loss_matches:
            info["loss"] = loss_matches[-1].group(1)
            break

    lr_m = _RE_LR.findall(text)
    if lr_m:
        info["lr"] = lr_m[-1]

    # epoch 取最后一次匹配（最新值）
    ep_matches = list(_RE_EPOCH.finditer(text))
    if ep_matches:
        ep_m = ep_matches[-1]
        info["epoch"] = f"{ep_m.group(1)}/{ep_m.group(2)}" if ep_m.group(2) else ep_m.group(1)

    # 速度必须来自同一条最新训练进度，不能从缓存、下载等其他 tqdm 行误抓。
    speed_m = list(_RE_SPEED.finditer(m.group(0))) if progress_matches else []
    if speed_m:
        last = speed_m[-1]
        info["speed"] = last.group(1) + last.group(2)

    return info


def _format_param_value(key: str, v: Any) -> str:
    """将 TOML 原生值格式化为展示字符串。

    - 布尔 → "true"/"false"，由前端展示为开启/关闭
    - list → 逗号连接的字符串
    - 数值保留原始精度，由界面按字段定义展示
    - 路径类字段保留原值
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)


# section 输出顺序（与 field_registry.get_fields_json 一致）
_SECTION_ORDER = ["model", "network", "training", "optimizer",
                  "regularization", "caption", "performance", "save", "preview"]


def extract_train_params(config: dict, profile_id: str = "") -> list[dict]:
    """从 TOML 配置提取结构化训练参数，按 registry 分组输出。

    返回条目格式（供前端分组渲染 + 本地化标签）::

        {key, desc_key, value, section, type, label_raw?}

    - ``desc_key`` — registry 字段的 i18n 键，前端 ``t(desc_key)`` 取本地化标签
    - ``section``   — registry 分组（model/network/.../preview），前端 ``t('section.'+s)`` 取组标题
    - ``type``      — 字段输入类型（toggle → 前端渲染 ✓/✕ 徽标）
    - ``label_raw`` — 仅 network_args/optimizer_args 解析出的 ``algo=lokr`` 这类自定义项：
                      无 desc_key，直接显示键名作为标签
    """
    if not config:
        return []

    params: list[dict] = []
    profile_id = profile_id or config.get("model_train_type", "")
    if not profile_id and "dit" in config and "text_encoder" in config:
        profile_id = "krea2-lora"
    seen = set()

    # 1) registry 字段：按 section 顺序遍历，保证分组与字段顺序稳定
    #    hidden 字段（如 logging_dir/log_with）在前端表单不展示，但训练时仍写入
    #    config.toml 并实际生效——只要 config 里存在且非空就显示，避免遗漏生效配置。
    for section in _SECTION_ORDER:
        for f in _REGISTRY_FIELDS:
            if not field_applies_to_profile(f, profile_id):
                continue
            if profile_id != "krea2-lora" and f.get("target") != "toml":
                continue
            if f["section"] != section:
                continue
            key = f["key"]
            if key not in config or key in seen:
                continue
            v = config[key]
            if v is None or v == "":
                continue
            entry = {
                "key": key,
                "desc_key": f.get("desc_key", ""),
                "value": _format_param_value(key, v),
                "section": section,
                "type": f.get("type", "text"),
            }
            params.append(entry)
            seen.add(key)

    # Runtime-only and legacy fields remain inspectable without guessing a label.
    for key, value in config.items():
        if key not in seen and key not in {"network_args", "optimizer_args", "lr_scheduler_args"} and value is not None and value != "":
            params.append({"key": key, "desc_key": "", "label_raw": key,
                           "value": _format_param_value(key, value), "section": "misc", "type": "text"})

    # 2) adapter 折叠的网络/优化器/调度器子参数数组
    #    形如 ["algo=lokr", "preset=attn-mlp"] → 拆成独立条目，归入对应 section
    for arr_key, section in (("network_args", "network"), ("optimizer_args", "optimizer"), ("lr_scheduler_args", "optimizer")):
        arr = config.get(arr_key)
        if not isinstance(arr, list) or not arr:
            continue
        for item in arr:
            s = str(item).strip()
            if not s:
                continue
            if "=" in s:
                k, _, val = s.partition("=")
                k = k.strip()
                val = val.strip()
            else:
                k, val = s, "true"
            # 跳过空键（如纯标志位无值时 k 已是值，仍展示）
            entry = {
                "key": f"{arr_key}.{k}",
                "desc_key": "",
                "value": val,
                "section": section,
                "type": "text",
                "label_raw": k,
            }
            # 保留原文字面量；已知表单文本/选项可另外使用解码后的字符串。
            if arr_key != "network_args" and val and val[0] in {"'", '"'}:
                try:
                    decoded = ast.literal_eval(val)
                except (ValueError, SyntaxError):
                    pass
                else:
                    if isinstance(decoded, str):
                        entry["string_value"] = decoded
            params.append(entry)

    return params
