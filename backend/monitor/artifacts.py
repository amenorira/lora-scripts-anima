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


# ── 模型排行榜 ────────────────────────────────────────────

_ranking_cache_lock = threading.Lock()
_ranking_cache: tuple[float, list[dict]] | None = None
_RANKING_CACHE_TTL = 30  # 秒


def scan_ranking() -> list[dict]:
    """扫描所有历史训练 run，聚合 final_loss + 模型文件，按 final_loss 升序排序。

    每项返回:
      {run_dir, output_name, status, duration, final_loss, model_files[{name,path,size}],
       time, lr, dim, epochs, train_type}
    final_loss 取 TensorBoard loss/average 的 latest 值（无则 None，排末尾）。
    """
    global _ranking_cache
    now = time.time()
    with _ranking_cache_lock:
        if _ranking_cache and now - _ranking_cache[0] < _RANKING_CACHE_TTL:
            return _ranking_cache[1]

    # 复用 scan_history 的基础数据（已含 status/duration/lr/dim/epochs/run_dir/time）
    base = scan_history()
    if not base:
        with _ranking_cache_lock:
            _ranking_cache = (time.time(), [])
        return []

    # 延迟导入避免循环依赖
    from backend.monitor.training import read_tensorboard_loss

    items: list[dict] = []
    for h in base:
        run_dir_rel = h.get("run_dir", "")
        if not run_dir_rel:
            continue
        run_dir_abs = (REPO_ROOT / run_dir_rel).resolve()

        # final_loss：从该 run 的 TB 读 loss/average latest
        final_loss = None
        try:
            series = read_tensorboard_loss(run_dir=str(run_dir_abs))
            for s in series:
                if s.get("tag") in ("loss/average", "loss/current", "loss/epoch_average"):
                    final_loss = s.get("latest")
                    break
        except Exception:
            pass

        # 模型文件：扫描 run 目录的 .safetensors/.pt/.pth
        model_files = []
        try:
            for p in _iter_dir(run_dir_abs):
                if not p.is_file():
                    continue
                if p.suffix.lower() in LORA_EXTENSIONS:
                    try:
                        rel = str(p.relative_to(REPO_ROOT)).replace("\\", "/")
                    except ValueError:
                        rel = str(p).replace("\\", "/")
                    model_files.append({
                        "name": p.name,
                        "path": rel,
                        "size": p.stat().st_size,
                    })
        except OSError:
            pass

        items.append({
            "run_dir": run_dir_rel,
            "output_name": h.get("name", ""),
            "status": h.get("status", ""),
            "duration": h.get("duration", ""),
            "final_loss": final_loss,
            "model_files": model_files,
            "time": h.get("time", ""),
            "lr": h.get("lr", "?"),
            "dim": h.get("dim", "?"),
            "epochs": h.get("epochs", "?"),
        })

    # 按 final_loss 升序（None 排末尾）；同 loss 按时间倒序
    items.sort(key=lambda x: (x["final_loss"] is None, x["final_loss"] if x["final_loss"] is not None else 0))

    with _ranking_cache_lock:
        _ranking_cache = (time.time(), items)
    return items


def invalidate_ranking_cache() -> None:
    """失效排行榜缓存。"""
    global _ranking_cache
    with _ranking_cache_lock:
        _ranking_cache = None


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
        result.append({
            "name": p.name,
            "path": rel,
            "size": p.stat().st_size,
            "mtime": p.stat().st_mtime,
            "is_lora": is_lora,
            "category": category,
        })
    # 模型文件优先，其次样本，再日志，最后其他；同类按修改时间倒序
    cat_order = {"model": 0, "sample": 1, "log": 2, "tensorboard": 3, "other": 4}
    result.sort(key=lambda f: (cat_order.get(f["category"], 9), -f["mtime"]))
    return result


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
    task_id_short = task_id[:8]

    def _cache_log(task_id: str, log_file: Path):
        """写入缓存并淘汰溢出条目（调用方需持有 _log_file_cache_lock）"""
        _log_file_cache[task_id] = (now, log_file)
        if len(_log_file_cache) > _LOG_FILE_CACHE_MAX:
            # 淘汰最旧的条目（按缓存时间戳）
            oldest_key = min(_log_file_cache, key=lambda k: _log_file_cache[k][0])
            del _log_file_cache[oldest_key]

    # 先在指定目录查找
    if output_dir and output_dir.exists():
        for log_file in sorted(output_dir.glob(f"train_{task_id_short}*.log"),
                               key=lambda p: p.stat().st_mtime, reverse=True):
            lines = _tail_file(log_file)
            if lines:
                with _log_file_cache_lock:
                    _cache_log(task_id, log_file)
                return lines

    # 回退：扫描所有运行子目录
    if OUTPUT_DIR.exists():
        for run_dir in sorted(OUTPUT_DIR.iterdir(),
                              key=lambda p: p.stat().st_mtime if p.is_dir() else 0,
                              reverse=True):
            if not run_dir.is_dir():
                continue
            for log_file in sorted(run_dir.glob(f"train_{task_id_short}*.log"),
                                   key=lambda p: p.stat().st_mtime, reverse=True):
                lines = _tail_file(log_file)
                if lines:
                    with _log_file_cache_lock:
                        _cache_log(task_id, log_file)
                    return lines

    return []
