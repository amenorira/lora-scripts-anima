"""Transactional caption persistence for Tag Editor."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from backend.tageditor.core import (
    caption_candidates,
    caption_revision,
    dataset_lock,
    read_caption_snapshot,
    restore_caption_state,
    write_tags,
)
from backend.tageditor.timeline import timeline_store


Writer = Callable[[Path, str], bool]


class TimelineConflict(ValueError):
    def __init__(self, count: int):
        super().__init__(f"Timeline restore conflict: {count} tag file(s) changed / 时间线恢复冲突: {count} 个标签文件已变化")
        self.count = count


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _rollback_restores(applied: list[tuple[Path, bool, str]], error: Exception) -> None:
    failures = []
    for path, existed, text in reversed(applied):
        try:
            restore_caption_state(path, existed, text)
        except Exception:
            failures.append(str(path))
    if failures:
        raise RuntimeError("Caption rollback failed / 标签回滚失败: " + ", ".join(failures)) from error


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
    targets: dict[Path, dict] = {}

    with dataset_lock(dataset_dir):
        for item in items:
            raw_path = str(item.get("path", ""))
            if not raw_path:
                failed.append({"path": "", "reason": "图片路径无效", "error_code": "tageditor_invalid_image"})
                continue
            image_path = Path(raw_path).resolve()
            if not image_path.is_file():
                failed.append({"path": raw_path, "reason": "图片不存在", "error_code": "tageditor_image_missing"})
                continue
            if not _within(image_path, dataset_dir):
                failed.append({"path": raw_path, "reason": "图片不在数据集目录内", "error_code": "tageditor_outside_dataset"})
                continue
            candidates = caption_candidates(image_path)
            if len(candidates) > 1:
                failed.append({"path": str(image_path), "reason": "同时存在 .txt 与 .caption，请先解决冲突", "error_code": "tageditor_caption_conflict"})
                continue
            caption_path = candidates[0] if candidates else image_path.with_suffix(".txt")
            try:
                before_text, current_revision, _ = read_caption_snapshot(caption_path)
            except (OSError, UnicodeError) as exc:
                failed.append({"path": str(image_path), "reason": str(exc), "error_code": "tageditor_read_failed", "error_details": str(exc)})
                continue
            before_exists = current_revision != "missing"
            expected_revision = item.get("expected_revision")
            if expected_revision is not None and expected_revision != current_revision:
                conflicts.append({"path": str(image_path), "reason": "标签文件已被外部修改", "revision": current_revision, "error_code": "tageditor_external_change"})
                continue
            after_text = str(item.get("tags", ""))
            # Atomic writes replace this directory entry, not a final symlink's target.
            target = caption_path
            if target in targets:
                previous = targets[target]
                if previous["after_text"] != after_text:
                    for alias in [*previous["image_paths"], image_path]:
                        conflicts.append({"path": str(alias), "reason": "多张图片共用标签文件，待保存内容不一致", "error_code": "tageditor_shared_caption_conflict"})
                elif image_path not in previous["image_paths"]:
                    previous["image_paths"].append(image_path)
                continue
            targets[target] = {
                "image_paths": [image_path],
                "caption_path": caption_path,
                "before_exists": before_exists,
                "before_text": before_text,
                "after_text": after_text,
                "revision": current_revision,
            }

        for change in targets.values():
            if change["before_text"] == change["after_text"]:
                for image_path in change["image_paths"]:
                    skipped_paths.append(str(image_path))
                    revisions[str(image_path)] = change["revision"]
            else:
                prepared.append(change)

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
                saved_paths.extend(str(path) for path in change["image_paths"])
                continue
            rollback_failed: list[str] = []
            for previous in reversed(applied):
                try:
                    restore_caption_state(previous["caption_path"], previous["before_exists"], previous["before_text"])
                except Exception:
                    rollback_failed.extend(str(path) for path in previous["image_paths"])
            failed.extend({"path": str(path), "reason": "写入标签文件失败", "error_code": "tageditor_write_failed"} for change in prepared for path in change["image_paths"])
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
            revision = caption_revision(change["caption_path"])
            revisions.update({str(path): revision for path in change["image_paths"]})

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
    applied: list[tuple[Path, bool, str]] = []
    restore_changes: list[dict] = []
    with dataset_lock(dataset_dir):
        conflicts: list[dict[str, str]] = []
        for source in source_changes:
            target = (dataset_dir / source["rel_path"]).resolve()
            if not _within(target, dataset_dir):
                raise ValueError("Timeline contains an out-of-bounds path / 时间线包含越界路径")
            current_exists = target.exists()
            current_text = read_caption_snapshot(target)[0] if current_exists else ""
            expected_exists = bool(source["after_exists"])
            expected_text = source["after_text"] or ""
            if current_exists != expected_exists or (current_exists and current_text != expected_text):
                conflicts.append({"path": str(target), "reason": "标签文件在该保存事件后已被修改"})
        if conflicts:
            raise TimelineConflict(len(conflicts))
        try:
            for source in reversed(source_changes):
                target = (dataset_dir / source["rel_path"]).resolve()
                if not _within(target, dataset_dir):
                    raise ValueError("Timeline contains an out-of-bounds path / 时间线包含越界路径")
                current_exists = target.exists()
                current_text = read_caption_snapshot(target)[0] if current_exists else ""
                desired_exists = bool(source["before_exists"])
                desired_text = source["before_text"] or ""
                restore_caption_state(target, desired_exists, desired_text)
                applied.append((target, current_exists, current_text))
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
        except Exception as exc:
            _rollback_restores(applied, exc)
            raise
    return {"restored": len(restore_changes), "timeline_event": event}


def restore_legacy_backups(dataset_dir: Path) -> dict:
    """Restore legacy .bak files as one rollback-capable Timeline transaction."""
    dataset_dir = dataset_dir.resolve()
    changes: list[dict] = []
    applied: list[tuple[Path, bool, str]] = []
    with dataset_lock(dataset_dir):
        for extension in (".txt", ".caption"):
            for backup in sorted(dataset_dir.rglob(f"*{extension}.bak")):
                target = backup.with_suffix("").resolve()
                if not _within(target, dataset_dir):
                    continue
                before_exists = target.exists()
                before_text = read_caption_snapshot(target)[0] if before_exists else ""
                after_text = read_caption_snapshot(backup)[0]
                if before_exists and before_text == after_text:
                    continue
                changes.append({
                    "path": target,
                    "before_exists": before_exists,
                    "before_text": before_text,
                    "after_text": after_text,
                })
        try:
            for change in changes:
                restore_caption_state(change["path"], True, change["after_text"])
                applied.append((change["path"], change["before_exists"], change["before_text"]))
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
        except Exception as exc:
            _rollback_restores(applied, exc)
            raise
    return {"restored": len(changes), "timeline_event": event}
