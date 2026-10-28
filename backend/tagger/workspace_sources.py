"""Tagger source scanning and read-only annotation browsing."""
from __future__ import annotations

import os
import threading
import time
import uuid
from pathlib import Path

from backend.tagger import captioning
from backend.tagger.workspace_state import (
    _IMAGE_EXTENSIONS, _MAX_RECENT_ITEMS, _sources, _sources_lock,
    _tasks, _tasks_lock, _cleanup,
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
