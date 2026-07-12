"""
训练状态解析 — 日志解析 + TensorBoard Event 读取 + TOML 配置解析
"""
from __future__ import annotations

import logging
import re
import threading
import time
import tomllib
from pathlib import Path
from typing import Any

from backend.constants import REPO_ROOT, OUTPUT_DIR
from backend.constants import AUTOSAVE_DIR as CONFIG_AUTOSAVE
from backend.training.field_registry import FIELDS as _REGISTRY_FIELDS

# TensorBoard 的 DirectoryWatcher 会在每次读到当前 event 文件末尾时输出
# "No path found after ..."。这是正常轮询状态，不应污染训练控制台。
logging.getLogger("tensorboard").setLevel(logging.WARNING)

# ── TensorBoard Event 缓存 ─────────────────────────────────
# 缓存 EventAccumulator 实例，按 log_dir 索引
# 每次请求检查 event file mtime，仅在文件更新时重新 Reload
_tb_cache: dict[str, tuple[float, float, str, Any]] = {}
_tb_cache_lock = threading.Lock()
_CACHE_TTL = 2.0  # 缓存有效期（秒），避免频繁 Reload

# 增量读取用：按 (log_dir_str, tag) 追踪已推送的最大 step
_last_seen_step: dict[tuple[str, str], int] = {}
_last_seen_step_lock = threading.Lock()
_MAX_SEEN_ENTRIES = 200  # 防止无限增长

# ── Autosave TOML glob 缓存 ─────────────────────────────────
_autosave_glob_cache: tuple[float, list[Path]] | None = None
_autosave_glob_cache_lock = threading.Lock()
_AUTOSAVE_GLOB_TTL = 5.0  # 缓存有效期（秒），训练期间 autosave 不常变


def _get_cached_accumulator(log_dir: Path) -> Any | None:
    """获取缓存的 EventAccumulator，若 event file 未变化则复用"""
    try:
        from tensorboard.backend.event_processing import event_accumulator
    except Exception:
        return None

    log_dir_str = str(log_dir)
    event_files = list(log_dir.rglob("events.out.tfevents.*"))
    if not event_files:
        with _tb_cache_lock:
            _tb_cache.pop(log_dir_str, None)
        return None

    # 使用最新 event file 的所在目录（EventAccumulator 不递归搜索子目录）
    ef_with_mtime = [(p, p.stat().st_mtime) for p in event_files]
    ef_with_mtime.sort(key=lambda x: x[1], reverse=True)
    latest_ef_path, latest_mtime = ef_with_mtime[0]
    event_dir = str(latest_ef_path.parent)  # 实际包含 event file 的目录
    now = time.time()

    with _tb_cache_lock:
        if log_dir_str in _tb_cache:
            cache_time, cached_mtime, cached_event_dir, cached_ea = _tb_cache[log_dir_str]
            if cached_event_dir == event_dir and (now - cache_time) < _CACHE_TTL:
                return cached_ea

            if cached_event_dir == event_dir and cached_mtime == latest_mtime:
                _tb_cache[log_dir_str] = (now, cached_mtime, cached_event_dir, cached_ea)
                return cached_ea

            if cached_event_dir == event_dir:
                try:
                    cached_ea.Reload()
                    _tb_cache[log_dir_str] = (now, latest_mtime, event_dir, cached_ea)
                    return cached_ea
                except Exception:
                    _tb_cache.pop(log_dir_str, None)

    # 缓存未命中或过期：创建新 accumulator
    try:
        ea = event_accumulator.EventAccumulator(
            event_dir,
            size_guidance={event_accumulator.SCALARS: 0},
        )
        ea.Reload()
        with _tb_cache_lock:
            _tb_cache[log_dir_str] = (now, latest_mtime, event_dir, ea)
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

            with _last_seen_step_lock:
                last_step = _last_seen_step.get((log_dir_str, tag), -1)
            new_points = [
                {"step": int(e.step), "value": round(float(e.value), 6)}
                for e in events
                if int(e.step) > last_step
            ]
            if not new_points:
                continue

            result[tag] = new_points
            # 更新 last_seen_step（线程安全）
            max_step = max(p["step"] for p in new_points)
            with _last_seen_step_lock:
                _last_seen_step[(log_dir_str, tag)] = max_step

    # 清理过大的追踪字典（LRU 淘汰最旧的条目）
    with _last_seen_step_lock:
        if len(_last_seen_step) > _MAX_SEEN_ENTRIES:
            # 单次 O(n) 找到最小值，避免 O(n log n) 排序
            overflow = len(_last_seen_step) - _MAX_SEEN_ENTRIES
            for _ in range(overflow):
                oldest_key = min(_last_seen_step, key=lambda k: _last_seen_step[k])
                del _last_seen_step[oldest_key]

    return result


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


def parse_log_progress(lines: list[str]) -> dict:
    """从训练日志中解析进度、Loss、LR"""
    text = "\n".join(lines[-3000:])
    info: dict[str, Any] = {}

    # 进度: "steps: 45%|████ | 450/1000 [02:30<03:03]"
    # 取最后一个匹配（最新进度），而不是 search() 返回的第一个
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

    error_matchers = [
        _RE_ERROR_TRACEBACK, _RE_ERROR_CUDA,
        _RE_ERROR_EXEC, _RE_ERROR_EXIT,
        _RE_ERROR_FAIL,
    ]
    for pattern in error_matchers:
        if pattern.search(text):
            info["has_error"] = True
            m = pattern.search(text)
            info["error_msg"] = m.group(0) if m else ""
            break

    return info


# ── 训练配置解析 (TOML) ────────────────────────────────────

_latest_config_cache: dict[tuple[str | None, float], dict] = {}
_MAX_CONFIG_CACHE = 32


def _evict_config_cache() -> None:
    """LRU 淘汰：保留最近 32 条缓存记录"""
    if len(_latest_config_cache) <= _MAX_CONFIG_CACHE:
        return
    sorted_keys = sorted(_latest_config_cache.keys(), key=lambda k: k[1], reverse=True)
    for key in sorted_keys[_MAX_CONFIG_CACHE:]:
        del _latest_config_cache[key]


def latest_train_config(task_id: str | None = None) -> dict:
    """解析最新的 autosave TOML 配置"""
    global _autosave_glob_cache
    if not CONFIG_AUTOSAVE.exists():
        return {}

    now = time.time()
    with _autosave_glob_cache_lock:
        if _autosave_glob_cache and now - _autosave_glob_cache[0] < _AUTOSAVE_GLOB_TTL:
            configs = _autosave_glob_cache[1]
        else:
            configs = sorted(
                CONFIG_AUTOSAVE.glob("*.toml"),
                key=lambda p: p.stat().st_mtime, reverse=True
            )
            _autosave_glob_cache = (now, configs)

    if not configs:
        return {}
    latest_mtime = configs[0].stat().st_mtime
    cache_key = (task_id, latest_mtime)
    if cache_key in _latest_config_cache:
        return _latest_config_cache[cache_key]
    for cfg_path in configs[:3]:
        try:
            with cfg_path.open("rb") as f:
                params = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError, Exception):
            continue

        if params:
            _latest_config_cache[cache_key] = params
            _evict_config_cache()
            return params
    return {}


def _format_param_value(key: str, v: Any, field: dict | None) -> str:
    """将 TOML 原生值格式化为展示字符串。

    - 布尔 → "true"/"false"（前端 toggle 字段会渲染为 ✓/✕ 徽标，此处保留可读文本兜底）
    - list → 逗号连接的字符串
    - learning_rate/unet_lr/text_encoder_lr 等小学习率用科学计数法
    - 路径类字段保留原值
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        # 学习率类字段：小量值用科学计数法更易读
        if key in ("learning_rate", "unet_lr", "text_encoder_lr") and 0 < abs(v) < 0.001:
            return f"{float(v):.2e}"
        return str(v)
    return str(v)


# 预构建 registry 索引：key → field 元数据（仅 target=toml 且非 hidden 的字段）
_REGISTRY_INDEX: dict[str, dict] = {
    f["key"]: f for f in _REGISTRY_FIELDS
    if f.get("target") == "toml" and not f.get("hidden")
}
# section 输出顺序（与 field_registry.get_fields_json 一致）
_SECTION_ORDER = ["model", "network", "training", "optimizer",
                  "regularization", "caption", "performance", "save", "preview"]


def extract_train_params(config: dict) -> list[dict]:
    """从 TOML 配置提取结构化训练参数，按 registry 分组输出。

    返回条目格式（供前端分组渲染 + 本地化标签）::

        {key, desc_key, value, section, advanced, type, label_raw?}

    - ``desc_key`` — registry 字段的 i18n 键，前端 ``t(desc_key)`` 取本地化标签
    - ``section``   — registry 分组（model/network/.../preview），前端 ``t('section.'+s)`` 取组标题
    - ``type``      — 字段输入类型（toggle → 前端渲染 ✓/✕ 徽标）
    - ``advanced``  — 是否进阶参数（本次平铺显示，保留供未来折叠）
    - ``label_raw`` — 仅 network_args/optimizer_args 解析出的 ``algo=lokr`` 这类自定义项：
                      无 desc_key，直接显示键名作为标签
    """
    if not config:
        return []

    params: list[dict] = []
    seen_keys: set[str] = set()

    # 1) registry 字段：按 section 顺序遍历，保证分组与字段顺序稳定
    #    hidden 字段（如 logging_dir/log_with）在前端表单不展示，但训练时仍写入
    #    config.toml 并实际生效——只要 config 里存在且非空就显示，避免遗漏生效配置。
    for section in _SECTION_ORDER:
        for f in _REGISTRY_FIELDS:
            if f.get("target") != "toml":
                continue
            if f["section"] != section:
                continue
            key = f["key"]
            if key not in config:
                continue
            v = config[key]
            if v is None or v == "":
                continue
            entry = {
                "key": key,
                "desc_key": f.get("desc_key", ""),
                "value": _format_param_value(key, v, f),
                "section": section,
                "advanced": bool(f.get("advanced", False)),
                "type": f.get("type", "text"),
            }
            params.append(entry)
            seen_keys.add(key)

    # 2) network_args / optimizer_args：adapter 折叠的 LyCORIS/优化器子参数数组
    #    形如 ["algo=lokr", "preset=attn-mlp"] → 拆成独立条目，归入对应 section
    for arr_key, section in (("network_args", "network"), ("optimizer_args", "optimizer")):
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
            params.append({
                "key": f"{arr_key}.{k}",
                "desc_key": "",
                "value": val,
                "section": section,
                "advanced": True,
                "type": "text",
                "label_raw": k,
            })

    return params
