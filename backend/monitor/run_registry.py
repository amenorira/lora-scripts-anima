"""训练运行目录注册与安全路径解析。

内部 ``run_dir`` 始终位于项目 ``output/`` 下，保存配置、日志和 TensorBoard
事件；``artifact_dir`` 可以位于任意盘符，保存模型、断点和原始预览图。
所有外部文件访问都必须先通过这里登记的映射，避免监控接口直接接受任意绝对路径。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.constants import AUTOSAVE_DIR, OUTPUT_DIR, REPO_ROOT


RUN_META_NAME = "task_meta.json"
RUN_SCHEMA_VERSION = 2

_CONTROL_FILES = {
    "config.toml",
    "run_info.txt",
    "output_dir.txt",
    "prompts.txt",
    "result.json",
    "error.log",
}


def resolve_user_path(path: str | Path) -> Path:
    """将用户路径解析为绝对路径；相对路径以项目根目录为基准。"""
    value = Path(path).expanduser()
    if not value.is_absolute():
        value = REPO_ROOT / value
    return value.resolve()


def resolve_internal_run_dir(run_dir: str | Path) -> Path | None:
    """解析并验证内部运行目录必须位于项目 output/ 下。"""
    value = Path(run_dir)
    if not value.is_absolute():
        value = REPO_ROOT / value
    try:
        resolved = value.resolve()
        resolved.relative_to(OUTPUT_DIR.resolve())
        return resolved
    except (OSError, ValueError):
        return None


def run_dir_ref(run_dir: str | Path) -> str:
    """返回供 API/前端使用的项目相对运行目录。"""
    resolved = resolve_internal_run_dir(run_dir)
    if resolved is None:
        raise ValueError(f"Invalid internal run directory: {run_dir}")
    return str(resolved.relative_to(REPO_ROOT)).replace("\\", "/")


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def write_run_record(
    run_dir: str | Path,
    *,
    artifact_dir: str | Path,
    task_id: str | None = None,
    output_base_dir: str | Path | None = None,
    autosave_file: str | Path | None = None,
    imported: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """写入版本化运行记录并返回记录内容。"""
    internal = resolve_internal_run_dir(run_dir)
    if internal is None:
        raise ValueError(f"run_dir must be inside output/: {run_dir}")
    internal.mkdir(parents=True, exist_ok=True)
    artifact = resolve_user_path(artifact_dir)

    record = {
        "schema_version": RUN_SCHEMA_VERSION,
        "task_id": task_id,
        "run_dir": run_dir_ref(internal),
        "artifact_dir": str(artifact),
        "output_base_dir": str(output_base_dir) if output_base_dir is not None else str(artifact.parent),
        "autosave_file": str(autosave_file) if autosave_file else "",
        "created_at": datetime.now().isoformat(),
        "imported": bool(imported),
        "deleted": False,
        "extra": extra or {},
    }
    _atomic_write_json(internal / RUN_META_NAME, record)
    return record


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _config_output_dir(run_dir: Path) -> str | None:
    config_file = run_dir / "config.toml"
    if not config_file.is_file():
        return None
    try:
        with config_file.open("rb") as handle:
            config = tomllib.load(handle)
        value = config.get("output_dir")
        return str(value) if value else None
    except (OSError, tomllib.TOMLDecodeError):
        return None


def load_run_record(
    run_dir: str | Path,
    *,
    include_deleted: bool = False,
) -> dict[str, Any] | None:
    """读取运行记录，并兼容没有 v2 metadata 的旧项目内运行。"""
    internal = resolve_internal_run_dir(run_dir)
    if internal is None or not internal.is_dir():
        return None

    meta = _load_json(internal / RUN_META_NAME) or {}
    if meta.get("deleted") and not include_deleted:
        return None

    artifact_raw = meta.get("artifact_dir")
    if not artifact_raw:
        artifact_raw = (meta.get("extra") or {}).get("output_dir")
    if not artifact_raw:
        artifact_raw = _config_output_dir(internal)
    if not artifact_raw:
        artifact_raw = internal

    try:
        artifact = resolve_user_path(artifact_raw)
    except (OSError, ValueError):
        artifact = Path(artifact_raw)

    output_base = meta.get("output_base_dir")
    if not output_base:
        output_base = str(artifact.parent) if artifact != internal else str(OUTPUT_DIR)

    try:
        schema_version = int(meta.get("schema_version") or 1)
    except (TypeError, ValueError):
        schema_version = 1
    try:
        artifact_external = artifact.resolve() != internal.resolve()
    except OSError:
        artifact_external = artifact != internal
    extra = meta.get("extra") if isinstance(meta.get("extra"), dict) else {}

    return {
        **meta,
        "schema_version": schema_version,
        "task_id": meta.get("task_id"),
        "run_dir": run_dir_ref(internal),
        "run_path": internal,
        "artifact_dir": str(artifact),
        "artifact_path": artifact,
        "artifact_available": artifact.is_dir(),
        "artifact_external": artifact_external,
        "preview_enabled": extra.get("preview_enabled"),
        "output_base_dir": str(output_base),
        "deleted": bool(meta.get("deleted", False)),
        "imported": bool(meta.get("imported", False)),
    }


def iter_run_records(*, include_deleted: bool = False) -> list[dict[str, Any]]:
    if not OUTPUT_DIR.exists():
        return []
    records: list[dict[str, Any]] = []
    for candidate in OUTPUT_DIR.iterdir():
        if not candidate.is_dir() or candidate.name.startswith((".", "__")):
            continue
        record = load_run_record(candidate, include_deleted=include_deleted)
        if record:
            records.append(record)
    return records


def find_run_record_by_task_id(task_id: str) -> dict[str, Any] | None:
    if not task_id:
        return None
    for record in iter_run_records():
        if record.get("task_id") == task_id:
            return record
    return None


def resolve_artifact_file(run_dir: str | Path, relative_path: str | Path) -> Path | None:
    """在已登记产物目录内安全解析相对文件路径。"""
    record = load_run_record(run_dir)
    if not record:
        return None
    relative = Path(relative_path)
    if relative.is_absolute():
        return None
    root = Path(record["artifact_path"]).resolve()
    try:
        candidate = (root / relative).resolve()
        candidate.relative_to(root)
    except (OSError, ValueError):
        return None
    return candidate


def mark_run_deleted(run_dir: str | Path) -> bool:
    """删除内部监控数据但保留模型、断点和 sample/，并写入防重导标记。"""
    record = load_run_record(run_dir, include_deleted=True)
    if not record:
        return False
    internal = Path(record["run_path"])
    artifact = Path(record["artifact_path"])

    for name in _CONTROL_FILES:
        try:
            (internal / name).unlink(missing_ok=True)
        except OSError:
            pass
    for log_file in internal.glob("train_*.log"):
        try:
            log_file.unlink(missing_ok=True)
        except OSError:
            pass
    for directory in (internal / "log", internal / "logs"):
        if directory.is_dir():
            try:
                shutil.rmtree(directory)
            except OSError:
                pass

    tombstone = {
        key: value
        for key, value in record.items()
        if key not in {"run_path", "artifact_path", "artifact_available"}
    }
    tombstone.update({
        "schema_version": RUN_SCHEMA_VERSION,
        "run_dir": run_dir_ref(internal),
        "artifact_dir": str(artifact),
        "deleted": True,
        "deleted_at": datetime.now().isoformat(),
    })
    _atomic_write_json(internal / RUN_META_NAME, tombstone)
    return True


def _safe_import_name(artifact_dir: Path) -> str:
    base = "".join(c if c.isalnum() or c in "._-" else "_" for c in artifact_dir.name).strip("._-")
    base = base or "imported_run"
    candidate = OUTPUT_DIR / base
    if not candidate.exists():
        return base
    existing = load_run_record(candidate, include_deleted=True)
    if existing and Path(existing["artifact_path"]).resolve() == artifact_dir.resolve():
        return base
    digest = hashlib.sha1(str(artifact_dir.resolve()).encode("utf-8", errors="ignore")).hexdigest()[:8]
    return f"{base}_imported_{digest}"


def _copy_legacy_control_files(source: Path, destination: Path, autosave: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in _CONTROL_FILES:
        source_file = source / name
        if source_file.is_file():
            try:
                shutil.copy2(source_file, destination / name)
            except OSError:
                pass
    if not (destination / "config.toml").exists():
        try:
            shutil.copy2(autosave, destination / "config.toml")
        except OSError:
            pass
    for log_file in source.glob("train_*.log"):
        try:
            shutil.copy2(log_file, destination / log_file.name)
        except OSError:
            pass
    source_log = source / "log"
    destination_log = destination / "log"
    if source_log.is_dir():
        for file in source_log.rglob("*"):
            if not file.is_file():
                continue
            try:
                relative = file.relative_to(source_log)
                target = destination_log / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists() or target.stat().st_size != file.stat().st_size:
                    shutil.copy2(file, target)
            except OSError:
                continue


def import_legacy_external_runs(limit: int = 50) -> dict[str, int]:
    """从 autosave 幂等导入旧的项目外运行记录，不复制模型和预览图。"""
    stats = {"imported": 0, "skipped": 0, "unavailable": 0}
    if not AUTOSAVE_DIR.exists():
        return stats
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    known_artifacts: set[str] = set()
    for record in iter_run_records(include_deleted=True):
        try:
            known_artifacts.add(os.path.normcase(str(Path(record["artifact_path"]).resolve())))
        except OSError:
            continue

    configs = sorted(
        AUTOSAVE_DIR.glob("*.toml"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:limit]
    for autosave in configs:
        try:
            with autosave.open("rb") as handle:
                params = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            stats["skipped"] += 1
            continue
        output_dir = params.get("output_dir")
        if not output_dir:
            stats["skipped"] += 1
            continue
        try:
            artifact = resolve_user_path(str(output_dir))
            artifact.relative_to(OUTPUT_DIR.resolve())
            stats["skipped"] += 1
            continue
        except ValueError:
            pass
        except OSError:
            stats["unavailable"] += 1
            continue

        key = os.path.normcase(str(artifact))
        if key in known_artifacts:
            stats["skipped"] += 1
            continue
        if not artifact.is_dir():
            stats["unavailable"] += 1
            continue

        internal = OUTPUT_DIR / _safe_import_name(artifact)
        _copy_legacy_control_files(artifact, internal, autosave)
        old_meta = _load_json(artifact / RUN_META_NAME) or {}
        write_run_record(
            internal,
            artifact_dir=artifact,
            task_id=old_meta.get("task_id"),
            output_base_dir=str(artifact.parent),
            autosave_file=autosave,
            imported=True,
            extra={"legacy_source": str(artifact)},
        )
        known_artifacts.add(key)
        stats["imported"] += 1
    return stats
