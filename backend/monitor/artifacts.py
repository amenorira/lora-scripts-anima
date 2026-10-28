"""
训练产物 — 预览样本扫描 + 历史记录 + 日志文件读取
"""
from __future__ import annotations

from backend.monitor.checkpoints import (
    LORA_EXTENSIONS,
    parse_checkpoint,
    enrich_model_files_with_loss,
    _parse_log_checkpoint_losses,
)

from backend.monitor.log_files import (
    _normalized_log_lines,
    read_clean_log_lines,
    _tail_file,
    find_train_log_path,
    find_run_log_path,
    read_log_slice,
)

import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from backend.constants import REPO_ROOT
from backend.image_preview import build_image_preview_url
from backend.monitor.run_registry import import_legacy_external_runs, iter_run_records, read_run_config, normalize_run_status
from backend.training.config_import import infer_training_profile
from backend.training.core_registry import PROFILES
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# 隐藏 / 缓存目录名前缀与名称，扫描时一律跳过（避免 .ipynb_checkpoints、__pycache__ 等污染）
_HIDDEN_PREFIXES = (".", "__")
_TRAINING_SAMPLE_RE = re.compile(
    r"(?:^|_)(?P<progress>e?\d{6})_(?P<prompt>\d{2})_(?P<timestamp>\d{14})(?:_-?\d+)?$",
    re.IGNORECASE,
)


def _is_hidden(name: str) -> bool:
    """判断目录/文件名是否为隐藏或缓存项（.开头 或 __开头）。"""
    return name.startswith(_HIDDEN_PREFIXES)


def _iter_dir(root: Path):
    """Prune hidden directories before walking them; never follow directory links."""
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not _is_hidden(name)]
        for name in files:
            if not _is_hidden(name):
                yield Path(directory) / name


def _preview_sort_key(path: Path, stat) -> tuple[int, int, int, int, str]:
    """Return a stable generation-order key for trainer sample filenames."""
    match = _TRAINING_SAMPLE_RE.search(path.stem)
    if match:
        progress_token = match.group("progress").lower()
        progress_value = int(progress_token[1:] if progress_token.startswith("e") else progress_token)
        return (
            int(match.group("timestamp")),
            progress_value,
            int(match.group("prompt")),
            stat.st_mtime_ns,
            path.as_posix().lower(),
        )
    fallback_time = int(datetime.fromtimestamp(stat.st_mtime).strftime("%Y%m%d%H%M%S"))
    return (fallback_time, -1, -1, stat.st_mtime_ns, path.as_posix().lower())


# ── 缓存 + 线程安全锁 ────────────────────────────────────
_history_cache_lock = threading.Lock()
_history_scan_lock = threading.Lock()
_history_cache: tuple[float, list[dict]] | None = None
_history_cache_generation = 0
_HISTORY_CACHE_TTL = 30  # 秒


def invalidate_history_cache() -> None:
    """失效历史记录缓存（删除/新增记录后调用）。"""
    global _history_cache, _history_cache_generation
    with _history_cache_lock:
        _history_cache = None
        _history_cache_generation += 1


# ── 预览样本 ──────────────────────────────────────────────

_previews_cache_lock = threading.Lock()
_previews_cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
_PREVIEWS_CACHE_TTL = 5.0
_PREVIEWS_CACHE_MAX_RUNS = 8


def _store_previews(cache_key: str, result: list[dict]) -> None:
    with _previews_cache_lock:
        _previews_cache[cache_key] = (time.time(), result)
        _previews_cache.move_to_end(cache_key)
        while len(_previews_cache) > _PREVIEWS_CACHE_MAX_RUNS:
            _previews_cache.popitem(last=False)


def newest_previews(
    output_dir: str | None = None,
    limit: int = 0,
    force_refresh: bool = False,
    run_dir: str = "",
) -> list[dict]:
    """扫描最新的训练样本图（扁平结构：run_dir/sample/ → run_dir/；兼容旧 outputs/sample/）

    limit: 返回的最新样本数量上限；0 表示返回全部（按训练生成顺序升序，最新在末尾）。
    force_refresh: True 时跳过 5s 缓存，立即重新扫描磁盘并覆盖缓存。
    """
    now = time.time()
    cache_key = f"{run_dir}|{output_dir or ''}"
    if not force_refresh:
        with _previews_cache_lock:
            cached = _previews_cache.get(cache_key)
            if cached and now - cached[0] < _PREVIEWS_CACHE_TTL:
                _previews_cache.move_to_end(cache_key)
                return cached[1][-limit:] if limit else cached[1]

    recursive_roots: list[Path] = []
    flat_roots: list[Path] = []
    if not output_dir:
        _store_previews(cache_key, [])
        return []
    if output_dir:
        try:
            od = Path(output_dir).resolve()
        except OSError:
            _store_previews(cache_key, [])
            return []
        if not od.is_dir():
            _store_previews(cache_key, [])
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

    ordered: list[tuple[Path, object]] = []
    for p in found:
        try:
            ordered.append((p, p.stat()))
        except OSError:
            continue
    ordered.sort(key=lambda item: _preview_sort_key(item[0], item[1]))
    result = []
    for p, stat in ordered:
        try:
            rel = str(p.relative_to(od)).replace("\\", "/")
        except ValueError:
            continue
        version = f"{stat.st_mtime_ns}-{stat.st_size}"
        result.append({
            "name": p.name,
            "path": rel,
            "url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="original", version=version),
            "inspect_url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="inspect", version=version),
            "thumb_url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="thumb", size=320, version=version),
            "metadata_url": f"/api/monitor/preview-metadata?run_dir={quote(run_dir, safe='')}&path={quote(rel, safe='/')}&v={version}",
            "size": stat.st_size,
            "version": version,
        })
    _store_previews(cache_key, result)
    return result[-limit:] if limit else result


# ── 历史记录 ──────────────────────────────────────────────

def scan_history() -> list[dict]:
    """扫描内部运行记录；旧跨盘记录会先由 autosave 幂等导入。"""
    # Background warm-up and the first page request share one scan/migration.
    with _history_scan_lock:
        return _scan_history()


def _scan_history() -> list[dict]:
    global _history_cache
    now = time.time()
    with _history_cache_lock:
        if _history_cache and now - _history_cache[0] < _HISTORY_CACHE_TTL:
            return _history_cache[1]
        generation = _history_cache_generation

    try:
        import_legacy_external_runs()
    except Exception:
        # 旧记录迁移是增强功能，失败不能影响现有历史页。
        pass
    history: list[dict] = []
    for record in iter_run_records():
        try:
            item = _history_item(record)
            if item:
                history.append(item)
        except (OSError, TypeError, ValueError) as exc:
            logging.getLogger(__name__).warning("Skipping unreadable history %s: %s", record.get("run_dir"), exc)

    history.sort(key=lambda item: item.get("timestamp", 0), reverse=True)
    with _history_cache_lock:
        if generation == _history_cache_generation:
            _history_cache = (time.time(), history)
    return history


def _history_item(record: dict) -> dict | None:
    run_dir = Path(record["run_path"])
    config_file = run_dir / "config.toml"
    params = record.get("deletion_config") if record.get("deletion_pending") else read_run_config(run_dir)
    if not isinstance(params, dict) or not params:
        return None
    # Older migrations stamped created_at with import time; their copied config
    # retains the original mtime. New records distinguish imported_at explicitly.
    created_at = record.get("created_at")
    if record.get("imported") and not record.get("imported_at"):
        created_at = None
    try:
        timestamp = datetime.fromisoformat(record.get("snapshot_time") or created_at or "").timestamp()
    except (ValueError, TypeError):
        timestamp = config_file.stat().st_mtime if config_file.exists() else run_dir.stat().st_mtime

    result_data = record.get("deletion_result") or {}
    warning = ""
    result_file = run_dir / "result.json"
    try:
        if result_file.exists():
            result_data = json.loads(result_file.read_text(encoding="utf-8"))
        if not isinstance(result_data, dict):
            raise ValueError("result.json must contain an object")
    except (OSError, UnicodeDecodeError, ValueError):
        result_data = {}
        warning = "result_unreadable"

    model_path = params.get("pretrained_model_name_or_path") or params.get("dit", "")
    try:
        profile_id = infer_training_profile(params, record)
    except ValueError:
        profile_id = None
    profile = PROFILES.get(profile_id)
    network_args = params.get("network_args", [])
    algorithm = ""
    for arg in network_args if isinstance(network_args, list) else []:
        if isinstance(arg, str) and arg.partition("=")[0].strip() == "algo":
            algorithm = arg.partition("=")[2].strip()
    network = algorithm or str(params.get("network_module", "")).rsplit(".", 1)[-1]
    network = {"lora": "LoRA", "lora_anima": "LoRA", "lora_generic": "LoRA",
               "lokr": "LoKr", "loha": "LoHa", "kohya": "LyCORIS"}.get(network, network)
    return {
        "time": datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M"),
        "timestamp": timestamp,
        "task_id": record.get("task_id"),
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
        "status": normalize_run_status(result_data.get("status")),
        "duration": result_data.get("duration_str", ""),
        "profile_id": profile_id,
        "profile_label": profile.label.removesuffix(" LoRA") if profile else "",
        "network": network,
        "optimizer": str(params.get("optimizer_type", "")).rsplit(".", 1)[-1],
        "warning": warning,
        "deletion_pending": bool(record.get("deletion_pending")),
    }


# 日志/元数据文件在输出列表中归为"其他"分类，便于前端区分模型/样本/日志
META_FILES = {"config.toml", "training.yaml", "run_info.txt", "output_dir.txt", "prompts.txt", "result.json",
               "error.log", "task_meta.json"}


def _output_file_paths(run_dir: str):
    """计数与文件列表共用目录范围及隐藏项规则。"""
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    if not rd.exists() or not rd.is_dir():
        return
    for p in _iter_dir(rd):
        if not p.is_file():
            continue
        try:
            rel = str(p.relative_to(rd)).replace("\\", "/")
        except ValueError:
            continue
        yield p, rel


def read_output_summary(run_dir: str) -> dict:
    """轻量总数与模型变更签名；不读取样本/日志等文件的元数据或解析检查点。"""
    count, models = 0, []
    for path, rel in _output_file_paths(run_dir):
        count += 1
        if path.suffix.lower() in LORA_EXTENSIONS:
            stat = path.stat()
            models.append((rel, stat.st_size, stat.st_mtime_ns))
    return {"count": count, "models": sorted(models)}


def list_output_files(run_dir: str) -> list[dict]:
    """列出已由调用方验证的产物目录，路径统一相对该目录返回。"""
    result = []
    for p, rel in _output_file_paths(run_dir):
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
        stat = p.stat()
        entry = {
            "name": p.name,
            "path": rel,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
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
