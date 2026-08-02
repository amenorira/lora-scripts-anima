"""Dataset-scoped, paginated Tag Editor sessions."""
from __future__ import annotations

import hashlib
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from backend.tageditor.core import get_cached_scan_dataset, resolve_dir, tag_list


@dataclass(frozen=True)
class DatasetSession:
    id: str
    directory: Path
    recursive: bool
    generation: int
    revision: str
    images: tuple[dict, ...]
    tags: tuple[dict, ...]
    created_at: float
    accessed_at: float


def _dataset_revision(images: tuple[dict, ...]) -> str:
    digest = hashlib.sha1()
    for item in images:
        digest.update(str(item.get("rel_path", "")).encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(str(item.get("caption_revision", "missing")).encode("ascii", errors="ignore"))
        digest.update(b"\0")
    return digest.hexdigest()


class DatasetSessionService:
    def __init__(self, max_sessions: int = 12, ttl_seconds: int = 1800):
        self.max_sessions = max_sessions
        self.ttl_seconds = ttl_seconds
        self._sessions: dict[str, DatasetSession] = {}
        self._lock = threading.RLock()

    def create(self, directory: str, recursive: bool = True) -> DatasetSession:
        path = resolve_dir(directory)
        if not path.exists() or not path.is_dir():
            raise ValueError(f"目录不存在或不是目录: {directory}")
        images, tags = get_cached_scan_dataset(path, recursive)
        image_snapshot = tuple(dict(item) for item in images)
        now = time.time()
        session = DatasetSession(
            id=uuid.uuid4().hex,
            directory=path,
            recursive=recursive,
            generation=1,
            revision=_dataset_revision(image_snapshot),
            images=image_snapshot,
            tags=tuple(dict(item) for item in tags),
            created_at=now,
            accessed_at=now,
        )
        with self._lock:
            self._prune_locked(now)
            self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> DatasetSession:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise KeyError(session_id)
            refreshed = DatasetSession(**{**session.__dict__, "accessed_at": time.time()})
            self._sessions[session_id] = refreshed
            return refreshed

    def refresh(self, session_id: str) -> DatasetSession:
        old = self.get(session_id)
        from backend.tageditor.core import _invalidate_cache

        _invalidate_cache(old.directory, old.recursive)
        images, tags = get_cached_scan_dataset(old.directory, old.recursive)
        image_snapshot = tuple(dict(item) for item in images)
        now = time.time()
        refreshed = DatasetSession(
            id=old.id,
            directory=old.directory,
            recursive=old.recursive,
            generation=old.generation + 1,
            revision=_dataset_revision(image_snapshot),
            images=image_snapshot,
            tags=tuple(dict(item) for item in tags),
            created_at=old.created_at,
            accessed_at=now,
        )
        with self._lock:
            self._sessions[session_id] = refreshed
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
             sort_by2: str = "", sort_asc2: bool = True) -> dict:
        session = self.get(session_id)
        items = list(session.images)
        if quick_filter == "notag":
            items = [item for item in items if not str(item.get("tags", "")).strip()]
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

        if sort_by2:
            items.sort(key=lambda item: (sort_value(item, sort_by2), str(item.get("path", ""))), reverse=not sort_asc2)
        items.sort(key=lambda item: (sort_value(item, sort_by), str(item.get("path", ""))), reverse=not sort_asc)
        total = len(items)
        page_size = max(30, min(page_size, 240))
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = max(1, min(page, total_pages))
        start = (page - 1) * page_size
        return {
            "items": items[start:start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
            "generation": session.generation,
            "revision": session.revision,
        }

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
