"""Incremental per-sample loss analyzer and safe preview resolver."""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import stat as stat_module
import threading
import urllib.parse
from array import array
import tomllib
from collections import Counter, OrderedDict, defaultdict
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

import numpy as np

from backend.constants import REPO_ROOT
from backend.image_preview import IMAGE_EXTENSIONS
from backend.monitor.dataset_diagnostic_index import (
    PROFILE_BINS, Codes, DIMENSIONS, LossIndex, SampleRows, ZONES, deweight_losses, epoch_metrics,
)
from backend.monitor.run_control import read_object
from backend.monitor.run_registry import read_run_config
from backend.tageditor.core import caption_candidates, read_caption_snapshot

LOSS_FILE = "loss.jsonl"
MANIFEST_FILE = "manifest.json"

HIGH_RESIDUAL_THRESHOLD = 0.20
LOW_RESIDUAL_THRESHOLD = -0.20
CONVERGING_SLOPE_THRESHOLD = -0.02
MIN_CONVERGING_SLOPE_THRESHOLD = -0.004
CONVERGING_CUMULATIVE_DROP = 0.10
_MAX_CACHED_FILES = 4
_MAX_INDEX_LRU = 4
_MAX_CACHED_SAMPLES = 500_000
_MAX_DETAIL_SAMPLES = 500
_MAX_METADATA_PREVIEW_BYTES = 16 * 1024 * 1024
_MAX_LOCAL_STAT_CACHE = 50_000
_BATCH_SCANDIR_MIN_FILES = 16
_IMAGE_ID_RE = re.compile(r"^[0-9a-f]{16}$")

_cache_lock = threading.Lock()
_file_cache: OrderedDict[str, "_LossFileState"] = OrderedDict()
_state_token_counter = itertools.count(1)
_local_stat_lock = threading.Lock()
_local_stat_cache: OrderedDict[str, tuple[tuple[int, int], dict[str, tuple[str | None, str]]]] = OrderedDict()


def _finite_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        fval = float(value)
    except OverflowError:
        return None
    return fval if math.isfinite(fval) else None


def _opt_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _image_id_for_key(image_key: str) -> str:
    return hashlib.sha1(image_key.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _normalize_image_key(raw_key: str) -> str:
    """Normalize path separators, redundant slashes, and Windows drive letter casing."""
    text = str(raw_key or "").replace("\\", "/").strip()
    if not text:
        return ""
    unc_prefix = "//" if text.startswith("//") else ""
    body = re.sub(r"/+", "/", text[2:] if unc_prefix else text)
    normalized = unc_prefix + body
    if len(normalized) > 1 and normalized.endswith("/") and not (len(normalized) == 3 and normalized[1] == ":"):
        normalized = normalized.rstrip("/")
    if len(normalized) >= 2 and normalized[0].isalpha() and normalized[1] == ":":
        normalized = normalized[0].upper() + normalized[1:]
    return normalized


def _case_key(path_text: str) -> str:
    """Fold Windows / drive-qualified paths 1:1 per character for consistent deduplication."""
    if os.name == "nt" or (len(path_text) >= 2 and path_text[0].isalpha() and path_text[1] == ":"):
        if path_text.isascii():
            return path_text.lower()
        return "".join(ch.lower() if len(ch.lower()) == 1 else ch for ch in path_text)
    return path_text


def _split_image_key(raw_key: str) -> tuple[str, str, str]:
    """Return (filename, full_directory, concise_dir_label) independent of OS separators."""
    normalized = _normalize_image_key(raw_key)
    if "/" not in normalized:
        return normalized or "(unknown)", "", ""
    directory, name = normalized.rsplit("/", 1)
    parts = [part for part in PurePosixPath(directory).parts if part not in ("", "/")]
    if not parts:
        dir_label = directory
    elif len(parts) == 1:
        dir_label = parts[0]
    else:
        dir_label = "/".join(parts[-2:])
    return name or normalized, directory, dir_label


def _local_image_candidate(raw_key: str) -> Path | None:
    text = str(raw_key or "").strip()
    if not text:
        return None
    try:
        candidate = Path(text)
        if not candidate.is_absolute():
            candidate = REPO_ROOT / candidate
        if candidate.suffix.lower() not in IMAGE_EXTENSIONS:
            return None
        return candidate
    except (OSError, RuntimeError, ValueError):
        return None


def _resolve_local_image_with_stat(raw_key: str) -> tuple[Path | None, str]:
    candidate = _local_image_candidate(raw_key)
    if candidate is None:
        return None, ""
    try:
        resolved = candidate.resolve(strict=True)
        if resolved.suffix.lower() not in IMAGE_EXTENSIONS:
            return None, ""
        st = resolved.stat()
        if not stat_module.S_ISREG(st.st_mode):
            return None, ""
        return resolved, f"{st.st_mtime_ns}-{st.st_size}"
    except (OSError, RuntimeError, ValueError):
        return None, ""


def _resolve_local_image_path(raw_key: str) -> Path | None:
    return _resolve_local_image_with_stat(raw_key)[0]


def _drop_local_stat_bucket(state_path: str, max_token: int | None = None) -> None:
    with _local_stat_lock:
        if max_token is None:
            _local_stat_cache.pop(state_path, None)
            return
        bucket = _local_stat_cache.get(state_path)
        if bucket is not None and bucket[0][0] <= max_token:
            _local_stat_cache.pop(state_path, None)


def _store_local_stat_entries(
    state_path: str,
    cache_epoch: tuple[int, int],
    entries: dict[str, tuple[str | None, str]],
) -> None:
    if not entries:
        return
    with _local_stat_lock:
        bucket = _local_stat_cache.get(state_path)
        if bucket is not None:
            bucket_epoch, items = bucket
            if cache_epoch < bucket_epoch:
                return
            if cache_epoch > bucket_epoch:
                items = {}
                _local_stat_cache[state_path] = (cache_epoch, items)
            _local_stat_cache.move_to_end(state_path)
        else:
            items = {}
            _local_stat_cache[state_path] = (cache_epoch, items)

        for raw_key, value in entries.items():
            items.pop(raw_key, None)
            items[raw_key] = value

        total = sum(len(b[1]) for b in _local_stat_cache.values())
        while total > _MAX_LOCAL_STAT_CACHE and _local_stat_cache:
            oldest_path, (_, oldest_items) = next(iter(_local_stat_cache.items()))
            if not oldest_items:
                _local_stat_cache.popitem(last=False)
                continue
            excess = total - _MAX_LOCAL_STAT_CACHE
            if excess >= len(oldest_items):
                _local_stat_cache.popitem(last=False)
                total -= len(oldest_items)
            else:
                for key in list(oldest_items)[:excess]:
                    del oldest_items[key]
                total -= excess


def _stat_local_image_cached(
    state_path: str,
    raw_key: str,
    cache_epoch: tuple[int, int],
) -> tuple[Path | None, str]:
    """Stat local image outside state.lock, cached per state_path and current (state_token, generation)."""
    with _local_stat_lock:
        bucket = _local_stat_cache.get(state_path)
        if bucket is not None and bucket[0] == cache_epoch:
            cached = bucket[1].get(raw_key)
            if cached is not None:
                _local_stat_cache.move_to_end(state_path)
                resolved_str, version = cached
                return (Path(resolved_str) if resolved_str else None), version
    resolved, version = _resolve_local_image_with_stat(raw_key)
    resolved_str = str(resolved) if resolved is not None else None
    _store_local_stat_entries(state_path, cache_epoch, {raw_key: (resolved_str, version)})
    return resolved, version


def _scan_local_image_dir(
    parent_dir: Path,
    items: list[tuple[str, Path]],
) -> dict[str, tuple[str | None, str]]:
    """Resolve and stat multiple images sharing a parent directory via one os.scandir."""
    out: dict[str, tuple[str | None, str]] = {}
    try:
        resolved_dir = parent_dir.resolve(strict=True)
        if not resolved_dir.is_dir():
            return {raw_key: (None, "") for raw_key, _ in items}
        exact_entries: dict[str, tuple[str | None, str]] = {}
        folded_candidates: set[str] = set()
        symlinks: set[str] = set()
        folded_symlinks: set[str] = set()
        with os.scandir(resolved_dir) as dir_iter:
            for entry in dir_iter:
                name = entry.name
                if os.path.splitext(name)[1].lower() not in IMAGE_EXTENSIONS:
                    continue
                try:
                    is_link = entry.is_symlink()
                except OSError:
                    is_link = True
                if is_link:
                    symlinks.add(name)
                    if os.name == "nt":
                        folded_symlinks.add(name.casefold())
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                    if not stat_module.S_ISREG(st.st_mode):
                        continue
                    val = (str(resolved_dir / name), f"{st.st_mtime_ns}-{st.st_size}")
                except OSError:
                    symlinks.add(name)
                    if os.name == "nt":
                        folded_symlinks.add(name.casefold())
                    continue
                exact_entries[name] = val
                if os.name == "nt":
                    folded_candidates.add(name.casefold())
    except (FileNotFoundError, NotADirectoryError):
        return {raw_key: (None, "") for raw_key, _ in items}
    except (OSError, RuntimeError, ValueError):
        for raw_key, _ in items:
            resolved, version = _resolve_local_image_with_stat(raw_key)
            out[raw_key] = (str(resolved) if resolved is not None else None, version)
        return out

    for raw_key, candidate in items:
        fname = candidate.name
        is_symlink = fname in symlinks or (os.name == "nt" and fname.casefold() in folded_symlinks)
        if is_symlink:
            resolved, version = _resolve_local_image_with_stat(raw_key)
            out[raw_key] = (str(resolved) if resolved is not None else None, version)
            continue
        found = exact_entries.get(fname)
        if found is not None:
            out[raw_key] = found
        elif os.name == "nt" and (fname.casefold() in folded_candidates or "~" in fname):
            resolved, version = _resolve_local_image_with_stat(raw_key)
            out[raw_key] = (str(resolved) if resolved is not None else None, version)
        else:
            out[raw_key] = (None, "")
    return out


def _stat_local_images_batch(
    state_path: str,
    raw_keys: Iterable[str],
    cache_epoch: tuple[int, int],
) -> dict[str, tuple[str | None, str]]:
    """Batch-stat local images outside state.lock using per-directory os.scandir on cache misses."""
    results: dict[str, tuple[str | None, str]] = {}
    misses: list[str] = []
    seen_misses: set[str] = set()
    with _local_stat_lock:
        bucket = _local_stat_cache.get(state_path)
        if bucket is not None and bucket[0] == cache_epoch:
            _local_stat_cache.move_to_end(state_path)
            items = bucket[1]
            for raw_key in raw_keys:
                if raw_key in results:
                    continue
                cached = items.get(raw_key)
                if cached is not None:
                    results[raw_key] = cached
                elif raw_key not in seen_misses:
                    seen_misses.add(raw_key)
                    misses.append(raw_key)
        else:
            for raw_key in raw_keys:
                if raw_key not in seen_misses:
                    seen_misses.add(raw_key)
                    misses.append(raw_key)

    if not misses:
        return results

    resolved_misses: dict[str, tuple[str | None, str]] = {}
    dir_groups: dict[str, tuple[Path, list[tuple[str, Path]]]] = {}
    for raw_key in misses:
        candidate = _local_image_candidate(raw_key)
        if candidate is None:
            resolved_misses[raw_key] = (None, "")
            continue
        parent = candidate.parent
        parent_key = os.path.normpath(str(parent))
        group = dir_groups.get(parent_key)
        if group is None:
            dir_groups[parent_key] = (parent, [(raw_key, candidate)])
        else:
            group[1].append((raw_key, candidate))

    for parent_dir, group_items in dir_groups.values():
        if len(group_items) >= _BATCH_SCANDIR_MIN_FILES:
            resolved_misses.update(_scan_local_image_dir(parent_dir, group_items))
        else:
            for raw_key, _ in group_items:
                resolved, version = _resolve_local_image_with_stat(raw_key)
                resolved_misses[raw_key] = (str(resolved) if resolved is not None else None, version)

    _store_local_stat_entries(state_path, cache_epoch, resolved_misses)
    results.update(resolved_misses)
    return results


class _LossFileState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.stat_key: tuple[int, int] | None = None
        self.mtime: int | None = None
        self.lock = threading.Lock()
        self.state_token = next(_state_token_counter)
        self.local_generation = 0
        self.reset()

    def reset(self) -> None:
        self.offset = 0
        self.tail = b""
        self.sample_count = 0
        self.runs: dict[str, SampleRows] = {}
        self.current_run_id = None
        self.image_registry = {}
        self.images_by_key = {}
        self.images = []
        self.structure_codes = Codes()
        self.structures = []
        self.epochs = Codes()
        self.epoch_images = array("I")
        self.epoch_numbers = array("q")
        self.groups = {name: Codes() for name in DIMENSIONS}
        self.dir_canonical: dict[str, str] = {}
        self.index_key = None
        self.index = None
        self.index_lru: OrderedDict[tuple[Any, ...], tuple[tuple[Any, Any], int, LossIndex]] = OrderedDict()
        self.cached_revision = None
        self.cached_summary = None
        self.summary_lru: OrderedDict[tuple[Any, ...], tuple[str, dict[str, Any]]] = OrderedDict()
        self.local_generation += 1
        _drop_local_stat_bucket(str(self.path), max_token=self.state_token)
        self.metadata_revision = None
        self.reg_mask_version = 0
        self.structure_labels = []
        self.dir_lookup: dict[str, dict[str, dict[str, Any]]] = {"train": {}, "reg": {}}
        self.subset_lookup: dict[tuple[int, int], dict[str, Any]] = {}
        self.train_dirs: set[str] = set()
        self.reg_dirs: set[str] = set()
        self.canonical_dir_roots: list[tuple[str, bool]] = []
        self.dir_reg_cache: dict[tuple[str, bool], bool | None] = {}
        self.reg_scope_cache: dict[tuple[Any, ...], tuple[int, int, bool, bool]] = {}
        self.reg_mask_cache: dict[tuple[int, int, str], np.ndarray] = {}
        self.edges_cache: dict[tuple[str, str], tuple[int, dict[str, int], tuple[float | None, float | None]]] = {}

    def sync(self) -> None:
        try:
            st = self.path.stat()
        except OSError:
            if self.stat_key is not None:
                self.stat_key, self.mtime = None, None
                self.reset()
            return
        identity = (st.st_dev, st.st_ino)
        if (self.stat_key != identity or st.st_size < self.offset
                or (st.st_size == self.offset and self.mtime != st.st_mtime_ns)):
            self.stat_key = identity
            self.reset()
        self.mtime = st.st_mtime_ns

        if st.st_size == self.offset:
            return

        try:
            with self.path.open("rb") as stream:
                if self.tail:
                    stream.seek(self.offset - len(self.tail))
                    if stream.read(len(self.tail)) != self.tail:
                        self.reset()
                stream.seek(self.offset)
                while self.offset < st.st_size:
                    line = stream.readline(st.st_size - self.offset)
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        # Incomplete line currently being flushed; retry on next poll.
                        break
                    self.tail = line[-128:]
                    self.offset += len(line)
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    if "image" not in row:
                        rid = row.get("run_id")
                        if isinstance(rid, str) and rid:
                            self.current_run_id = rid
                            if rid not in self.runs:
                                self.runs[rid] = SampleRows()
                        continue
                    self.add_row(row, line)
        except OSError:
            pass

    def add_row(self, row, source):
        raw_key = row.get("image")
        if not isinstance(raw_key, str) or not raw_key:
            return
        image_key = _normalize_image_key(raw_key)
        if not image_key:
            return
        lookup_key = _case_key(image_key)
        image = self.images_by_key.get(lookup_key)
        if image is None:
            image_id = _image_id_for_key(lookup_key)
            name, directory, directory_label = _split_image_key(image_key)
            if directory:
                dir_canon = self.dir_canonical.setdefault(_case_key(directory), directory)
                if dir_canon != directory:
                    directory = dir_canon
                    _, _, directory_label = _split_image_key(f"{directory}/{name}")
            image = {"index": len(self.images), "key": image_key, "image_id": image_id, "structures": [],
                     "name": name, "directory": directory, "dir_label": directory_label}
            self.images_by_key[lookup_key] = image
            self.image_registry[image_id] = image
            self.images.append(image)

        dataset = _opt_int(row.get("dataset"))
        subset = _opt_int(row.get("subset"))
        width = _opt_int(row.get("width"))
        height = _opt_int(row.get("height"))
        batch = _opt_int(row.get("batch_size"))
        weight = _finite_float(row.get("loss_weight"))
        image_idx = image["index"]
        structure = self.structure_codes.get((image_idx, dataset, subset, width, height, batch, weight))
        if structure == len(self.structures):
            image["structures"].append(structure)
            self.structures.append((
                image_idx,
                self.groups["resolution"].get(f"{width}x{height}" if width is not None and height is not None else "(unknown)"),
                self.groups["subset"].get(f"{dataset}-{subset}" if dataset is not None and subset is not None else "(unknown)"),
                self.groups["batch_size"].get(str(batch) if batch is not None else "(unknown)"),
                self.groups["directory"].get(image["directory"] or "(root)"),
            ))
        step, epoch = _opt_int(row.get("step")), _opt_int(row.get("epoch"))
        step = step if step is not None and 0 <= step < 2**63 else None
        epoch = epoch if epoch is not None and 0 <= epoch < 2**63 else None
        epoch_id = self.epochs.get((image_idx, epoch))
        if epoch_id == len(self.epoch_images):
            self.epoch_images.append(image_idx)
            self.epoch_numbers.append(epoch if epoch is not None else -1)
        run_id = self.current_run_id or "(unknown)"
        bucket = self.runs.get(run_id)
        if bucket is None:
            bucket = self.runs[run_id] = SampleRows()
        bucket.append(image_idx, structure, epoch_id, step, _finite_float(row.get("timestep")), _finite_float(row.get("loss")), source)
        self.sample_count += 1

    def select(self, requested):
        if requested == "all":
            return "all", self.runs
        if requested not in self.runs:
            requested = next(reversed(self.runs), "")
        return requested, {requested: self.runs[requested]} if requested else {}

    def indexed(
        self,
        run_id,
        runs,
        bins,
        scale,
        *,
        deweight_scheme: str | None = None,
        reg_mode: str = "all",
        allowed_structures: np.ndarray | None = None,
        reg_mask_version: int = 0,
    ):
        if allowed_structures is None:
            edges = LossIndex.edges_of(runs)
        else:
            edge_key = (run_id, reg_mode)
            prev = self.edges_cache.get(edge_key)
            if (
                prev is not None
                and prev[0] == reg_mask_version
                and set(prev[1]).issubset(runs)
                and all(prev[1].get(rid, 0) <= len(rows) for rid, rows in runs.items())
            ):
                if len(prev[1]) == len(runs) and all(prev[1].get(rid, 0) == len(rows) for rid, rows in runs.items()):
                    edges = prev[2]
                else:
                    edges = LossIndex.edges_of(
                        runs, allowed_structures=allowed_structures, offsets=prev[1], prev_edges=prev[2],
                    )
                    self.edges_cache[edge_key] = (
                        reg_mask_version,
                        {rid: len(rows) for rid, rows in runs.items()},
                        edges,
                    )
            else:
                edges = LossIndex.edges_of(runs, allowed_structures=allowed_structures)
                self.edges_cache[edge_key] = (
                    reg_mask_version,
                    {rid: len(rows) for rid, rows in runs.items()},
                    edges,
                )
        slot_key = (run_id, bins, scale, deweight_scheme, reg_mode)
        cached = self.index_lru.get(slot_key)
        if cached is not None and cached[0] == edges and cached[1] == reg_mask_version:
            index = cached[2]
            self.index_lru.move_to_end(slot_key)
        else:
            index = LossIndex(bins, edges, scale, deweight_scheme=deweight_scheme)
            self.index_lru[slot_key] = (edges, reg_mask_version, index)
            self.index_lru.move_to_end(slot_key)
            while len(self.index_lru) > _MAX_INDEX_LRU:
                self.index_lru.popitem(last=False)
        index.extend(runs, self.structures, self.epoch_numbers, allowed_structures=allowed_structures)
        self.index = index
        self.index_key = (*slot_key, edges, reg_mask_version)
        return index

    def sample_metadata(self, structure):
        image, dataset, subset, width, height, batch, weight = self.structure_codes.keys[structure]
        entry = self.images[image]
        return {"image": entry["key"], "image_id": entry["image_id"], "dataset": dataset, "subset": subset,
                "width": width, "height": height, "batch_size": batch, "loss_weight": weight}

    def image_samples(self, runs, image):
        for bucket in runs.values():
            for row_index in bucket.image_rows.get(image["index"], ()):
                step, epoch_id = bucket.step[row_index], bucket.epoch[row_index]
                timestep, loss = bucket.timestep[row_index], bucket.loss[row_index]
                yield {**self.sample_metadata(bucket.structure[row_index]),
                       "structure": bucket.structure[row_index],
                       "step": step if step >= 0 else None, "epoch": self.epochs.keys[epoch_id][1], "epoch_id": epoch_id,
                       "timestep": timestep if math.isfinite(timestep) else None,
                       "loss": loss if math.isfinite(loss) else None}


def _get_loss_state(loss_path: Path) -> _LossFileState:
    cache_key = str(loss_path)
    evicted: list[tuple[str, int]] = []
    with _cache_lock:
        state = _file_cache.get(cache_key)
        if state is None:
            state = _LossFileState(loss_path)
            _file_cache[cache_key] = state
            while len(_file_cache) > _MAX_CACHED_FILES:
                evicted_key, oldest = _file_cache.popitem(last=False)
                evicted.append((evicted_key, oldest.state_token))
        else:
            _file_cache.move_to_end(cache_key)
    for evicted_key, evicted_token in evicted:
        _drop_local_stat_bucket(evicted_key, max_token=evicted_token)
    return state


def _trim_loss_cache() -> None:
    evicted: list[tuple[str, int]] = []
    with _cache_lock:
        total = sum(state.sample_count for state in _file_cache.values())
        while total > _MAX_CACHED_SAMPLES and len(_file_cache) > 1:
            evicted_key, oldest = _file_cache.popitem(last=False)
            total -= oldest.sample_count
            evicted.append((evicted_key, oldest.state_token))
    for evicted_key, evicted_token in evicted:
        _drop_local_stat_bucket(evicted_key, max_token=evicted_token)


def has_dataset_diagnostics(run_path: Path) -> bool:
    """Fast stat-only check for run detail and live snapshot payloads."""
    try:
        return (run_path / "log" / ".run-control" / LOSS_FILE).is_file()
    except OSError:
        return False


def clear_dataset_diagnostics_cache() -> None:
    with _cache_lock:
        _file_cache.clear()
    with _local_stat_lock:
        _local_stat_cache.clear()
    _read_metadata_revision.cache_clear()


def _run_config(record: dict[str, Any] | None) -> dict[str, Any]:
    if not record or not record.get("run_path"):
        return {}
    return read_run_config(Path(record["run_path"]))


def _resolve_relative_path(raw_path: str | Path, manifest_cwd: str | None = None) -> Path:
    path = Path(str(raw_path))
    if path.is_absolute():
        return path
    if isinstance(manifest_cwd, str) and manifest_cwd.strip():
        cwd_candidate = Path(manifest_cwd.strip()) / path
        if cwd_candidate.exists():
            return cwd_candidate
        repo_candidate = REPO_ROOT / path
        return repo_candidate if repo_candidate.exists() else cwd_candidate
    return REPO_ROOT / path


def _dataset_config_path(
    record: dict[str, Any] | None,
    config: dict[str, Any] | None = None,
    *,
    manifest_cwd: str | None = None,
) -> Path | None:
    if not record or not record.get("run_path"):
        return None
    run_path = Path(record["run_path"])
    snapshot = run_path / "dataset.toml"
    if snapshot.is_file():
        return snapshot
    cfg = config if config is not None else _run_config(record)
    configured = cfg.get("dataset_config")
    if not configured:
        return None
    return _resolve_relative_path(str(configured), manifest_cwd=manifest_cwd)


def _dataset_config(
    record: dict[str, Any] | None,
    config: dict[str, Any],
    *,
    manifest_cwd: str | None = None,
) -> dict[str, Any] | None:
    """Read the dataset configuration used by the run, when one was supplied."""
    path = _dataset_config_path(record, config, manifest_cwd=manifest_cwd)
    if path is None:
        return None
    try:
        if path.suffix.lower() == ".json":
            with path.open("r", encoding="utf-8") as stream:
                value = json.load(stream)
            return value if isinstance(value, dict) else None
        with path.open("rb") as stream:
            return tomllib.load(stream)
    except (OSError, UnicodeError, ValueError):
        return None


def _canonical_path(path: str | Path) -> str:
    try:
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = REPO_ROOT / candidate
        return os.path.normcase(str(candidate.resolve()))
    except (OSError, RuntimeError, ValueError):
        return ""


def _is_path_under(path: str | Path, root: str | Path) -> bool:
    candidate, parent = _canonical_path(path), _canonical_path(root)
    if not candidate or not parent:
        return False
    try:
        return os.path.commonpath((candidate, parent)) == parent
    except ValueError:  # Different drives on Windows.
        return False


def _manifest_matches_run(manifest: dict[str, Any] | None, run_id: str, available_runs: list[str]) -> bool:
    if not isinstance(manifest, dict) or not manifest or run_id == "all":
        return False
    m_run = manifest.get("run_id")
    if isinstance(m_run, str) and m_run.strip():
        return m_run.strip() == run_id
    return not available_runs or run_id == available_runs[-1]


def _match_manifest_and_trust(
    manifest: dict[str, Any] | None, run_id: str, available_runs: list[str],
) -> tuple[bool, bool, dict[str, Any]]:
    manifest_matches = _manifest_matches_run(manifest, run_id, available_runs)
    config_trusted = manifest_matches or (not manifest and (not available_runs or run_id == available_runs[-1]))
    active_manifest = manifest if manifest_matches else {}
    return manifest_matches, config_trusted, active_manifest


def _path_name_matches(cand_path: Any, runtime_name: Any) -> bool:
    if not cand_path or not runtime_name:
        return False
    left = Path(str(cand_path).replace("\\", "/").rstrip("/")).name
    right = Path(str(runtime_name).replace("\\", "/").rstrip("/")).name
    if not left or not right:
        return False
    if os.name == "nt" or (":" in str(cand_path)) or (":" in str(runtime_name)):
        return left.casefold() == right.casefold()
    return left == right


def _align_subset_cursor(
    subset_lookup: dict[tuple[int, int], dict[str, Any]],
    ds_index: int,
    cfg_subsets: list[dict[str, Any]],
    ds: dict[str, Any],
    general: dict[str, Any],
) -> dict[int, int]:
    """Align surviving runtime ss_datasets subset indices to original config subsets."""
    aligned: dict[int, int] = {}
    runtime_indices = sorted(sub_idx for (d_i, sub_idx) in subset_lookup if d_i == ds_index)
    cursor = 0
    for s_idx in runtime_indices:
        runtime = subset_lookup.get((ds_index, s_idx))
        if not runtime:
            continue
        name = runtime.get("metadata_file") or runtime.get("label")
        found = None
        for cfg_i in range(cursor, len(cfg_subsets)):
            cand = cfg_subsets[cfg_i]
            if not isinstance(cand, dict):
                continue
            cand_path = cand.get("metadata_file") if runtime.get("metadata_file") else (
                cand.get("image_dir") or ds.get("image_dir") or general.get("image_dir")
            )
            cand_reg = cand.get("is_reg", ds.get("is_reg", general.get("is_reg", False)))
            if _path_name_matches(cand_path, name) and (
                runtime.get("is_reg") is None or bool(cand_reg) == runtime["is_reg"]
            ):
                found = cfg_i
                break
        if found is not None:
            aligned[s_idx] = found
            cursor = found + 1
    return aligned


def _opt_subset_offset(*containers: dict[str, Any] | None) -> float | None:
    """Resolve custom_attributes.timestep_sampling.offset using subset -> dataset -> general precedence."""
    for container in containers:
        if not isinstance(container, dict):
            continue
        ca = container.get("custom_attributes")
        if ca is None:
            continue
        if not isinstance(ca, dict):
            return None
        ts = ca.get("timestep_sampling")
        if not isinstance(ts, dict):
            return None
        val = _opt_float(ts.get("offset"))
        return val if (val is not None and abs(val) > 1e-9) else None
    return None


def _build_subset_lookup(
    manifest: dict[str, Any], record: dict[str, Any] | None = None, *, allow_config: bool = True,
) -> tuple[dict[tuple[int, int], dict[str, Any]], set[str]]:
    metadata = manifest.get("metadata") if isinstance(manifest, dict) and isinstance(manifest.get("metadata"), dict) else {}
    lookup: dict[tuple[int, int], dict[str, Any]] = {}
    ss_datasets = metadata.get("ss_datasets")
    if isinstance(ss_datasets, list):
        for d_idx, ds in enumerate(ss_datasets):
            if not isinstance(ds, dict):
                continue
            subsets = ds.get("subsets")
            if not isinstance(subsets, list):
                continue
            for s_idx, sub in enumerate(subsets):
                if not isinstance(sub, dict):
                    continue
                label = sub.get("image_dir") or sub.get("metadata_file") or f"{d_idx}-{s_idx}"
                img_count = _opt_int(sub.get("img_count"))
                num_repeats = _opt_int(sub.get("num_repeats"))
                is_reg = bool(sub["is_reg"]) if "is_reg" in sub else False if sub.get("metadata_file") else None
                entry: dict[str, Any] = {
                    "label": str(label),
                    "is_reg": is_reg,
                    "num_repeats": num_repeats if num_repeats is not None and num_repeats > 0 else None,
                    "img_count": img_count if img_count is not None and img_count > 0 else None,
                    "metadata_file": sub.get("metadata_file"),
                    "class_tokens": sub.get("class_tokens"),
                }
                aug_flags = [k for k in ("flip_aug", "color_aug", "random_crop", "shuffle_caption") if sub.get(k)]
                if aug_flags:
                    entry["aug_flags"] = aug_flags
                offset = _opt_subset_offset(sub, ds)
                if offset is not None:
                    entry["timestep_offset"] = offset
                lookup[(d_idx, s_idx)] = entry
    reg_dirs: set[str] = set()
    manifest_args = manifest.get("args") if isinstance(manifest, dict) and isinstance(manifest.get("args"), dict) else {}
    if manifest_args.get("reg_data_dir"):
        reg_dirs.add(str(manifest_args["reg_data_dir"]))
    manifest_cwd = manifest.get("cwd") if isinstance(manifest, dict) else None
    if allow_config:
        config = _run_config(record)
        if config.get("reg_data_dir"):
            reg_dirs.add(str(config["reg_data_dir"]))
        dataset_config = _dataset_config(record, config, manifest_cwd=manifest_cwd)
        if isinstance(dataset_config, dict):
            general = dataset_config.get("general") if isinstance(dataset_config.get("general"), dict) else {}
            for d_idx, ds in enumerate(dataset_config.get("datasets", [])):
                if not isinstance(ds, dict):
                    continue
                ds_subsets = ds.get("subsets")
                if not isinstance(ds_subsets, list):
                    continue
                cfg_subsets = [sub for sub in ds_subsets if isinstance(sub, dict)]
                for sub in cfg_subsets:
                    if sub.get("is_reg") and sub.get("image_dir"):
                        reg_dirs.add(str(sub["image_dir"]))
                runtime_indices = sorted(sub_idx for (ds_idx, sub_idx) in lookup if ds_idx == d_idx)
                if runtime_indices:
                    aligned = _align_subset_cursor(lookup, d_idx, cfg_subsets, ds, general)
                    for s_idx in runtime_indices:
                        runtime = lookup[(d_idx, s_idx)]
                        cfg_idx = aligned.get(s_idx)
                        if cfg_idx is None:
                            if 0 <= s_idx < len(cfg_subsets):
                                offset = _opt_subset_offset(cfg_subsets[s_idx], ds, general)
                                if offset is not None:
                                    runtime.setdefault("timestep_offset", offset)
                            continue
                        cand = cfg_subsets[cfg_idx]
                        cand_path = cand.get("metadata_file") if runtime.get("metadata_file") else (
                            cand.get("image_dir") or ds.get("image_dir") or general.get("image_dir")
                        )
                        if cand_path:
                            runtime["source_path"] = _canonical_path(cand_path) or _case_key(_normalize_image_key(str(cand_path)))
                        offset = _opt_subset_offset(cand, ds, general)
                        if offset is not None:
                            runtime.setdefault("timestep_offset", offset)
                else:
                    for s_idx, sub in enumerate(cfg_subsets):
                        offset = _opt_subset_offset(sub, ds, general)
                        if offset is not None:
                            lookup.setdefault((d_idx, s_idx), {})["timestep_offset"] = offset
    return lookup, reg_dirs


def _collect_train_dirs(
    manifest: dict[str, Any], record: dict[str, Any] | None = None, *, allow_config: bool = True,
) -> set[str]:
    train_dirs: set[str] = set()
    manifest_args = manifest.get("args") if isinstance(manifest, dict) and isinstance(manifest.get("args"), dict) else {}
    if manifest_args.get("train_data_dir"):
        train_dirs.add(str(manifest_args["train_data_dir"]))
    manifest_cwd = manifest.get("cwd") if isinstance(manifest, dict) else None
    if allow_config:
        config = _run_config(record)
        if config.get("train_data_dir"):
            train_dirs.add(str(config["train_data_dir"]))
        dataset_config = _dataset_config(record, config, manifest_cwd=manifest_cwd)
        if isinstance(dataset_config, dict):
            general = dataset_config.get("general") if isinstance(dataset_config.get("general"), dict) else {}
            for ds in dataset_config.get("datasets", []):
                if not isinstance(ds, dict) or not isinstance(ds.get("subsets"), list):
                    continue
                for sub in ds["subsets"]:
                    if not isinstance(sub, dict):
                        continue
                    is_reg = sub.get("is_reg", ds.get("is_reg", general.get("is_reg", False)))
                    image_dir = sub.get("image_dir") or ds.get("image_dir") or general.get("image_dir")
                    if not is_reg and image_dir:
                        train_dirs.add(str(image_dir))
    return train_dirs


def _decode_json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.lstrip().startswith("{"):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


def _build_dir_lookup(manifest: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    """Fallback metadata lookup for --train_data_dir / --reg_data_dir runs without ss_datasets."""
    metadata = manifest.get("metadata") if isinstance(manifest, dict) and isinstance(manifest.get("metadata"), dict) else {}
    if isinstance(metadata.get("ss_datasets"), list):
        return {"train": {}, "reg": {}}
    train_dirs: dict[str, dict[str, Any]] = {}
    reg_dirs: dict[str, dict[str, Any]] = {}
    for key, is_reg, target in (("ss_dataset_dirs", False, train_dirs), ("ss_reg_dataset_dirs", True, reg_dirs)):
        mapping = _decode_json_dict(metadata.get(key))
        for dir_name, info in mapping.items():
            if not isinstance(info, dict):
                continue
            img_count = _opt_int(info.get("img_count"))
            num_repeats = _opt_int(info.get("n_repeats"))
            target[str(dir_name)] = {
                "is_reg": is_reg,
                "img_count": img_count if img_count is not None and img_count > 0 else None,
                "num_repeats": num_repeats if num_repeats is not None and num_repeats > 0 else None,
            }
    return {"train": train_dirs, "reg": reg_dirs}


def _split_dir_lookup(
    dir_lookup: dict[str, Any] | None,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    if not dir_lookup:
        return {}, {}
    if "train" in dir_lookup or "reg" in dir_lookup:
        train_map = dir_lookup.get("train")
        reg_map = dir_lookup.get("reg")
        if isinstance(train_map, dict) or isinstance(reg_map, dict):
            return (train_map if isinstance(train_map, dict) else {}), (reg_map if isinstance(reg_map, dict) else {})
    train_map = {k: v for k, v in dir_lookup.items() if isinstance(v, dict) and v.get("is_reg") is not True}
    reg_map = {k: v for k, v in dir_lookup.items() if isinstance(v, dict) and v.get("is_reg") is True}
    return train_map, reg_map


def _lookup_dir_info(dir_lookup: dict[str, Any] | None, label: str, is_reg: bool | None) -> dict[str, Any] | None:
    if not dir_lookup or not label:
        return None
    train_map, reg_map = _split_dir_lookup(dir_lookup)
    if is_reg is True:
        return reg_map.get(label)
    if is_reg is False:
        return train_map.get(label)
    in_train = train_map.get(label)
    in_reg = reg_map.get(label)
    if in_train and not in_reg:
        return in_train
    if in_reg and not in_train:
        return in_reg
    return None


def _unique_dataset_image_weight(ds: dict[str, Any], binfo: dict[str, Any] | None = None) -> float | None:
    subsets = ds.get("subsets")
    if isinstance(subsets, list) and subsets:
        train_subs = [sub for sub in subsets if isinstance(sub, dict) and not sub.get("is_reg")]
        reg_subs = [sub for sub in subsets if isinstance(sub, dict) and sub.get("is_reg")]
        if (train_subs or reg_subs) and all((_opt_int(sub.get("img_count")) or 0) > 0 for sub in (*train_subs, *reg_subs)):
            unique_total = sum(_opt_int(sub.get("img_count")) or 0 for sub in train_subs)
            if reg_subs:
                num_train_images = _opt_int(ds.get("num_train_images"))
                if num_train_images is None or num_train_images <= 0:
                    num_train_images = sum(
                        (_opt_int(sub.get("img_count")) or 0) * max(1, _opt_int(sub.get("num_repeats")) or 1)
                        for sub in train_subs
                    )
                reg_expanded_total = sum(
                    (_opt_int(sub.get("img_count")) or 0) * max(1, _opt_int(sub.get("num_repeats")) or 1)
                    for sub in reg_subs
                )
                if num_train_images > 0 and reg_expanded_total > num_train_images:
                    remaining = num_train_images
                    for sub in reg_subs:
                        if remaining <= 0:
                            break
                        cnt = _opt_int(sub.get("img_count")) or 0
                        rep = max(1, _opt_int(sub.get("num_repeats")) or 1)
                        used = min(cnt, math.ceil(remaining / rep))
                        unique_total += used
                        remaining -= used * rep
                else:
                    unique_total += sum(_opt_int(sub.get("img_count")) or 0 for sub in reg_subs)
            buckets = binfo.get("buckets") if isinstance(binfo, dict) else None
            if ds.get("is_dreambooth") is False and isinstance(buckets, (dict, list)):
                items = buckets.values() if isinstance(buckets, dict) else buckets
                bucket_total = sum(
                    max(0, _opt_int(item.get("count")) or 0)
                    for item in items
                    if isinstance(item, dict)
                )
                if bucket_total == 0:
                    return 0.0
                reps = {max(1, _opt_int(sub.get("num_repeats")) or 1) for sub in (*train_subs, *reg_subs)}
                if len(reps) == 1:
                    return bucket_total / next(iter(reps))
                expected_expanded = sum(
                    (_opt_int(sub.get("img_count")) or 0) * max(1, _opt_int(sub.get("num_repeats")) or 1)
                    for sub in (*train_subs, *reg_subs)
                )
                if expected_expanded > 0 and bucket_total < expected_expanded:
                    return None
            if unique_total > 0:
                return float(unique_total)
    return float(_opt_int(ds.get("num_train_images")) or 1)


def _extract_bucket_ar_error(manifest: dict[str, Any]) -> float | None:
    metadata = manifest.get("metadata") if isinstance(manifest, dict) and isinstance(manifest.get("metadata"), dict) else {}
    ss_datasets = metadata.get("ss_datasets")
    if isinstance(ss_datasets, list):
        entries: list[tuple[float, float | None]] = []
        for ds in ss_datasets:
            if not isinstance(ds, dict):
                continue
            binfo = _decode_json_dict(ds.get("bucket_info"))
            ar = _opt_float(binfo.get("mean_img_ar_error"))
            if ar is None or ar < 0:
                continue
            w = _unique_dataset_image_weight(ds, binfo)
            if w is not None and w <= 0:
                continue
            entries.append((ar, w))
        if not entries:
            return None
        if len(entries) == 1:
            return entries[0][0]
        if any(w is None for _, w in entries):
            return None
        weighted = sum(ar * w for ar, w in entries if w is not None)
        total_w = sum(w for _, w in entries if w is not None)
        return (weighted / total_w) if total_w > 0 else None
    binfo = _decode_json_dict(metadata.get("ss_bucket_info"))
    ar = _opt_float(binfo.get("mean_img_ar_error"))
    return ar if ar is not None and ar >= 0 else None


def _resolve_subset_label(
    row: dict[str, Any], subset_lookup: dict[tuple[int, int], dict[str, Any]], *, fallback_to_key: bool = False,
) -> str:
    info = subset_lookup.get((row.get("dataset"), row.get("subset")))
    if info and info.get("label"):
        return str(info["label"])
    if fallback_to_key:
        return _subset_key(row)
    _, directory, _ = _split_image_key(row.get("image", ""))
    return directory.rstrip("/").rsplit("/", 1)[-1] if directory else _subset_key(row)


def _timestep_scale(profile: str) -> str:
    if profile == "anima-lora":
        return "unit"
    if profile in ("sdxl-lora", "moss-image-lora", "flux-lora"):
        return "thousand"
    return "unknown"


_SCRIPT_PROFILE_MAP = {
    "anima_train_network.py": "anima-lora",
    "anima_train.py": "anima-lora",
    "sdxl_train_network.py": "sdxl-lora",
    "sdxl_train.py": "sdxl-lora",
    "moss_image_train_network.py": "moss-image-lora",
    "moss_image_train.py": "moss-image-lora",
    "flux_train_network.py": "flux-lora",
    "flux_train.py": "flux-lora",
    "krea2_train_network.py": "krea2-lora",
}


def _detect_profile(record: dict[str, Any]) -> str:
    extra = record.get("extra") if isinstance(record.get("extra"), dict) else {}
    profile = str(extra.get("profile_id") or "").strip()
    if not profile and record.get("run_path"):
        run_path = Path(record["run_path"])
        cfg = read_run_config(run_path)
        profile = str(cfg.get("model_train_type") or "").strip()
        if not profile:
            # Older run records or imported runs may identify the trainer via extra or manifest.json["script"].
            from backend.training.config.config_import import infer_training_profile

            trainer_hint = str(extra.get("trainer_file") or "").strip()
            if not trainer_hint:
                manifest = read_object(run_path / "log" / ".run-control" / MANIFEST_FILE)
                if isinstance(manifest, dict):
                    trainer_hint = str(manifest.get("script") or "").strip()
            try:
                profile = infer_training_profile(cfg, {"extra": {**extra, "trainer_file": trainer_hint}}) or ""
            except ValueError:
                profile = ""
            if not profile and trainer_hint:
                script_name = PurePosixPath(trainer_hint.replace("\\", "/")).name
                profile = _SCRIPT_PROFILE_MAP.get(script_name, "")
    return profile


def _subset_key(row: dict[str, Any]) -> str:
    if row["dataset"] is None or row["subset"] is None:
        return "(unknown)"
    return f"{row['dataset']}-{row['subset']}"


def _build_canonical_dir_roots(reg_dirs: set[str], train_dirs: set[str] | None) -> list[tuple[str, bool]]:
    candidates: list[tuple[str, bool]] = []
    for root in reg_dirs:
        canon = _canonical_path(root)
        if canon:
            candidates.append((canon, True))
    for root in (train_dirs or ()):
        canon = _canonical_path(root)
        if canon:
            candidates.append((canon, False))
    candidates.sort(key=lambda item: len(item[0]), reverse=True)
    return candidates


def _match_canonical_roots(path_canon: str, roots: list[tuple[str, bool]]) -> bool | None:
    if not path_canon or not roots:
        return None
    for root_canon, root_is_reg in roots:
        try:
            if os.path.commonpath((path_canon, root_canon)) == root_canon:
                return root_is_reg
        except ValueError:
            continue
    return None


def _row_is_reg(
    row: dict[str, Any],
    subset_lookup: dict[tuple[int, int], dict[str, Any]],
    reg_dirs: set[str],
    dir_lookup: dict[str, Any] | None = None,
    subset_label: str = "",
    train_dirs: set[str] | None = None,
    *,
    canonical_roots: list[tuple[str, bool]] | None = None,
    dir_match_cache: dict[tuple[str, bool], bool | None] | None = None,
) -> bool | None:
    d, s = row["dataset"], row["subset"]
    if d is not None and s is not None and (d, s) in subset_lookup:
        is_reg = subset_lookup[(d, s)].get("is_reg")
        if is_reg is not None:
            return bool(is_reg)
    image = row.get("image") or ""
    if image and (reg_dirs or train_dirs):
        is_abs_outside = bool(reg_dirs and Path(image).is_absolute())
        parent_key = os.path.dirname(image)
        if dir_match_cache is not None and parent_key:
            cache_key = (parent_key, is_abs_outside)
            if cache_key in dir_match_cache:
                matched = dir_match_cache[cache_key]
            else:
                roots = canonical_roots if canonical_roots is not None else _build_canonical_dir_roots(reg_dirs, train_dirs)
                matched = _match_canonical_roots(_canonical_path(parent_key), roots)
                if matched is None and is_abs_outside:
                    matched = False
                dir_match_cache[cache_key] = matched
            if matched is not None:
                return matched
        else:
            roots = canonical_roots if canonical_roots is not None else _build_canonical_dir_roots(reg_dirs, train_dirs)
            matched = _match_canonical_roots(_canonical_path(image), roots)
            if matched is not None:
                return matched
            if is_abs_outside:
                # A concrete, absolute image outside the recorded regularization roots
                # is a training image; metadata keys alone cannot establish a path.
                return False
    lw = row.get("loss_weight")
    if lw is not None and abs(lw - 1.0) > 1e-5:
        return True
    if dir_lookup and subset_label:
        train_map, reg_map = _split_dir_lookup(dir_lookup)
        in_train = subset_label in train_map
        in_reg = subset_label in reg_map
        if in_reg != in_train:
            return in_reg
    return None


def _converging_slope_threshold(epoch_from: int | None, epoch_to: int | None) -> float:
    if epoch_from is None or epoch_to is None or epoch_to <= epoch_from:
        return CONVERGING_SLOPE_THRESHOLD
    span = epoch_to - epoch_from
    return -min(
        abs(CONVERGING_SLOPE_THRESHOLD),
        max(abs(MIN_CONVERGING_SLOPE_THRESHOLD), round(CONVERGING_CUMULATIVE_DROP / span, 6)),
    )


def _classify_image(
    *,
    count: int,
    comparable_count: int,
    non_finite_count: int,
    mean_residual: float | None,
    slope: float | None,
    min_count: int,
    converging_slope: float = CONVERGING_SLOPE_THRESHOLD,
) -> str:
    if non_finite_count > 0:
        return "non_finite"
    if count < min_count:
        return "insufficient"
    if comparable_count < min_count or mean_residual is None:
        return "insufficient_reference"
    if mean_residual >= HIGH_RESIDUAL_THRESHOLD:
        if slope is not None and slope <= converging_slope:
            return "learning"
        return "attention"
    if mean_residual <= LOW_RESIDUAL_THRESHOLD:
        return "easy"
    return "normal"


def _pick_notable_group(
    groups_by_dim: dict[str, list[dict[str, Any]]],
    min_count: int,
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_score = 0.0
    for dim in ("subset", "resolution", "directory"):
        items = groups_by_dim.get(dim) or []
        if len(items) < 2:
            continue
        for item in items:
            if item["key"] == "(unknown)":
                continue
            if item.get("comparable_count", item["count"]) < min_count or item["images"] < 2:
                continue
            if item.get("mean_residual") is None:
                continue
            res = float(item["mean_residual"])
            if res < 0.12:
                continue
            score = res * math.log1p(item["images"])
            if score > best_score:
                best_score = score
                best = {
                    "dimension": dim,
                    "key": item["key"],
                    "label": item["label"],
                    "mean_residual": res,
                    "images": item["images"],
                }
    return best


def _file_revision(path: Path):
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns


def _metadata_revision(state, record, *, manifest_cwd: str | None = None):
    run_path = Path(record["run_path"])
    ds_path = _dataset_config_path(record, manifest_cwd=manifest_cwd)
    return (
        state.local_generation,
        _file_revision(state.path.with_name(MANIFEST_FILE)),
        _file_revision(run_path / "config.toml"),
        (str(ds_path), _file_revision(ds_path)) if ds_path is not None else None,
    )


def _analysis_revision(
    state, runs, run_id, profile, bins, min_samples, record,
    reg_mode: str = "all", deweight_scheme: str | None = None,
    *, metadata_revision=None,
):
    metadata = metadata_revision if metadata_revision is not None else _metadata_revision(state, record)
    selections = tuple((key, rows.digest.hexdigest()) for key, rows in runs.items())
    parts = (
        str(state.path), selections, tuple(state.runs), run_id,
        profile, bins, min_samples, record.get("run_dir", ""), metadata,
        reg_mode, deweight_scheme,
    )
    data_metadata = metadata[1:] if isinstance(metadata, tuple) else metadata
    data_parts = (
        str(state.path), selections, tuple(state.runs), run_id,
        profile, bins, min_samples, record.get("run_dir", ""), data_metadata,
        reg_mode, deweight_scheme,
    )
    return (
        hashlib.sha256(repr(parts).encode()).hexdigest(),
        hashlib.sha256(repr(data_parts).encode()).hexdigest(),
    )


def _unavailable(reason, known_revision, **details):
    revision = hashlib.sha256(repr((reason, details)).encode()).hexdigest()
    if revision == known_revision:
        return {"revision": revision, "unchanged": True}
    return {"available": False, "reason": reason, "revision": revision, **details}


def _timestep_table(index, means, distinct, eligible):
    start, end = index.edges
    if start is None or end is None:
        return []
    width = index.width
    return [
        {"bin": b, "timestep_from": start + width * b, "timestep_to": start + width * (b + 1) if width else end,
         "count": int(index.counts[b]), "images": distinct[b],
         "comparable_count": int(index.counts[b]) if eligible[b] else 0, "mean_loss": float(means[b])}
        for b in range(index.num_bins) if index.counts[b]
    ]


def _stats_at(totals, index):
    return _stats_values(*(float(values[index]) for values in totals))


def _stats_values(count, loss, compared, residual):
    return {
        "count": int(count), "comparable_count": int(compared),
        "mean_loss": loss / count if count else None,
        "mean_residual": residual / compared if compared else None,
    }


def _reg_status(members):
    if True in members and False in members:
        return None
    if True in members:
        return True
    return False if members == {False} else None


def _structure_labels(state, revision, manifest, record, *, allow_config: bool = True, fallback_to_key: bool = False):
    cache_key = (revision[1:] if isinstance(revision, tuple) else revision, bool(manifest), allow_config, fallback_to_key)
    if getattr(state, "metadata_revision", None) != cache_key:
        state.metadata_revision = cache_key
        state.subset_lookup, state.reg_dirs = _build_subset_lookup(manifest, record, allow_config=allow_config)
        state.train_dirs = _collect_train_dirs(manifest, record, allow_config=allow_config)
        state.dir_lookup = _build_dir_lookup(manifest)
        state.canonical_dir_roots = _build_canonical_dir_roots(state.reg_dirs, state.train_dirs)
        state.dir_reg_cache = {}
        state.reg_scope_cache.clear()
        state.reg_mask_cache.clear()
        state.edges_cache.clear()
        state.structure_labels = []
        state.reg_mask_version += 1
    train_dirs = getattr(state, "train_dirs", set())
    canonical_roots = getattr(state, "canonical_dir_roots", None)
    dir_match_cache = getattr(state, "dir_reg_cache", None)
    for structure in range(len(state.structure_labels), len(state.structures)):
        row = state.sample_metadata(structure)
        sub_label = _resolve_subset_label(row, state.subset_lookup, fallback_to_key=fallback_to_key)
        is_reg = _row_is_reg(
            row, state.subset_lookup, state.reg_dirs, state.dir_lookup, sub_label,
            train_dirs=train_dirs, canonical_roots=canonical_roots, dir_match_cache=dir_match_cache,
        )
        state.structure_labels.append((sub_label, is_reg))
    return state.structure_labels


def _compute_reg_scope(
    state: _LossFileState,
    runs: dict[str, SampleRows],
    labels: list[tuple[str, bool | None]],
    requested_reg_mode: str,
    *,
    selected: str = "",
    need_mask: bool = True,
) -> tuple[str, np.ndarray | None, int, int, bool]:
    """Compute full-run train/reg image counts and effective filter mask for reg_mode."""
    req_mode = requested_reg_mode if requested_reg_mode in ("all", "exclude", "only") else "all"
    scope_key = (
        selected,
        tuple((rid, len(rows.structures_seen)) for rid, rows in runs.items()),
        state.reg_mask_version,
    )
    cached_scope = state.reg_scope_cache.get(scope_key)
    if cached_scope is not None:
        train_images_total, reg_images_total, has_reg_images, has_train_rows = cached_scope
    else:
        run_structures: set[int] = set()
        for rows in runs.values():
            run_structures.update(rows.structures_seen)
        img_regs: dict[int, set[bool | None]] = defaultdict(set)
        for structure in run_structures:
            img_idx = state.structures[structure][0]
            img_regs[img_idx].add(labels[structure][1])
        reg_images_total = sum(1 for regs in img_regs.values() if True in regs)
        train_images_total = sum(1 for regs in img_regs.values() if any(flag is not True for flag in regs))
        has_reg_images = reg_images_total > 0
        has_train_rows = train_images_total > 0
        if len(state.reg_scope_cache) >= 16:
            state.reg_scope_cache.clear()
        state.reg_scope_cache[scope_key] = (train_images_total, reg_images_total, has_reg_images, has_train_rows)

    if not has_reg_images:
        return "all", None, train_images_total, reg_images_total, False
    if req_mode == "exclude":
        if not has_train_rows:
            return "all", None, train_images_total, reg_images_total, has_reg_images
        effective = "exclude"
    elif req_mode == "only":
        effective = "only"
    else:
        return "all", None, train_images_total, reg_images_total, has_reg_images

    if not need_mask:
        return effective, None, train_images_total, reg_images_total, has_reg_images

    mask_key = (len(state.structures), state.reg_mask_version, effective)
    allowed = state.reg_mask_cache.get(mask_key)
    if allowed is None:
        if effective == "exclude":
            allowed = np.array([labels[s][1] is not True for s in range(len(state.structures))], dtype=bool)
        else:
            allowed = np.array([labels[s][1] is True for s in range(len(state.structures))], dtype=bool)
        allowed.setflags(write=False)
        for old_key in [k for k in state.reg_mask_cache if k[2] == effective]:
            state.reg_mask_cache.pop(old_key, None)
        state.reg_mask_cache[mask_key] = allowed
    return effective, allowed, train_images_total, reg_images_total, has_reg_images


def _pair_sort_key(key: str, sep: str) -> tuple[int, int, int, str]:
    if isinstance(key, str) and key.count(sep) == 1:
        left, right = key.split(sep, 1)
        if left.isdigit() and right.isdigit():
            return 0, int(left), int(right), key
    return 1, 0, 0, str(key)


def _resolution_sort_key(key: str) -> tuple[int, int, int, str]:
    """Match sd-scripts BucketManager.sort(): numeric (width, height) ascending."""
    return _pair_sort_key(key, "x")


def _subset_sort_key(key: str) -> tuple[int, int, int, str]:
    """Match sd-scripts subset registration order: numeric (dataset, subset) ascending."""
    return _pair_sort_key(key, "-")


def _subset_item_sort_key(item: dict[str, Any]) -> tuple[int, int, int, int, str]:
    """Match sd-scripts registration order within non-reg / reg groups, placing reg subsets last and (unknown) after all."""
    unknown_rank, ds_idx, sub_idx, raw_key = _subset_sort_key(item["key"])
    reg_rank = 1 if item.get("is_reg") is True else 0
    return unknown_rank, reg_rank, ds_idx, sub_idx, raw_key


def _group_tables(state, index, means, eligible, labels, by_image=None):
    anomalies = {dim: defaultdict(lambda: [0, 0]) for dim in ("resolution", "subset", "directory")}
    for img in (by_image or ()):
        is_nf = img.get("status") == "non_finite" or int(img.get("non_finite_count") or 0) > 0
        is_att = img.get("status") == "attention"
        if not is_nf and not is_att:
            continue
        idx_pos = 0 if is_nf else 1
        for key in (img.get("resolutions") or [img.get("resolution")]):
            if key:
                anomalies["resolution"][key][idx_pos] += 1
        for key in (img.get("subsets") or [img.get("subset")]):
            if key:
                anomalies["subset"][key][idx_pos] += 1
        dir_key = img.get("directory") or "(root)"
        anomalies["directory"][dir_key][idx_pos] += 1

    dir_lookup = getattr(state, "dir_lookup", {}) or {}
    by_dimension = {}
    for column, dimension in enumerate(DIMENSIONS, start=1):
        group_codes = state.groups[dimension].keys
        totals = index.totals(dimension, len(group_codes), means, eligible)
        slopes = index.group_slopes(dimension, len(group_codes)) if dimension in ("resolution", "subset", "directory") else None
        images = defaultdict(set)
        subset_regs = defaultdict(set)
        subset_labels = defaultdict(Counter)
        weight_sums = defaultdict(float)
        weight_counts = defaultdict(int)
        for structure, count in index.all_structures.items():
            meta = state.structures[structure]
            image, group = meta[0], meta[column]
            images[group].add(image)
            if dimension == "subset":
                label, is_reg = labels[structure]
                subset_labels[group][label] += count
                subset_regs[group].add(is_reg)
                lw = state.structure_codes.keys[structure][6]
                if lw is not None:
                    weight_sums[group] += lw * count
                    weight_counts[group] += count
        table = []
        for group, members in images.items():
            key = group_codes[group]
            item = {"key": key, "label": key, "images": len(members), **_stats_at(totals, group)}
            if slopes is not None:
                nf_cnt, att_cnt = anomalies[dimension].get(key, (0, 0))
                item["non_finite_count"] = int(nf_cnt)
                item["attention_count"] = int(att_cnt)
                item["slope"] = _finite_float(float(slopes[group]))
            if dimension == "subset":
                item.update(label=subset_labels[group].most_common(1)[0][0], is_reg=_reg_status(subset_regs[group]))
                sub_info = None
                if key.count("-") == 1:
                    ds_idx, sub_idx = key.split("-", 1)
                    if ds_idx.isdigit() and sub_idx.isdigit():
                        sub_info = state.subset_lookup.get((int(ds_idx), int(sub_idx)))
                if sub_info:
                    if sub_info.get("img_count"):
                        item["expected_images"] = sub_info["img_count"]
                    if sub_info.get("num_repeats"):
                        item["num_repeats"] = sub_info["num_repeats"]
                    if sub_info.get("timestep_offset") is not None:
                        item["timestep_offset"] = sub_info["timestep_offset"]
                    if sub_info.get("aug_flags"):
                        item["aug_flags"] = sub_info["aug_flags"]
                else:
                    dir_info = _lookup_dir_info(dir_lookup, item["label"], item.get("is_reg"))
                    if dir_info:
                        if dir_info.get("img_count"):
                            item["expected_images"] = dir_info["img_count"]
                        if dir_info.get("num_repeats"):
                            item["num_repeats"] = dir_info["num_repeats"]
                        if item.get("is_reg") is None and dir_info.get("is_reg") is not None:
                            item["is_reg"] = dir_info["is_reg"]
                if weight_counts[group] > 0:
                    avg_lw = weight_sums[group] / weight_counts[group]
                    if abs(avg_lw - 1.0) > 1e-4:
                        item["loss_weight"] = round(avg_lw, 4)
            elif dimension == "directory":
                item.update(label=state.images[next(iter(members))]["dir_label"] or key, full_path=key)
            elif dimension == "batch_size" and key != "(unknown)":
                item["label"] = f"bs {key}"
            table.append(item)
        by_dimension[dimension] = table
    by_dimension["resolution"].sort(key=lambda item: _resolution_sort_key(item["key"]))
    by_dimension["batch_size"].sort(key=lambda item: int(item["key"]) if item["key"].isdigit() else math.inf)
    by_dimension["subset"].sort(key=_subset_item_sort_key)
    by_dimension["directory"].sort(key=lambda item: (
        item["mean_residual"] is None, -(item["mean_residual"] or 0), item["key"],
    ))
    return by_dimension


def _preview_fields_from_stat(
    image_id: str,
    encoded_run_dir: str,
    stat_entry: tuple[str | None, str] | None,
) -> dict[str, str]:
    if not encoded_run_dir or not stat_entry or not stat_entry[0]:
        return {"thumb_url": "", "preview_url": ""}
    version = stat_entry[1]
    suffix = f"{image_id}&run_dir={encoded_run_dir}"
    if version:
        suffix = f"{suffix}&v={version}"
    return {
        "thumb_url": f"/api/image-preview?scope=loss_sample&variant=thumb&path={suffix}",
        "preview_url": f"/api/image-preview?scope=loss_sample&variant=preview&path={suffix}",
    }


def _preview_fields_for(
    state_path: str, image_key: str, image_id: str, run_dir: str, cache_epoch: tuple[int, int],
) -> dict[str, str]:
    local, version = _stat_local_image_cached(state_path, image_key, cache_epoch)
    if not local or not run_dir:
        return {"thumb_url": "", "preview_url": ""}
    return _preview_fields_from_stat(
        image_id,
        urllib.parse.quote_plus(run_dir),
        (str(local), version),
    )


def _image_stats(
    state, index, entry, labels, stats, epoch_stats, zone_stats, min_samples,
    *, converging_slope: float = CONVERGING_SLOPE_THRESHOLD,
):
    resolutions, subsets, subset_labels = Counter(), Counter(), Counter()
    reg = set()
    for structure in entry["structures"]:
        count = index.all_structures.get(structure, 0)
        if not count:
            continue
        _, resolution, subset, _, _ = state.structures[structure]
        label, is_reg = labels[structure]
        resolutions[state.groups["resolution"].keys[resolution]] += count
        subsets[state.groups["subset"].keys[subset]] += count
        subset_labels[label] += count
        reg.add(is_reg)
    non_finite = index.non_finite.get(entry["index"], 0)
    epochs, _, slope, _, _ = epoch_stats
    slope = _finite_float(float(slope))
    return {
        "image_id": entry["image_id"], "image": entry["key"], "name": entry["name"],
        "directory": entry["directory"], "dir_label": entry["dir_label"] or "(root)",
        "resolution": resolutions.most_common(1)[0][0], "resolutions": sorted(resolutions),
        "subset": subsets.most_common(1)[0][0], "subsets": sorted(subsets),
        "subset_label": subset_labels.most_common(1)[0][0], "is_reg": _reg_status(reg),
        **stats, "non_finite_count": non_finite,
        "epochs": int(epochs), "slope": slope,
        "noise_zones": {zone: values if values["count"] else None for zone, values in zone_stats.items()},
        "status": _classify_image(count=stats["count"], comparable_count=stats["comparable_count"],
                                  non_finite_count=non_finite, mean_residual=stats["mean_residual"],
                                  slope=slope, min_count=min_samples, converging_slope=converging_slope),
        "thumb_url": "", "preview_url": "",
    }


def _overview_images(
    state, index, means, eligible, labels, zones, min_samples,
    *, converging_slope: float = CONVERGING_SLOPE_THRESHOLD,
):
    size = len(state.images)
    totals = index.totals("image", size, means, eligible)
    total, _, compared, residual, slope_compared, slope_residual = index.epoch_totals(state.epoch_numbers)
    epochs = epoch_metrics(
        size, state.epoch_images, state.epoch_numbers, total, compared, residual, slope_compared, slope_residual,
    )

    images = [
        _image_stats(
            state, index, entry, labels, _stats_at(totals, image),
            [column[image] for column in epochs],
            {zone: _stats_at(zones, image * len(ZONES) + z) for z, zone in enumerate(ZONES)},
            min_samples,
            converging_slope=converging_slope,
        )
        for image, entry in enumerate(state.images)
        if totals[0][image] or index.non_finite.get(image)
    ]
    images.sort(key=lambda image: (
        not image["non_finite_count"], image["mean_residual"] is None,
        -(image["mean_residual"] or 0), -image["count"], image["image_id"],
    ))
    return images



def _opt_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _finite_float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return _finite_float(float(text))
        except ValueError:
            return None
    return None


def _opt_timestep_bound(value: Any) -> int | None:
    num = _opt_float(value)
    if num is None or not num.is_integer():
        return None
    ival = int(num)
    return ival if 0 <= ival <= 1000 else None


def _opt_resolution_str(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num = _finite_float(value)
        return str(int(num)) if num is not None and num > 0 else None
    if isinstance(value, (list, tuple)) and 1 <= len(value) <= 2:
        nums = [_opt_float(item) for item in value]
        if all(n is not None and n > 0 for n in nums):
            return ",".join(str(int(n)) if n.is_integer() else str(n) for n in nums)
    return None


def _extract_sampling_config(
    manifest: dict[str, Any], record: dict[str, Any] | None, *, allow_config: bool = True, profile: str = "",
) -> dict[str, Any]:
    args = manifest.get("args") if isinstance(manifest, dict) and isinstance(manifest.get("args"), dict) else None
    source = args if args else (_run_config(record) if allow_config else {})
    if not isinstance(source, dict) or not source:
        return {}
    cfg: dict[str, Any] = {}
    ts_sampling = source.get("timestep_sampling")
    if isinstance(ts_sampling, str) and ts_sampling.strip():
        cfg["timestep_sampling"] = ts_sampling.strip()
    elif profile == "sdxl-lora":
        cfg["timestep_sampling"] = "uniform"
    shift = _opt_float(source.get("discrete_flow_shift"))
    if shift is not None:
        cfg["discrete_flow_shift"] = shift
    sigmoid_scale = _opt_float(source.get("sigmoid_scale"))
    if sigmoid_scale is not None:
        cfg["sigmoid_scale"] = sigmoid_scale
    weighting = source.get("weighting_scheme")
    if isinstance(weighting, str) and weighting.strip():
        cfg["weighting_scheme"] = weighting.strip()
    if profile not in ("anima-lora", "moss-image-lora"):
        min_t = _opt_timestep_bound(source.get("min_timestep"))
        max_t = _opt_timestep_bound(source.get("max_timestep"))
        if min_t is not None and max_t is not None and min_t >= max_t:
            min_t = max_t = None
        if min_t is not None:
            cfg["min_timestep"] = min_t
        if max_t is not None:
            cfg["max_timestep"] = max_t
    for key in ("logit_mean", "logit_std", "mode_scale", "timestep_cutoff", "timestep_uniform_ratio"):
        fval = _opt_float(source.get(key))
        if fval is not None:
            cfg[key] = fval
    res_str = _opt_resolution_str(source.get("resolution"))
    if res_str is not None:
        cfg["resolution"] = res_str
    return cfg


def _deweight_scheme_for(profile: str, sampling_config: dict[str, Any]) -> str | None:
    if profile not in ("anima-lora", "moss-image-lora"):
        return None
    scheme = str(sampling_config.get("weighting_scheme") or "").strip().lower()
    return scheme if scheme in ("sigma_sqrt", "cosmap") else None


def _expected_images_count(state: _LossFileState, effective_reg_mode: str) -> int | None:
    """Compute deduplicated expected image count filtered by effective_reg_mode."""
    def _keep(is_reg_val: Any) -> bool:
        if effective_reg_mode == "exclude":
            return is_reg_val is not True
        if effective_reg_mode == "only":
            return is_reg_val is True
        return True

    if state.subset_lookup:
        dedup: dict[tuple[bool, str], Any] = {}
        for (d_idx, s_idx), info in state.subset_lookup.items():
            if not _keep(info.get("is_reg")):
                continue
            ident = info.get("source_path") or _case_key(
                _normalize_image_key(str(info.get("metadata_file") or info.get("label") or f"{d_idx}-{s_idx}"))
            )
            key = (bool(info.get("is_reg")), ident)
            if key not in dedup:
                dedup[key] = info.get("img_count")
        if not dedup:
            return None
        img_counts = list(dedup.values())
        return sum(img_counts) if all(isinstance(c, int) and c > 0 for c in img_counts) else None
    if state.dir_lookup:
        train_map, reg_map = _split_dir_lookup(state.dir_lookup)
        dedup_dirs: dict[tuple[bool, str], Any] = {}
        for is_reg_dir, mapping in ((False, train_map), (True, reg_map)):
            for dir_name, info in mapping.items():
                if not _keep(is_reg_dir):
                    continue
                key = (is_reg_dir, _case_key(_normalize_image_key(dir_name)))
                if key not in dedup_dirs:
                    dedup_dirs[key] = info.get("img_count")
        if not dedup_dirs:
            return None
        img_counts = list(dedup_dirs.values())
        return sum(img_counts) if all(isinstance(c, int) and c > 0 for c in img_counts) else None
    return None


def _profile_series(counts_vec: np.ndarray, loss_vec: np.ndarray) -> dict[str, list]:
    counts_list = [int(v) for v in counts_vec.tolist()]
    means_list = [
        (float(loss_vec[b] / counts_list[b]) if counts_list[b] > 0 else None)
        for b in range(PROFILE_BINS)
    ]
    return {"counts": counts_list, "mean_loss": means_list}


def _build_timestep_profile(
    state: _LossFileState,
    index: LossIndex,
    by_image: list[dict[str, Any]],
    means: np.ndarray | None = None,
    eligible: np.ndarray | None = None,
    sampling_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bins = index.profile_bins(state.epoch_numbers)
    if not bins:
        return {"num_bins": PROFILE_BINS, "bins": [], "by_status": {}, "by_group": {}}

    by_group: dict[str, dict[str, Any]] = {}
    for dimension in DIMENSIONS:
        codes = state.groups[dimension].keys
        dim_counts, dim_loss = index.profile_matrix(dimension, len(codes))
        dim_zones = (
            index.dim_zone_totals(dimension, len(codes), means, eligible)
            if (means is not None and eligible is not None and len(codes))
            else None
        )
        dim_map: dict[str, Any] = {}
        for g_idx, code in enumerate(codes):
            if int(dim_counts[g_idx].sum()) > 0:
                series = _profile_series(dim_counts[g_idx], dim_loss[g_idx])
                if dim_zones is not None:
                    series["noise_zones"] = {
                        zone: (_stats_at(dim_zones, g_idx * len(ZONES) + z) if dim_zones[0][g_idx * len(ZONES) + z] else None)
                        for z, zone in enumerate(ZONES)
                    }
                dim_map[code] = series
        if dim_map:
            by_group[dimension] = dim_map

    img_counts, img_loss = index.profile_matrix("image", len(state.images))
    buckets: dict[str, list[int]] = {
        key: [] for key in ("non_finite", "attention", "learning", "normal", "easy", "unqualified")
    }
    for item in by_image:
        entry = state.image_registry.get(item["image_id"])
        if not entry:
            continue
        idx = entry["index"]
        status = item["status"]
        if item.get("non_finite_count", 0) > 0 or status == "non_finite":
            buckets["non_finite"].append(idx)
        if status in ("insufficient", "insufficient_reference"):
            buckets["unqualified"].append(idx)
        elif status in buckets and status != "non_finite":
            buckets[status].append(idx)

    by_status: dict[str, Any] = {}
    for preset, indices in buckets.items():
        if not indices:
            continue
        counts_sum = img_counts[indices].sum(axis=0)
        if int(counts_sum.sum()) > 0:
            by_status[preset] = _profile_series(counts_sum, img_loss[indices].sum(axis=0))

    profile_out: dict[str, Any] = {
        "num_bins": PROFILE_BINS, "bins": bins, "by_status": by_status, "by_group": by_group,
    }
    sampling_name = str((sampling_config or {}).get("timestep_sampling") or "")
    if sampling_name in ("flux_shift", "krea2_shift") and state.subset_lookup and any(
        info.get("timestep_offset") is not None for info in state.subset_lookup.values()
    ):
        res_keys = state.groups["resolution"].keys
        sub_keys = state.groups["subset"].keys
        joint_counts: dict[tuple[str, float], int] = defaultdict(int)
        has_nonzero_offset = False
        for structure_id, count in index.finite_structures.items():
            if count <= 0:
                continue
            _, res_id, sub_id, _, _ = state.structures[structure_id]
            res_raw = res_keys[res_id] if 0 <= res_id < len(res_keys) else ""
            if "x" not in res_raw:
                continue
            w_str, h_str = res_raw.split("x", 1)
            if not (w_str.isdigit() and h_str.isdigit()):
                continue
            w_val, h_val = int(w_str), int(h_str)
            if w_val <= 0 or h_val <= 0:
                continue
            sub_key = sub_keys[sub_id] if 0 <= sub_id < len(sub_keys) else ""
            offset = 0.0
            if isinstance(sub_key, str) and sub_key.count("-") == 1:
                ds_s, sub_s = sub_key.split("-", 1)
                if ds_s.isdigit() and sub_s.isdigit():
                    sub_info = state.subset_lookup.get((int(ds_s), int(sub_s)))
                    if sub_info and sub_info.get("timestep_offset") is not None:
                        offset = round(float(sub_info["timestep_offset"]), 6)
                        if abs(offset) > 1e-9:
                            has_nonzero_offset = True
                        else:
                            offset = 0.0
            joint_counts[(f"{w_val},{h_val}", offset)] += int(count)
        if has_nonzero_offset and joint_counts:
            profile_out["resolution_offsets"] = [
                {"resolution": res, "offset": off, "count": cnt}
                for (res, off), cnt in sorted(
                    joint_counts.items(),
                    key=lambda item: (_pair_sort_key(item[0][0], ","), item[0][1]),
                )
            ]

    return profile_out


def _render_overview(
    state, index, record, revision, profile, run_id, min_samples,
    *, available_runs, manifest_matches, active_manifest, sampling_config, labels,
    effective_reg_mode: str, train_images_total: int, reg_images_total: int, has_reg_images: bool,
):
    training = active_manifest.get("training") if isinstance(active_manifest, dict) else None
    num_processes = (_opt_int(training.get("num_processes")) if isinstance(training, dict) else None) or 1
    means, distinct, eligible = index.baseline()
    zones = index.totals("zone", len(state.images) * len(ZONES), means, eligible)
    converging_slope = _converging_slope_threshold(index.epoch_from, index.epoch_to)
    by_image = _overview_images(
        state, index, means, eligible, labels, zones, min_samples,
        converging_slope=converging_slope,
    )
    groups = _group_tables(state, index, means, eligible, labels, by_image=by_image)
    timestep_profile = _build_timestep_profile(
        state, index, by_image, means=means, eligible=eligible, sampling_config=sampling_config,
    )
    counts = Counter(item["status"] for item in by_image)
    qualified = sum(item["comparable_count"] >= min_samples for item in by_image)
    has_slope = any(item["slope"] is not None for item in by_image)
    total_non_finite = sum(index.non_finite.values())
    total_finite = int(index.counts.sum())
    total_comparable = int(index.counts[eligible].sum())
    images_expected = _expected_images_count(state, effective_reg_mode) if manifest_matches else None
    bucket_ar_error = _extract_bucket_ar_error(active_manifest)
    if total_non_finite:
        verdict = {"code": "non_finite", "tone": "danger"}
    elif qualified == 0:
        verdict = {"code": "early", "tone": "neutral"}
    elif counts["attention"]:
        severe = any(item["status"] == "attention" and item["mean_residual"] >= 0.35 for item in by_image)
        verdict = {"code": "attention", "tone": "danger" if severe else "warn"}
    elif not has_slope:
        verdict = {"code": "early_ok", "tone": "neutral"}
    else:
        verdict = {"code": "balanced", "tone": "ok"}
    zone_totals = tuple(values.reshape(-1, len(ZONES)).sum(axis=0) for values in zones)
    total_in_zones = sum(zone_totals[0])
    zone_extras = index.profile_zone_extras(state.epoch_numbers)
    noise_zones = {
        zone: {
            **_stats_at(zone_totals, z),
            "share": float(zone_totals[0][z] / total_in_zones) if total_in_zones else 0.0,
            **zone_extras.get(zone, {}),
        }
        for z, zone in enumerate(ZONES)
    }
    return {
        "revision": revision, "available": True, "profile": profile, "run_id": run_id,
        "reg_mode": effective_reg_mode,
        "available_runs": available_runs, "timestep_scale": index.scale, "sampling_config": sampling_config,
        "verdict": verdict, "notable_group": _pick_notable_group(groups, min_samples),
        "thresholds": {
            "high_residual": HIGH_RESIDUAL_THRESHOLD, "low_residual": LOW_RESIDUAL_THRESHOLD,
            "converging_slope": converging_slope, "min_count": min_samples, "num_bins": index.num_bins,
        },
        "summary": {
            "samples": total_finite, "non_finite_total": total_non_finite,
            "comparable_count": total_comparable, "unknown_timestep_count": int(index.counts[-1]),
            "images_total": len(by_image), "images_expected": images_expected,
            "train_images_total": train_images_total, "reg_images_total": reg_images_total,
            "images_qualified": qualified, "images_skipped": len(by_image) - qualified,
            "step_from": index.step_from, "step_to": index.step_to, "epoch_from": index.epoch_from, "epoch_to": index.epoch_to,
            "mean_loss": float(index.loss.sum() / total_finite) if total_finite else None,
            "has_slope": has_slope, "has_reg_images": has_reg_images,
            "loss_deweighted": bool(index.deweight_scheme),
            "multi_gpu_partial": num_processes > 1, "num_processes": num_processes,
            "bucket_ar_error": bucket_ar_error,
            "counts": {key: counts[key] for key in (
                "attention", "learning", "easy", "normal", "non_finite", "insufficient", "insufficient_reference",
            )},
        },
        "noise_zones": noise_zones, "by_timestep": _timestep_table(index, means, distinct, eligible),
        "timestep_profile": timestep_profile,
        **{f"by_{dimension}": table for dimension, table in groups.items()}, "by_image": by_image,
    }


def analyze_dataset_diagnostics(
    record: dict[str, Any] | None,
    *,
    min_count: int = 3,
    num_bins: int = 10,
    run_id: str = "",
    is_active: bool = False,
    known_revision: str = "",
    refresh_local: bool = False,
    reg_mode: str = "all",
) -> dict[str, Any]:
    if not record:
        return _unavailable("no_run", known_revision)
    profile = _detect_profile(record)
    if profile == "krea2-lora":
        return _unavailable("unsupported_engine", known_revision, profile=profile)
    loss_path = Path(record["run_path"]) / "log" / ".run-control" / LOSS_FILE
    if not loss_path.is_file():
        return _unavailable("waiting" if is_active else "not_recorded", known_revision, profile=profile)
    req_reg_mode = reg_mode if reg_mode in ("all", "exclude", "only") else "all"
    state = _get_loss_state(loss_path)
    try:
        with state.lock:
            state.sync()
            selected, runs = state.select(run_id)
            if not any(len(rows) for rows in runs.values()):
                return _unavailable("waiting" if is_active else "empty", known_revision,
                                    profile=profile, available_runs=list(state.runs), run_id=selected)
            if refresh_local:
                state.local_generation += 1
            bins = max(2, min(30, int(num_bins)))
            min_samples = max(1, min(100, int(min_count)))
            manifest = read_object(state.path.with_name(MANIFEST_FILE))
            available_runs = list(state.runs)
            manifest_matches, config_trusted, active_manifest = _match_manifest_and_trust(manifest, selected, available_runs)
            sampling_config = _extract_sampling_config(active_manifest, record, allow_config=config_trusted, profile=profile)
            deweight_scheme = _deweight_scheme_for(profile, sampling_config)
            manifest_cwd = active_manifest.get("cwd") if isinstance(active_manifest, dict) else None
            metadata_revision = _metadata_revision(state, record, manifest_cwd=manifest_cwd)
            labels = _structure_labels(
                state, metadata_revision, active_manifest, record,
                allow_config=config_trusted, fallback_to_key=not config_trusted,
            )
            effective_reg_mode, _, train_total, reg_total, has_reg = _compute_reg_scope(
                state, runs, labels, req_reg_mode, selected=selected, need_mask=False,
            )
            revision, data_revision = _analysis_revision(
                state, runs, selected, profile, bins, min_samples, record,
                effective_reg_mode, deweight_scheme, metadata_revision=metadata_revision,
            )
            if revision == known_revision:
                return {"revision": revision, "unchanged": True}
            summary_key = (selected, profile, bins, min_samples, effective_reg_mode, deweight_scheme)
            cached = state.summary_lru.get(summary_key)
            if cached is not None and cached[0] == data_revision:
                summary = cached[1]
                state.summary_lru.move_to_end(summary_key)
            else:
                allowed_structures = None
                if effective_reg_mode in ("exclude", "only"):
                    _, allowed_structures, _, _, _ = _compute_reg_scope(
                        state, runs, labels, effective_reg_mode, selected=selected, need_mask=True,
                    )
                index = state.indexed(
                    selected, runs, bins, _timestep_scale(profile),
                    deweight_scheme=deweight_scheme, reg_mode=effective_reg_mode,
                    allowed_structures=allowed_structures, reg_mask_version=state.reg_mask_version,
                )
                summary = _render_overview(
                    state, index, record, revision, profile, selected, min_samples,
                    available_runs=available_runs, manifest_matches=manifest_matches,
                    active_manifest=active_manifest, sampling_config=sampling_config, labels=labels,
                    effective_reg_mode=effective_reg_mode, train_images_total=train_total,
                    reg_images_total=reg_total, has_reg_images=has_reg,
                )
                state.summary_lru[summary_key] = (data_revision, summary)
                state.summary_lru.move_to_end(summary_key)
                while len(state.summary_lru) > _MAX_INDEX_LRU:
                    state.summary_lru.popitem(last=False)
            state.cached_summary = summary
            state.cached_revision = data_revision
            state_path_str = str(state.path)
            cache_epoch = (state.state_token, state.local_generation)
            run_dir = record.get("run_dir", "")
            raw_images = summary["by_image"]
    finally:
        _trim_loss_cache()

    stat_map = _stat_local_images_batch(
        state_path_str,
        (item["image"] for item in raw_images),
        cache_epoch,
    )
    encoded_run_dir = urllib.parse.quote_plus(run_dir) if run_dir else ""
    enriched_images = [
        {**item, **_preview_fields_from_stat(item["image_id"], encoded_run_dir, stat_map.get(item["image"]))}
        for item in raw_images
    ]
    return {**summary, "revision": revision, "by_image": enriched_images}



def _caption_extension(value: Any) -> str | None:
    if not isinstance(value, str) or any(c in value for c in "/\\"):
        return None
    return "." + value if value and not value.startswith(".") else value


def _caption_config_for_row(
    row: dict[str, Any], image_path: Path | None, config: dict[str, Any],
    dataset: dict[str, Any] | None, subset_lookup: dict[tuple[int, int], dict[str, Any]],
) -> list[dict[str, Any]]:
    """Follow sd-scripts' subset, dataset, general, argument precedence."""
    info = subset_lookup.get((row.get("dataset"), row.get("subset"))) or {}
    if dataset is None:
        metadata_file = config.get("in_json") or info.get("metadata_file")
        if metadata_file:
            # Manifest metadata_file is only a basename, not a usable full path.
            return [{"source": "metadata", "metadata_file": config.get("in_json"), "options": config}]
        class_tokens = info.get("class_tokens")
        if class_tokens is None and image_path is not None:
            for key in ("train_data_dir", "reg_data_dir"):
                root = config.get(key)
                if root and _canonical_path(image_path.parent.parent) == _canonical_path(root):
                    parts = image_path.parent.name.split("_")
                    if parts and parts[0].isdigit():
                        class_tokens = "_".join(parts[1:])
                    break
        return [{"source": "sidecar", "extension": _caption_extension(config.get("caption_extension", ".caption")),
                 "class_tokens": class_tokens}]

    datasets = dataset.get("datasets")
    if not isinstance(datasets, list):
        return []
    d_idx, s_idx = row.get("dataset"), row.get("subset")
    selected = [(d_idx, datasets[d_idx])] if isinstance(d_idx, int) and 0 <= d_idx < len(datasets) else list(enumerate(datasets))
    general = dataset.get("general") if isinstance(dataset.get("general"), dict) else {}
    matches: list[dict[str, Any]] = []
    for ds_index, ds in selected:
        if not isinstance(ds, dict) or not isinstance(ds.get("subsets"), list):
            continue
        subsets = ds["subsets"]
        matching: list[tuple[int, dict[str, Any]]] = []
        for index, sub in enumerate(subsets):
            if not isinstance(sub, dict):
                continue
            metadata_file = sub.get("metadata_file")
            metadata_name = info.get("metadata_file")
            image_dir = sub.get("image_dir") or ds.get("image_dir") or general.get("image_dir")
            metadata_match = bool(metadata_file and metadata_name and
                                  _path_name_matches(metadata_file, metadata_name))
            if metadata_file and not info and image_path is None and ds_index == d_idx and index == s_idx:
                metadata_match = True
            image_match = bool(image_dir and image_path and
                               _canonical_path(image_dir) == _canonical_path(image_path.parent))
            if not (metadata_match or image_match):
                continue
            matching.append((index, sub))

        # Runtime subset indices can shift when sd-scripts skips an empty or
        # duplicate config subset. The manifest records the surviving order;
        # align it with the original config before interpreting the index.
        aligned = None
        if isinstance(s_idx, int) and s_idx >= 0 and (ds_index, s_idx) in subset_lookup:
            aligned = _align_subset_cursor(subset_lookup, ds_index, subsets, ds, general).get(s_idx)
        elif isinstance(s_idx, int) and 0 <= s_idx < len(subsets):
            aligned = s_idx
        if aligned is not None and any(index == aligned for index, _ in matching):
            matching = [(index, sub) for index, sub in matching if index == aligned]

        for _, sub in matching:
            metadata_file = sub.get("metadata_file")
            options = {**config, **general, **ds, **sub}
            if metadata_file:
                matches.append({"source": "metadata", "metadata_file": metadata_file, "options": options})
            else:
                matches.append({"source": "sidecar", "extension": _caption_extension(options.get("caption_extension", ".caption")),
                                "class_tokens": options.get("class_tokens")})
    return matches


def _normalize_metadata_key(raw_key: str) -> str:
    norm = _normalize_image_key(raw_key)
    while norm.startswith("./"):
        norm = norm[2:]
    return norm


@lru_cache(maxsize=2)
def _read_metadata_revision(path: str, device: int, inode: int, modified_ns: int, size: int) -> dict[str, dict[str, Any]]:
    del device, inode, modified_ns, size  # The full file revision remains part of the cache key.
    def caption_fields(value: dict[str, Any]) -> dict[str, Any]:
        return {"caption": value.get("caption"), "tags": value.get("tags")}

    exact: dict[str, dict[str, Any]] = {}
    normalized: dict[str, dict[str, Any]] = {}
    folded: dict[str, dict[str, Any]] = {}

    def add_entry(raw_key: str, entry: dict[str, Any]) -> None:
        fields = caption_fields(entry)
        exact[raw_key] = fields
        norm = _normalize_metadata_key(raw_key)
        if norm:
            normalized[norm] = fields
            folded[_case_key(norm)] = fields

    with Path(path).open("r", encoding="utf-8") as stream:
        if path.lower().endswith(".jsonl"):
            for line in stream:
                row = json.loads(line)
                if isinstance(row, dict) and isinstance(row.get("image_path"), str):
                    add_entry(row["image_path"], row)
        else:
            value = json.load(stream)
            if isinstance(value, dict):
                for key, entry in value.items():
                    if isinstance(key, str) and isinstance(entry, dict):
                        add_entry(key, entry)
    return {"exact": exact, "normalized": normalized, "folded": folded}


def _metadata_caption_preview(
    path: str | None,
    image_key: str,
    options: dict[str, Any],
    *,
    manifest_cwd: str | None = None,
) -> dict[str, Any]:
    result = {"exists": False, "filename": "", "path": "", "text": "", "error": "",
              "editor_safe": False, "source": "metadata", "text_available": False}
    if not path:
        return result
    metadata_path = _resolve_relative_path(path, manifest_cwd=manifest_cwd).resolve()
    result.update(filename=metadata_path.name, path=str(metadata_path))
    try:
        stat = metadata_path.stat()
        if stat.st_size > _MAX_METADATA_PREVIEW_BYTES:
            return result
        data = _read_metadata_revision(str(metadata_path), stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size)
        result["text_available"] = True
        norm_key = _normalize_metadata_key(image_key)
        entry = (
            data["exact"].get(image_key)
            or (data["normalized"].get(norm_key) if norm_key else None)
            or (data["folded"].get(_case_key(norm_key)) if norm_key else None)
        )
        if not isinstance(entry, dict):
            return result
        caption, tags = entry.get("caption") or "", entry.get("tags") or ""
        separator = str(options.get("caption_separator") or ",")
        multiline_separator = str(options.get("multiline_caption_separator") or "---===---")
        if isinstance(caption, list):
            caption = f"\n{multiline_separator}\n".join(str(value) for value in caption)
        if not isinstance(caption, str) or not isinstance(tags, str):
            raise ValueError("Invalid caption in metadata")
        if tags and options.get("enable_multiline_caption"):
            parts = re.split(r"(?m)^\s*" + re.escape(multiline_separator) + r"(?:\s*#.*)?\s*$", caption)
            caption = f"\n{multiline_separator}\n".join(
                f"{part.strip()}{separator}{tags}" if part.strip() else tags for part in parts
            )
        elif tags and options.get("enable_wildcard"):
            tags = tags.replace("\n", separator)
            lines = [line for line in caption.split("\n") if line.strip()]
            caption = "\n".join(f"{line}{separator}{tags}" for line in lines) if lines else tags
        elif tags:
            caption = f"{caption}{separator}{tags}" if caption else tags
        result.update(exists=True, text=caption)
    except (OSError, UnicodeError, ValueError, TypeError) as exc:
        result["error"] = str(exc)
    return result


def _read_caption_preview(
    image_path: Path | None, *, record: dict[str, Any] | None = None,
    rows: list[dict[str, Any]] | None = None,
    subset_lookup: dict[tuple[int, int], dict[str, Any]] | None = None,
    allow_config: bool = True,
    manifest_cwd: str | None = None,
) -> dict[str, Any]:
    empty = {"exists": False, "filename": "", "path": "", "text": "", "error": "",
             "editor_safe": False, "source": "unknown"}
    if not allow_config:
        return empty
    config = _run_config(record)
    dataset = _dataset_config(record, config, manifest_cwd=manifest_cwd)
    if dataset is None and record and record.get("run_path") and (
        config.get("dataset_config") or (Path(record["run_path"]) / "dataset.toml").exists()
    ):
        return empty
    image_rows = rows or [{"image": str(image_path or ""), "dataset": None, "subset": None}]
    image_rows = list({(row.get("dataset"), row.get("subset"), row.get("image")): row for row in image_rows}.values())
    choices = []
    for row in image_rows:
        choices.extend(_caption_config_for_row(row, image_path, config, dataset, subset_lookup or {}))
    if not choices:
        return empty
    def source_key(item: dict[str, Any]) -> tuple[Any, ...]:
        if item["source"] == "metadata":
            options = item["options"]
            path = item.get("metadata_file")
            return ("metadata", _canonical_path(_resolve_relative_path(path, manifest_cwd=manifest_cwd)) if path else "",
                    options.get("caption_separator") or ",", bool(options.get("enable_wildcard")),
                    bool(options.get("enable_multiline_caption")),
                    options.get("multiline_caption_separator") or "---===---")
        extension = item.get("extension")
        class_tokens = item.get("class_tokens")
        if image_path is not None and isinstance(extension, str):
            stem = os.path.splitext(str(image_path))[0]
            parts = stem.split("_")
            face_stem = "_".join(parts[:-4]) if len(parts) >= 5 else stem
            for value in (stem, face_stem):
                candidate = Path(value + extension)
                if candidate.is_file():
                    return ("sidecar", _canonical_path(candidate))
            if class_tokens:
                return ("class_tokens", str(class_tokens))
        return ("sidecar", extension, class_tokens)

    keys = {source_key(item) for item in choices}
    if len(keys) != 1:
        return {**empty, "source": "ambiguous"}
    choice = choices[0]
    if choice["source"] == "metadata":
        return _metadata_caption_preview(
            choice.get("metadata_file"),
            str(image_rows[0].get("image") or ""),
            choice["options"],
            manifest_cwd=manifest_cwd,
        )
    if image_path is None:
        return empty
    extension = choice.get("extension")
    if not isinstance(extension, str):
        return empty
    stem = os.path.splitext(str(image_path))[0]
    tokens = stem.split("_")
    face_stem = "_".join(tokens[:-4]) if len(tokens) >= 5 else stem
    candidates = [Path(stem + extension), Path(face_stem + extension)]
    cap_path = next((candidate for candidate in candidates if candidate.is_file()), candidates[0])
    result = {**empty, "filename": cap_path.name, "path": str(cap_path), "source": "sidecar"}
    try:
        editor_candidates = caption_candidates(image_path)
        editor_path = editor_candidates[0] if editor_candidates else image_path.with_suffix(".txt")
        result["editor_safe"] = len(editor_candidates) <= 1 and editor_path == cap_path
        if not cap_path.is_file():
            if choice.get("class_tokens"):
                result.update(exists=True, filename="", path="", text=str(choice["class_tokens"]),
                              source="class_tokens", editor_safe=False)
            return result
        text, _, _ = read_caption_snapshot(cap_path)
        result.update(exists=True, text=text)
    except (OSError, UnicodeDecodeError) as exc:
        result["error"] = str(exc)
    return result


def _read_image_dimensions(image_path: Path) -> tuple[int | None, int | None, int | None]:
    try:
        size = image_path.stat().st_size
    except OSError:
        return None, None, None
    try:
        from PIL import Image
        from backend.image_preview import open_preview_source

        with open_preview_source(image_path) as img:
            return img.width, img.height, size
    except Exception:
        return None, None, size


def read_dataset_diagnostic_image(
    record: dict[str, Any] | None,
    *,
    image_id: str,
    min_count: int = 3,
    num_bins: int = 10,
    run_id: str = "",
    refresh_local: bool = False,
    reg_mode: str = "all",
    include_local: bool = True,
    include_profile: bool = True,
) -> dict[str, Any] | None:
    if not record or not _IMAGE_ID_RE.fullmatch(image_id or ""):
        return None
    profile = _detect_profile(record)
    if profile == "krea2-lora":
        return None
    loss_path = Path(record["run_path"]) / "log" / ".run-control" / LOSS_FILE
    if not loss_path.is_file():
        return None
    req_reg_mode = reg_mode if reg_mode in ("all", "exclude", "only") else "all"
    state = _get_loss_state(loss_path)
    try:
        with state.lock:
            state.sync()
            selected, runs = state.select(run_id)
            entry = state.image_registry.get(image_id)
            if not entry:
                return None
            if refresh_local:
                state.local_generation += 1
            bins = max(2, min(30, int(num_bins)))
            min_samples = max(1, min(100, int(min_count)))
            scale = _timestep_scale(profile)
            manifest = read_object(state.path.with_name(MANIFEST_FILE))
            available_runs = list(state.runs)
            manifest_matches, config_trusted, active_manifest = _match_manifest_and_trust(manifest, selected, available_runs)
            sampling_config = _extract_sampling_config(active_manifest, record, allow_config=config_trusted, profile=profile)
            deweight_scheme = _deweight_scheme_for(profile, sampling_config)
            manifest_cwd = active_manifest.get("cwd") if isinstance(active_manifest, dict) else None
            metadata_revision = _metadata_revision(state, record, manifest_cwd=manifest_cwd)
            labels = _structure_labels(
                state, metadata_revision, active_manifest, record,
                allow_config=config_trusted, fallback_to_key=not config_trusted,
            )
            subset_lookup = state.subset_lookup
            effective_reg_mode, allowed_structures, _, _, _ = _compute_reg_scope(
                state, runs, labels, req_reg_mode, selected=selected, need_mask=True,
            )
            revision, data_revision = _analysis_revision(
                state, runs, selected, profile, bins, min_samples, record,
                effective_reg_mode, deweight_scheme, metadata_revision=metadata_revision,
            )
            matching = list(state.image_samples(runs, entry))
            if allowed_structures is not None:
                matching = [row for row in matching if allowed_structures[row["structure"]]]
            if not matching:
                return None
            index = state.indexed(
                selected, runs, bins, scale,
                deweight_scheme=deweight_scheme, reg_mode=effective_reg_mode,
                allowed_structures=allowed_structures, reg_mask_version=state.reg_mask_version,
            )
            means, distinct, eligible = index.baseline()
            converging_slope = _converging_slope_threshold(index.epoch_from, index.epoch_to)
            summary_key = (selected, profile, bins, min_samples, effective_reg_mode, deweight_scheme)
            cached_entry = state.summary_lru.get(summary_key)
            cached_summary = (
                cached_entry[1] if (cached_entry is not None and cached_entry[0] == data_revision)
                else (state.cached_summary if state.cached_revision == data_revision else None)
            )
            if cached_summary is not None:
                sampling_config = cached_summary["sampling_config"]
                by_timestep = cached_summary["by_timestep"] if include_profile else None
                profile_bins = cached_summary["timestep_profile"]["bins"] if include_profile else None
                cached_image = next((img for img in cached_summary["by_image"] if img["image_id"] == image_id), None)
            else:
                by_timestep = _timestep_table(index, means, distinct, eligible) if include_profile else None
                profile_bins = index.profile_bins(state.epoch_numbers) if include_profile else None
                cached_image = None
            finite_rows = [row for row in matching if row["loss"] is not None]
            non_finite = [row for row in matching if row["loss"] is None]
            finite_ts = np.asarray([row["timestep"] for row in finite_rows], dtype=np.float64)
            finite_losses = np.asarray([row["loss"] for row in finite_rows], dtype=np.float64)
            if index.deweight_scheme and len(finite_losses):
                finite_losses = deweight_losses(finite_losses, finite_ts, scale, index.deweight_scheme)
            row_bins = index.bins(finite_ts)
            residuals = [
                float(val / means[bin_id] - 1) if eligible[bin_id] else None
                for val, bin_id in zip(finite_losses.tolist(), row_bins)
            ]
            epoch_ids = sorted({row["epoch_id"] for row in finite_rows if row["epoch"] is not None},
                               key=lambda epoch_id: state.epoch_numbers[epoch_id])
            epoch_numbers = np.array([state.epoch_numbers[epoch_id] for epoch_id in epoch_ids], dtype=np.int64)
            epoch_totals = [column[epoch_ids] for column in index.epoch_totals(state.epoch_numbers)]
            nf_by_epoch = Counter(int(row["epoch"]) for row in non_finite if row["epoch"] is not None)
            finite_epochs_map = {
                int(epoch): {"epoch": int(epoch), **_stats_at(epoch_totals[:4], i), "non_finite_count": int(nf_by_epoch.get(int(epoch), 0))}
                for i, epoch in enumerate(epoch_numbers)
            }
            all_epoch_nums = sorted(set(finite_epochs_map) | set(nf_by_epoch))
            epochs = [
                finite_epochs_map[ep] if ep in finite_epochs_map else {
                    "epoch": int(ep), "count": 0, "comparable_count": 0,
                    "mean_loss": None, "mean_residual": None, "non_finite_count": int(nf_by_epoch[ep]),
                }
                for ep in all_epoch_nums
            ]
            if cached_image is not None:
                image_summary = dict(cached_image)
            else:
                total, _, count, residual, slope_count, slope_residual = epoch_totals
                epoch_stats = [column[0] for column in epoch_metrics(
                    1, np.zeros(len(epoch_ids), dtype=np.int64), epoch_numbers,
                    total, count, residual, slope_count, slope_residual,
                )]
                image = entry["index"]
                stats = _stats_values(*index.single("image", image, means, eligible))
                zones = {
                    zone: _stats_values(*index.single("zone", image * len(ZONES) + z, means, eligible))
                    for z, zone in enumerate(ZONES)
                }
                image_summary = _image_stats(
                    state, index, entry, labels, stats, epoch_stats, zones, min_samples,
                    converging_slope=converging_slope,
                )
            cum_by_ep = index.cumulative_image_trajectory_residuals(
                entry["index"], state.epoch_images, state.epoch_numbers, image_epoch_ids=epoch_ids,
            )
            subset_meta: dict[str, Any] = {}
            sub_key = image_summary.get("subset") or ""
            sub_info = None
            if isinstance(sub_key, str) and sub_key.count("-") == 1:
                ds_idx, sub_idx = sub_key.split("-", 1)
                if ds_idx.isdigit() and sub_idx.isdigit():
                    sub_info = subset_lookup.get((int(ds_idx), int(sub_idx)))
            if not sub_info and getattr(state, "dir_lookup", None):
                sub_info = _lookup_dir_info(state.dir_lookup, image_summary.get("subset_label") or "", image_summary.get("is_reg"))
            if sub_info:
                if sub_info.get("num_repeats"):
                    subset_meta["num_repeats"] = sub_info["num_repeats"]
                if sub_info.get("timestep_offset") is not None:
                    subset_meta["timestep_offset"] = sub_info["timestep_offset"]
                if sub_info.get("aug_flags"):
                    subset_meta["aug_flags"] = list(sub_info["aug_flags"])
            lw_values = [float(row["loss_weight"]) for row in matching if row.get("loss_weight") is not None]
            if lw_values:
                avg_lw = sum(lw_values) / len(lw_values)
                if abs(avg_lw - 1.0) > 1e-4:
                    subset_meta["loss_weight"] = round(avg_lw, 4)
            state_path_str = str(state.path)
            image_key = entry["key"]
            cache_epoch = (state.state_token, state.local_generation)
            run_ref = record.get("run_dir", "")
            loss_deweighted = bool(index.deweight_scheme)
            run_epoch_from = index.epoch_from
    finally:
        _trim_loss_cache()

    trajectory = _build_image_trajectory(
        non_finite, epoch_numbers, epoch_totals, min_samples, cum_by_ep,
        run_epoch_from=run_epoch_from,
    )
    diag_losses = finite_losses.tolist()
    samples = [_detail_sample(row, residual, diag_loss) for row, residual, diag_loss in zip(finite_rows, residuals, diag_losses)]
    samples.extend(_detail_sample(row, None) for row in non_finite)
    samples.sort(key=lambda item: (item["step"] if item["step"] is not None else -1, item["epoch"] or 0))
    samples_total = len(samples)
    first_non_finite = next((item for item in samples if item["non_finite"]), None)
    if samples_total > _MAX_DETAIL_SAMPLES:
        nf_items = [item for item in samples if item["non_finite"]]
        if len(nf_items) >= _MAX_DETAIL_SAMPLES:
            visible_samples = nf_items[-_MAX_DETAIL_SAMPLES:]
        else:
            fin_items = [item for item in samples if not item["non_finite"]]
            visible_samples = nf_items + fin_items[-(_MAX_DETAIL_SAMPLES - len(nf_items)):]
            visible_samples.sort(key=lambda item: (item["step"] if item["step"] is not None else -1, item["epoch"] or 0))
    else:
        visible_samples = samples

    payload: dict[str, Any] = {
        "revision": revision, "run_id": selected, "reg_mode": effective_reg_mode,
        "loss_deweighted": loss_deweighted,
        "timestep_scale": scale, "sampling_config": sampling_config,
        "thresholds": {
            "high_residual": HIGH_RESIDUAL_THRESHOLD, "low_residual": LOW_RESIDUAL_THRESHOLD,
            "converging_slope": converging_slope, "min_count": min_samples, "num_bins": bins,
        },
        "subset_meta": subset_meta,
        "image": image_summary, "epoch_series": epochs, "trajectory": trajectory,
        "first_non_finite": first_non_finite,
        "samples": visible_samples, "samples_total": samples_total,
        "samples_truncated": samples_total > _MAX_DETAIL_SAMPLES,
    }
    if include_profile:
        payload["by_timestep"] = by_timestep
        payload["timestep_profile"] = {"num_bins": PROFILE_BINS, "bins": profile_bins}
    if include_local:
        local_path, version = _stat_local_image_cached(state_path_str, image_key, cache_epoch)
        encoded_run_ref = urllib.parse.quote_plus(run_ref) if run_ref else ""
        image_summary.update(
            _preview_fields_from_stat(
                image_id,
                encoded_run_ref,
                (str(local_path) if local_path is not None else None, version),
            )
        )
        payload["caption"] = _read_caption_preview(
            local_path,
            record=record,
            rows=matching,
            subset_lookup=subset_lookup,
            allow_config=config_trusted,
            manifest_cwd=manifest_cwd,
        )
        if local_path is not None:
            width, height, size = _read_image_dimensions(local_path)
            payload["file_info"] = {"exists": size is not None, "abs_path": str(local_path), "dir_path": str(local_path.parent),
                                    "size": size, "width": width, "height": height}
        else:
            payload["file_info"] = {"exists": False, "raw_key": image_key}
    return payload


def _build_image_trajectory(
    non_finite: list[dict[str, Any]],
    epoch_numbers: np.ndarray,
    epoch_totals: list[np.ndarray],
    min_samples: int,
    cum_by_ep: dict[int, tuple[int, int, float]],
    run_epoch_from: int | None = None,
) -> list[dict[str, Any]]:
    """Reconstruct cumulative per-epoch scatter coordinates without future-epoch look-ahead."""
    nf_by_epoch: dict[int, int] = Counter(int(row["epoch"]) for row in non_finite if row.get("epoch") is not None)
    _, _, peer_compared_arr, peer_residual_arr, slope_compared_arr, slope_residual_arr = epoch_totals
    peer_by_epoch = {
        int(ep): (int(peer_compared_arr[i]), float(peer_residual_arr[i]))
        for i, ep in enumerate(epoch_numbers)
        if int(ep) >= 0
    }
    slope_peer_by_epoch = {
        int(ep): (int(slope_compared_arr[i]), float(slope_residual_arr[i]))
        for i, ep in enumerate(epoch_numbers)
        if int(ep) >= 0
    }

    all_epochs = sorted(set(cum_by_ep) | set(nf_by_epoch) | set(peer_by_epoch))
    cum_count = 0
    cum_comp_count = 0
    cum_res_sum = 0.0
    cum_non_finite = 0
    ep0: int | None = None
    n = 0
    mx = 0.0
    my = 0.0
    sxx = 0.0
    sxy = 0.0
    prefix_slope: float | None = None
    trajectory: list[dict[str, Any]] = []
    last_ep = all_epochs[-1] if all_epochs else None

    for ep in all_epochs:
        if ep in cum_by_ep:
            cum_count, cum_comp_count, cum_res_sum = cum_by_ep[ep]
        cum_non_finite += nf_by_epoch.get(ep, 0)
        ep_peer = slope_peer_by_epoch.get(ep) if ep == last_ep else peer_by_epoch.get(ep)
        if ep_peer is not None:
            p_comp, p_res = ep_peer
            if p_comp > 0:
                y = p_res / p_comp
                if ep0 is None:
                    ep0 = ep
                x = float(ep - ep0)
                n += 1
                dx = x - mx
                mx += dx / n
                dy = y - my
                my += dy / n
                x_diff = x - mx
                sxx += dx * x_diff
                sxy += dy * x_diff
                prefix_slope = (sxy / sxx) if (n >= 3 and sxx > 0.0) else None

        if cum_comp_count >= min_samples and prefix_slope is not None:
            cum_mean_res = cum_res_sum / cum_comp_count
            trajectory.append({
                "epoch": int(ep),
                "mean_residual": round(cum_mean_res, 6),
                "slope": round(prefix_slope, 6),
                "count": int(cum_count),
                "non_finite_count": int(cum_non_finite),
                "status": _classify_image(
                    count=cum_count,
                    comparable_count=cum_comp_count,
                    non_finite_count=cum_non_finite,
                    mean_residual=cum_mean_res,
                    slope=prefix_slope,
                    min_count=min_samples,
                    converging_slope=_converging_slope_threshold(
                        run_epoch_from if run_epoch_from is not None else ep0,
                        ep,
                    ),
                ),
            })

    return trajectory


def _detail_sample(row, residual, diag_loss=None):
    fields = ("step", "epoch", "timestep", "width", "height", "batch_size", "loss_weight")
    raw_loss = row["loss"]
    loss = float(diag_loss) if (diag_loss is not None and raw_loss is not None) else raw_loss
    return {
        **{field: row[field] for field in fields},
        "loss": loss,
        "raw_loss": raw_loss,
        "residual": residual,
        "non_finite": raw_loss is None,
    }



def resolve_loss_sample_image(run_dir: str, image_id: str) -> Path | None:
    """Resolve an image_id strictly against keys recorded in that run's loss.jsonl."""
    from backend.monitor.run_registry import load_run_record

    if not run_dir or not _IMAGE_ID_RE.fullmatch(image_id or ""):
        return None
    record = load_run_record(run_dir)
    if not record:
        return None
    loss_path = Path(record["run_path"]) / "log" / ".run-control" / LOSS_FILE
    if not loss_path.is_file():
        return None
    state = _get_loss_state(loss_path)
    try:
        with state.lock:
            state.sync()
            entry = state.image_registry.get(image_id)
            if not entry:
                return None
            state_path_str = str(state.path)
            image_key = entry["key"]
            cache_epoch = (state.state_token, state.local_generation)
    finally:
        _trim_loss_cache()
    return _stat_local_image_cached(state_path_str, image_key, cache_epoch)[0]
