"""
Tag Editor — 还原点快照系统
"""
from __future__ import annotations

import json
import os
import stat
import time
import uuid
import zipfile
from pathlib import Path

from backend.tageditor.core import dataset_lock, restore_caption_state


SNAPSHOT_DIR_NAME = ".snapshots"
CAPTION_EXTS = {".txt", ".caption"}
SNAPSHOT_KEEP = 10  # 默认自动保留最近快照数，防止 .snapshots/ 无限膨胀（A3/C5）


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _read_caption_exact(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def create_snapshot(dataset_dir: str) -> dict:
    src = Path(dataset_dir).resolve()
    if not src.is_dir():
        raise ValueError(f"Directory does not exist or is not a directory / 目录不存在或不是目录: {dataset_dir}")
    snap_dir = src / SNAPSHOT_DIR_NAME

    with dataset_lock(src):
        snap_dir.mkdir(parents=True, exist_ok=True)
        ts = time.time()
        ts_str = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        zip_path = snap_dir / f"{ts_str}.zip"
        temp_zip_path = snap_dir / f".{ts_str}.zip.tmp"
        meta_path = snap_dir / f"{ts_str}.json"
        temp_meta_path = snap_dir / f".{ts_str}.json.tmp"
        zip_published = False
        meta_published = False

        try:
            file_count = 0
            with zipfile.ZipFile(temp_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for caption_path in sorted(src.rglob("*")):
                    if caption_path.is_symlink() or not caption_path.is_file():
                        continue
                    if caption_path.name.startswith(".") or caption_path.suffix.lower() not in CAPTION_EXTS:
                        continue
                    resolved = caption_path.resolve()
                    if not _is_within(resolved, src) or _is_within(resolved, snap_dir):
                        continue
                    arcname = str(resolved.relative_to(src)).replace("\\", "/")
                    zf.write(resolved, arcname)
                    file_count += 1
            os.replace(temp_zip_path, zip_path)
            zip_published = True

            size_bytes = zip_path.stat().st_size
            meta = {"timestamp": ts, "file_count": file_count, "size_bytes": size_bytes}
            temp_meta_path.write_text(json.dumps(meta), encoding="utf-8")
            os.replace(temp_meta_path, meta_path)
            meta_published = True
            prune_snapshots(str(src), keep=SNAPSHOT_KEEP)
            return {"id": ts_str, **meta}
        except Exception:
            if zip_published and not meta_published:
                zip_path.unlink(missing_ok=True)
            if meta_published and not zip_published:
                meta_path.unlink(missing_ok=True)
            raise
        finally:
            temp_zip_path.unlink(missing_ok=True)
            temp_meta_path.unlink(missing_ok=True)


def prune_snapshots(dataset_dir: str, keep: int = SNAPSHOT_KEEP) -> int:
    """删除多余旧快照，保留最近 keep 个（按时间戳 id 倒序）。返回删除数。"""
    src = Path(dataset_dir).resolve()
    snap_dir = src / SNAPSHOT_DIR_NAME
    with dataset_lock(src):
        if not snap_dir.exists() or keep < 0:
            return 0
        metas = sorted(snap_dir.glob("*.json"), reverse=True)
        if len(metas) <= keep:
            return 0
        removed = 0
        for meta_file in metas[keep:]:
            sid = meta_file.stem
            for path in (snap_dir / f"{sid}.zip", meta_file):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            removed += 1
        return removed


def clear_all_snapshots(dataset_dir: str) -> int:
    """清空所有快照。返回删除条数。"""
    src = Path(dataset_dir).resolve()
    snap_dir = src / SNAPSHOT_DIR_NAME
    with dataset_lock(src):
        if not snap_dir.exists():
            return 0
        count = 0
        for meta_file in snap_dir.glob("*.json"):
            sid = meta_file.stem
            for path in (snap_dir / f"{sid}.zip", meta_file):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            count += 1
        return count


def list_snapshots(dataset_dir: str) -> list[dict]:
    src = Path(dataset_dir).resolve()
    snap_dir = src / SNAPSHOT_DIR_NAME
    with dataset_lock(src):
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
    src = Path(dataset_dir).resolve()
    snap_dir = src / SNAPSHOT_DIR_NAME
    if not sid or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in sid):
        return False
    zip_path = snap_dir / f"{sid}.zip"
    if not zip_path.exists():
        return False

    with dataset_lock(src):
        desired: dict[Path, str] = {}
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError("Snapshot contains a symlink / 快照包含符号链接")
                target = (src / member.filename).resolve()
                if not _is_within(target, src):
                    raise ValueError("Snapshot contains an out-of-bounds path / 快照包含越界路径")
                if target.suffix.lower() not in CAPTION_EXTS:
                    raise ValueError("Snapshot contains a non-tag file / 快照包含非标签文件")
                if member.file_size > 16 * 1024 * 1024:
                    raise ValueError("Snapshot tag file too large / 快照标签文件过大")
                desired[target] = zf.read(member).decode("utf-8")

        existing: set[Path] = set()
        for candidate in src.rglob("*"):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            if candidate.suffix.lower() not in CAPTION_EXTS:
                continue
            resolved = candidate.resolve()
            if _is_within(resolved, src) and not _is_within(resolved, snap_dir):
                existing.add(resolved)

        targets = sorted(existing | set(desired), key=str)
        before = {
            target: (target.exists(), _read_caption_exact(target) if target.exists() else "")
            for target in targets
        }
        applied: list[Path] = []
        try:
            for target in targets:
                restore_caption_state(target, target in desired, desired.get(target, ""))
                applied.append(target)
        except Exception as original_error:
            rollback_failed = []
            for target in reversed(applied):
                existed, text = before[target]
                try:
                    restore_caption_state(target, existed, text)
                except Exception:
                    rollback_failed.append(str(target))
            if rollback_failed:
                raise RuntimeError(
                    f"Snapshot restore failed, and rollback failed for {len(rollback_failed)} file(s) / "
                    f"快照恢复失败，且 {len(rollback_failed)} 个文件回滚失败"
                ) from original_error
            raise
    return True


def delete_snapshot(dataset_dir: str, sid: str) -> bool:
    src = Path(dataset_dir).resolve()
    snap_dir = src / SNAPSHOT_DIR_NAME
    if not sid or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in sid):
        return False
    zip_path = snap_dir / f"{sid}.zip"
    meta_path = snap_dir / f"{sid}.json"
    with dataset_lock(src):
        deleted = False
        for path in (zip_path, meta_path):
            if path.exists():
                path.unlink()
                deleted = True
        return deleted
