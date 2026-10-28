"""Unified Tagger workspace tasks, source scanning, thumbnails, and captions."""
from __future__ import annotations

import os
import json
from contextlib import ExitStack
import threading
import time
import uuid
from collections import OrderedDict, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from queue import Full, Queue
from typing import Any

from PIL import Image, UnidentifiedImageError

from backend.log import log
from backend.tagger import captioning, api_engine
from backend.tagger.interrogator import (
    available_interrogators,
    gpu_inference_lock,
    has_active_legacy_tagger_task,
    split_str,
)
from backend.tagger.interrogators.base import CATEGORY_LABELS, Interrogator
from backend.tagger.registry import MODEL_SPEC_BY_ID
from backend.utils.file_io import atomic_write_text
from backend.tasks import tm
from backend.tagger.workspace_state import (
    _IMAGE_EXTENSIONS,
    _SOURCE_TTL,
    _TASK_TTL,
    _TASK_KEEP_MAX,
    _MAX_LOGS,
    _MAX_RECENT_ITEMS,
    _ACTIVE_TASK_STATUSES,
    _sources,
    _sources_lock,
    _tasks,
    _tasks_lock,
    _direct_tagger,
    _cleanup,
)


def _is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS


def _enumerate_images(path: Path, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path] if _is_image(path) else []
    iterator = path.rglob("*") if recursive else path.iterdir()
    return sorted((item for item in iterator if _is_image(item)), key=lambda item: str(item).lower())


def scan_source(path_value: str, recursive: bool = True, caption_extension: str = ".txt", caption_options: dict | None = None) -> dict:
    _cleanup()
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        raise ValueError("Source does not exist / 输入路径不存在")
    if path == Path(path.anchor):
        raise ValueError("Filesystem root is not allowed / 不允许选择磁盘根目录")
    images = _enumerate_images(path, recursive)
    token = uuid.uuid4().hex[:16]
    caption_extension = "." + str(caption_extension).strip().lstrip(".")
    if caption_extension == "." or any(c in caption_extension for c in '/\\\r\n'):
        raise ValueError("Invalid caption extension / 无效的标注扩展名")
    settings = captioning.output_options(caption_options, caption_extension)
    directories = len({image.parent for image in images})
    source = {
        "token": token,
        "root": str(path),
        "kind": "file" if path.is_file() else "folder",
        "recursive": recursive,
        "caption_extension": caption_extension,
        "caption_options": settings,
        "paths": images,
        "created_at": time.time(),
        "annotation_lock": threading.RLock(),
        "annotation_cache": {},
    }
    with _sources_lock:
        _sources[token] = source
    if caption_options is not None:
        _, counts = _annotation_states(source, settings)
    else:
        caption_count = sum(image.with_suffix(caption_extension).is_file() for image in images)
        counts = {"outputs": caption_count, "missing_outputs": len(images) - caption_count}
    return {
        "source_token": token,
        "path": str(path),
        "kind": source["kind"],
        "total": len(images),
        "directories": directories,
        "with_caption": counts["outputs"],
        "without_caption": counts["missing_outputs"],
        "items": [
            {"index": index, "name": image.name, "path": str(image), "has_caption": image.with_suffix(caption_extension).is_file()}
            for index, image in enumerate(images[:_MAX_RECENT_ITEMS])
        ],
        "items_truncated": len(images) > _MAX_RECENT_ITEMS,
        **counts,
    }


def register_upload(path: Path) -> dict:
    result = scan_source(str(path), recursive=False)
    result["kind"] = "upload"
    with _sources_lock:
        if result["source_token"] in _sources:
            _sources[result["source_token"]]["kind"] = "upload"
    return result


def source_item(source_token: str, index: int) -> Path:
    source = _get_source(source_token)
    with source["annotation_lock"]:
        return _source_path(source, index)


def _source_path(source: dict, index: int) -> Path:
    paths = source["paths"]
    if index < 0 or index >= len(paths):
        raise IndexError("Image index out of range / 图片索引超出范围")
    candidate = paths[index].resolve()
    root = Path(str(source["root"])).resolve()
    if source.get("kind") in {"file", "upload"}:
        if candidate != root:
            raise ValueError("Image escaped source scope / 图片超出输入源范围")
    else:
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError("Image escaped source scope / 图片超出输入源范围") from exc
    return candidate


def _get_source(token: str) -> dict:
    _cleanup()
    with _sources_lock:
        source = _sources.get(token)
    if source is None:
        raise KeyError("Source expired or not found / 输入源已过期或不存在")
    return source


def _annotation_states(source: dict, settings: dict, *, cached: bool = False) -> tuple[list[dict], dict]:
    # Plans/default callers always stat every output. Overview callers may reuse
    # a five-second snapshot; completed task items invalidate just their paths.
    with source["annotation_lock"]:
        cache = source["annotation_cache"]
        now = time.monotonic()
        reuse = (cached and source.get("annotation_settings") == settings
                 and now - source.get("annotation_checked_at", -float("inf")) < 5.0)
        states = []
        root = Path(source["root"]).resolve()
        parents = {}
        for index, path in enumerate(source["paths"]):
            if reuse and str(path) in cache:
                states.append(cache[str(path)])
                continue
            if source["kind"] in {"file", "upload"}:
                _source_path(source, index)
            parent = parents.get(path.parent)
            if parent is None:
                parent = path.parent.resolve()
                if source["kind"] == "folder":
                    try:
                        parent.relative_to(root)
                    except ValueError as exc:
                        raise ValueError("Image escaped source scope / 图片超出输入源范围") from exc
                parents[path.parent] = parent
            try:
                if captioning.is_reparse(path.lstat()):
                    _source_path(source, index)
            except FileNotFoundError:
                pass  # A deleted image remains visible until an explicit rescan.
            state = captioning.output_state(path, settings, cache.get(str(path)), parent=parent)
            cache[str(path)] = state
            states.append(state)
        if not reuse:
            source["annotation_checked_at"] = now
            source["annotation_settings"] = dict(settings)
        return states, captioning.output_counts(states)


def _annotation_text(path: Path, settings: dict, state: dict) -> dict:
    text = captioning.read_bounded(captioning.related_file(path, path.with_suffix(settings["caption_extension"]))) if state["has_caption"] and state["caption_kind"] != "unreadable" else ""
    candidates = captioning.parse_caption_text(text, settings["separator"]) if state["caption_kind"] == "moss" else {}
    return {"text": text, "candidates": candidates, "caption_excerpt": (next(iter(candidates.values()), text)).strip()[:240],
            "candidate_lengths": {key: len(value) for key, value in candidates.items()}}


def annotations(token: str, offset=0, limit=60, status="all", q="", refresh=False, options=None, task_id="", cached=False) -> dict:
    source = _get_source(token)
    if source["kind"] != "folder":
        raise ValueError("Overview requires a directory / 总览仅支持批量目录")
    if status not in {"all", "missing", "missing_json", "invalid_json", "ordinary", "failed"}:
        raise ValueError("Invalid annotation filter / 无效的标注筛选")
    settings = captioning.output_options(options, options.get("caption_extension", ".txt")) if options is not None else source["caption_options"]
    with source["annotation_lock"]:
        if refresh and not source.get("subset"):
            source["paths"] = _enumerate_images(Path(source["root"]), source["recursive"])
            source["annotation_cache"] = {}
        states, counts = _annotation_states(source, settings, cached=cached and not refresh)
        task_states = {}
        if task_id:
            with _tasks_lock:
                task = _tasks.get(task_id)
            if task and task["engine"] == "api" and task["source_root"] == source["root"]:
                with task["lock"]:
                    task_states = {os.path.normcase(item["path"]): {k: item[k] for k in ("status", "event", "error") if k in item} for item in task["items"]}
        selected = []
        root = Path(source["root"])
        query = str(q).casefold()[:512]
        for index, (path, state) in enumerate(zip(source["paths"], states)):
            relative = path.relative_to(root).as_posix()
            live = task_states.get(os.path.normcase(str(path)), {})
            if query and query not in relative.casefold():
                continue
            if ((status == "missing" and state["caption_kind"] != "missing") or (status == "missing_json" and state["has_sidecar"] is not False)
                    or (status == "invalid_json" and not state.get("sidecar_error"))
                    or (status == "ordinary" and state["caption_kind"] != "ordinary") or (status == "failed" and live.get("status") != "failed")):
                continue
            selected.append((index, path, relative, state, live))
        total = len(selected)
        limit = max(1, min(int(limit), 60))
        offset = max(0, min(int(offset), max(0, (total - 1) // limit * limit)))
        items = []
        for index, path, relative, state, live in selected[offset:offset + limit]:
            item = {k: v for k, v in state.items() if k != "fingerprint"}
            try:
                content = _annotation_text(path, settings, state)
                item.update(caption_excerpt=content["caption_excerpt"], candidate_lengths=content["candidate_lengths"])
            except (OSError, ValueError) as exc:
                item["read_error"] = str(exc)
            try:
                image_version = path.stat().st_mtime_ns
            except OSError:
                image_version = 0
            items.append({"index": index, "name": path.name, "path": str(path), "relative": relative, "image_version": str(image_version), **item, "task": live})
        return {"total": total, "offset": offset, "limit": limit, "counts": counts, "items": items,
                "settings": settings, "scanned_at": time.time()}


def annotation_detail(token: str, index: int, options: dict | None = None) -> dict:
    source = _get_source(token)
    with source["annotation_lock"]:
        path = source_item(token, index)
        settings = captioning.output_options(options, options.get("caption_extension", ".txt")) if options is not None else source["caption_options"]
        state = captioning.output_state(path, settings)
        output, sidecar, reference = captioning.output_files(path, settings)
        content = _annotation_text(path, settings, state)
        sidecar_error = ""
        try:
            data = captioning.read_result(sidecar, path) if state["has_sidecar"] else {}
        except (OSError, ValueError) as exc:
            data = {}
            sidecar_error = str(exc)
        # Explicit allowlist: credentials and arbitrary sidecar properties never leave this API.
        metadata = {key: data.get(key) for key in ("model", "created_at", "usage", "finish_reason", "prompt", "reference", "knowledge", "response") if key in data}
        try:
            reference_text = captioning.read_bounded(reference) if reference and reference.is_file() and (reference != output or state["caption_kind"] != "moss") else data.get("reference") or ""
        except (OSError, ValueError) as exc:
            reference_text = ""
            state["read_error"] = str(exc)
        relative = path.relative_to(Path(source["root"])).as_posix() if source["kind"] == "folder" else path.name
        return {"index": index, "name": path.name, "path": str(path), "relative": relative, "image_version": str(path.stat().st_mtime_ns), **{k: v for k, v in state.items() if k != "fingerprint"},
                **content, "reference": reference_text, "sidecar": metadata, "sidecar_error": sidecar_error}


def caption_plan(token: str, options: dict) -> dict:
    """Plan and validate writes separately from the read-only annotation browser."""
    source = _get_source(token)
    if source["kind"] != "folder":
        raise ValueError("MOSS requires an image directory / MOSS 标注请选择图片目录")
    settings = captioning.plan_options(options)
    with source["annotation_lock"]:
        states, counts = _annotation_states(source, settings)
        captioning.validate_output_targets(source["paths"], settings, states)
        return {"counts": counts, "plan": captioning.execution_plan(states, settings)}


def claim_direct_tagger(owner: str, *, remote=False, cancel_event=None) -> None:
    """One synchronous Tagger request, sharing the batch gate without a new task."""
    with _tasks_lock:
        if _direct_tagger or any(task["status"] in _ACTIVE_TASK_STATUSES for task in _tasks.values()) or has_active_legacy_tagger_task():
            raise RuntimeError("Another Tagger task is running / 已有反推任务正在运行")
        claim = tm.claim_dataset_reader if remote else tm.claim_external
        if not claim(owner):
            raise RuntimeError("Resource is busy / 训练、打标、生成任务或目录重命名正在运行")
        _direct_tagger.update(owner=owner, remote=remote, cancel_event=cancel_event, phase="preparing")


def release_direct_tagger(owner: str) -> None:
    with _tasks_lock:
        if _direct_tagger.get("owner") != owner:
            return
        release = tm.release_dataset_reader if _direct_tagger["remote"] else tm.release_external
        release(owner)
        _direct_tagger.clear()


def preview_state() -> dict:
    with _tasks_lock:
        return {"active": bool(_direct_tagger.get("remote")), "request_id": _direct_tagger.get("owner", "") if _direct_tagger.get("remote") else "",
                "phase": _direct_tagger.get("phase", "idle") if _direct_tagger.get("remote") else "idle",
                "tagger_busy": bool(_direct_tagger) or any(task["status"] in _ACTIVE_TASK_STATUSES for task in _tasks.values()) or has_active_legacy_tagger_task()}


def cancel_preview(request_id: str) -> bool:
    with _tasks_lock:
        if _direct_tagger.get("owner") != request_id or not _direct_tagger.get("remote"):
            return False
        _direct_tagger["cancel_event"].set()
        _direct_tagger["phase"] = "cancelling"
        return True


def prepare_preview(payload: dict) -> dict:
    """Register cancellation before dispatching the synchronous worker."""
    request_id = str(payload.get("request_id") or uuid.uuid4().hex)
    if len(request_id) > 80:
        raise ValueError("Invalid request ID")
    cancel = threading.Event()
    claim_direct_tagger(request_id, remote=True, cancel_event=cancel)
    return {"request_id": request_id, "cancel_event": cancel}


def preview_caption(payload: dict, request: dict | None = None) -> dict:
    request = prepare_preview(payload) if request is None else request
    request_id, cancel = request["request_id"], request["cancel_event"]
    try:
        if cancel.is_set():
            raise InterruptedError("cancelled")
        token = str(payload.get("source_token") or "")
        source = _get_source(token)
        if source["kind"] not in {"file", "upload"}:
            raise ValueError("Preview requires a single image / 预览请选择单张图片")
        path = source_item(token, int(payload.get("index", 0)))
        # Preview consumes prompts and candidates, not batch output filenames.
        settings = {key: value for key, value in (payload.get("captioning") or {}).items()
                    if key in {"candidates", "knowledge", "knowledge_file", "prompt_source", "prompt_text", "prompt_file", "separator"}}
        options = captioning.validate_options({**settings, "overwrite": True, "reference_extension": "", "dir_knowledge_name": "", "knowledge_suffix": ""})
        config = captioning.validate_config(payload.get("api") or {}, options)
        with _tasks_lock:
            if cancel.is_set():
                raise InterruptedError("cancelled")
            _direct_tagger["phase"] = "running"
        return captioning.preview(config, path, options, cancel_event=cancel)
    finally:
        release_direct_tagger(request_id)


def source_items(source_token: str, offset: int = 0, limit: int = 120) -> dict:
    with _sources_lock:
        source = _sources.get(source_token)
        if not source:
            raise KeyError("Source expired or not found / 输入源已过期或不存在")
        paths = source["paths"]
        start = max(0, offset)
        page = paths[start:start + max(1, min(limit, 500))]
    return {
        "total": len(paths),
        "offset": start,
        "items": [
            {
                "index": start + index,
                "name": path.name,
                "path": str(path),
                "has_caption": path.with_suffix(source.get("caption_extension", ".txt")).is_file(),
                "status": "pending",
            }
            for index, path in enumerate(page)
        ],
    }


def training_active() -> bool:
    return any(task.get("status") in {"CREATED", "RUNNING"} for task in tm.dump())


def has_active_tagger_task() -> bool:
    with _tasks_lock:
        active = bool(_direct_tagger) or any(task.get("status") in _ACTIVE_TASK_STATUSES for task in _tasks.values())
    return active or has_active_legacy_tagger_task()


def _task_log(task: dict, event: str, level: str = "info", **data) -> None:
    with task["lock"]:
        task["logs"].append({"time": time.strftime("%H:%M:%S"), "event": event, "level": level, **data})
        task["updated_at"] = time.time()


def _record_task_item(task: dict, index: int, outcome: dict) -> None:
    with task["lock"]:
        status = outcome["status"]
        task[status] += 1
        task["current"] += 1
        item = task["items"][index]
        item.update({key: outcome[key] for key in ("status", "tag_count", "error", "event", "planned_action") if key in outcome})
        task["current_file"] = item["name"]
        if "result" in outcome:
            task["current_result"] = task["results"][index] = outcome["result"]
        event = outcome.get("event") or ("written" if status == "success" and task["write_captions"] else status)
        if event in {"caption_written", "reused", "written"}:
            task["written"] += 1
        if event == "reused":
            task["reused"] += 1
        action = outcome.get("planned_action")
        if action:
            task["plan"][{"request": "requests", "reuse": "reused", "skip": "skipped"}[action]] += 1
            task["plan"]["writes"] += action != "skip"
        if outcome.get("prompt") and not task.get("check_prompt"):
            task["check_prompt"] = outcome["prompt"]
            task["check_prompt_image"] = item["path"]
        _task_log(task, event, {"skipped": "warning", "failed": "error"}.get(status, "info"),
                  current=task["current"], total=task["total"], name=item["name"],
                  count=outcome.get("tag_count", 0), error=outcome.get("error", ""),
                  reference=outcome.get("reference", False), knowledge=outcome.get("knowledge", 0))
    # Do not take annotation locks while holding the task lock: overview reads
    # acquire them in the opposite order. External edits are rechecked within 5s.
    path = Path(item["path"])
    with _sources_lock:
        sources = list(_sources.values())
    for source in sources:
        if path.is_relative_to(Path(source["root"])):
            with source["annotation_lock"]:
                source["annotation_cache"].pop(str(path), None)


def _finish_task(task: dict, status: str, error: str = "") -> None:
    for key, release in (("resource_claim", tm.release_external), ("dataset_claim", tm.release_dataset_reader)):
        if task.get(key):
            release(task[key])
    with task["lock"]:
        if status in {"cancelled", "error"}:
            for item in task["items"]:
                if item["status"] in {"pending", "running"}:
                    item.update(status="cancelled", event="cancelled")
        task.update(status=status, phase={"done": "completed", "cancelled": "cancelled", "error": "error"}[status],
                    error_detail=error or None)
        level = ("error" if status == "error" or task["failed"] == task["total"] else
                 "warning" if task["failed"] or status == "cancelled" else "success")
        _task_log(task, status, level, elapsed=f"{max(0.0, time.time() - task['started_at']):.1f}",
                  success=task["success"], skipped=task["skipped"], failed=task["failed"],
                  checked=task["checked"], written=task["written"], reused=task["reused"], error=error)


def _task_snapshot_unlocked(task: dict) -> dict:
    elapsed = max(0.0, time.time() - task["started_at"]) if task.get("started_at") else 0.0
    current = task["current"]
    speed = current / elapsed if elapsed > 0 else 0.0
    remaining = max(0, task["total"] - current)
    return {
        "status": task["status"],
        "phase": task["phase"],
        "current": current,
        "total": task["total"],
        "current_file": task.get("current_file", ""),
        "success": task["success"],
        "skipped": task["skipped"],
        "failed": task["failed"],
        "written": task["written"],
        "reused": task["reused"],
        "checked": task["checked"],
        "plan": task["plan"],
        "has_check_prompt": bool(task.get("check_prompt")),
        "speed": round(speed, 2),
        "eta_seconds": round(remaining / speed) if speed > 0 else None,
        "source_token": task["source_token"],
        "source_kind": task["source_kind"],
        "source_root": task["source_root"],
        "overview_source_token": task.get("overview_source_token", task["source_token"]),
        "model_id": task["model_id"],
        "engine": task.get("engine", "onnx"),
        "caption_options": (task.get("options") or {}).get("captioning"),
        "logs": list(task["logs"]),
        "error_detail": task.get("error_detail"),
        **({"current_result": task.get("current_result")} if task["engine"] != "api" else {}),
        "updated_at": task["updated_at"],
    }


def task_snapshot(task_id: str) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return {"status": "error", "error_detail": "Task not found / 任务不存在", "logs": []}
    with task["lock"]:
        return _task_snapshot_unlocked(task)


def task_items(task_id: str, offset: int = 0, limit: int = 120, failed_only: bool = False) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        raise KeyError("Task not found / 任务不存在")
    with task["lock"]:
        items = task["items"]
        start = max(0, offset)
        page_size = max(1, min(limit, 500))
        if failed_only:
            indexed = [(idx, item) for idx, item in enumerate(items) if item.get("status") == "failed"]
            total = len(indexed)
            page = indexed[start:start + page_size]
        else:
            total = len(items)
            page = enumerate(items[start:start + page_size], start=start)
        return {
            "total": total,
            "offset": start,
            "items": [
                dict(item, index=index, **({"result": task["results"].get(index)} if task["engine"] != "api" else {}))
                for index, item in page
            ],
        }


def task_check_prompt(task_id: str) -> dict:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        raise KeyError("Task not found / 任务不存在")
    with task["lock"]:
        return {"prompt": task.get("check_prompt", ""), "path": task.get("check_prompt_image", "")}


def _load_local_model(model_id: str, options: dict) -> None:
    interrogator = available_interrogators[model_id]
    with gpu_inference_lock:
        if getattr(interrogator, "model", None) is None:
            if model_id == "pixai-tagger-v1.0":
                interrogator.load(precision=options.get("precision", "auto"))
            else:
                interrogator.load()
        elif model_id == "pixai-tagger-v1.0":
            interrogator._configure_precision(options.get("precision", "auto"))


def _local_tags(model_id: str, image: Image.Image, options: dict, *, full_categories: bool = False) -> tuple[list[str], dict]:
    interrogator = available_interrogators[model_id]
    with gpu_inference_lock:
        if model_id == "pixai-tagger-v1.0":
            raw = interrogator.interrogate(image, precision=options.get("precision", "auto"))
        else:
            raw = interrogator.interrogate(image)
    categories = {
        key: {
            "label": CATEGORY_LABELS.get(key, key),
            "tags": [[name, float(score)] for name, score in (values if full_categories else values[:200])],
            "total": len(values),
            "truncated": not full_categories and len(values) > 200,
        }
        for key, values in raw.items() if values
    }
    spec = MODEL_SPEC_BY_ID[model_id]
    # Explicit global thresholds retain the legacy API semantics. Otherwise
    # clients omitting UI presets still receive the model's recommended defaults.
    explicit_threshold = "threshold" in options or "character_threshold" in options
    category_thresholds = {} if explicit_threshold else dict(spec.threshold_presets.get("macro", {}))
    category_thresholds.update(options.get("category_thresholds") or {})
    category_enabled = dict(options.get("category_enabled") or {})
    for category, enabled in category_enabled.items():
        if enabled is False:
            category_thresholds[str(category)] = 1.01
    threshold_categories = MODEL_SPEC_BY_ID[model_id].threshold_categories
    add_rating_tag = (
        category_enabled.get("rating", True)
        if "rating" in threshold_categories
        else bool(options.get("add_rating_tag", False))
    )
    add_model_tag = MODEL_SPEC_BY_ID[model_id].supports_model_tag and bool(options.get("add_model_tag", False))
    tags = Interrogator.postprocess_tags(
        {key: list(values) for key, values in raw.items()},
        float(options.get("threshold", 0.35)),
        float(options.get("character_threshold", 0.6)),
        category_thresholds,
        add_rating_tag,
        add_model_tag,
        split_str(str(options.get("additional_tags", ""))),
        split_str(str(options.get("exclude_tags", ""))),
        False,
        False,
        bool(options.get("replace_underscore", True)),
        split_str(str(options.get("replace_underscore_excludes", ""))),
        bool(options.get("escape_tag", False)),
    )
    return list(tags), categories


def _existing_caption(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore").strip() if path.is_file() else ""


def _write_caption(path: Path, tags: list[str], conflict: str, remove_duplicated: bool = True,
                   *, cancel_event: threading.Event | None = None) -> str:
    output = path.with_suffix(".txt")
    existing = _existing_caption(output)
    if existing and conflict == "ignore":
        return "skipped"
    generated = ", ".join(tags)
    if existing and conflict == "prepend":
        combined = [part.strip() for part in f"{existing}, {generated}".split(",") if part.strip()]
        if remove_duplicated:
            combined = list(OrderedDict.fromkeys(combined))
        generated = ", ".join(combined)
    output.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(output, generated, cancel_event=cancel_event)
    return "success"


def _caption_one(task: dict, config, path: Path, runtime: dict) -> dict:
    try:
        return captioning.process(config, path, runtime, cancel_event=task["cancel_event"])
    except api_engine.ApiAuthError:
        raise
    except InterruptedError:
        return {"status": "aborted"}
    except Exception as exc:
        if runtime["options"].get("verbose"):
            log.exception("MOSS caption failed / MOSS 描述生成失败")
        return {"status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:2000]}"}


def _run_api_task(task: dict, paths: list[Path], options: dict, config) -> None:
    settings = options["captioning"]
    phase = "caption_check" if settings["dry_run"] else "caption_export" if settings["mode"] == "export" else "api_request"
    with task["lock"]:
        task["started_at"] = time.time()
        task["status"] = "cancelling" if task["cancel_event"].is_set() else "running"
        task["phase"] = phase
    _task_log(task, "api_start" if phase == "api_request" else phase, "phase", total=len(paths), model=config.model,
              endpoint=config.base_url, concurrency=config.concurrency)
    error = ""
    try:
        root = Path(task["source_root"])
        runtime = captioning.prepare_runtime(settings, root)
        with ExitStack() as stack:
            if settings["mode"] == "generate" and not settings["dry_run"]:
                runtime["client"] = stack.enter_context(api_engine.create_client(config))
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=config.concurrency, thread_name_prefix=f"moss-{task['id']}"))
            pending = {}
            source = iter(enumerate(paths))

            def fill_pending():
                while len(pending) < config.concurrency and not task["cancel_event"].is_set():
                    try:
                        index, path = next(source)
                    except StopIteration:
                        break
                    with task["lock"]:
                        task["items"][index]["status"] = "running"
                        task["current_file"] = path.name
                        task["updated_at"] = time.time()
                    pending[pool.submit(_caption_one, task, config, path, runtime)] = index

            fill_pending()
            while pending:
                completed, _ = wait(tuple(pending), timeout=.1, return_when=FIRST_COMPLETED)
                for future in completed:
                    index = pending.pop(future)
                    try:
                        outcome = future.result()
                    except api_engine.ApiAuthError as exc:
                        error = f"API authentication failed / API 鉴权失败: {str(exc)[:500]}"
                        _record_task_item(task, index, {"status": "failed", "error": error})
                        task["cancel_event"].set()
                        continue
                    if outcome["status"] != "aborted":
                        _record_task_item(task, index, outcome)
                fill_pending()
    except Exception as exc:
        log.exception("MOSS task failed / MOSS 任务失败")
        error = str(exc)[:2000]
    finally:
        with task["lock"]:
            cancelled = task["cancel_event"].is_set() or task["current"] < task["total"]
        _finish_task(task, "error" if error else "cancelled" if cancelled else "done", error)


def _start_image_prefetch(paths: list[Path], skip_existing: bool, stop_event: threading.Event) -> tuple[Queue, threading.Thread]:
    pending: Queue = Queue(maxsize=2)

    def _put(value) -> bool:
        while not stop_event.is_set():
            try:
                pending.put(value, timeout=0.1)
                return True
            except Full:
                continue
        return False

    def _producer() -> None:
        for index, path in enumerate(paths):
            if stop_event.is_set():
                break
            try:
                caption = path.with_suffix(".txt")
                existing = _existing_caption(caption) if skip_existing else None
                image = None
                if not existing:
                    with Image.open(path) as opened:
                        alpha = opened.getchannel("A") if "A" in opened.getbands() else None
                        source_has_transparency = bool(alpha and alpha.getextrema()[0] < 128)
                        image = opened.copy()
                        image.info["source_has_transparency"] = source_has_transparency
                        image.load()
                if not _put((index, path, image, None, existing)):
                    return
            except Exception as exc:
                if not _put((index, path, None, exc, None)):
                    return
        _put(None)

    thread = threading.Thread(target=_producer, daemon=True, name="tagger-image-prefetch")
    thread.start()
    return pending, thread


def _run_task(task: dict, paths: list[Path], options: dict, conflict: str, write_captions: bool) -> None:
    def set_phase(phase: str) -> None:
        with task["lock"]:
            if task["cancel_event"].is_set():
                raise InterruptedError("cancelled")
            task["phase"] = phase
            task["updated_at"] = time.time()

    with task["lock"]:
        task["started_at"] = time.time()
        task["status"] = "cancelling" if task["cancel_event"].is_set() else "running"
        task["phase"] = "cancelling" if task["cancel_event"].is_set() else "created"
    spec = None
    prefetch_stop = threading.Event()
    producer = None
    model_ready = False
    first_inference_done = False
    final_status = "done"
    final_error = ""
    try:
        spec = MODEL_SPEC_BY_ID[task["model_id"]]
        _task_log(task, "start", "phase", total=len(paths), model=spec.name)
        pending, producer = _start_image_prefetch(paths, write_captions and conflict == "ignore", prefetch_stop)
        while True:
            prefetched = pending.get()
            if prefetched is None:
                break
            index, path, image, decode_error, existing_text = prefetched
            if task["cancel_event"].is_set():
                if image is not None:
                    image.close()
                final_status = "cancelled"
                break
            if existing_text:
                tags = [part.strip() for part in existing_text.split(",") if part.strip()]
                result = {
                    "index": index,
                    "name": path.name,
                    "path": str(path),
                    "tags": tags,
                    "text": existing_text,
                    "categories": {},
                }
                _record_task_item(task, index, {"status": "skipped", "tag_count": len(tags), "result": result})
                continue
            with task["lock"]:
                task["current_file"] = path.name
                task["items"][index]["status"] = "running"
                task["updated_at"] = time.time()
            writing = False
            try:
                if decode_error:
                    raise decode_error
                if not model_ready:
                    set_phase("loading_model")
                    _task_log(task, "loading", "phase", model=spec.name)
                    started = time.perf_counter()
                    _load_local_model(spec.id, options)
                    set_phase("first_inference")
                    model_ready = True
                    _task_log(task, "ready", model=spec.name, elapsed=f"{time.perf_counter() - started:.1f}")
                    if spec.id == "pixai-tagger-v1.0":
                        label = available_interrogators[spec.id].precision_label
                        _task_log(task, "precision", precision=label, requested=options.get("precision", "auto"))
                set_phase("inference" if first_inference_done else "first_inference")
                started = time.perf_counter()
                if not first_inference_done:
                    _task_log(task, "first_inference", "phase", name=path.name)
                tags, categories = _local_tags(spec.id, image, options, full_categories=not write_captions)
                if task["cancel_event"].is_set():
                    raise InterruptedError("cancelled")
                if not first_inference_done:
                    first_inference_done = True
                    _task_log(task, "first_inference_done", elapsed=f"{time.perf_counter() - started:.1f}")
                result = {
                    "index": index,
                    "name": path.name,
                    "path": str(path),
                    "tags": tags,
                    "text": ", ".join(tags),
                    "categories": categories,
                }
                outcome = "success"
                if write_captions:
                    set_phase("writing")
                    writing = True
                    outcome = _write_caption(
                        path,
                        tags,
                        conflict,
                        bool(options.get("remove_duplicated", False)),
                        cancel_event=task["cancel_event"],
                    )
                _record_task_item(task, index, {"status": outcome, "tag_count": len(tags), "result": result})
            except InterruptedError:
                if not task["cancel_event"].is_set():
                    raise
                final_status = "cancelled"
                break
            except UnidentifiedImageError:
                _record_task_item(task, index, {"status": "failed", "error": "Unsupported image / 不支持的图片"})
            except Exception as exc:
                message = f"{type(exc).__name__}: {str(exc)[:240]}"
                _record_task_item(task, index, {"status": "failed", "error": message})
                if writing and isinstance(exc, OSError):
                    raise RuntimeError(
                        f"Caption write failed / 标签写入失败: {path.with_suffix('.txt')}: {message}"
                    ) from exc
                if "out of memory" in str(exc).lower() or (
                    "cuda" in str(exc).lower() and "memory" in str(exc).lower()
                ):
                    raise RuntimeError(
                        "CUDA out of memory during ONNX inference. Close other GPU applications."
                    ) from exc
            finally:
                if image is not None:
                    image.close()
        if task["cancel_event"].is_set():
            final_status = "cancelled"
    except Exception as exc:
        log.exception("Tagger workspace task failed / 打标工作区任务失败")
        final_status = "error"
        final_error = str(exc)[:500]
    finally:
        prefetch_stop.set()
        if producer is not None:
            producer.join()
        if spec is not None and options.get("unload_model_after"):
            try:
                with gpu_inference_lock:
                    if available_interrogators[task["model_id"]].unload():
                        _task_log(task, "unloaded", model=spec.name)
            except Exception:
                log.exception("Failed to unload tagger model / 打标模型卸载失败")
        _finish_task(task, final_status, final_error)


def create_task(payload: dict) -> str:
    _cleanup()
    engine = str(payload.get("engine") or "onnx")
    if engine not in {"onnx", "pytorch", "api"}:
        raise ValueError("Unknown engine / 未知引擎")
    options = dict(payload.get("options") or {})
    config = None
    if engine == "api":
        options["captioning"] = captioning.validate_options(options.get("captioning") or {})
        config = captioning.validate_config(dict(payload.get("api") or {}), options["captioning"])
        model_id = f"api:{config.model}"
    else:
        if training_active():
            raise RuntimeError("Training or generation is using the GPU / 训练或正则生成任务正在使用 GPU")
        model_id = str(payload.get("model_id") or "")
        if model_id not in MODEL_SPEC_BY_ID:
            raise ValueError("Unknown model / 未知模型")
        engine = MODEL_SPEC_BY_ID[model_id].engine
    if has_active_tagger_task():
        raise RuntimeError("Another Tagger task is running / 已有反推任务正在运行")
    source_token = str(payload.get("source_token") or "")
    conflict = str(payload.get("conflict") or "ignore")
    if conflict not in {"ignore", "copy", "prepend"}:
        raise ValueError("Invalid caption conflict action / 无效的标签冲突策略")
    with _sources_lock:
        source = _sources.get(source_token)
        if not source:
            raise ValueError("Source expired or not found / 输入源已过期或不存在")
    with source["annotation_lock"]:
        paths = list(source["paths"])
        source_kind = source["kind"]
        source_root = source["root"]
        overview_source_token = source.get("overview_source_token", source_token)
        if engine == "api" and source_kind != "folder":
            raise ValueError("MOSS requires an image directory / MOSS 标注请选择图片目录")
        if not paths:
            raise ValueError("No supported images found / 没有找到支持的图片")
        if engine == "api":
            for index in range(len(paths)):
                _source_path(source, index)
            states, _ = _annotation_states(source, options["captioning"])
            captioning.validate_output_targets(paths, options["captioning"], states)
        elif bool(payload.get("write_captions", source_kind == "folder")):
            targets = []
            for path in paths:
                target = captioning.related_file(path, path.with_suffix(".txt"))
                if conflict == "ignore":
                    try:
                        if _existing_caption(target):
                            continue
                    except OSError:
                        pass  # Inference records unreadable captions per image.
                targets.append(target)
            captioning.validate_write_targets(paths, targets)
    if model_id == "pixai-tagger-v1.0":
        from backend.tagger.interrogators.pixai import PixAITaggerInterrogator

        PixAITaggerInterrogator.validate_precision(options.get("precision", "auto"))
    write_captions = not options["captioning"]["dry_run"] if engine == "api" else bool(payload.get("write_captions", source_kind == "folder"))
    task_id = uuid.uuid4().hex[:12]
    task = {
        "id": task_id,
        "status": "created",
        "phase": "created",
        "source_token": source_token,
        "source_kind": source_kind,
        "source_root": source_root,
        "overview_source_token": overview_source_token,
        "model_id": model_id,
        "engine": engine,
        "api_payload": dict(payload.get("api") or {}) if engine == "api" else None,
        "total": len(paths),
        "current": 0,
        "success": 0,
        "skipped": 0,
        "failed": 0,
        "written": 0,
        "reused": 0,
        "checked": 0,
        "plan": {"requests": 0, "reused": 0, "skipped": 0, "writes": 0},
        "current_file": "",
        "items": [{"name": path.name, "path": str(path), "status": "pending"} for path in paths],
        "logs": deque(maxlen=_MAX_LOGS),
        "lock": threading.RLock(),
        "cancel_event": threading.Event(),
        "started_at": 0.0,
        "updated_at": time.time(),
        "error_detail": None,
        "options": options,
        "conflict": conflict,
        "write_captions": write_captions,
        "resource_claim": None,
        "dataset_claim": None,
    }
    if engine != "api":
        task.update(current_result=None, results={})
    with _tasks_lock:
        if _direct_tagger or any(item.get("status") in _ACTIVE_TASK_STATUSES for item in _tasks.values()):
            raise RuntimeError("Another Tagger task is running / 已有反推任务正在运行")
        if has_active_legacy_tagger_task():
            raise RuntimeError("Another Tagger task is running / 已有反推任务正在运行")
        if engine != "api" or write_captions:
            owner = f"tagger:{task_id}"
            if not tm.claim_external(owner):
                raise RuntimeError("Training, tagging or generation task is active / 训练、打标或正则生成任务正在运行")
            task["resource_claim"] = owner
        else:
            owner = f"tagger-reader:{task_id}"
            if not tm.claim_dataset_reader(owner):
                raise RuntimeError("Dataset folders are being renamed / 数据集目录正在重命名")
            task["dataset_claim"] = owner
        _tasks[task_id] = task
    try:
        if engine == "api":
            threading.Thread(
                target=_run_api_task,
                args=(task, paths, options, config),
                daemon=True,
                name=f"tagger-{task_id}",
            ).start()
        else:
            threading.Thread(
                target=_run_task,
                args=(task, paths, options, conflict, write_captions),
                daemon=True,
                name=f"tagger-{task_id}",
            ).start()
    except Exception:
        with _tasks_lock:
            _tasks.pop(task_id, None)
        if task["resource_claim"]:
            tm.release_external(task["resource_claim"])
        if task["dataset_claim"]:
            tm.release_dataset_reader(task["dataset_claim"])
        raise
    return task_id


def retry_failed_task(task_id: str) -> str:
    with _tasks_lock:
        previous = _tasks.get(task_id)
    if not previous:
        raise KeyError("Task not found / 任务不存在")
    with previous["lock"]:
        failed_paths = [
            Path(item["path"])
            for item in previous["items"]
            if item.get("status") == "failed"
        ]
        engine = previous.get("engine", "onnx")
        model_id = previous["model_id"]
        options = dict(previous.get("options") or {})
        conflict = previous.get("conflict", "ignore")
        write_captions = bool(previous.get("write_captions", True))
        api_payload = dict(previous.get("api_payload") or {}) if engine == "api" else None
        source_root = previous["source_root"]
        source_kind = previous["source_kind"]
        overview_source_token = previous.get("overview_source_token", previous["source_token"])
        if previous["status"] in _ACTIVE_TASK_STATUSES:
            raise ValueError("Wait for the task to finish / 请等待任务结束后重试")
    if not failed_paths:
        raise ValueError("No failed items to retry / 没有可重试的失败项")
    token = uuid.uuid4().hex[:16]
    with _sources_lock:
        _sources[token] = {
            "token": token,
            "root": source_root,
            "kind": source_kind,
            "recursive": True,
            "paths": failed_paths,
            "created_at": time.time(),
            "subset": True,
            "overview_source_token": overview_source_token,
            "caption_options": captioning.output_options(options.get("captioning"), (options.get("captioning") or {}).get("caption_extension", ".txt")),
            "annotation_lock": threading.RLock(),
            "annotation_cache": {},
        }
    payload: dict[str, Any] = {
        "source_token": token,
        "options": options,
        "conflict": conflict,
        "write_captions": write_captions,
    }
    if engine == "api":
        payload["engine"] = "api"
        payload["api"] = api_payload
    else:
        payload["model_id"] = model_id
    return create_task(payload)


def cancel_task(task_id: str) -> bool:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return False
    with task["lock"]:
        if task["status"] in {"created", "running"}:
            task["status"] = "cancelling"
            task["phase"] = "cancelling"
            task["updated_at"] = time.time()
        task["cancel_event"].set()
    return True


def latest_active_task_id() -> str | None:
    with _tasks_lock:
        active = [task for task in _tasks.values() if task["status"] in _ACTIVE_TASK_STATUSES]
    if not active:
        return None
    return max(active, key=lambda task: task["updated_at"])["id"]
