"""Read training state reported by the local trainer."""
import json
from pathlib import Path, PureWindowsPath

from backend.training.checkpoint_state import resumable_state
from backend.utils.file_io import read_bytes


def read_object(path):
    try:
        value = json.loads(read_bytes(path), parse_constant=lambda _: None)
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def saved_training_state(root: Path, artifacts: Path, run_dir: Path | None = None) -> dict:
    """Only advertise the last state confirmed by this trainer in its output directory."""
    status = read_object(root / "status.json")
    saved = status.get("last_state") or {}
    if status.get("schema_version") != 1 or not isinstance(saved, dict) or not isinstance(saved.get("path"), str):
        return {}
    # Trainer status can come from a different OS. Only reuse its directory name.
    name = PureWindowsPath(saved["path"]).name
    if not name or name == "..":
        return {}
    path = artifacts / name
    if resumable_state(path, run_dir):
        return {"resume_state": str(path), "resume_step": saved.get("step")}
    return {}
