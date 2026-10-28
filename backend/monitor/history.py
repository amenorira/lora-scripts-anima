"""训练历史索引、摘要与缓存失效。"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path

from backend.monitor.run_registry import import_legacy_external_runs, iter_run_records, read_run_config, normalize_run_status
from backend.training.config.config_import import infer_training_profile
from backend.training.core_registry import PROFILES


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
