"""
训练产物 — 预览样本扫描 + 历史记录 + 日志文件读取
"""
from __future__ import annotations

import json
import re
import threading
import time
import tomllib
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from backend.constants import REPO_ROOT, OUTPUT_DIR
from backend.monitor.run_registry import import_legacy_external_runs, iter_run_records
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# 隐藏 / 缓存目录名前缀与名称，扫描时一律跳过（避免 .ipynb_checkpoints、__pycache__ 等污染）
_HIDDEN_PREFIXES = (".", "__")


def _is_hidden(name: str) -> bool:
    """判断目录/文件名是否为隐藏或缓存项（.开头 或 __开头）。"""
    return name.startswith(_HIDDEN_PREFIXES)


def _iter_dir(root: Path):
    """安全遍历目录树：rglob 替代，跳过隐藏/缓存子目录与文件。"""
    for p in root.rglob("*"):
        # 检查路径中任一成分是否为隐藏目录
        if any(_is_hidden(part) for part in p.relative_to(root).parts):
            continue
        yield p


# ── 缓存 + 线程安全锁 ────────────────────────────────────
_history_cache_lock = threading.Lock()
_history_cache: tuple[float, list[dict]] | None = None
_HISTORY_CACHE_TTL = 30  # 秒


def invalidate_history_cache() -> None:
    """失效历史记录缓存（删除/新增记录后调用）。"""
    global _history_cache
    with _history_cache_lock:
        _history_cache = None


# ── 预览样本 ──────────────────────────────────────────────

_previews_cache_lock = threading.Lock()
_previews_cache: tuple[float, str, list[dict]] | None = None
_PREVIEWS_CACHE_TTL = 5.0


def newest_previews(
    output_dir: str | None = None,
    limit: int = 0,
    force_refresh: bool = False,
    run_dir: str = "",
) -> list[dict]:
    """扫描最新的训练样本图（扁平结构：run_dir/sample/ → run_dir/；兼容旧 outputs/sample/）

    limit: 返回的最新样本数量上限；0 表示返回全部（按 mtime 升序，最新在末尾）。
    force_refresh: True 时跳过 5s 缓存，立即重新扫描磁盘并覆盖缓存。
    """
    global _previews_cache
    now = time.time()
    cache_key = f"{run_dir}|{output_dir or ''}|{int(limit or 0)}"
    if not force_refresh:
        with _previews_cache_lock:
            if _previews_cache and _previews_cache[1] == cache_key and now - _previews_cache[0] < _PREVIEWS_CACHE_TTL:
                return _previews_cache[2]

    recursive_roots: list[Path] = []
    flat_roots: list[Path] = []
    if not output_dir:
        with _previews_cache_lock:
            _previews_cache = (now, cache_key, [])
        return []
    if output_dir:
        try:
            od = Path(output_dir).resolve()
        except OSError:
            with _previews_cache_lock:
                _previews_cache = (now, cache_key, [])
            return []
        if not od.is_dir():
            with _previews_cache_lock:
                _previews_cache = (now, cache_key, [])
            return []
        recursive_roots.extend([od / "sample", od / "outputs" / "sample"])
        flat_roots.extend([od, od / "outputs"])

    found: list[Path] = []
    seen: set[Path] = set()
    for root in recursive_roots:
        if not root.exists():
            continue
        for p in _iter_dir(root):
            if not p.is_file():
                continue
            if p.suffix.lower() not in IMAGE_EXTENSIONS or p in seen:
                continue
            seen.add(p)
            found.append(p)
    for root in flat_roots:
        if not root.exists():
            continue
        for p in root.iterdir():
            if not p.is_file() or _is_hidden(p.name):
                continue
            if p.suffix.lower() not in IMAGE_EXTENSIONS or p in seen:
                continue
            seen.add(p)
            found.append(p)

    found.sort(key=lambda p: p.stat().st_mtime)
    selected = found[-limit:] if limit else found

    result = []
    for p in selected:
        try:
            rel = str(p.relative_to(od)).replace("\\", "/")
            stat = p.stat()
        except ValueError:
            continue
        except OSError:
            continue
        encoded_run = quote(run_dir, safe="")
        encoded_path = quote(rel, safe="/")
        version = f"{stat.st_mtime_ns}-{stat.st_size}"
        base = f"/api/monitor/preview-image?run_dir={encoded_run}&path={encoded_path}&v={version}"
        result.append({
            "name": p.name,
            "path": rel,
            "url": base + "&variant=original",
            "inspect_url": base + "&variant=inspect",
            "thumb_url": base + "&variant=thumb",
            "metadata_url": f"/api/monitor/preview-metadata?run_dir={encoded_run}&path={encoded_path}&v={version}",
            "size": stat.st_size,
            "version": version,
        })
    with _previews_cache_lock:
        _previews_cache = (now, cache_key, result)
    return result


# ── 历史记录 ──────────────────────────────────────────────

def _load_toml(path: Path) -> dict | None:
    """用 tomllib 真实解析 TOML 文件，返回完整 dict（含数组/布尔/数字原生类型）。

    替代早期手写 regex 解析器——旧版只能识别约 9 个硬编码 key 且对引号/数组处理粗糙，
    导致历史记录与监控页只能显示极少参数。改用标准库 tomllib 后可拿到全部字段。
    """
    try:
        with path.open("rb") as f:
            return tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError, Exception):
        return None


def _parse_toml_config(path: Path) -> dict | None:
    """从 TOML 配置文件中解析全部参数（完整 dict）。

    保留旧函数名以避免改动多个调用方；返回值从「9 个 key 的字符串 dict」
    升级为「完整原生类型 dict」。所有消费方均通过 ``.get(key)`` 取值并自行
    兜底/转字符串，因此类型变化向后兼容。
    """
    return _load_toml(path)


def scan_history() -> list[dict]:
    """扫描内部运行记录；旧跨盘记录会先由 autosave 幂等导入。"""
    global _history_cache
    now = time.time()
    with _history_cache_lock:
        if _history_cache and now - _history_cache[0] < _HISTORY_CACHE_TTL:
            return _history_cache[1]

    try:
        import_legacy_external_runs()
    except Exception:
        # 旧记录迁移是增强功能，失败不能影响现有历史页。
        pass
    history: list[dict] = []
    for record in iter_run_records():
        run_dir = Path(record["run_path"])
        config_file = run_dir / "config.toml"
        if not config_file.is_file():
            continue
        params = _parse_toml_config(config_file)
        if not params:
            continue
        try:
            st = config_file.stat()
        except OSError:
            continue

        status = ""
        duration = ""
        result_file = run_dir / "result.json"
        if result_file.exists():
            try:
                result_data = json.loads(result_file.read_text(encoding="utf-8"))
                status = result_data.get("status", "")
                duration = result_data.get("duration_str", "")
            except (OSError, json.JSONDecodeError):
                pass

        model_path = params.get("pretrained_model_name_or_path", "")
        history.append({
            "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            "timestamp": st.st_mtime,
            "run_dir": record["run_dir"],
            "artifact_dir": record["artifact_dir"],
            "artifact_available": record["artifact_available"],
            "artifact_external": record["artifact_external"],
            "preview_enabled": record["preview_enabled"],
            "imported": record["imported"],
            "config_file": config_file.name,
            "name": params.get("output_name", run_dir.name),
            "model": Path(model_path).name if model_path else "Unknown",
            "lr": params.get("learning_rate", "?"),
            "dim": params.get("network_dim", "?"),
            "alpha": params.get("network_alpha", ""),
            "epochs": params.get("max_train_epochs", "?"),
            "dataset": params.get("train_data_dir", ""),
            "status": status,
            "duration": duration,
        })

    history.sort(key=lambda item: item.get("timestamp", 0), reverse=True)

    with _history_cache_lock:
        _history_cache = (time.time(), history)
    return history


# ── Checkpoint 解析（文件名 → epoch/step 编号）──────────────
# 命名约定见 vendor/sd-scripts/library/checkpoint_io.py:
#   epoch 存档: {name}-{:06d}.{ext}      → my_lora-000003.safetensors
#   step  存档: {name}-step{:08d}.{ext}  → my_lora-step00001000.safetensors
#   最终  存档: {name}.{ext}             → my_lora.safetensors / last.safetensors

_RE_CKPT_EPOCH = re.compile(r"^(?P<name>.+)-(?P<epoch>\d{6})\.(?:safetensors|pt|pth)$")
_RE_CKPT_STEP = re.compile(r"^(?P<name>.+)-step(?P<step>\d{8})\.(?:safetensors|pt|pth)$")


def parse_checkpoint(name: str) -> dict | None:
    """从模型文件名解析 checkpoint 类型与编号。

    返回:
      {'type': 'epoch', 'epoch_no': N, 'step': None} |
      {'type': 'step',  'epoch_no': None, 'step': S} |
      {'type': 'final', 'epoch_no': None, 'step': None} |
      None（非 .safetensors/.pt/.pth 或无法识别）
    """
    if not name:
        return None
    suffix = name.rsplit(".", 1)[-1].lower()
    if ("." + suffix) not in LORA_EXTENSIONS:
        return None
    m = _RE_CKPT_STEP.search(name)
    if m:
        return {"type": "step", "epoch_no": None, "step": int(m.group("step"))}
    m = _RE_CKPT_EPOCH.search(name)
    if m:
        return {"type": "epoch", "epoch_no": int(m.group("epoch")), "step": None}
    # 无数字后缀的模型文件 → 最终存档
    return {"type": "final", "epoch_no": None, "step": None}


# loss/epoch_average 每 epoch 末追加一次，第 N 个点对应第 N 个 epoch。
# 见 vendor/sd-scripts/train_network.py:1803-1804（loss_recorder.moving_average + epoch_logging）。
_LOSS_EPOCH_AVG = "loss/epoch_average"


def _find_nearest_point(points: list[dict], target_step: int) -> float | None:
    """在已按 step 升序的 points 中找离 target_step 最近的点的 value。"""
    if not points:
        return None
    lo, hi = 0, len(points) - 1
    # 二分找左边界
    while lo < hi:
        mid = (lo + hi) >> 1
        if points[mid]["step"] < target_step:
            lo = mid + 1
        else:
            hi = mid
    # lo 是首个 step >= target 的点；比较 lo 与 lo-1 谁更近
    best_idx = lo
    if lo > 0 and abs(points[lo - 1]["step"] - target_step) <= abs(points[lo]["step"] - target_step):
        best_idx = lo - 1
    return points[best_idx]["value"]


def enrich_model_files_with_loss(files: list[dict], tb_series: list[dict], run_dir: str = "") -> list[dict]:
    """给 list_output_files 的结果中 model 类文件补充对应 loss。
    
    优先从 TensorBoard 读取；TB 无数据时回退到解析训练日志（从保存检查点
    之前的进度行提取 avr_loss/loss）。
    """
    if not files:
        return files
    # 预取常用 series，避免重复扫描
    epoch_avg = None
    step_series = None
    avg_latest = None
    if tb_series:
        for s in tb_series:
            tag = s.get("tag")
            if tag == _LOSS_EPOCH_AVG and epoch_avg is None:
                epoch_avg = s.get("points") or []
            if tag == "loss/average":
                avg_latest = s.get("latest")
            if tag == "loss/current":
                step_series = s.get("points") or []
            elif step_series is None and tag == "loss/average":
                step_series = s.get("points") or []

    has_tb_loss = bool(epoch_avg or step_series or avg_latest)

    for f in files:
        if f.get("category") != "model":
            continue
        ckpt_type = f.get("ckpt_type")
        loss = None
        try:
            if ckpt_type == "epoch" and f.get("ckpt_epoch") is not None and epoch_avg:
                idx = f["ckpt_epoch"] - 1
                if 0 <= idx < len(epoch_avg):
                    loss = epoch_avg[idx].get("value")
            elif ckpt_type == "step" and f.get("ckpt_step") is not None:
                loss = _find_nearest_point(step_series or [], f["ckpt_step"])
            elif ckpt_type == "final":
                loss = avg_latest
        except (KeyError, IndexError, TypeError):
            loss = None
        f["ckpt_loss"] = loss

    # 回退：TensorBoard 无数据时从训练日志提取
    if not has_tb_loss and run_dir:
        log_losses = _parse_log_checkpoint_losses(run_dir)
        for f in files:
            if f.get("category") != "model" or f.get("ckpt_loss") is not None:
                continue
            name = f.get("name", "")
            if name in log_losses:
                f["ckpt_loss"] = log_losses[name]

    return files


def _parse_log_checkpoint_losses(run_dir: str) -> dict[str, float]:
    """从训练日志中提取每个检查点保存前的 loss 值。
    
    解析模式：在 'saving checkpoint' 行之前查找 'avr_loss=X.XXX' 或 'loss=X.XXX'。
    返回 {文件名: loss值} 字典。
    """
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    if not rd.is_dir():
        return {}

    # 查找训练日志文件
    log_files = sorted(rd.glob("train_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not log_files:
        return {}

    lines = _tail_file(log_files[0])
    if not lines:
        return {}

    re_loss = re.compile(r'(?:avr_loss|loss)[:=]\s*([\d.]+)')
    # 匹配: saving checkpoint: .../name-000002.safetensors 或 name-step00001000.safetensors
    re_save = re.compile(
        r'saving\s+checkpoint.*?[/\\](?P<name>[\w.-]+?)(?:-step(?P<step>\d{8})|-(?P<epoch>\d{6}))\.safetensors'
    )
    # 也匹配最终存档（无数字后缀的 safetensors）
    re_final = re.compile(
        r'saving\s+checkpoint.*?[/\\](?P<name>[\w.-]+)\.safetensors\s*$'
    )

    losses: dict[str, float] = {}
    for i, line in enumerate(lines):
        m = re_save.search(line)
        if m:
            fname = m.group(0).split('/')[-1].split('\\')[-1].strip()
            # 向前查找 loss
            for j in range(i - 1, max(i - 6, -1), -1):
                lm = re_loss.search(lines[j])
                if lm:
                    losses[fname] = float(lm.group(1))
                    break
            continue
        m = re_final.search(line)
        if m:
            fname = m.group(0).split('/')[-1].split('\\')[-1].strip()
            for j in range(i - 1, max(i - 6, -1), -1):
                lm = re_loss.search(lines[j])
                if lm:
                    losses[fname] = float(lm.group(1))
                    break

    return losses


# ── 训练日志读取 ──────────────────────────────────────────

# 日志 tail 读取的最大字节数（实时快照读取用，约 20000+ 行）
_LOG_TAIL_BYTES = 2 * 1024 * 1024  # 2 MiB

# ANSI 转义序列正则（颜色、光标控制、清屏等）
_ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


def _clean_log_text(text: str) -> str:
    """清理训练日志中的终端控制字符：
    - 移除 ANSI 转义序列（颜色、光标移动等）
    - 处理 \\r 覆盖（tqdm 进度条）：每行只保留最后一次覆盖的结果
    """
    # 二进制切片读取不会像文本模式那样自动把 CRLF 归一化；先处理 Windows
    # 换行，避免下面的 tqdm "\r 覆盖" 逻辑误删正常行内容。
    text = text.replace("\r\n", "\n")
    # 移除 ANSI CSI 序列
    text = _ANSI_RE.sub('', text)
    # 处理 \r（tqdm 在同一行反复覆盖）：每段取最终值
    if '\r' in text:
        cleaned_lines = []
        for line in text.split('\n'):
            if '\r' in line:
                line = line.split('\r')[-1]
            cleaned_lines.append(line)
        text = '\n'.join(cleaned_lines)
    return text


def read_clean_log_lines(path: Path) -> list[str]:
    """Read a terminal log without universal-newline conversion changing CR overwrites."""
    content = path.read_bytes().decode("utf-8", errors="replace")
    content = _clean_log_text(content)
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _tail_file(path: Path, max_bytes: int = _LOG_TAIL_BYTES) -> list[str]:
    """高效读取文件尾部内容（不加载整个文件到内存），并清理终端控制字符"""
    try:
        size = path.stat().st_size
        if size == 0:
            return []
        with open(path, "rb") as f:
            if size <= max_bytes:
                f.seek(0)
                raw = f.read()
            else:
                f.seek(size - max_bytes)
                # 丢弃第一行（可能是不完整的行）
                raw = f.read()
                first_newline = raw.find(b"\n")
                if first_newline >= 0:
                    raw = raw[first_newline + 1:]
        content = raw.decode("utf-8", errors="replace")
        # 清理 ANSI + \r 覆盖
        content = _clean_log_text(content)
        lines = content.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return lines
    except OSError:
        return []


_log_file_cache: dict[str, tuple[float, Path]] = {}
_log_file_cache_lock = threading.Lock()
_LOG_FILE_CACHE_TTL = 10.0
_LOG_FILE_CACHE_MAX = 50  # 防止无限增长


LORA_EXTENSIONS = {".safetensors", ".pt", ".pth"}
# 日志/元数据文件在输出列表中归为"其他"分类，便于前端区分模型/样本/日志
META_FILES = {"config.toml", "run_info.txt", "output_dir.txt", "prompts.txt", "result.json",
               "error.log", "task_meta.json"}


def list_output_files(run_dir: str) -> list[dict]:
    """列出已由调用方验证的产物目录，路径统一相对该目录返回。"""
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    if not rd.exists() or not rd.is_dir():
        return []

    result = []
    for p in _iter_dir(rd):
        if not p.is_file():
            continue
        try:
            rel = str(p.relative_to(rd)).replace("\\", "/")
        except ValueError:
            continue
        suffix = p.suffix.lower()
        is_lora = suffix in LORA_EXTENSIONS
        is_image = suffix in IMAGE_EXTENSIONS
        if is_lora:
            category = "model"
        elif is_image:
            category = "sample"
        elif p.name in META_FILES or suffix in {".log", ".txt"}:
            category = "log"
        elif "events.out.tfevents" in p.name or suffix == ".tfevents":
            category = "tensorboard"
        else:
            category = "other"
        entry = {
            "name": p.name,
            "path": rel,
            "size": p.stat().st_size,
            "mtime": p.stat().st_mtime,
            "is_lora": is_lora,
            "category": category,
        }
        # 模型文件：从文件名解析 checkpoint 编号（loss 由路由层注入，需 TB series）
        if is_lora:
            info = parse_checkpoint(p.name)
            if info:
                entry["ckpt_type"] = info["type"]
                entry["ckpt_epoch"] = info["epoch_no"]
                entry["ckpt_step"] = info["step"]
            else:
                entry["ckpt_type"] = None
                entry["ckpt_epoch"] = None
                entry["ckpt_step"] = None
                entry["ckpt_loss"] = None
        result.append(entry)
    # 模型文件优先，其次样本，再日志，最后其他；同类按修改时间倒序
    cat_order = {"model": 0, "sample": 1, "log": 2, "tensorboard": 3, "other": 4}
    result.sort(key=lambda f: (cat_order.get(f["category"], 9), -f["mtime"]))
    return result


def find_train_log_path(task_id: str, output_dir: Path | None = None) -> Path | None:
    """查找训练日志文件路径（不读取内容）。
    优先从指定 output_dir 查找，否则扫描 output/ 子目录。结果写入路径缓存。"""
    now = time.time()
    task_id_short = task_id[:8]

    def _cache_log_path(tid: str, log_file: Path):
        """写入路径缓存（调用方需持有 _log_file_cache_lock）"""
        _log_file_cache[tid] = (now, log_file)
        if len(_log_file_cache) > _LOG_FILE_CACHE_MAX:
            oldest_key = min(_log_file_cache, key=lambda k: _log_file_cache[k][0])
            del _log_file_cache[oldest_key]

    # 先查缓存
    with _log_file_cache_lock:
        if task_id in _log_file_cache:
            cache_time, cached_path = _log_file_cache[task_id]
            if now - cache_time < _LOG_FILE_CACHE_TTL and cached_path.exists():
                return cached_path

    # 在指定目录查找
    if output_dir and output_dir.exists():
        for log_file in sorted(output_dir.glob(f"train_{task_id_short}*.log"),
                               key=lambda p: p.stat().st_mtime, reverse=True):
            if log_file.stat().st_size > 0:
                with _log_file_cache_lock:
                    _cache_log_path(task_id, log_file)
                return log_file

    # 回退：扫描所有运行子目录
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.iterdir(),
                              key=lambda p: p.stat().st_mtime if p.is_dir() else 0,
                              reverse=True):
            if not run_dir.is_dir():
                continue
            for log_file in sorted(run_dir.glob(f"train_{task_id_short}*.log"),
                                   key=lambda p: p.stat().st_mtime, reverse=True):
                if log_file.stat().st_size > 0:
                    with _log_file_cache_lock:
                        _cache_log_path(task_id, log_file)
                    return log_file

    return None


def read_train_log(task_id: str, output_dir: Path | None = None) -> list[str]:
    """读取训练任务的实时日志（tail 方式，高性能）。
    优先从指定 output_dir 读取，否则扫描 output/ 子目录"""
    now = time.time()
    with _log_file_cache_lock:
        if task_id in _log_file_cache:
            cache_time, cached_path = _log_file_cache[task_id]
            if now - cache_time < _LOG_FILE_CACHE_TTL and cached_path.exists():
                cached_path_ref = cached_path
            else:
                cached_path_ref = None
        else:
            cached_path_ref = None
    if cached_path_ref:
        lines = _tail_file(cached_path_ref)
        if lines:
            return lines

    # 使用 find_train_log_path 定位文件
    log_path = find_train_log_path(task_id, output_dir)
    if log_path:
        lines = _tail_file(log_path)
        if lines:
            return lines

    return []


# 完整日志分页：单次搜索返回的匹配行号上限（避免超大文件撑爆响应）
_LOG_SLICE_MAX_MATCHES = 5000
_LOG_INDEX_CACHE_MAX = 20
_LOG_INDEX_CHUNK_BYTES = 1024 * 1024
_log_index_cache_lock = threading.Lock()
_log_index_cache: dict[str, tuple[int, int, list[int], float]] = {}


def _scan_line_start_offsets(path: Path, start: int = 0) -> tuple[list[int], int]:
    """Return newline-following byte offsets and the byte position scanned to."""
    offsets: list[int] = []
    pos = start
    with open(path, "rb") as f:
        f.seek(start)
        while True:
            chunk = f.read(_LOG_INDEX_CHUNK_BYTES)
            if not chunk:
                break
            search_from = 0
            while True:
                idx = chunk.find(b"\n", search_from)
                if idx < 0:
                    break
                offsets.append(pos + idx + 1)
                search_from = idx + 1
            pos += len(chunk)
    return offsets, pos


def _get_log_line_offsets(log_path: Path) -> tuple[list[int], int]:
    """Get cached line-start byte offsets for a log file.

    offsets[0] is always 0. Additional offsets point at the first byte after
    every newline. The cache is incremental for growing live logs, so tail/page
    reads do not rebuild the whole index on every request.
    """
    stat = log_path.stat()
    size = stat.st_size
    mtime_ns = stat.st_mtime_ns
    key = str(log_path.resolve())
    now = time.time()

    with _log_index_cache_lock:
        cached = _log_index_cache.get(key)
        if cached:
            cached_mtime_ns, cached_size, cached_offsets, _ = cached
            if cached_size == size and cached_mtime_ns == mtime_ns:
                _log_index_cache[key] = (cached_mtime_ns, cached_size, cached_offsets, now)
                return cached_offsets, size
            if size > cached_size:
                base_offsets = cached_offsets
                start = cached_size
            else:
                base_offsets = [0]
                start = 0
        else:
            base_offsets = [0]
            start = 0

    new_offsets, scanned_size = _scan_line_start_offsets(log_path, start)
    offsets = base_offsets + new_offsets
    if not offsets:
        offsets = [0]

    with _log_index_cache_lock:
        try:
            mtime_ns = log_path.stat().st_mtime_ns
        except OSError:
            pass
        _log_index_cache[key] = (mtime_ns, scanned_size, offsets, now)
        if len(_log_index_cache) > _LOG_INDEX_CACHE_MAX:
            oldest_key = min(_log_index_cache, key=lambda k: _log_index_cache[k][3])
            del _log_index_cache[oldest_key]
    return offsets, scanned_size


def _log_line_count(offsets: list[int], size: int) -> int:
    if size <= 0:
        return 0
    if offsets and offsets[-1] == size:
        return max(0, len(offsets) - 1)
    return len(offsets)


def _read_log_lines_by_offset(log_path: Path, offsets: list[int], size: int,
                              start_line: int, end_line: int) -> list[str]:
    if start_line >= end_line:
        return []
    start_byte = offsets[start_line]
    end_byte = offsets[end_line] if end_line < len(offsets) else size
    if end_byte <= start_byte:
        return []
    with open(log_path, "rb") as f:
        f.seek(start_byte)
        raw = f.read(end_byte - start_byte)
    content = raw.decode("utf-8", errors="replace")
    content = _clean_log_text(content)
    lines = content.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines[:end_line - start_line]


def _search_log_matches(log_path: Path, query: str) -> list[int]:
    matches: list[int] = []
    if not query:
        return matches
    ql = query.lower()
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for i, raw_line in enumerate(f):
            line = raw_line[:-1] if raw_line.endswith("\n") else raw_line
            line = _clean_log_text(line)
            if ql in line.lower():
                matches.append(i)
                if len(matches) >= _LOG_SLICE_MAX_MATCHES:
                    break
    return matches


def find_run_log_path(run_dir_path: Path) -> Path | None:
    """在历史训练目录中查找最新的训练日志文件（不读取内容）。"""
    try:
        log_files = list(run_dir_path.glob("train_*.log"))
        if log_files:
            return max(log_files, key=lambda p: p.stat().st_mtime)
    except Exception:
        pass
    return None


def read_log_slice(log_path: Path, offset: int = 0, limit: int = 1000,
                   query: str = "", tail: bool = False) -> dict:
    """读取日志文件的指定行区间（分页）+ 可选全文件搜索。

    磁盘文件是完整日志的真相源：使用换行字节偏移索引定位页面，仅读取当前页
    内容；搜索按行流式扫描，避免大日志被整体载入内存。

    返回 {total, offset, limit, lines, query, match_indices}：
      - total: 文件总行数
      - lines: [offset, offset+limit) 区间的行
      - match_indices: query 非空时，全文件匹配行的索引（上限 _LOG_SLICE_MAX_MATCHES），
        供前端「上一/下一匹配」跳转。
      - tail: 为 True 时定位到文件末尾（offset = max(0, total-limit)）；用于实时任务
        首次进入完整日志模式（此时前端未知 total，无法自行计算尾部 offset）。
    """
    empty = {"total": 0, "offset": offset, "limit": limit,
             "lines": [], "query": query, "match_indices": []}
    try:
        if not log_path or not log_path.exists() or log_path.stat().st_size == 0:
            return empty
        offsets, size = _get_log_line_offsets(log_path)
        total = _log_line_count(offsets, size)

        match_indices = _search_log_matches(log_path, query) if query else []

        if tail:
            offset = max(0, total - max(1, limit))
        offset = max(0, min(offset, total))
        end = min(offset + max(1, limit), total)
        lines = _read_log_lines_by_offset(log_path, offsets, size, offset, end)
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "lines": lines,
            "query": query,
            "match_indices": match_indices,
        }
    except Exception:
        return empty
