"""Incremental per-sample loss analyzer and safe preview resolver."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from array import array
import tomllib
from collections import Counter, OrderedDict, defaultdict
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np

from backend.constants import REPO_ROOT
from backend.image_preview import IMAGE_EXTENSIONS, build_image_preview_url
from backend.monitor.dataset_diagnostic_index import Codes, DIMENSIONS, LossIndex, SampleRows, ZONES, epoch_metrics
from backend.monitor.run_control import read_object
from backend.monitor.run_registry import read_run_config
from backend.tageditor.core import caption_candidates, read_caption_snapshot

LOSS_FILE = "loss.jsonl"
MANIFEST_FILE = "manifest.json"

HIGH_RESIDUAL_THRESHOLD = 0.20
LOW_RESIDUAL_THRESHOLD = -0.20
CONVERGING_SLOPE_THRESHOLD = -0.02
_MAX_CACHED_FILES = 4
_MAX_CACHED_SAMPLES = 500_000
_MAX_DETAIL_SAMPLES = 500
_MAX_METADATA_PREVIEW_BYTES = 16 * 1024 * 1024
_IMAGE_ID_RE = re.compile(r"^[0-9a-f]{16}$")

_cache_lock = threading.Lock()
_file_cache: OrderedDict[str, "_LossFileState"] = OrderedDict()


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


def _split_image_key(raw_key: str) -> tuple[str, str, str]:
    """Return (filename, full_directory, concise_dir_label) independent of OS separators."""
    normalized = str(raw_key or "").replace("\\", "/").strip()
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


def _resolve_local_image_path(raw_key: str) -> Path | None:
    text = str(raw_key or "").strip()
    if not text:
        return None
    try:
        candidate = Path(text)
        if not candidate.is_absolute():
            candidate = REPO_ROOT / candidate
        if candidate.suffix.lower() not in IMAGE_EXTENSIONS or not candidate.is_file():
            return None
        resolved = candidate.resolve()
        return resolved if resolved.suffix.lower() in IMAGE_EXTENSIONS else None
    except (OSError, RuntimeError, ValueError):
        return None


def _stat_local_image(entry: dict[str, Any], *, refresh: bool = False) -> tuple[Path | None, str]:
    if entry.get("checked") and not refresh:
        return entry.get("path"), entry.get("version", "")
    resolved = _resolve_local_image_path(entry["key"])
    version = ""
    if resolved is not None:
        try:
            st = resolved.stat()
            version = f"{st.st_mtime_ns}-{st.st_size}"
        except OSError:
            resolved = None
    entry["path"] = resolved
    entry["version"] = version
    entry["checked"] = True
    return resolved, version


class _LossFileState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.stat_key: tuple[int, int] | None = None
        self.mtime: int | None = None
        self.lock = threading.Lock()
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
        self.index_key = None
        self.index = None
        self.cached_revision = None
        self.cached_summary = None
        self.local_generation = 0
        self.metadata_revision = None
        self.structure_labels = []

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
        image_key = row.get("image")
        if not isinstance(image_key, str) or not image_key:
            return
        image = self.images_by_key.get(image_key)
        if image is None:
            image_id = _image_id_for_key(image_key)
            name, directory, directory_label = _split_image_key(image_key)
            image = {"index": len(self.images), "key": image_key, "image_id": image_id, "structures": [],
                     "name": name, "directory": directory, "dir_label": directory_label}
            self.images_by_key[image_key] = image
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

    def indexed(self, run_id, runs, bins, scale):
        edges = LossIndex.edges_of(runs)
        index_key = run_id, bins, edges, scale
        if self.index_key != index_key:
            self.index = LossIndex(bins, edges, scale)
            self.index_key = index_key
        self.index.extend(runs, self.structures, self.epoch_numbers)
        return self.index

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
                       "step": step if step >= 0 else None, "epoch": self.epochs.keys[epoch_id][1], "epoch_id": epoch_id,
                       "timestep": timestep if math.isfinite(timestep) else None,
                       "loss": loss if math.isfinite(loss) else None}


def _get_loss_state(loss_path: Path) -> _LossFileState:
    cache_key = str(loss_path)
    with _cache_lock:
        state = _file_cache.get(cache_key)
        if state is None:
            state = _LossFileState(loss_path)
            _file_cache[cache_key] = state
            while len(_file_cache) > _MAX_CACHED_FILES:
                _file_cache.popitem(last=False)
        else:
            _file_cache.move_to_end(cache_key)
        return state


def _trim_loss_cache() -> None:
    with _cache_lock:
        total = sum(state.sample_count for state in _file_cache.values())
        while total > _MAX_CACHED_SAMPLES and len(_file_cache) > 1:
            _, oldest = _file_cache.popitem(last=False)
            total -= oldest.sample_count


def has_dataset_diagnostics(run_path: Path) -> bool:
    """Fast stat-only check for run detail and live snapshot payloads."""
    try:
        return (run_path / "log" / ".run-control" / LOSS_FILE).is_file()
    except OSError:
        return False


def clear_dataset_diagnostics_cache() -> None:
    with _cache_lock:
        _file_cache.clear()
    _read_metadata_revision.cache_clear()


def _run_config(record: dict[str, Any] | None) -> dict[str, Any]:
    if not record or not record.get("run_path"):
        return {}
    return read_run_config(Path(record["run_path"]))


def _dataset_config(record: dict[str, Any] | None, config: dict[str, Any]) -> dict[str, Any] | None:
    """Read the dataset configuration used by the run, when one was supplied."""
    if not record or not record.get("run_path"):
        return None
    run_path = Path(record["run_path"])
    snapshot = run_path / "dataset.toml"
    configured = config.get("dataset_config")
    path = snapshot if snapshot.is_file() else Path(str(configured)) if configured else None
    if path is None:
        return None
    if not path.is_absolute():
        path = REPO_ROOT / path
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


def _build_subset_lookup(
    manifest: dict[str, Any], record: dict[str, Any] | None = None,
) -> tuple[dict[tuple[int, int], dict[str, Any]], set[str]]:
    metadata = manifest.get("metadata") if isinstance(manifest.get("metadata"), dict) else {}
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
                lookup[(d_idx, s_idx)] = {
                    "label": str(label),
                    "is_reg": bool(sub["is_reg"]) if "is_reg" in sub else False if sub.get("metadata_file") else None,
                    "num_repeats": _opt_int(sub.get("num_repeats")),
                    "metadata_file": sub.get("metadata_file"),
                    "class_tokens": sub.get("class_tokens"),
                }
    config = _run_config(record)
    reg_dirs: set[str] = set()
    if config.get("reg_data_dir"):
        reg_dirs.add(str(config["reg_data_dir"]))
    dataset_config = _dataset_config(record, config)
    if isinstance(dataset_config, dict):
        for ds in dataset_config.get("datasets", []):
            if not isinstance(ds, dict):
                continue
            for sub in ds.get("subsets", []):
                if isinstance(sub, dict) and sub.get("is_reg") and sub.get("image_dir"):
                    reg_dirs.add(str(sub["image_dir"]))
    return lookup, reg_dirs


def _resolve_subset_label(row: dict[str, Any], subset_lookup: dict[tuple[int, int], dict[str, Any]]) -> str:
    info = subset_lookup.get((row.get("dataset"), row.get("subset")))
    if info and info.get("label"):
        return str(info["label"])
    _, directory, _ = _split_image_key(row.get("image", ""))
    return directory.rstrip("/").rsplit("/", 1)[-1] if directory else _subset_key(row)


def _timestep_scale(profile: str) -> str:
    if profile == "anima-lora":
        return "unit"
    if profile in ("sdxl-lora", "moss-image-lora"):
        return "thousand"
    return "unknown"


def _detect_profile(record: dict[str, Any]) -> str:
    extra = record.get("extra") if isinstance(record.get("extra"), dict) else {}
    profile = str(extra.get("profile_id") or "").strip()
    if not profile and record.get("run_path"):
        cfg = read_run_config(Path(record["run_path"]))
        profile = str(cfg.get("model_train_type") or "").strip()
        if not profile:
            # Older run records may identify the actual trainer but predate profile_id.
            from backend.training.config.config_import import infer_training_profile

            try:
                profile = infer_training_profile(cfg, {"extra": extra}) or ""
            except ValueError:
                profile = ""
    return profile


def _subset_key(row: dict[str, Any]) -> str:
    if row["dataset"] is None or row["subset"] is None:
        return "(unknown)"
    return f"{row['dataset']}-{row['subset']}"


def _row_is_reg(
    row: dict[str, Any],
    subset_lookup: dict[tuple[int, int], dict[str, Any]],
    reg_dirs: set[str],
) -> bool | None:
    d, s = row["dataset"], row["subset"]
    if d is not None and s is not None and (d, s) in subset_lookup:
        is_reg = subset_lookup[(d, s)].get("is_reg")
        if is_reg is not None:
            return bool(is_reg)
    lw = row.get("loss_weight")
    if lw is not None and abs(lw - 1.0) > 1e-5:
        return True
    image = row.get("image") or ""
    if image and reg_dirs:
        if any(_is_path_under(image, root) for root in reg_dirs):
            return True
        # A concrete, absolute image outside the recorded regularization roots
        # is a training image; metadata keys alone cannot establish a path.
        if Path(image).is_absolute():
            return False
    return None


def _classify_image(
    *,
    count: int,
    comparable_count: int,
    non_finite_count: int,
    mean_residual: float | None,
    slope: float | None,
    min_count: int,
) -> str:
    if non_finite_count > 0:
        return "non_finite"
    if count < min_count:
        return "insufficient"
    if comparable_count < min_count or mean_residual is None:
        return "insufficient_reference"
    if mean_residual >= HIGH_RESIDUAL_THRESHOLD:
        if slope is not None and slope <= CONVERGING_SLOPE_THRESHOLD:
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


def _analysis_revision(state, runs, run_id, profile, bins, min_samples, record):
    run_path = Path(record["run_path"])
    metadata = (
        state.local_generation,
        _file_revision(state.path.with_name(MANIFEST_FILE)),
        _file_revision(run_path / "config.toml"),
        _file_revision(run_path / "dataset.toml"),
    )
    selections = tuple((key, rows.digest.hexdigest()) for key, rows in runs.items())
    parts = (
        str(state.path), selections, tuple(state.runs), run_id,
        profile, bins, min_samples, record.get("run_dir", ""), metadata,
    )
    return hashlib.sha256(repr(parts).encode()).hexdigest(), metadata


def _unavailable(reason, known_revision, **details):
    revision = hashlib.sha256(repr((reason, details)).encode()).hexdigest()
    if revision == known_revision:
        return {"revision": revision, "unchanged": True}
    return {"available": False, "reason": reason, "revision": revision, **details}


def _timestep_table(index, means, distinct, eligible):
    start, end = index.edges
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


def _structure_labels(state, revision, manifest, record):
    if getattr(state, "metadata_revision", None) != revision:
        state.metadata_revision = revision
        state.subset_lookup, state.reg_dirs = _build_subset_lookup(manifest, record)
        state.structure_labels = []
    for structure in range(len(state.structure_labels), len(state.structures)):
        row = state.sample_metadata(structure)
        state.structure_labels.append((
            _resolve_subset_label(row, state.subset_lookup), _row_is_reg(row, state.subset_lookup, state.reg_dirs),
        ))
    return state.structure_labels


def _group_tables(state, index, means, eligible, labels):
    by_dimension = {}
    for column, dimension in enumerate(DIMENSIONS, start=1):
        group_codes = state.groups[dimension].keys
        totals = index.totals(dimension, len(group_codes), means, eligible)
        images = defaultdict(set)
        subset_regs = defaultdict(set)
        subset_labels = defaultdict(Counter)
        for structure, count in index.finite_structures.items():
            meta = state.structures[structure]
            image, group = meta[0], meta[column]
            images[group].add(image)
            if dimension == "subset":
                label, is_reg = labels[structure]
                subset_labels[group][label] += count
                subset_regs[group].add(is_reg)
        table = []
        for group, members in images.items():
            key = group_codes[group]
            item = {"key": key, "label": key, "images": len(members), **_stats_at(totals, group)}
            if dimension == "subset":
                item.update(label=subset_labels[group].most_common(1)[0][0], is_reg=_reg_status(subset_regs[group]))
            elif dimension == "directory":
                item.update(label=state.images[next(iter(members))]["dir_label"] or key, full_path=key)
            elif dimension == "batch_size" and key != "(unknown)":
                item["label"] = f"bs {key}"
            table.append(item)
        by_dimension[dimension] = table
    by_dimension["resolution"].sort(key=lambda item: (-item["count"], item["key"]))
    by_dimension["batch_size"].sort(key=lambda item: int(item["key"]) if item["key"].isdigit() else math.inf)
    by_dimension["subset"].sort(key=lambda item: item["key"])
    by_dimension["directory"].sort(key=lambda item: (
        item["mean_residual"] is None, -(item["mean_residual"] or 0), item["key"],
    ))
    return by_dimension


def _preview_fields(entry, run_dir):
    local, version = _stat_local_image(entry)
    key = run_dir, version, local is not None
    if entry.get("preview_key") != key:
        url_args = {"scope": "loss_sample", "run_dir": run_dir, "path": entry["image_id"], "version": version}
        entry["preview_key"] = key
        entry["preview_fields"] = {
            "local_available": local is not None,
            "thumb_url": build_image_preview_url(variant="thumb", **url_args) if local and run_dir else "",
            "preview_url": build_image_preview_url(variant="preview", **url_args) if local and run_dir else "",
        }
    return entry["preview_fields"]


def _image_stats(state, index, entry, labels, stats, epoch_stats, zone_stats, min_samples, run_dir):
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
    epochs, comparable_epochs, slope, first, last = epoch_stats
    slope = _finite_float(float(slope))
    for zone in zone_stats.values():
        zone.pop("mean_loss")
    return {
        "image_id": entry["image_id"], "image": entry["key"], "name": entry["name"],
        "directory": entry["directory"], "dir_label": entry["dir_label"] or "(root)",
        "resolution": resolutions.most_common(1)[0][0], "resolutions": sorted(resolutions),
        "subset": subsets.most_common(1)[0][0], "subsets": sorted(subsets),
        "subset_label": subset_labels.most_common(1)[0][0], "is_reg": _reg_status(reg),
        **stats, "non_finite_count": non_finite,
        "epochs": int(epochs), "comparable_epochs": int(comparable_epochs), "slope": slope,
        "first_epoch_residual": _finite_float(float(first)), "last_epoch_residual": _finite_float(float(last)),
        "noise_zones": {zone: values if values["count"] else None for zone, values in zone_stats.items()},
        "status": _classify_image(count=stats["count"], comparable_count=stats["comparable_count"],
                                  non_finite_count=non_finite, mean_residual=stats["mean_residual"],
                                  slope=slope, min_count=min_samples),
        **_preview_fields(entry, run_dir),
    }


def _overview_images(state, index, means, eligible, labels, zones, min_samples, run_dir):
    size = len(state.images)
    totals = index.totals("image", size, means, eligible)
    epochs = index.image_epochs(size, state.epoch_images, state.epoch_numbers, means, eligible)

    images = [
        _image_stats(
            state, index, entry, labels, _stats_at(totals, image),
            [column[image] for column in epochs],
            {zone: _stats_at(zones, image * len(ZONES) + z) for z, zone in enumerate(ZONES)},
            min_samples, run_dir,
        )
        for image, entry in enumerate(state.images)
        if totals[0][image] or index.non_finite.get(image)
    ]
    images.sort(key=lambda image: (
        not image["non_finite_count"], image["mean_residual"] is None,
        -(image["mean_residual"] or 0), -image["count"], image["image_id"],
    ))
    return images



def _render_overview(state, index, record, revision, metadata_revision, profile, run_id, min_samples):
    manifest = read_object(state.path.with_name(MANIFEST_FILE))
    training = manifest.get("training")
    num_processes = (_opt_int(training.get("num_processes")) if isinstance(training, dict) else None) or 1
    labels = _structure_labels(state, metadata_revision, manifest, record)
    means, distinct, eligible = index.baseline()
    groups = _group_tables(state, index, means, eligible, labels)
    zones = index.totals("zone", len(state.images) * len(ZONES), means, eligible)
    by_image = _overview_images(state, index, means, eligible, labels, zones, min_samples, record.get("run_dir", ""))
    counts = Counter(item["status"] for item in by_image)
    qualified = sum(item["comparable_count"] >= min_samples for item in by_image)
    has_slope = any(item["slope"] is not None for item in by_image)
    total_non_finite = sum(index.non_finite.values())
    total_finite = int(index.counts.sum())
    total_comparable = int(index.counts[eligible].sum())
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
    noise_zones = {
        zone: {**_stats_at(zone_totals, z), "share": float(zone_totals[0][z] / total_in_zones) if total_in_zones else 0.0}
        for z, zone in enumerate(ZONES)
    }
    return {
        "revision": revision, "available": True, "profile": profile, "run_id": run_id,
        "available_runs": list(state.runs), "timestep_scale": index.scale, "verdict": verdict,
        "notable_group": _pick_notable_group(groups, min_samples),
        "thresholds": {
            "high_residual": HIGH_RESIDUAL_THRESHOLD, "low_residual": LOW_RESIDUAL_THRESHOLD,
            "converging_slope": CONVERGING_SLOPE_THRESHOLD, "min_count": min_samples, "num_bins": index.num_bins,
        },
        "summary": {
            "samples": total_finite, "non_finite_total": total_non_finite,
            "comparable_count": total_comparable, "unknown_timestep_count": int(index.counts[-1]),
            "images_total": len(by_image), "images_qualified": qualified, "images_skipped": len(by_image) - qualified,
            "step_from": index.step_from, "step_to": index.step_to, "epoch_from": index.epoch_from, "epoch_to": index.epoch_to,
            "mean_loss": float(index.loss.sum() / total_finite) if total_finite else None,
            "has_slope": has_slope, "has_reg_images": any(item["is_reg"] for item in by_image),
            "multi_gpu_partial": num_processes > 1, "num_processes": num_processes,
            "counts": {key: counts[key] for key in (
                "attention", "learning", "easy", "normal", "non_finite", "insufficient", "insufficient_reference",
            )},
        },
        "noise_zones": noise_zones, "by_timestep": _timestep_table(index, means, distinct, eligible),
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
) -> dict[str, Any]:
    if not record:
        return _unavailable("no_run", known_revision)
    profile = _detect_profile(record)
    if profile == "krea2-lora":
        return _unavailable("unsupported_engine", known_revision, profile=profile)
    loss_path = Path(record["run_path"]) / "log" / ".run-control" / LOSS_FILE
    if not loss_path.is_file():
        return _unavailable("waiting" if is_active else "not_recorded", known_revision, profile=profile)
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
                for image in state.images:
                    image["checked"] = False
            bins = max(2, min(30, int(num_bins)))
            min_samples = max(1, min(100, int(min_count)))
            revision, metadata_revision = _analysis_revision(state, runs, selected, profile, bins, min_samples, record)
            if revision == known_revision:
                return {"revision": revision, "unchanged": True}
            if revision != state.cached_revision:
                index = state.indexed(selected, runs, bins, _timestep_scale(profile))
                state.cached_summary = _render_overview(state, index, record, revision, metadata_revision, profile, selected, min_samples)
                state.cached_revision = revision
            return state.cached_summary
    finally:
        _trim_loss_cache()



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
                                  Path(str(metadata_file)).name == Path(str(metadata_name)).name)
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
            cursor = 0
            for runtime_index in range(s_idx + 1):
                runtime = subset_lookup.get((ds_index, runtime_index))
                if not runtime:
                    break
                name = runtime.get("metadata_file") or runtime.get("label")
                found = None
                for index in range(cursor, len(subsets)):
                    candidate = subsets[index]
                    if not isinstance(candidate, dict):
                        continue
                    candidate_path = candidate.get("metadata_file") if runtime.get("metadata_file") else (
                        candidate.get("image_dir") or ds.get("image_dir") or general.get("image_dir")
                    )
                    is_reg = candidate.get("is_reg", ds.get("is_reg", general.get("is_reg", False)))
                    if candidate_path and name and Path(str(candidate_path)).name == Path(str(name)).name and (
                        runtime.get("is_reg") is None or bool(is_reg) == runtime["is_reg"]
                    ):
                        found = index
                        break
                if found is None:
                    break
                cursor = found + 1
                if runtime_index == s_idx:
                    aligned = found
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


@lru_cache(maxsize=2)
def _read_metadata_revision(path: str, device: int, inode: int, modified_ns: int, size: int) -> dict[str, Any]:
    del device, inode, modified_ns, size  # The full file revision remains part of the cache key.
    def caption_fields(value: dict[str, Any]) -> dict[str, Any]:
        return {"caption": value.get("caption"), "tags": value.get("tags")}

    with Path(path).open("r", encoding="utf-8") as stream:
        if path.lower().endswith(".jsonl"):
            records = {}
            for line in stream:
                row = json.loads(line)
                if isinstance(row, dict) and isinstance(row.get("image_path"), str):
                    records[row["image_path"]] = caption_fields(row)
            return records
        value = json.load(stream)
        return {key: caption_fields(entry) for key, entry in value.items()
                if isinstance(key, str) and isinstance(entry, dict)} if isinstance(value, dict) else {}


def _metadata_caption_preview(path: str | None, image_key: str, options: dict[str, Any]) -> dict[str, Any]:
    result = {"exists": False, "filename": "", "path": "", "text": "", "error": "",
              "editor_safe": False, "source": "metadata", "text_available": False}
    if not path:
        return result
    metadata_path = Path(path)
    if not metadata_path.is_absolute():
        metadata_path = REPO_ROOT / metadata_path
    metadata_path = metadata_path.resolve()
    result.update(filename=metadata_path.name, path=str(metadata_path))
    try:
        stat = metadata_path.stat()
        if stat.st_size > _MAX_METADATA_PREVIEW_BYTES:
            return result
        data = _read_metadata_revision(str(metadata_path), stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size)
        result["text_available"] = True
        entry = data.get(image_key)
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
) -> dict[str, Any]:
    empty = {"exists": False, "filename": "", "path": "", "text": "", "error": "",
             "editor_safe": False, "source": "unknown"}
    config = _run_config(record)
    dataset = _dataset_config(record, config)
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
            return ("metadata", _canonical_path(path) if path else "",
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
        return _metadata_caption_preview(choice.get("metadata_file"), str(image_rows[0].get("image") or ""), choice["options"])
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
) -> dict[str, Any] | None:
    if not record or not _IMAGE_ID_RE.fullmatch(image_id or ""):
        return None
    profile = _detect_profile(record)
    if profile == "krea2-lora":
        return None
    loss_path = Path(record["run_path"]) / "log" / ".run-control" / LOSS_FILE
    if not loss_path.is_file():
        return None
    state = _get_loss_state(loss_path)
    try:
        with state.lock:
            state.sync()
            selected, runs = state.select(run_id)
            entry = state.image_registry.get(image_id)
            if not entry:
                return None
            matching = list(state.image_samples(runs, entry))
            if not matching:
                return None
            bins = max(2, min(30, int(num_bins)))
            min_samples = max(1, min(100, int(min_count)))
            scale = _timestep_scale(profile)
            revision, metadata_revision = _analysis_revision(state, runs, selected, profile, bins, min_samples, record)
            index = state.indexed(selected, runs, bins, scale)
            means, distinct, eligible = index.baseline()
            by_timestep = _timestep_table(index, means, distinct, eligible)
            finite_rows = [row for row in matching if row["loss"] is not None]
            non_finite = [row for row in matching if row["loss"] is None]
            row_bins = index.bins(np.asarray([row["timestep"] for row in finite_rows], dtype=np.float64))
            residuals = [
                float(row["loss"] / means[bin_id] - 1) if eligible[bin_id] else None
                for row, bin_id in zip(finite_rows, row_bins)
            ]
            manifest = read_object(state.path.with_name(MANIFEST_FILE))
            labels = _structure_labels(state, metadata_revision, manifest, record)
            subset_lookup = state.subset_lookup
            local_path, _ = _stat_local_image(entry, refresh=refresh_local)
            run_ref = record.get("run_dir", "")
            epoch_ids = sorted({row["epoch_id"] for row in finite_rows if row["epoch"] is not None},
                               key=lambda epoch_id: state.epoch_numbers[epoch_id])
            epoch_numbers = np.array([state.epoch_numbers[epoch_id] for epoch_id in epoch_ids], dtype=np.int64)
            epoch_totals = np.array([index.single("epoch", epoch_id, means, eligible) for epoch_id in epoch_ids])
            epochs = [{"epoch": int(epoch), **_stats_values(*map(float, totals))}
                      for epoch, totals in zip(epoch_numbers, epoch_totals)]
            cached_image = None
            if state.cached_revision == revision:
                cached_image = next((image for image in state.cached_summary["by_image"] if image["image_id"] == image_id), None)
            if cached_image is not None:
                image_summary = {**cached_image, **_preview_fields(entry, run_ref)}
            else:
                if epoch_ids:
                    total, _, count, residual = epoch_totals.T
                    epoch_stats = [column[0] for column in epoch_metrics(
                        1, np.zeros(len(epoch_ids), dtype=np.int64), epoch_numbers, total, count, residual,
                    )]
                else:
                    epoch_stats = [0, 0, math.nan, math.nan, math.nan]
                image = entry["index"]
                stats = _stats_values(*index.single("image", image, means, eligible))
                zones = {
                    zone: _stats_values(*index.single("zone", image * len(ZONES) + z, means, eligible))
                    for z, zone in enumerate(ZONES)
                }
                image_summary = _image_stats(state, index, entry, labels, stats, epoch_stats, zones, min_samples, run_ref)
    finally:
        _trim_loss_cache()

    samples = [_detail_sample(row, residual) for row, residual in zip(finite_rows, residuals)]
    samples.extend(_detail_sample(row, None) for row in non_finite)
    samples.sort(key=lambda item: (item["step"] if item["step"] is not None else -1, item["epoch"] or 0))
    samples_total = len(samples)
    caption = _read_caption_preview(local_path, record=record, rows=matching, subset_lookup=subset_lookup)
    if local_path is not None:
        width, height, size = _read_image_dimensions(local_path)
        file_info = {"exists": size is not None, "abs_path": str(local_path), "dir_path": str(local_path.parent),
                     "size": size, "width": width, "height": height}
    else:
        file_info = {"exists": False, "raw_key": entry["key"]}
    return {
        "revision": revision, "run_id": selected, "timestep_scale": scale, "image": image_summary,
        "epoch_series": epochs, "by_timestep": by_timestep, "samples": samples[-_MAX_DETAIL_SAMPLES:],
        "samples_total": samples_total, "samples_truncated": samples_total > _MAX_DETAIL_SAMPLES,
        "caption": caption, "file_info": file_info,
    }


def _detail_sample(row, residual):
    fields = ("step", "epoch", "timestep", "loss", "width", "height", "batch_size", "loss_weight")
    return {**{field: row[field] for field in fields}, "residual": residual, "non_finite": row["loss"] is None}



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
            return _stat_local_image(entry)[0] if entry else None
    finally:
        _trim_loss_cache()
