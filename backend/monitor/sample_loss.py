"""Resolve sample log sources once per preview refresh, then attach foreign loss."""
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime
import json
from pathlib import Path

from backend.monitor.history import scan_history
from backend.monitor.legacy_sample_steps import _read_calls, enrich_legacy_sample_steps
from backend.monitor.run_registry import load_run_record, resolve_user_path
from backend.monitor.sample_metadata import parse_sample_filename
from backend.monitor.training import read_tensorboard_loss


def _command_sample_details(root: Path, event: dict) -> dict:
    """The completion event identifies the files. Its receipt also identifies the prompts."""
    cmd = {}
    result = event.get("result")
    filename = event.get("file")
    if isinstance(filename, str) and filename and "/" not in filename and "\\" not in filename:
        try:
            receipt = json.loads((root / "commands" / "done" / filename).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            receipt = None
        if (isinstance(receipt, dict) and receipt.get("status") == "ok"
                and (not event.get("run_id") or receipt.get("run_id") == event["run_id"])):
            cmd = receipt.get("command") or {}
            result = receipt.get("result") or result
    files = result.get("files") if isinstance(result, dict) else None
    if not isinstance(cmd, dict) or not isinstance(files, list):
        return {}
    indices = [idx for idx in (cmd.get("indices") or []) if type(idx) is int and idx >= 0]
    prompts = cmd.get("prompts") or []
    details = {}
    for pos, raw_path in enumerate(files):
        if not isinstance(raw_path, str):
            continue
        name = Path(raw_path).name
        info = {"sample_origin": "manual"}
        if pos < len(indices):
            info["source_prompt_index"] = indices[pos]
        else:
            prompt_pos = pos - len(indices)
            if 0 <= prompt_pos < len(prompts):
                entry = prompts[prompt_pos]
                text = entry.get("prompt") if isinstance(entry, dict) else entry if isinstance(entry, str) else None
                if isinstance(text, str) and text.strip():
                    info["prompt"] = text.strip()
        details["sample/" + name] = info
    return details


def _apply_sample_events(previews, record):
    """Match filenames reported by this trainer when no per-image metadata was captured."""
    root = Path(record["run_path"]) / "log" / ".run-control"
    pending = {item["path"]: item for item in previews if item["sample"].get("metadata_source") == "filename"}
    if not pending:
        return
    manual_details = {}
    generation_paths = set()
    generation_step = None
    try:
        with (root / "events.jsonl").open("rb") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("event")
                if kind == "command_finished" and event.get("command") == "sample":
                    if generation_paths and event.get("status") == "ok" and event.get("step") == generation_step:
                        details = _command_sample_details(root, event)
                        manual_details.update((path, details[path]) for path in generation_paths & details.keys())
                    generation_paths.clear()
                    continue
                if kind != "samples_generated":
                    continue
                step, epoch, stamp = event.get("step"), event.get("epoch"), event.get("ts")
                generation_paths.clear()
                generation_step = step
                if type(step) is not int or type(epoch) is not int or not isinstance(stamp, (int, float)):
                    continue
                for name in event.get("files") or []:
                    item = pending.get("sample/" + name) if isinstance(name, str) else None
                    if not item:
                        continue
                    manual_details.pop(item["path"], None)
                    # Replaced files must not inherit an earlier generation's details.
                    mtime = item["version"].split("-", 1)[0]
                    if not mtime.isdigit() or int(mtime) / 1e9 > stamp + 0.001:
                        continue
                    generation_paths.add(item["path"])
                    item["sample"].update(task_id=record["task_id"], step=step, epoch=epoch,
                                          step_source="event", batch_id=f"{record['task_id']}:{stamp}:{step}",
                                          batch_label=f"Epoch {epoch} · Step {step}" if epoch else f"Step {step}")
    except OSError:
        return
    for rel_path, info in manual_details.items():
        item = pending.get(rel_path)
        if not item:
            continue
        sample = item["sample"]
        sample["sample_origin"] = "manual"
        sample["prompt_index"] = info.get("source_prompt_index")
        sample["prompt_label"] = ""
        sample["prompt_id"] = "manual:" + rel_path
        if "source_prompt_index" in info:
            sample["source_prompt_index"] = info["source_prompt_index"]
        if "prompt" in info:
            sample.setdefault("params", {})["prompt"] = info["prompt"]
            sample["prompt_label"] = info["prompt"][:128]


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

    if current.get("run_path") and current.get("task_id"):
        _apply_sample_events(previews, current)
        if all(item["sample"].get("task_id") == current["task_id"] and item["sample"].get("step") is not None
               for item in previews):
            for item in previews:
                item["sample"].pop("epoch_loss", None)
                item["sample"]["loss_run_dir"] = current["run_dir"]
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
