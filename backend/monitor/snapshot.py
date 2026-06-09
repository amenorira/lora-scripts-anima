"""
Training configuration snapshot management.
"""
from __future__ import annotations
import json
import shutil
from datetime import datetime
from pathlib import Path

def save_config_snapshot(task_id: str, config_path: str, extra_info: dict = None) -> Path:
    """Save a snapshot of the training configuration."""
    snapshot_dir = Path("output") / task_id
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy config file
    config_src = Path(config_path)
    if config_src.exists():
        config_dst = snapshot_dir / "config_snapshot.toml"
        shutil.copy2(config_src, config_dst)
    
    # Save metadata
    metadata = {
        "task_id": task_id,
        "config_path": str(config_path),
        "snapshot_time": datetime.now().isoformat(),
        "extra": extra_info or {}
    }
    
    meta_path = snapshot_dir / "snapshot_metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    
    return snapshot_dir

def get_config_snapshot(task_id: str) -> dict | None:
    """Get the saved config snapshot for a task."""
    snapshot_dir = Path("output") / task_id
    if not snapshot_dir.exists():
        return None
    
    result = {"task_id": task_id}
    
    config_path = snapshot_dir / "config_snapshot.toml"
    if config_path.exists():
        result["config_content"] = config_path.read_text(encoding="utf-8")
    
    meta_path = snapshot_dir / "snapshot_metadata.json"
    if meta_path.exists():
        try:
            result["metadata"] = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            result["metadata"] = {}
    
    return result
