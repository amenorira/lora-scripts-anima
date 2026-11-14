"""Versioned sampling records shared by the training hooks and monitor.

This module deliberately imports no trainer, image decoder or torch dependency.
Only parameters recorded for the saved image are eligible for strict pairing.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from datetime import datetime

from backend.utils.file_io import atomic_replace


SCHEMA_VERSION = 1
_SAMPLE_NAME = re.compile(
    r"^(?P<prefix>.*?)(?P<progress>e?\d{6})_(?P<prompt>\d{2,})_(?P<timestamp>\d{14})(?:_(?P<seed>-?\d+))?$", re.I)
_CORE = {"prompt", "negative_prompt", "seed", "architecture", "width", "height", "steps", "cfg_scale", "sampler", "scheduler", "loras"}
_PROMPT_KEYS = {"prompt", "negative_prompt", "seed"}
_MANIFEST_CACHE_TTL = 5.0
_manifest_cache_lock = threading.Lock()
_manifest_cache: OrderedDict[str, tuple[tuple, float, str]] = OrderedDict()


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()[:24]


def _integer(value, minimum=0):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= minimum else None


def _browser_json(value):
    """Preserve exact uint64 seeds and weight versions across JSON/JavaScript."""
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2 ** 53 - 1:
        return str(value)
    if isinstance(value, dict):
        return {key: _browser_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_browser_json(item) for item in value]
    return value


def _json_value(value, depth=0):
    if depth > 5:
        raise ValueError("sample metadata nesting is too deep")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("sample parameters must be finite")
        return value
    if isinstance(value, str):
        if len(value) > 32768:
            raise ValueError("sample parameter text is too long")
        return value
    if isinstance(value, (list, tuple)) and len(value) <= 256:
        return [_json_value(item, depth + 1) for item in value]
    if isinstance(value, dict) and len(value) <= 128:
        return {str(key): _json_value(item, depth + 1) for key, item in value.items()}
    raise ValueError("unsupported sample parameter")


def parse_sample_filename(name: str, *, frame_suffix=False) -> dict | None:
    stem = Path(name).stem
    # Musubi's single-frame saver appends _000 after its optional seed. Native
    # sd-scripts seeds use unpadded integers, so _000 cannot be its seed zero.
    if frame_suffix or stem.endswith("_000"):
        stem = re.sub(r"_\d{3}$", "", stem)
    match = _SAMPLE_NAME.fullmatch(stem)
    if not match or (match["prefix"] and not match["prefix"].endswith("_")):
        return None
    progress = match["progress"].lower()
    return {"prefix": match["prefix"], "stage_kind": "epoch" if progress.startswith("e") else "step",
            "stage_value": int(progress.lstrip("e")), "prompt_index": int(match["prompt"]),
            "timestamp": match["timestamp"], "seed": int(match["seed"]) if match["seed"] is not None else None}


def file_version(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns}-{stat.st_size}"


def _safe_path(root: Path, relative: str) -> Path | None:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        return None
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    resolved = (root / candidate).resolve()
    return resolved if resolved.is_relative_to(root) else None


def write_sample_batch(artifact_root, batch: dict, items: dict, *, process_index=0, num_processes=1) -> Path:
    """Atomically persist one rank's sampling call, without touching image bytes.

    ``items`` maps artifact-relative image paths to ``{params, prompt_index,
    prompt_label?}``. Missing images are omitted; file versions reject stale
    records after an image has been replaced. All ranks share batch.id.
    """
    root = Path(artifact_root).resolve()
    identifier = str(batch["id"])
    if not identifier or len(identifier) > 256:
        raise ValueError("invalid sample batch id")
    rank, count = _integer(process_index), _integer(num_processes, 1)
    if rank is None or count is None or rank >= count:
        raise ValueError("invalid sample process index")
    saved = {}
    for relative, item in items.items():
        path = _safe_path(root, relative)
        if path is not None and path.is_file() and isinstance(item, dict):
            saved[relative] = {**_json_value(item), "file_version": file_version(path)}
    directory = root / "sample" / ".anima-preview" / "batches"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{_digest(identifier)}-r{rank}.json"
    payload = {"schema_version": SCHEMA_VERSION, "batch": _json_value(batch), "items": saved,
               "process_index": rank, "num_processes": count}
    fd, temporary = tempfile.mkstemp(prefix=".sample-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        atomic_replace(Path(temporary), destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return destination


def _complete(params: dict) -> bool:
    if not _CORE <= params.keys() or not all(isinstance(params.get(key), str) for key in ("prompt", "negative_prompt", "architecture", "sampler", "scheduler")):
        return False
    if not params["architecture"] or not params["sampler"] or not params["scheduler"] or not isinstance(params["loras"], list):
        return False
    if any(_integer(params.get(key), 1) is None for key in ("width", "height", "steps")) or _integer(params.get("seed")) is None:
        return False
    if isinstance(params.get("cfg_scale"), bool) or not isinstance(params.get("cfg_scale"), (int, float)):
        return False
    if params["architecture"] in {"anima", "moss_image"} and not isinstance(params.get("flow_shift"), (int, float)):
        return False
    if params["architecture"] == "moss_image" and not isinstance(params.get("uncond_skip_layers"), list):
        return False
    return True


def _normalize(batch: dict, item: dict, status: str, expected: int | None) -> dict:
    params = _json_value(item.get("params", {}))
    if not isinstance(params, dict):
        raise ValueError("sample params must be an object")
    seed = _integer(params.get("seed"))
    index = _integer(item.get("prompt_index"))
    prompt = params.get("prompt")
    negative = params.get("negative_prompt")
    prompt_known = isinstance(prompt, str) and isinstance(negative, str)
    comparable = item.get("params_complete", True) is True and _complete(params)
    raw_trigger_epoch = _integer(batch.get("epoch"))
    trigger_epoch, step = _integer(raw_trigger_epoch, 1), _integer(batch.get("step"))
    # epoch=0 is the trainers' pre-loop sampling convention, including after
    # a resume; it does not establish an actual current epoch.
    epoch = trigger_epoch
    if raw_trigger_epoch is None:
        epoch = _integer(batch.get("current_epoch"), 1)
    kind = "epoch" if trigger_epoch is not None else "step" if step is not None else "unknown"
    value = trigger_epoch if kind == "epoch" else step
    label = item.get("prompt_label")
    if not isinstance(label, str) or not label.strip():
        label = (prompt.strip()[:64] if isinstance(prompt, str) else "") or (f"Prompt {index + 1}" if index is not None else "")
    order = _integer(batch.get("order")) or 0
    batch_label = (f"Epoch {epoch} · Step {step}" if epoch is not None and step is not None
                   else f"{'Epoch' if kind == 'epoch' else 'Step'} {value}" if value is not None else "")
    return {"batch_id": str(batch["id"]), "batch_order": order // 1000 if order > 2 ** 53 - 1 else order,
            "batch_label": batch_label,
            "batch_expected": expected, "batch_status": status, "batch_inferred": False,
            "stage_kind": kind, "stage_value": value, "step": step, "epoch": epoch,
            "prompt_id": "prompt:" + _digest([prompt, negative]) if prompt_known else "recorded-slot:" + str(index),
            "prompt_label": label[:128], "prompt_index": index, "seed": _browser_json(seed),
            "params": _browser_json(params), "condition_key": _digest({key: value for key, value in params.items() if key not in _PROMPT_KEYS}) if comparable else None,
            "pair_key": _digest(params) if comparable else None, "comparable": comparable, "metadata_source": "recorded"}


def sample_manifest_version(artifact_root, *, force_refresh=False) -> str:
    """Reuse the signature while the manifest directories remain unchanged.

    Atomic batch writes change the directory stamp, including final status
    updates. The short TTL also covers external in-place edits to old records.
    """
    root = Path(artifact_root).resolve()
    directories = (root / "sample" / ".anima-preview" / "batches", root / "outputs" / "sample" / ".anima-preview" / "batches")
    stamp = []
    for directory in directories:
        try:
            stat = directory.stat()
            stamp.append((stat.st_dev, stat.st_ino, stat.st_mtime_ns))
        except OSError:
            stamp.append(None)
    stamp = tuple(stamp)
    key, now = str(root), time.monotonic()
    with _manifest_cache_lock:
        cached = _manifest_cache.get(key)
        if not force_refresh and cached and cached[0] == stamp and now - cached[1] < _MANIFEST_CACHE_TTL:
            _manifest_cache.move_to_end(key)
            return cached[2]
    files = []
    for directory in directories:
        if not directory.is_dir() or directory.is_symlink():
            continue
        for path in directory.glob("*.json"):
            try:
                stat = path.stat()
                files.append((str(path.relative_to(root)), stat.st_mtime_ns, stat.st_size))
            except OSError:
                continue
    version = _digest(sorted(files))
    with _manifest_cache_lock:
        _manifest_cache[key] = (stamp, now, version)
        _manifest_cache.move_to_end(key)
        while len(_manifest_cache) > 8:
            _manifest_cache.popitem(last=False)
    return version


def read_sample_records(artifact_root, versions: dict[str, str]) -> dict[str, dict]:
    """Read small manifests only. Never decode every image or consult current config."""
    root = Path(artifact_root).resolve()
    grouped = {}
    for directory in (root / "sample" / ".anima-preview" / "batches", root / "outputs" / "sample" / ".anima-preview" / "batches"):
        if not directory.is_dir() or directory.is_symlink():
            continue
        for path in directory.glob("*.json"):
            try:
                stat = path.stat()
                if path.is_symlink() or stat.st_size > 2_000_000:
                    continue
                doc = json.loads(path.read_text(encoding="utf-8"))
                batch, items = doc.get("batch"), doc.get("items")
                rank, count = _integer(doc.get("process_index")), _integer(doc.get("num_processes"), 1)
                if doc.get("schema_version") != SCHEMA_VERSION or not isinstance(batch, dict) or not isinstance(items, dict) or not isinstance(batch.get("id"), str) or rank is None or count is None or rank >= count:
                    continue
                doc["_version"] = (path.name, stat.st_mtime_ns, stat.st_size)
                grouped.setdefault(batch["id"], {})[rank] = doc
            except (OSError, ValueError, TypeError, AttributeError):
                continue
    result = {}
    for parts in grouped.values():
        counts = {doc["num_processes"] for doc in parts.values()}
        try:
            identities = {_digest({key: doc["batch"].get(key) for key in ("step", "epoch", "order", "expected")}) for doc in parts.values()}
        except (ValueError, TypeError, OverflowError):
            continue
        if len(counts) != 1 or len(identities) != 1:
            continue
        # This is optional context, not a batch identity. Preserve samples and
        # fall back to an unknown epoch if ranks observed conflicting values.
        observed_epochs = {_integer(doc["batch"].get("current_epoch"), 1) for doc in parts.values()}
        observed_epochs.discard(None)
        current_epoch = next(iter(observed_epochs)) if len(observed_epochs) == 1 else None
        expected_values = {doc["batch"].get("expected") for doc in parts.values() if _integer(doc["batch"].get("expected")) is not None}
        expected = next(iter(expected_values)) if len(expected_values) == 1 else None
        statuses = {doc["batch"].get("status") if isinstance(doc["batch"].get("status"), str) else "unknown" for doc in parts.values()}
        all_ranks = len(parts) == next(iter(counts))
        saved, conflicts = {}, set()
        for doc in parts.values():
            for relative, item in doc["items"].items():
                if not isinstance(item, dict) or not isinstance(item.get("file_version"), str) or _safe_path(root, relative) is None:
                    continue
                if relative in saved and saved[relative][1] != item:
                    conflicts.add(relative)
                saved[relative] = (doc["batch"], item)
        ended = all_ranks and statuses == {"complete"}
        status = ("failed" if "failed" in statuses or conflicts or (ended and expected is not None and len(saved) < expected)
                  else "complete" if ended and expected is not None else "unknown" if ended else "running" if statuses <= {"running", "complete"} else "unknown")
        batch_version = _digest(sorted(doc["_version"] for doc in parts.values()))
        for relative, (batch, item) in saved.items():
            if relative in conflicts or relative not in versions or item.get("file_version") != versions[relative]:
                continue
            try:
                sample = _normalize({**batch, "current_epoch": current_epoch}, item, status, expected)
                sample.update(batch_version=batch_version, batch_saved=len(saved))
                previous = result.get(relative)
                if previous is None or sample["batch_order"] >= previous["batch_order"]:
                    result[relative] = sample
            except (TypeError, ValueError, KeyError, OverflowError):
                continue
    return result


def legacy_sample_metadata(name: str, relative: str) -> dict:
    parsed = parse_sample_filename(name)
    if parsed:
        kind, value, prefix = parsed["stage_kind"], parsed["stage_value"], parsed["prefix"]
        try:
            order = int(datetime.strptime(parsed["timestamp"], "%Y%m%d%H%M%S").timestamp() * 1_000_000)
        except ValueError:
            order = 0
        return {"batch_id": f"legacy:{prefix}:{kind}:{value}", "batch_order": order,
                "batch_label": f"{'Epoch' if kind == 'epoch' else 'Step'} {value}", "batch_expected": None,
                "batch_status": "unknown", "batch_inferred": True, "stage_kind": kind, "stage_value": value,
                "step": value if kind == "step" else None, "epoch": value if kind == "epoch" else None,
                "prompt_id": f"legacy:{prefix}:{parsed['prompt_index']}", "prompt_label": f"Prompt {parsed['prompt_index'] + 1}",
                "prompt_index": parsed["prompt_index"], "seed": _browser_json(_integer(parsed["seed"])), "params": {},
                "condition_key": None, "pair_key": None, "comparable": False, "metadata_source": "filename"}
    return {"batch_id": "unknown:" + _digest(relative), "batch_order": 0, "batch_label": name,
            "batch_expected": None, "batch_status": "unknown", "batch_inferred": True, "stage_kind": "unknown",
            "stage_value": None, "step": None, "epoch": None, "prompt_id": "unknown:" + _digest(relative),
            "prompt_label": "", "prompt_index": None, "seed": None, "params": {}, "condition_key": None,
            "pair_key": None, "comparable": False, "metadata_source": "unknown"}
