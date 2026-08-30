"""Transactional caption persistence for Tag Editor."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from backend.tageditor.core import (
    caption_candidates,
    caption_revision,
    dataset_lock,
    read_tags,
    restore_caption_state,
    write_tags,
)
from backend.tageditor.timeline import timeline_store


Writer = Callable[[Path, str], bool]


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def save_caption_transaction(
    dataset_dir: Path,
    items: list[dict],
    *,
    writer: Writer = write_tags,
    event_type: str = "save",
    label: str = "",
) -> dict:
    """Save valid caption changes as one rollback-capable dataset transaction."""
    dataset_dir = dataset_dir.resolve()
    saved_paths: list[str] = []
    skipped_paths: list[str] = []
    failed: list[dict[str, str]] = []
    conflicts: list[dict[str, str]] = []
    revisions: dict[str, str] = {}
    prepared: list[dict] = []

    with dataset_lock(dataset_dir):
        for item in items:
            raw_path = str(item.get("path", ""))
            if not raw_path:
                failed.append({"path": "", "reason": "图片路径无效"})
                continue
            image_path = Path(raw_path).resolve()
            if not image_path.is_file():
                failed.append({"path": raw_path, "reason": "图片不存在"})
                continue
            if not _within(image_path, dataset_dir):
                failed.append({"path": raw_path, "reason": "图片不在数据集目录内"})
                continue
            candidates = caption_candidates(image_path)
            if len(candidates) > 1:
                failed.append({"path": str(image_path), "reason": "同时存在 .txt 与 .caption，请先解决冲突"})
                continue
            caption_path = candidates[0] if candidates else image_path.with_suffix(".txt")
            before_exists = caption_path.exists()
            before_text = read_tags(caption_path) if before_exists else ""
            current_revision = caption_revision(caption_path)
            expected_revision = item.get("expected_revision")
            if expected_revision is not None and expected_revision != current_revision:
                conflicts.append({"path": str(image_path), "reason": "标签文件已被外部修改", "revision": current_revision})
                continue
            after_text = str(item.get("tags", "")).strip()
            if before_text == after_text:
                skipped_paths.append(str(image_path))
                revisions[str(image_path)] = current_revision
                continue
            prepared.append({
                "image_path": image_path,
                "caption_path": caption_path,
                "before_exists": before_exists,
                "before_text": before_text,
                "after_text": after_text,
            })

        if failed or conflicts:
            return {
                "saved": 0,
                "skipped": len(skipped_paths),
                "saved_paths": [],
                "skipped_paths": skipped_paths,
                "failed": failed,
                "conflicts": conflicts,
                "revisions": revisions,
                "rolled_back": False,
                "rollback_failed": [],
                "aborted": True,
                "timeline_event": None,
                "timeline_warning": "",
            }

        applied: list[dict] = []
        for change in prepared:
            if writer(change["caption_path"], change["after_text"]):
                applied.append(change)
                saved_paths.append(str(change["image_path"]))
                continue
            rollback_failed: list[str] = []
            for previous in reversed(applied):
                try:
                    restore_caption_state(previous["caption_path"], previous["before_exists"], previous["before_text"])
                except Exception:
                    rollback_failed.append(str(previous["image_path"]))
            failed.extend({"path": str(change["image_path"]), "reason": "写入标签文件失败"} for change in prepared)
            return {
                "saved": 0,
                "skipped": len(skipped_paths),
                "saved_paths": [],
                "skipped_paths": skipped_paths,
                "failed": failed,
                "conflicts": conflicts,
                "revisions": revisions,
                "rolled_back": True,
                "rollback_failed": rollback_failed,
                "aborted": True,
                "timeline_event": None,
                "timeline_warning": "",
            }

        timeline_changes = []
        for change in applied:
            rel_path = str(change["caption_path"].relative_to(dataset_dir)).replace("\\", "/")
            timeline_changes.append({
                "rel_path": rel_path,
                "before_text": change["before_text"],
                "after_text": change["after_text"],
                "before_exists": change["before_exists"],
                "after_exists": True,
            })
            revisions[str(change["image_path"])] = caption_revision(change["caption_path"])

        event = None
        timeline_warning = ""
        if timeline_changes:
            try:
                event = timeline_store.record(
                    dataset_dir,
                    timeline_changes,
                    event_type=event_type,
                    label=label or f"保存 {len(timeline_changes)} 个标签文件",
                )
            except Exception as exc:
                timeline_warning = str(exc)

    return {
        "saved": len(saved_paths),
        "skipped": len(skipped_paths),
        "saved_paths": saved_paths,
        "skipped_paths": skipped_paths,
        "failed": failed,
        "conflicts": conflicts,
        "revisions": revisions,
        "rolled_back": False,
        "rollback_failed": [],
        "aborted": False,
        "timeline_event": event,
        "timeline_warning": timeline_warning,
    }


def restore_timeline_event(dataset_dir: Path, event_id: str) -> dict:
    """Revert one committed timeline event and record the restore as a new event."""
    dataset_dir = dataset_dir.resolve()
    source_changes = timeline_store.changes_for(event_id, dataset_dir)
    applied: list[dict] = []
    restore_changes: list[dict] = []
    with dataset_lock(dataset_dir):
        conflicts: list[dict[str, str]] = []
        for source in source_changes:
            target = (dataset_dir / source["rel_path"]).resolve()
            if not _within(target, dataset_dir):
                raise ValueError("Timeline contains an out-of-bounds path / 时间线包含越界路径")
            current_exists = target.exists()
            current_text = read_tags(target) if current_exists else ""
            expected_exists = bool(source["after_exists"])
            expected_text = source["after_text"] or ""
            if current_exists != expected_exists or (current_exists and current_text != expected_text):
                conflicts.append({"path": str(target), "reason": "标签文件在该保存事件后已被修改"})
        if conflicts:
            raise ValueError(f"Timeline restore conflict: {len(conflicts)} tag file(s) changed / 时间线恢复冲突: {len(conflicts)} 个标签文件已变化")
        for source in reversed(source_changes):
            target = (dataset_dir / source["rel_path"]).resolve()
            if not _within(target, dataset_dir):
                raise ValueError("Timeline contains an out-of-bounds path / 时间线包含越界路径")
            current_exists = target.exists()
            current_text = read_tags(target) if current_exists else ""
            desired_exists = bool(source["before_exists"])
            desired_text = source["before_text"] or ""
            try:
                restore_caption_state(target, desired_exists, desired_text)
            except Exception:
                for previous in reversed(applied):
                    restore_caption_state(previous["path"], previous["existed"], previous["text"])
                raise
            applied.append({"path": target, "existed": current_exists, "text": current_text})
            restore_changes.append({
                "rel_path": source["rel_path"],
                "before_text": current_text,
                "after_text": desired_text,
                "before_exists": current_exists,
                "after_exists": desired_exists,
            })
        event = timeline_store.record(
            dataset_dir,
            restore_changes,
            event_type="restore",
            label=f"恢复时间线事件 {event_id[:8]}",
            metadata={"source_event_id": event_id},
        )
    return {"restored": len(restore_changes), "timeline_event": event}


def restore_legacy_backups(dataset_dir: Path) -> dict:
    """Restore legacy .bak files as one rollback-capable Timeline transaction."""
    dataset_dir = dataset_dir.resolve()
    changes: list[dict] = []
    for extension in (".txt", ".caption"):
        for backup in sorted(dataset_dir.rglob(f"*{extension}.bak")):
            target = backup.with_suffix("").resolve()
            if not _within(target, dataset_dir):
                continue
            before_exists = target.exists()
            before_text = read_tags(target) if before_exists else ""
            after_text = backup.read_text(encoding="utf-8")
            if before_exists and before_text == after_text:
                continue
            changes.append({
                "path": target,
                "before_exists": before_exists,
                "before_text": before_text,
                "after_text": after_text,
            })

    applied: list[dict] = []
    with dataset_lock(dataset_dir):
        try:
            for change in changes:
                restore_caption_state(change["path"], True, change["after_text"])
                applied.append(change)
        except Exception:
            for change in reversed(applied):
                restore_caption_state(change["path"], change["before_exists"], change["before_text"])
            raise
        timeline_changes = [
            {
                "rel_path": str(change["path"].relative_to(dataset_dir)).replace("\\", "/"),
                "before_text": change["before_text"],
                "after_text": change["after_text"],
                "before_exists": change["before_exists"],
                "after_exists": True,
            }
            for change in changes
        ]
        event = timeline_store.record(
            dataset_dir,
            timeline_changes,
            event_type="legacy_backup_restore",
            label=f"恢复 {len(changes)} 个旧备份",
        )
    return {"restored": len(changes), "timeline_event": event}
