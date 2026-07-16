"""训练任务快照与 task_id ↔ 内部 run_dir 映射。"""
from __future__ import annotations
from pathlib import Path

from backend.monitor.run_registry import (
    find_run_record_by_task_id,
    load_run_record,
    write_run_record,
)


def _write_task_meta(
    run_dir: str | Path,
    task_id: str,
    extra_info: dict | None = None,
    *,
    artifact_dir: str | Path | None = None,
    output_base_dir: str | Path | None = None,
    autosave_file: str | Path | None = None,
) -> Path:
    """在内部运行目录写入版本化 RunRecord。"""
    run_path = Path(run_dir)
    write_run_record(
        run_path,
        artifact_dir=artifact_dir or run_path,
        task_id=task_id,
        output_base_dir=output_base_dir,
        autosave_file=autosave_file,
        extra=extra_info,
    )
    return run_path / "task_meta.json"


def save_config_snapshot(
    task_id: str,
    config_path: str,
    run_dir: str,
    extra_info: dict | None = None,
    *,
    artifact_dir: str | None = None,
    output_base_dir: str | None = None,
) -> Path:
    """保存训练任务元数据到 run 目录（替代旧版独立快照文件夹）。

    - config_path 的内容已由 /run 端点复制到 run_dir/config.toml，此处不再重复复制。
    - 仅写入 task_meta.json 提供运行时所需的 task_id ↔ run_dir 映射。
    """
    _write_task_meta(
        run_dir,
        task_id,
        extra_info,
        artifact_dir=artifact_dir,
        output_base_dir=output_base_dir,
        autosave_file=config_path,
    )
    return Path(run_dir) / "task_meta.json"


def find_run_dir_by_task_id(task_id: str) -> str | None:
    """根据 task_id 反查内部运行目录。"""
    record = find_run_record_by_task_id(task_id)
    return str(record["run_path"]).replace("\\", "/") if record else None


def get_config_snapshot(task_id: str) -> dict | None:
    """获取指定任务的配置（从 task_meta.json 定位的 run 目录读取 config.toml）。"""
    run_dir_str = find_run_dir_by_task_id(task_id)
    if not run_dir_str:
        return None
    run_dir = Path(run_dir_str)
    record = load_run_record(run_dir)
    config_path = run_dir / "config.toml"
    result: dict = {
        "task_id": task_id,
        "run_dir": record["run_dir"] if record else run_dir_str,
        "artifact_dir": record["artifact_dir"] if record else run_dir_str,
    }
    if config_path.exists():
        result["config_content"] = config_path.read_text(encoding="utf-8")
    if record:
        result["metadata"] = {
            key: value for key, value in record.items()
            if key not in {"run_path", "artifact_path"}
        }
    return result
