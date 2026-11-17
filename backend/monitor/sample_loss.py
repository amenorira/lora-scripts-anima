"""Resolve sample log sources once per preview refresh, then attach foreign loss."""
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from backend.monitor.history import scan_history
from backend.monitor.legacy_sample_steps import _read_calls, enrich_legacy_sample_steps
from backend.monitor.run_registry import load_run_record, resolve_user_path
from backend.monitor.sample_metadata import parse_sample_filename
from backend.monitor.training import read_tensorboard_loss


def enrich_sample_loss(previews: list[dict], artifact_root: Path, run_dir: str) -> None:
    """Keep current-run loss live; other runs supply compact, batch-shared values.

    The history catalog and parsed sampling logs already have their own caches.
    This runs inside the existing preview cache, never during frontend rendering.
    """
    if not previews:
        return
    current = load_run_record(run_dir) if run_dir else None
    if not current:
        enrich_legacy_sample_steps(previews, resolve_user_path(run_dir) if run_dir else artifact_root, artifact_root)
        return

    catalog = scan_history()
    related = {item["run_dir"]: item for item in catalog if Path(item["artifact_dir"]) == artifact_root}
    # A just-started run can precede the history catalog's first config read.
    if current["run_dir"] not in related:
        related[current["run_dir"]] = {**current, "timestamp": datetime.fromisoformat(current["created_at"]).timestamp()
                                      if current.get("created_at") else 0}
    by_task = {item["task_id"]: item for item in catalog if item.get("task_id")}
    if current.get("task_id"):
        by_task[current["task_id"]] = related[current["run_dir"]]

    ordered = sorted(related.values(), key=lambda item: item["timestamp"])
    starts = [datetime.fromtimestamp(item["timestamp"]).strftime("%Y%m%d%H%M%S") for item in ordered]
    groups = defaultdict(list)
    calls_by_run = {}
    by_epoch = defaultdict(list)
    if len(ordered) > 1 and any(not item["sample"].get("task_id") for item in previews):
        for source in ordered:
            calls = _read_calls((resolve_user_path(source["run_dir"]),))
            calls_by_run[source["run_dir"]] = calls
            for call in calls:
                by_epoch[call.epoch].append((call.start.strftime("%Y%m%d%H%M%S"),
                                            call.end.strftime("%Y%m%d%H%M%S"), source))

    for preview in previews:
        sample = preview["sample"]
        sample.pop("epoch_loss", None)  # Cached metadata may have been viewed from another run.
        source = by_task.get(sample.get("task_id"))
        if source is None:
            source = ordered[0]
            if len(ordered) > 1:
                parsed = parse_sample_filename(preview["name"])
                if parsed:
                    saved_at = parsed["timestamp"]
                    matches = [(start, owner) for start, end, owner in by_epoch.get(sample.get("epoch"), ())
                               if start <= saved_at <= end]
                    source = (max(matches, key=lambda item: item[0])[1] if matches
                              else ordered[max(0, bisect_right(starts, saved_at) - 1)])
        sample["loss_run_dir"] = source["run_dir"]
        groups[source["run_dir"]].append(preview)

    for source_run, items in groups.items():
        root = resolve_user_path(source_run)
        enrich_legacy_sample_steps(items, root, calls=calls_by_run.get(source_run))
        # Filename-only records from resumed epochs must remain distinct batches
        # even when an old log has no sampling marker to recover a call ID.
        if len(related) > 1:
            for item in items:
                if item["sample"].get("metadata_source") == "filename":
                    item["sample"]["batch_id"] = source_run + ":" + item["sample"]["batch_id"]
        if source_run == current["run_dir"]:
            continue
        series = read_tensorboard_loss(run_dir=str(root), epoch_only=True)
        index = {entry["tag"]: {point["step"]: point["value"] for point in entry["points"]} for entry in series}

        def at(epoch):
            return {"overall": index.get("loss/epoch", {}).get(epoch, index.get("loss/epoch_average", {}).get(epoch)),
                    **{key: index.get("loss/timestep/epoch/" + key, {}).get(epoch) for key in ("high", "mid", "low")}}

        losses = {}
        detailed = any(tag.startswith("loss/timestep/epoch/") for tag in index)
        for item in items:
            sample = item["sample"]
            epoch = sample.get("epoch") if sample.get("stage_kind") == "epoch" else None
            if epoch is not None and epoch > 0:
                if epoch not in losses:
                    losses[epoch] = {"epoch": epoch, "values": at(epoch), "previous": at(epoch - 1), "detailed": detailed}
                sample["epoch_loss"] = losses[epoch]
