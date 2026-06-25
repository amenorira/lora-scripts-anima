"""
Training task metadata management.

每个训练运行的元数据写入其 run 目录内的 task_meta.json（含 task_id ↔ run_dir 映射），
不再创建独立的 output/<UUID>/ 快照文件夹，避免每次训练产生两个文件夹。
"""
from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

from backend.constants import OUTPUT_DIR


def _write_task_meta(run_dir: str | Path, task_id: str, extra_info: dict | None = None) -> Path:
    """在 run 目录内写入 task_meta.json（task_id ↔ run_dir 映射 + 额外元数据）。

    run_dir 必须位于 output/ 之下，否则视为非法路径。
    """
    run_dir_path = Path(run_dir)
    try:
        run_dir_path.resolve().relative_to(OUTPUT_DIR.resolve())
    except ValueError:
        # run_dir 不在 output/ 下（例如续训指向外部目录），跳过写入但不报错
        return run_dir_path

    meta = {
        "task_id": task_id,
        "run_dir": str(run_dir_path),
        "snapshot_time": datetime.now().isoformat(),
        "extra": extra_info or {},
    }
    meta_path = run_dir_path / "task_meta.json"
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    return meta_path


def save_config_snapshot(task_id: str, config_path: str, run_dir: str, extra_info: dict | None = None) -> Path:
    """保存训练任务元数据到 run 目录（替代旧版独立快照文件夹）。

    - config_path 的内容已由 /run 端点复制到 run_dir/config.toml，此处不再重复复制。
    - 仅写入 task_meta.json 提供运行时所需的 task_id ↔ run_dir 映射。
    """
    _write_task_meta(run_dir, task_id, extra_info)
    return Path(run_dir) / "task_meta.json"


def find_run_dir_by_task_id(task_id: str) -> str | None:
    """根据 task_id 在 output/*/task_meta.json 中反查 run 目录路径。

    用于 live 模式下将 SSE 的 task_id 映射到真实的产物目录。
    """
    if not task_id or not OUTPUT_DIR.exists():
        return None
    for run_dir in OUTPUT_DIR.iterdir():
        if not run_dir.is_dir():
            continue
        meta_file = run_dir / "task_meta.json"
        if not meta_file.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            if meta.get("task_id") == task_id:
                return str(run_dir).replace("\\", "/")
        except (json.JSONDecodeError, OSError):
            continue
    return None


def get_config_snapshot(task_id: str) -> dict | None:
    """获取指定任务的配置（从 task_meta.json 定位的 run 目录读取 config.toml）。"""
    run_dir_str = find_run_dir_by_task_id(task_id)
    if not run_dir_str:
        return None
    run_dir = Path(run_dir_str)
    config_path = run_dir / "config.toml"
    result: dict = {"task_id": task_id, "run_dir": run_dir_str}
    if config_path.exists():
        result["config_content"] = config_path.read_text(encoding="utf-8")
    meta_path = run_dir / "task_meta.json"
    if meta_path.exists():
        try:
            result["metadata"] = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            result["metadata"] = {}
    return result
