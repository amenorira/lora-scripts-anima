"""Unified Tagger workspace tasks, source scanning, thumbnails, and captions."""
from __future__ import annotations

import os
import tempfile
import threading
import time
import uuid
from collections import OrderedDict, deque
from pathlib import Path
from queue import Full, Queue
from typing import Any

from PIL import Image, UnidentifiedImageError

from backend.log import log
from backend.tagger.interrogator import (
    available_interrogators,
    gpu_inference_lock,
    has_active_legacy_tagger_task,
    split_str,
)
from backend.tagger.interrogators.base import CATEGORY_LABELS, Interrogator
from backend.tagger.registry import MODEL_SPEC_BY_ID
from backend.tasks import tm

_IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif",
}
_SOURCE_TTL = 3600
_TASK_TTL = 3600
_MAX_LOGS = 200
_MAX_RECENT_ITEMS = 120

_sources: dict[str, dict[str, Any]] = {}
_sources_lock = threading.Lock()
_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = threading.Lock()


def _is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS


def _cleanup() -> None:
    now = time.time()
    with _tasks_lock:
        retained_tokens = {task["source_token"] for task in _tasks.values()}
    with _sources_lock:
        for token, source in list(_sources.items()):
            if token not in retained_tokens and now - source.get("created_at", now) > _SOURCE_TTL:
                _sources.pop(token, None)
    with _tasks_lock:
        for task_id, task in list(_tasks.items()):
            if task.get("status") in {"done", "cancelled", "error"} and now - task.get("updated_at", now) > _TASK_TTL:
                _tasks.pop(task_id, None)


def _enumerate_images(path: Path, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path] if _is_image(path) else []
    iterator = path.rglob("*") if recursive else path.iterdir()
    return sorted((item for item in iterator if _is_image(item)), key=lambda item: str(item).lower())


def scan_source(path_value: str, recursive: bool = True) -> dict:
    _cleanup()
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        raise ValueError("Source does not exist / 输入路径不存在")
    if path == Path(path.anchor):
        raise ValueError("Filesystem root is not allowed / 不允许选择磁盘根目录")
    images = _enumerate_images(path, recursive)
    token = uuid.uuid4().hex[:16]
    caption_count = sum(1 for image in images if image.with_suffix(".txt").is_file())
    directories = len({image.parent for image in images})
    source = {
        "token": token,
        "root": str(path),
        "kind": "file" if path.is_file() else "folder",
        "recursive": recursive,
        "paths": images,
        "created_at": time.time(),
    }
    with _sources_lock:
        _sources[token] = source
    return {
        "source_token": token,
        "path": str(path),
        "kind": source["kind"],
        "total": len(images),
        "directories": directories,
        "with_caption": caption_count,
        "without_caption": len(images) - caption_count,
        "items": [
            {"index": index, "name": image.name, "path": str(image), "has_caption": image.with_suffix(".txt").is_file()}
            for index, image in enumerate(images[:_MAX_RECENT_ITEMS])
        ],
        "items_truncated": len(images) > _MAX_RECENT_ITEMS,
    }


def register_upload(path: Path) -> dict:
    result = scan_source(str(path), recursive=False)
    result["kind"] = "upload"
    with _sources_lock:
        if result["source_token"] in _sources:
            _sources[result["source_token"]]["kind"] = "upload"
    return result


def source_item(source_token: str, index: int) -> Path:
    with _sources_lock:
        source = _sources.get(source_token)
        if not source:
            raise KeyError("Source expired or not found / 输入源已过期或不存在")
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
                "has_caption": path.with_suffix(".txt").is_file(),
                "status": "pending",
            }
            for index, path in enumerate(page)
        ],
    }


def training_active() -> bool:
    return any(task.get("status") in {"CREATED", "RUNNING"} for task in tm.dump())


def has_active_tagger_task() -> bool:
    with _tasks_lock:
        active = any(task.get("status") in {"created", "running"} for task in _tasks.values())
    return active or has_active_legacy_tagger_task()


def _task_log(task: dict, message: str) -> None:
    with task["lock"]:
        task["logs"].append(f"[{time.strftime('%H:%M:%S')}] {message}")
        task["updated_at"] = time.time()


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
        "speed": round(speed, 2),
        "eta_seconds": round(remaining / speed) if speed > 0 else None,
        "source_token": task["source_token"],
        "source_kind": task["source_kind"],
        "source_root": task["source_root"],
        "model_id": task["model_id"],
        "logs": list(task["logs"]),
        "error_detail": task.get("error_detail"),
        "current_result": task.get("current_result"),
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
        if failed_only:
            indexed = [(idx, item) for idx, item in enumerate(items) if item.get("status") == "failed"]
        else:
            indexed = list(enumerate(items))
        page = indexed[max(0, offset):max(0, offset) + max(1, min(limit, 500))]
        return {
            "total": len(indexed),
            "offset": max(0, offset),
            "items": [
                dict(item, index=index, result=task["results"].get(index))
                for index, item in page
            ],
        }


def _onnx_tags(model_id: str, image: Image.Image, options: dict) -> tuple[list[str], dict]:
    interrogator = available_interrogators[model_id]
    with gpu_inference_lock:
        raw = interrogator.interrogate(image)
    categories = {
        key: {
            "label": CATEGORY_LABELS.get(key, key),
            "tags": [[name, round(float(score), 4)] for name, score in values[:200]],
            "total": len(values),
            "truncated": len(values) > 200,
        }
        for key, values in raw.items() if values
    }
    category_thresholds = dict(options.get("category_thresholds") or {})
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
        bool(options.get("escape_tag", True)),
    )
    return list(tags), categories


def _write_caption(path: Path, tags: list[str], conflict: str, remove_duplicated: bool = True) -> str:
    output = path.with_suffix(".txt")
    existing = output.read_text(encoding="utf-8", errors="ignore").strip() if output.is_file() else ""
    if existing and conflict == "ignore":
        return "skipped"
    generated = ", ".join(tags)
    if existing and conflict == "prepend":
        combined = [part.strip() for part in f"{existing}, {generated}".split(",") if part.strip()]
        if remove_duplicated:
            combined = list(OrderedDict.fromkeys(combined))
        generated = ", ".join(combined)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=str(output.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(generated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return "success"


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
                existing = caption.read_text(encoding="utf-8", errors="ignore").strip() if skip_existing and caption.is_file() else None
                image = None
                if not existing:
                    with Image.open(path) as opened:
                        alpha = opened.getchannel("A") if "A" in opened.getbands() else None
                        source_has_transparency = bool(alpha and alpha.getextrema()[0] < 128)
                        image = opened.convert("RGB")
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
    task["started_at"] = time.time()
    task["status"] = "running"
    task["phase"] = "created"
    spec = MODEL_SPEC_BY_ID[task["model_id"]]
    _task_log(task, f"Task started: {len(paths)} images; model: {spec.name}")
    prefetch_stop = threading.Event()
    pending, producer = _start_image_prefetch(paths, write_captions and conflict == "ignore", prefetch_stop)
    model_ready = False
    try:
        while True:
            prefetched = pending.get()
            if prefetched is None:
                break
            index, path, image, decode_error, existing_text = prefetched
            if task["cancel_event"].is_set():
                if image is not None:
                    image.close()
                task["status"] = "cancelled"
                task["phase"] = "cancelled"
                _task_log(task, "Task cancelled by user")
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
                with task["lock"]:
                    task["skipped"] += 1
                    task["current"] = index + 1
                    task["items"][index].update({"status": "skipped", "tag_count": len(tags)})
                    task["current_result"] = result
                    task["results"][index] = result
                    task["updated_at"] = time.time()
                _task_log(task, f"[{index + 1}/{len(paths)}] {path.name}: existing caption skipped")
                continue
            with task["lock"]:
                task["phase"] = "inference" if model_ready else "loading_model"
                task["current_file"] = path.name
                task["items"][index]["status"] = "running"
                task["updated_at"] = time.time()
            try:
                if decode_error:
                    raise decode_error
                if not model_ready:
                    _task_log(task, f"Loading model: {spec.name}")
                tags, categories = _onnx_tags(spec.id, image, options)
                if not model_ready:
                    model_ready = True
                    _task_log(task, f"Model ready: {spec.name}")
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
                    with task["lock"]:
                        task["phase"] = "writing"
                    outcome = _write_caption(
                        path,
                        tags,
                        conflict,
                        bool(options.get("remove_duplicated", False)),
                    )
                with task["lock"]:
                    task[outcome] += 1
                    task["items"][index].update({"status": outcome, "tag_count": len(tags)})
                    task["current_result"] = result
                    task["results"][index] = result
                _task_log(task, f"[{index + 1}/{len(paths)}] {path.name}: {len(tags)} tags ({outcome})")
            except UnidentifiedImageError:
                with task["lock"]:
                    task["failed"] += 1
                    task["items"][index].update({"status": "failed", "error": "Unsupported image"})
                _task_log(task, f"Unsupported image: {path.name}")
            except Exception as exc:
                message = f"{type(exc).__name__}: {str(exc)[:240]}"
                with task["lock"]:
                    task["failed"] += 1
                    task["items"][index].update({"status": "failed", "error": message})
                _task_log(task, f"Failed {path.name}: {message}")
                if "out of memory" in str(exc).lower() or (
                    "cuda" in str(exc).lower() and "memory" in str(exc).lower()
                ):
                    raise RuntimeError(
                        "CUDA out of memory during ONNX inference. Close other GPU applications."
                    ) from exc
            finally:
                if image is not None:
                    image.close()
                with task["lock"]:
                    task["current"] = index + 1
                    task["updated_at"] = time.time()
        if task["status"] == "running":
            task["status"] = "done"
            task["phase"] = "completed"
            elapsed = max(0.0, time.time() - task["started_at"])
            _task_log(
                task,
                f"Task completed in {elapsed:.1f}s: {task['success']} succeeded, "
                f"{task['skipped']} skipped, {task['failed']} failed",
            )
    except Exception as exc:
        log.exception("Tagger workspace task failed")
        with task["lock"]:
            task["status"] = "error"
            task["phase"] = "error"
            task["error_detail"] = str(exc)[:500]
        _task_log(task, f"Task failed: {str(exc)[:500]}")
    finally:
        prefetch_stop.set()
        producer.join(timeout=1)
        task["updated_at"] = time.time()


def create_task(payload: dict) -> str:
    _cleanup()
    if training_active():
        raise RuntimeError("Training is using the GPU / 训练任务正在使用 GPU")
    if has_active_tagger_task():
        raise RuntimeError("Another Tagger task is running / 已有反推任务正在运行")
    model_id = str(payload.get("model_id") or "")
    if model_id not in MODEL_SPEC_BY_ID:
        raise ValueError("Unknown model / 未知模型")
    source_token = str(payload.get("source_token") or "")
    with _sources_lock:
        source = _sources.get(source_token)
        if not source:
            raise ValueError("Source expired or not found / 输入源已过期或不存在")
        paths = list(source["paths"])
        source_kind = source["kind"]
        source_root = source["root"]
    if not paths:
        raise ValueError("No supported images found / 没有找到支持的图片")
    conflict = str(payload.get("conflict") or "ignore")
    if conflict not in {"ignore", "copy", "prepend"}:
        raise ValueError("Invalid caption conflict action / 无效的标签冲突策略")
    options = dict(payload.get("options") or {})
    write_captions = bool(payload.get("write_captions", source_kind == "folder"))
    task_id = uuid.uuid4().hex[:12]
    task = {
        "id": task_id,
        "status": "created",
        "phase": "created",
        "source_token": source_token,
        "source_kind": source_kind,
        "source_root": source_root,
        "model_id": model_id,
        "total": len(paths),
        "current": 0,
        "success": 0,
        "skipped": 0,
        "failed": 0,
        "current_file": "",
        "current_result": None,
        "results": {},
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
    }
    with _tasks_lock:
        _tasks[task_id] = task
    threading.Thread(
        target=_run_task,
        args=(task, paths, options, conflict, write_captions),
        daemon=True,
        name=f"tagger-{task_id}",
    ).start()
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
        model_id = previous["model_id"]
        options = dict(previous.get("options") or {})
        conflict = previous.get("conflict", "ignore")
        write_captions = bool(previous.get("write_captions", True))
    if not failed_paths:
        raise ValueError("No failed items to retry / 没有可重试的失败项")
    token = uuid.uuid4().hex[:16]
    with _sources_lock:
        _sources[token] = {
            "token": token,
            "root": str(failed_paths[0].parent),
            "kind": "folder",
            "recursive": True,
            "paths": failed_paths,
            "created_at": time.time(),
        }
    return create_task({
        "source_token": token,
        "model_id": model_id,
        "options": options,
        "conflict": conflict,
        "write_captions": write_captions,
    })


def cancel_task(task_id: str) -> bool:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        return False
    task["cancel_event"].set()
    return True


def latest_active_task_id() -> str | None:
    with _tasks_lock:
        active = [task for task in _tasks.values() if task["status"] in {"created", "running"}]
    if not active:
        return None
    return max(active, key=lambda task: task["updated_at"])["id"]
