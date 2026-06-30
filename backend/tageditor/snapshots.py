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
SNAPSHOT_KEEP = 10  # 默认自动保留最近快照数，防止 .snapshots/ 无限膨胀（A3/C5）


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

    # 递归打包所有 caption 文件，保留子目录结构（arcname 用相对路径）。
    # 标签编辑器以 recursive=True 加载，快照必须覆盖子目录才能完整还原。
    # 不打包 .bak：快照本身是该时点的独立还原点，与 .bak（原始版本回退）是两条线，
    # 混在一起会让"还原快照后还原备份"行为不可预期。
    snap_dir_resolved = snap_dir.resolve()
    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.rglob("*")):
            if not f.is_file() or f.name.startswith("."):
                continue
            if f.suffix.lower() not in CAPTION_EXTS:
                continue
            # 跳过快照目录自身（避免自我引用）
            try:
                f.resolve().relative_to(snap_dir_resolved)
                continue
            except ValueError:
                pass
            try:
                arcname = str(f.relative_to(src)).replace("\\", "/")
            except ValueError:
                arcname = f.name
            zf.write(f, arcname)
            file_count += 1

    size_bytes = zip_path.stat().st_size
    meta = {"timestamp": ts, "file_count": file_count, "size_bytes": size_bytes}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    # A3/C5: 创建后自动删除多余的旧快照，仅保留最近 SNAPSHOT_KEEP 个
    prune_snapshots(dataset_dir, keep=SNAPSHOT_KEEP)
    return {"id": ts_str, **meta}


def prune_snapshots(dataset_dir: str, keep: int = SNAPSHOT_KEEP) -> int:
    """删除多余旧快照，保留最近 keep 个（按时间戳 id 倒序）。返回删除数。"""
    snap_dir = _snapshot_dir(dataset_dir)
    if not snap_dir.exists() or keep < 0:
        return 0
    # 按 meta 文件名（即时间戳）倒序，整对删除 .zip + .json
    metas = sorted(snap_dir.glob("*.json"), reverse=True)
    if len(metas) <= keep:
        return 0
    deleted = 0
    to_remove = metas[keep:]
    for meta_file in to_remove:
        sid = meta_file.stem
        for p in (snap_dir / f"{sid}.zip", snap_dir / f"{sid}.json"):
            try:
                p.unlink()
                deleted += 1
            except Exception:
                pass
    return deleted // 2  # 返回快照条数（每个含 zip+json）


def clear_all_snapshots(dataset_dir: str) -> int:
    """清空所有快照。返回删除条数。"""
    snap_dir = _snapshot_dir(dataset_dir)
    if not snap_dir.exists():
        return 0
    count = 0
    for meta_file in snap_dir.glob("*.json"):
        sid = meta_file.stem
        for p in (snap_dir / f"{sid}.zip", snap_dir / f"{sid}.json"):
            try:
                p.unlink()
            except Exception:
                pass
        count += 1
    return count


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
