"""Dataset-scoped, paginated Tag Editor sessions."""
from __future__ import annotations

import hashlib
import os
import re
import threading
import time
import uuid
from collections import Counter, OrderedDict
from dataclasses import dataclass, field, replace
from pathlib import Path

from backend.tageditor.core import (
    build_image_entry, cache_dataset_scan, dataset_disk_state, get_cached_scan_dataset, resolve_dir, tag_list,
)
from backend.image_preview import build_image_preview_url


@dataclass(frozen=True)
class DatasetSession:
    id: str
    directory: Path
    recursive: bool
    generation: int
    revision: str
    images: tuple[dict, ...]
    image_by_rel_path: dict[str, dict]
    tags: tuple[dict, ...]
    created_at: float
    accessed_at: float
    image_paths: frozenset[str]
    caption_metadata: dict[str, tuple[int, int]]
    changed_images: tuple[dict, ...] = ()
    removed_paths: tuple[str, ...] = ()
    queries: OrderedDict = field(default_factory=OrderedDict, compare=False, repr=False)


def _image_index(images: tuple[dict, ...]) -> dict[str, dict]:
    return {
        str(item.get("rel_path", "")).replace("\\", "/"): item
        for item in images
    }


def session_image_payload(session_id: str, item: dict) -> dict:
    rel_path = item["rel_path"]
    version = str(item.get("modified_ns", ""))
    return {
        **item,
        "thumbnail": build_image_preview_url(
            scope="dataset", session_id=session_id, path=rel_path, variant="thumb", size=320, version=version,
        ),
        "preview": build_image_preview_url(
            scope="dataset", session_id=session_id, path=rel_path, variant="preview", size=960, version=version,
        ),
    }


def _dataset_revision(images: tuple[dict, ...]) -> str:
    digest = hashlib.sha1()
    for item in images:
        digest.update(str(item.get("rel_path", "")).encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(str(item.get("caption_revision", "missing")).encode("ascii", errors="ignore"))
        digest.update(b"\0")
    return digest.hexdigest()


def _caption_stem(path: str) -> str:
    return os.path.normcase(path.rpartition(".")[0])


def _refresh_changed_images(
    old: DatasetSession, image_paths: set[str], caption_metadata: dict[str, tuple[int, int]],
) -> tuple[list[dict], list[dict]]:
    changed_stems = {
        _caption_stem(path) for path, metadata in caption_metadata.items()
        if metadata != old.caption_metadata.get(path)
    }
    changed_stems.update(_caption_stem(path) for path in old.caption_metadata.keys() - caption_metadata.keys())
    added_paths = image_paths - old.image_paths
    removed_paths = old.image_paths - image_paths
    affected_paths = added_paths.copy()
    if changed_stems:
        affected_paths.update(path for path in image_paths if _caption_stem(path) in changed_stems)

    updates = {path: build_image_entry(Path(path), old.directory) for path in sorted(affected_paths)}
    counts = Counter({item["tag"]: item["count"] for item in old.tags})
    images = []
    for item in old.images:
        path = item["path"]
        if path in removed_paths:
            counts.subtract(tag_list(item["tags"]))
            continue
        replacement = updates.pop(path, item)
        if replacement["tags"] != item["tags"]:
            counts.subtract(tag_list(item["tags"]))
            counts.update(tag_list(replacement["tags"]))
        images.append(replacement)
    for item in updates.values():
        counts.update(tag_list(item["tags"]))
        images.append(item)
    if updates:
        images.sort(key=lambda item: item["name"])
    tags = [{"tag": tag, "count": count} for tag, count in counts.most_common() if count > 0]
    return images, tags


class DatasetDirectoryError(ValueError):
    def __init__(self, directory: str):
        super().__init__(f"Directory does not exist or is not a directory / 目录不存在或不是目录: {directory}")
        self.directory = directory


class DatasetSessionService:
    def __init__(self, max_sessions: int = 12, ttl_seconds: int = 1800):
        self.max_sessions = max_sessions
        self.ttl_seconds = ttl_seconds
        self._sessions: dict[str, DatasetSession] = {}
        self._lock = threading.RLock()

    def create(self, directory: str, recursive: bool = True) -> DatasetSession:
        path = resolve_dir(directory)
        if not path.exists() or not path.is_dir():
            raise DatasetDirectoryError(directory)
        _, caption_metadata = dataset_disk_state(path, recursive)
        # A new editor session must see caption writes made outside the editor.
        images, tags = get_cached_scan_dataset(path, recursive, force_refresh=True)
        image_snapshot = tuple(dict(item) for item in images)
        now = time.time()
        session = DatasetSession(
            id=uuid.uuid4().hex,
            directory=path,
            recursive=recursive,
            generation=1,
            revision=_dataset_revision(image_snapshot),
            images=image_snapshot,
            image_by_rel_path=_image_index(image_snapshot),
            tags=tuple(dict(item) for item in tags),
            created_at=now,
            accessed_at=now,
            image_paths=frozenset(item["path"] for item in image_snapshot),
            caption_metadata=caption_metadata,
        )
        with self._lock:
            self._prune_locked(now)
            self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> DatasetSession:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or time.time() - session.accessed_at > self.ttl_seconds:
                self._sessions.pop(session_id, None)
                raise KeyError(session_id)
            refreshed = replace(session, accessed_at=time.time())
            self._sessions[session_id] = refreshed
            return refreshed

    def refresh(self, session_id: str, *, since_generation: int | None = None) -> DatasetSession | None:
        old = self.get(session_id)
        if since_generation is not None and since_generation != old.generation:
            # Keep the last update available until the browser acknowledges it.
            if since_generation == old.generation - 1:
                return old
            raise KeyError(session_id)
        started_at = time.time()
        image_paths, caption_metadata = dataset_disk_state(old.directory, old.recursive)
        if since_generation is None:
            images, tags = get_cached_scan_dataset(old.directory, old.recursive, force_refresh=True)
        else:
            if image_paths == old.image_paths and caption_metadata == old.caption_metadata:
                return None
            images, tags = _refresh_changed_images(old, image_paths, caption_metadata)
        image_snapshot = tuple(images)
        image_index = _image_index(image_snapshot)
        changed_images = tuple(item for path, item in image_index.items() if item != old.image_by_rel_path.get(path))
        removed_paths = tuple(item["path"] for path, item in old.image_by_rel_path.items() if path not in image_index)
        unchanged = since_generation is not None and not (changed_images or removed_paths)
        now = time.time()
        refreshed = DatasetSession(
            id=old.id,
            directory=old.directory,
            recursive=old.recursive,
            generation=old.generation + 1,
            revision=_dataset_revision(image_snapshot),
            images=image_snapshot,
            image_by_rel_path=image_index,
            tags=tuple(dict(item) for item in tags),
            created_at=old.created_at,
            accessed_at=now,
            image_paths=frozenset(item["path"] for item in image_snapshot),
            caption_metadata=caption_metadata,
            changed_images=changed_images,
            removed_paths=removed_paths,
        )
        with self._lock:
            current = self._sessions.get(session_id)
            if current is None:
                raise KeyError(session_id)
            if current.generation != old.generation:
                return current
            if unchanged:
                self._sessions[session_id] = replace(current, caption_metadata=caption_metadata, accessed_at=now)
                return None
            self._sessions[session_id] = refreshed
            if since_generation is not None:
                cache_dataset_scan(old.directory, old.recursive, (images, tags), started_at)
        return refreshed

    def delete(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def invalidate_dataset(self, directory: Path) -> None:
        root = directory.resolve()
        with self._lock:
            stale = [sid for sid, session in self._sessions.items() if session.directory == root]
            for sid in stale:
                self._sessions.pop(sid, None)

    def page(self, session_id: str, *, page: int = 1, page_size: int = 60,
             search: str = "", use_regex: bool = False, quick_filter: str = "all",
             include_tags: tuple[str, ...] = (), exclude_tags: tuple[str, ...] = (),
             tag_logic: str = "AND", sort_by: str = "name", sort_asc: bool = True,
             sort_by2: str = "", sort_asc2: bool = True, group_by_dir: bool = False,
             caption_overrides: dict[str, str] | None = None) -> dict:
        session = self.get(session_id)
        query = (search, use_regex, quick_filter, tuple(include_tags), tuple(exclude_tags),
                 tag_logic, sort_by, sort_asc, sort_by2, sort_asc2, group_by_dir)
        items = None
        if caption_overrides:
            # 请求内的工作正文只参与查询，不修改扫描基线、修订号或共享查询缓存。
            working = replace(session, images=tuple(
                {**item, "tags": caption_overrides[item["path"]]} if item["path"] in caption_overrides else item
                for item in session.images
            ))
            items = self._filter_images(working, *query)
        else:
            with self._lock:
                items = session.queries.get(query)
                if items is not None:
                    session.queries.move_to_end(query)
        if items is None:
            items = self._filter_images(session, *query)
            with self._lock:
                session.queries[query] = items
                session.queries.move_to_end(query)
                while len(session.queries) > 4:
                    session.queries.popitem(last=False)
        total = len(items)
        page_size = max(30, min(page_size, 240))
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = max(1, min(page, total_pages))
        start = (page - 1) * page_size
        directory_counts = {}
        if group_by_dir:
            for item in items:
                directory = str(item.get("rel_path", item.get("name", ""))).replace("\\", "/").rpartition("/")[0]
                directory_counts[directory] = directory_counts.get(directory, 0) + 1
        return {
            "items": [session_image_payload(session_id, item) for item in items[start:start + page_size]],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
            "directory_counts": directory_counts,
            "generation": session.generation,
            "revision": session.revision,
        }

    @staticmethod
    def _filter_images(session, search, use_regex, quick_filter, include_tags,
                       exclude_tags, tag_logic, sort_by, sort_asc, sort_by2, sort_asc2,
                       group_by_dir=False):
        items = list(session.images)
        if quick_filter == "notag":
            items = [item for item in items if not str(item.get("tags", "")).lstrip("\ufeff").strip()]
        if search:
            if use_regex:
                try:
                    pattern = re.compile(search, re.IGNORECASE)
                except re.error as exc:
                    raise ValueError(str(exc)) from exc
                items = [item for item in items if pattern.search(str(item.get("rel_path", item.get("name", "")))) or pattern.search(str(item.get("tags", "")))]
            else:
                needle = search.lower()
                items = [item for item in items if needle in str(item.get("rel_path", item.get("name", ""))).lower() or needle in str(item.get("tags", "")).lower()]
        wanted = tuple(tag.lower() for tag in include_tags if tag)
        excluded = tuple(tag.lower() for tag in exclude_tags if tag)
        if wanted or excluded:
            filtered = []
            for item in items:
                values = set(tag_list(str(item.get("tags", "")).lower()))
                include_ok = not wanted or (all(tag in values for tag in wanted) if tag_logic == "AND" else any(tag in values for tag in wanted))
                exclude_ok = not excluded or all(tag not in values for tag in excluded)
                if include_ok and exclude_ok:
                    filtered.append(item)
            items = filtered

        def sort_value(item: dict, field: str):
            if field == "tagCount":
                return len(tag_list(str(item.get("tags", ""))))
            if field == "modified":
                return int(item.get("modified_ns", 0))
            return str(item.get("rel_path", item.get("name", ""))).lower()

        # 稳定排序：唯一路径只作为最后的平局规则，不能覆盖二级排序。
        items.sort(key=lambda item: str(item.get("path", "")))
        if sort_by2:
            items.sort(key=lambda item: sort_value(item, sort_by2), reverse=not sort_asc2)
        items.sort(key=lambda item: sort_value(item, sort_by), reverse=not sort_asc)
        if group_by_dir:
            # 分页前归组；稳定排序保留每个目录内的主、次排序。
            items.sort(key=lambda item: str(item.get("rel_path", item.get("name", ""))).replace("\\", "/").rpartition("/")[0])
        return tuple(items)

    def _prune_locked(self, now: float) -> None:
        expired = [sid for sid, session in self._sessions.items() if now - session.accessed_at > self.ttl_seconds]
        for sid in expired:
            self._sessions.pop(sid, None)
        if len(self._sessions) < self.max_sessions:
            return
        oldest = sorted(self._sessions.values(), key=lambda item: item.accessed_at)
        for session in oldest[:len(self._sessions) - self.max_sessions + 1]:
            self._sessions.pop(session.id, None)


dataset_sessions = DatasetSessionService()
