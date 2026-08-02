"""Durable incremental history for Tag Editor caption transactions."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from backend.constants import CACHE_DIR


TIMELINE_DB = CACHE_DIR / "tageditor" / "timeline.sqlite3"


class TimelineStore:
    def __init__(self, db_path: Path = TIMELINE_DB):
        self.db_path = db_path
        self._init_lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        self._ensure_schema()
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.db_path, timeout=30)
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS timeline_events (
                        id TEXT PRIMARY KEY,
                        dataset_key TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        event_type TEXT NOT NULL,
                        label TEXT NOT NULL,
                        status TEXT NOT NULL,
                        metadata TEXT NOT NULL DEFAULT '{}'
                    );
                    CREATE TABLE IF NOT EXISTS timeline_changes (
                        event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
                        seq INTEGER NOT NULL,
                        rel_path TEXT NOT NULL,
                        before_text TEXT,
                        after_text TEXT,
                        before_exists INTEGER NOT NULL,
                        after_exists INTEGER NOT NULL,
                        PRIMARY KEY(event_id, seq)
                    );
                    CREATE INDEX IF NOT EXISTS idx_timeline_dataset_time
                    ON timeline_events(dataset_key, created_at DESC);
                    """
                )
                conn.commit()
            finally:
                conn.close()
            self._initialized = True

    def record(self, dataset_dir: Path, changes: list[dict], *, event_type: str = "save",
               label: str = "", metadata: dict | None = None) -> dict | None:
        if not changes:
            return None
        event_id = uuid.uuid4().hex
        created_at = time.time()
        dataset_key = str(dataset_dir.resolve())
        conn = self._connect()
        try:
            with conn:
                conn.execute(
                    "INSERT INTO timeline_events(id,dataset_key,created_at,event_type,label,status,metadata) VALUES(?,?,?,?,?,?,?)",
                    (event_id, dataset_key, created_at, event_type, label or event_type, "committed", json.dumps(metadata or {}, ensure_ascii=False)),
                )
                conn.executemany(
                    "INSERT INTO timeline_changes(event_id,seq,rel_path,before_text,after_text,before_exists,after_exists) VALUES(?,?,?,?,?,?,?)",
                    [
                        (event_id, index, change["rel_path"], change.get("before_text"), change.get("after_text"),
                         int(change.get("before_exists", False)), int(change.get("after_exists", True)))
                        for index, change in enumerate(changes)
                    ],
                )
        finally:
            conn.close()
        return {"id": event_id, "timestamp": created_at, "file_count": len(changes), "event_type": event_type, "label": label or event_type}

    def list(self, dataset_dir: Path, limit: int = 100, before: float | None = None) -> list[dict]:
        dataset_key = str(dataset_dir.resolve())
        conn = self._connect()
        try:
            params: list[object] = [dataset_key]
            where = "dataset_key=?"
            if before is not None:
                where += " AND created_at<?"
                params.append(before)
            params.append(max(1, min(limit, 500)))
            rows = conn.execute(
                f"SELECT e.*, COUNT(c.seq) AS file_count FROM timeline_events e LEFT JOIN timeline_changes c ON c.event_id=e.id WHERE {where} GROUP BY e.id ORDER BY e.created_at DESC LIMIT ?",
                params,
            ).fetchall()
            return [
                {"id": row["id"], "timestamp": row["created_at"], "file_count": row["file_count"],
                 "event_type": row["event_type"], "label": row["label"], "status": row["status"],
                 "metadata": json.loads(row["metadata"] or "{}")}
                for row in rows
            ]
        finally:
            conn.close()

    def changes_for(self, event_id: str, dataset_dir: Path) -> list[dict]:
        conn = self._connect()
        try:
            row = conn.execute("SELECT id FROM timeline_events WHERE id=? AND dataset_key=?", (event_id, str(dataset_dir.resolve()))).fetchone()
            if row is None:
                raise KeyError(event_id)
            changes = conn.execute("SELECT * FROM timeline_changes WHERE event_id=? ORDER BY seq", (event_id,)).fetchall()
            return [dict(change) for change in changes]
        finally:
            conn.close()

    def delete(self, event_id: str, dataset_dir: Path) -> bool:
        conn = self._connect()
        try:
            with conn:
                cur = conn.execute("DELETE FROM timeline_events WHERE id=? AND dataset_key=?", (event_id, str(dataset_dir.resolve())))
            return cur.rowcount > 0
        finally:
            conn.close()

    def clear(self, dataset_dir: Path) -> int:
        conn = self._connect()
        try:
            with conn:
                cur = conn.execute("DELETE FROM timeline_events WHERE dataset_key=?", (str(dataset_dir.resolve()),))
            return cur.rowcount
        finally:
            conn.close()


timeline_store = TimelineStore()
