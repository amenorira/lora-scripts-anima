"""Identify resumable Accelerate states written by the desktop trainers."""
from collections.abc import Iterable
from functools import wraps
import json
from pathlib import Path
import re
import zipfile

from safetensors import safe_open, SafetensorError

from backend.utils.file_io import atomic_write_text


# Keep this visible in downloaded archives. An interrupted overwrite can still
# contain all the filenames of the previous, successful save.
SAVE_IN_PROGRESS = "anima-save-in-progress"
STATE_INVENTORY = "anima-state-files.json"
_SHARD_DIR = re.compile(r"(?:pytorch_model_fsdp|optimizer)_\d+")
_SHARD_FILE = re.compile(r"__\d+_\d+\.distcp")
_FSDP_FILE = re.compile(r"(?:pytorch_model_fsdp(?:_\d+)?(?:_rank\d+)?|optimizer_\d+_rank\d+)\.bin")
_SHARED_FILE = re.compile(
    r"(?:model(?:_\d+)?\.safetensors|(?:pytorch_model|optimizer|scheduler|sampler|"
    r"dl_state_dict|custom_checkpoint)(?:_\d+)?(?:_rank0)?\.bin|scaler\.pt|random_states_0\.pkl)"
)


def has_fsdp_files(entries: Iterable[Path]) -> bool:
    """Recognize Accelerate's full, per-rank and DCP layouts by name."""
    return any((_FSDP_FILE.fullmatch(entry.name) and entry.is_file())
               or (_SHARD_DIR.fullmatch(entry.name) and entry.is_dir()) for entry in entries)


def _state_files(entries: Iterable[Path]) -> dict[str, int]:
    """Sizes used by the desktop trainer's save inventory."""
    files = {}
    for entry in entries:
        if _SHARED_FILE.fullmatch(entry.name) and entry.is_file():
            files[entry.name] = entry.stat().st_size
    return files


def is_distributed_state_member(path: Path) -> bool:
    """These PyTorch checkpoint files belong in archived state, despite their prefixes."""
    if path.name != ".metadata" and not _SHARD_FILE.fullmatch(path.name):
        return False
    state = path.parent.parent
    return bool(_SHARD_DIR.fullmatch(path.parent.name)) and any(
        (state / marker).is_file() for marker in ("random_states_0.pkl", "train_state.json", SAVE_IN_PROGRESS, STATE_INVENTORY)
    )


def track_state_saves():
    from accelerate import Accelerator

    save_state = Accelerator.save_state

    @wraps(save_state)
    def save_with_marker(self, output_dir=None, *args, **kwargs):
        if output_dir is None or self.project_configuration.automatic_checkpoint_naming or not self.is_main_process:
            return save_state(self, output_dir, *args, **kwargs)
        marker = Path(output_dir) / SAVE_IN_PROGRESS
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        result = save_state(self, output_dir, *args, **kwargs)
        files = _state_files(marker.parent.iterdir())
        atomic_write_text(marker.parent / STATE_INVENTORY, json.dumps(files))
        marker.unlink()
        return result

    Accelerator.save_state = save_with_marker


def _complete_shared_files(path: Path, files: dict[str, int]) -> bool:
    for name in files:
        if name.endswith(".safetensors"):
            with safe_open(path / name, framework="numpy"):
                pass
        elif name.endswith((".bin", ".pt")) and not zipfile.is_zipfile(path / name):
            return False
    return True


def state_resume_status(path: Path, run_dir: Path | None = None) -> str:
    """Identify ordinary resumable saves and download-only distributed formats."""
    if (path / "pytorch_model").is_dir():
        return "downloadOnly"
    # Accelerate writes the RNG archive after model, optimizer and optional scheduler.
    if (path / SAVE_IN_PROGRESS).exists() or not zipfile.is_zipfile(path / "random_states_0.pkl"):
        return "incomplete"
    try:
        entries = list(path.iterdir())
        if has_fsdp_files(entries):
            return "downloadOnly"
        files = _state_files(entries)
        if not all(files.values()) or not _complete_shared_files(path, files):
            return "incomplete"
        inventory = path / STATE_INVENTORY
        if inventory.exists():
            expected = json.loads(inventory.read_text(encoding="utf-8"))
            if not isinstance(expected, dict) or not expected or not all(
                type(size) is int and files.get(name) == size for name, size in expected.items()
            ):
                return "incomplete"
        elif "scheduler.bin" not in files:
            # The original configuration may be on a different drive from the state.
            from backend.monitor.run_registry import read_run_config
            from backend.training.config.krea2_optimizers import INTERNAL_OPTIMIZERS

            optimizer = read_run_config(run_dir or path.parent).get("optimizer_type")
            if isinstance(optimizer, str) and optimizer and not (
                optimizer.lower().endswith("schedulefree") or optimizer in INTERNAL_OPTIMIZERS
            ):
                return "incomplete"
        if "optimizer.bin" in files and ("model.safetensors" in files or "pytorch_model.bin" in files):
            return "ready"
        return "incomplete"
    except (OSError, ValueError, OverflowError, RuntimeError, SafetensorError):
        return "incomplete"


def resumable_state(path: Path, run_dir: Path | None = None) -> bool:
    return state_resume_status(path, run_dir) == "ready"
