"""
训练产物 — 预览样本扫描 + 历史记录 + 日志文件读取
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime
from pathlib import Path

from backend.constants import REPO_ROOT, OUTPUT_DIR
from backend.constants import AUTOSAVE_DIR as CONFIG_AUTOSAVE
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


def newest_previews(output_dir: str | None = None, limit: int = 6) -> list[dict]:
    """扫描最新的训练样本图（扁平结构：run_dir/sample/ → run_dir/；兼容旧 outputs/sample/）"""
    global _previews_cache
    now = time.time()
    cache_key = output_dir or ""
    with _previews_cache_lock:
        if _previews_cache and _previews_cache[1] == cache_key and now - _previews_cache[0] < _PREVIEWS_CACHE_TTL:
            return _previews_cache[2]

    roots: list[Path] = []
    if output_dir:
        od = Path(output_dir)
        roots.extend([od / "sample", od])           # 扁平: run_dir/sample/, run_dir/
        roots.append(od / "outputs" / "sample")     # 兼容旧结构: run_dir/outputs/sample/
        roots.append(od / "outputs")                # 兼容旧结构: run_dir/outputs/
    roots.extend([OUTPUT_DIR / "sample", OUTPUT_DIR])

    found: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for p in _iter_dir(root):
            if not p.is_file():
                continue
            if p.suffix.lower() not in IMAGE_EXTENSIONS or p in seen:
                continue
            seen.add(p)
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
            "url": f"/api/monitor/preview-image?path={rel}",
            "size": p.stat().st_size,
        })
    with _previews_cache_lock:
        _previews_cache = (now, cache_key, result)
    return result


# ── 历史记录 ──────────────────────────────────────────────

def _parse_toml_config(path: Path) -> dict | None:
    """从 TOML 配置文件中提取关键参数"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        params = {}
        for key in ["output_name", "pretrained_model_name_or_path",
                     "learning_rate", "network_dim", "network_alpha",
                     "max_train_epochs", "model_train_type", "output_dir",
                     "train_data_dir"]:
            m = re.search(
                rf'^{key}\s*=\s*["\']?(?P<v>[^"\'\n#]+)["\']?\s*$',
                text, re.MULTILINE
            )
            if m:
                params[key] = m.group("v").strip().strip('"').strip("'")
        return params
    except (OSError, Exception):
        return None


def scan_history() -> list[dict]:
    """扫描训练记录：优先从 output/*/config.toml（运行文件夹），回退到 config/autosave/"""
    global _history_cache
    now = time.time()
    with _history_cache_lock:
        if _history_cache and now - _history_cache[0] < _HISTORY_CACHE_TTL:
            return _history_cache[1]

    history = []
    seen_names = set()  # 按 output_name+timestamp 去重

    # ── 优先：扫描运行文件夹（每个训练一个目录） ──
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if not run_dir.is_dir() or _is_hidden(run_dir.name):
                continue
            config_file = run_dir / "config.toml"
            if not config_file.exists():
                continue

            params = _parse_toml_config(config_file)
            if not params:
                continue

            st = config_file.stat()
            key = (params.get("output_name", ""), run_dir.name)
            if key in seen_names:
                continue
            seen_names.add(key)

            # 模型文件名（取 basename）
            model_path = params.get("pretrained_model_name_or_path", "")
            model_name = Path(model_path).name if model_path else "Unknown"

            # 读取 result.json 获取训练状态
            status = ""
            duration = ""
            result_file = run_dir / "result.json"
            if result_file.exists():
                try:
                    rj = json.loads(result_file.read_text(encoding="utf-8"))
                    status = rj.get("status", "")
                    duration = rj.get("duration_str", "")
                except Exception:
                    pass

            try:
                rel_run_dir = str(run_dir.relative_to(REPO_ROOT)).replace("\\", "/")
            except ValueError:
                rel_run_dir = str(run_dir).replace("\\", "/")

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "run_dir": rel_run_dir,
                "config_file": config_file.name,
                "name": params.get("output_name", run_dir.name),
                "model": model_name,
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
                "dataset": params.get("train_data_dir", ""),
                "status": status,
                "duration": duration,
            })

    # ── 回退/补充：扫描 autosave（可能有些旧记录只有 toml 没目录） ──
    if CONFIG_AUTOSAVE.exists():
        for cfg_path in sorted(CONFIG_AUTOSAVE.glob("*.toml"),
                               key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
            # 跳过 prompt 文件
            if cfg_path.name.endswith("-promopt.txt"):
                continue

            params = _parse_toml_config(cfg_path)
            if not params:
                continue

            key = (params.get("output_name", ""), cfg_path.stem)
            if key in seen_names:
                continue
            seen_names.add(key)

            st = cfg_path.stat()
            model_path = params.get("pretrained_model_name_or_path", "")
            model_name = Path(model_path).name if model_path else "Unknown"
            run_dir = params.get("output_dir", "")

            try:
                rel_run_dir = str(Path(run_dir).relative_to(REPO_ROOT)).replace("\\", "/") if run_dir else ""
            except ValueError:
                rel_run_dir = str(run_dir).replace("\\", "/") if run_dir else ""

            history.append({
                "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                "timestamp": st.st_mtime,
                "run_dir": rel_run_dir,
                "config_file": cfg_path.name,
                "name": params.get("output_name", cfg_path.stem),
                "model": model_name,
                "lr": params.get("learning_rate", "?"),
                "dim": params.get("network_dim", "?"),
                "epochs": params.get("max_train_epochs", "?"),
                "dataset": params.get("train_data_dir", ""),
                "status": "",
                "duration": "",
            })

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


def enrich_model_files_with_loss(files: list[dict], tb_series: list[dict]) -> list[dict]:
    """给 list_output_files 的结果中 model 类文件补充对应 loss。

    依赖 list_output_files 已写入的 ckpt_type/ckpt_epoch/ckpt_step 字段。
    在每个 model 文件 dict 上增加:
      ckpt_loss (float|None)  — 匹配到的 TensorBoard loss 值

    匹配规则:
      epoch 存档 → loss/epoch_average 第 N 个点（N = epoch_no）
      step  存档 → loss/current（优先）/loss/average 中 step 最接近的点
      最终存档 → loss/average 的 latest
    无 TB 数据或无法匹配时 ckpt_loss = None。非 model 文件不动。
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
            # step 存档优先用 loss/current，其次 loss/average
            if tag == "loss/current":
                step_series = s.get("points") or []
            elif step_series is None and tag == "loss/average":
                step_series = s.get("points") or []

    for f in files:
        if f.get("category") != "model":
            continue
        ckpt_type = f.get("ckpt_type")
        loss = None
        try:
            if ckpt_type == "epoch" and f.get("ckpt_epoch") is not None and epoch_avg:
                # 第 N 个 epoch → 第 N 个点（1-based）；epoch 号从 1 起，文件名 000003 = 第 3 epoch
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
    return files


# ── 训练日志读取 ──────────────────────────────────────────

# 日志 tail 读取的最大字节数（约 500-1000 行）
_LOG_TAIL_BYTES = 64 * 1024


def _tail_file(path: Path, max_bytes: int = _LOG_TAIL_BYTES) -> list[str]:
    """高效读取文件尾部内容（不加载整个文件到内存）"""
    try:
        size = path.stat().st_size
        if size == 0:
            return []
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if size <= max_bytes:
                f.seek(0)
                return f.read().split("\n")
            f.seek(size - max_bytes)
            # 丢弃第一行（可能是不完整的行）
            content = f.read()
            first_newline = content.find("\n")
            if first_newline >= 0:
                content = content[first_newline + 1:]
            return content.split("\n")
    except OSError:
        return []


_log_file_cache: dict[str, tuple[float, Path]] = {}
_log_file_cache_lock = threading.Lock()
_LOG_FILE_CACHE_TTL = 10.0
_LOG_FILE_CACHE_MAX = 50  # 防止无限增长


LORA_EXTENSIONS = {".safetensors", ".pt", ".pth"}
# 日志/元数据文件在输出列表中归为"其他"分类，便于前端区分模型/样本/日志
META_FILES = {"config.toml", "run_info.txt", "prompts.txt", "result.json",
              "error.log", "task_meta.json"}


def list_output_files(run_dir: str) -> list[dict]:
    """列出指定训练运行目录的输出文件。

    参数 run_dir 为相对于项目根的路径（如 output/my_lora_20260625-171200），
    或绝对路径。返回文件名、相对路径、大小、修改时间、是否为 LoRA 文件、分类。
    """
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    # 安全约束：必须在 output/ 之下
    try:
        rd.relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        return []
    if not rd.exists() or not rd.is_dir():
        return []

    result = []
    for p in _iter_dir(rd):
        if not p.is_file():
            continue
        try:
            rel = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
        except ValueError:
            rel = str(p).replace("\\", "/")
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
