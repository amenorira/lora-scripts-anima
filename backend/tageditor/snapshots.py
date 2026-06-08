"""
Tag Editor — 还原点快照系统
"""
from __future__ import annotations

import json
import os
import time
import zipfile
from pathlib import Path
from typing import Optional


SNAPSHOT_DIR_NAME = ".snapshots"
CAPTION_EXTS = {".txt", ".caption"}


def _snapshot_dir(dataset_dir: str) -> Path:
    return Path(dataset_dir) / SNAPSHOT_DIR_NAME


def create_snapshot(dataset_dir: str) -> dict:
    src = Path(dataset_dir)
    snap_dir = _snapshot_dir(dataset_dir)
    snap_dir.mkdir(parents=True, exist_ok=True)

    ts = int(time.time())
    ts_str = str(ts)
    zip_path = snap_dir / f"{ts_str}.zip"
    meta_path = snap_dir / f"{ts_str}.json"

    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.iterdir()):
            if f.is_file() and f.suffix.lower() in CAPTION_EXTS:
                zf.write(f, f.name)
                file_count += 1
            if f.is_file() and f.suffix.lower() == ".bak":
                zf.write(f, f.name)

    size_bytes = zip_path.stat().st_size
    meta = {"timestamp": ts, "file_count": file_count, "size_bytes": size_bytes}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return {"id": ts_str, **meta}


def list_snapshots(dataset_dir: str) -> list[dict]:
    snap_dir = _snapshot_dir(dataset_dir)
    if not snap_dir.exists():
        return []
    results = []
    for meta_file in sorted(snap_dir.glob("*.json"), reverse=True):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            meta["id"] = meta_file.stem
            results.append(meta)
        except Exception:
            pass
    return results


def restore_snapshot(dataset_dir: str, sid: str) -> bool:
    snap_dir = _snapshot_dir(dataset_dir)
    zip_path = snap_dir / f"{sid}.zip"
    if not zip_path.exists():
        return False

    src = Path(dataset_dir)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(src)
    return True


def delete_snapshot(dataset_dir: str, sid: str) -> bool:
    snap_dir = _snapshot_dir(dataset_dir)
    zip_path = snap_dir / f"{sid}.zip"
    meta_path = snap_dir / f"{sid}.json"
    deleted = False
    for p in (zip_path, meta_path):
        if p.exists():
            p.unlink()
            deleted = True
    return deleted
