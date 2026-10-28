"""Training run directories, autosave retention and human-readable summaries."""
import os
import tempfile
from pathlib import Path

from backend.log import log


def safe_output_name(output_name: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in output_name).strip("._-") or "my_lora"


def _prepare_writable_directory(path: Path) -> bool:
    """创建目录并进行一次真实写入探针，尽早给出可操作的路径错误。"""
    existed = path.exists()
    path.mkdir(parents=True, exist_ok=True)
    try:
        fd, probe = tempfile.mkstemp(prefix=".anima-write-test-", dir=path)
        os.close(fd)
        Path(probe).unlink(missing_ok=True)
    except OSError:
        if not existed:
            try:
                path.rmdir()
            except OSError:
                pass
        raise
    return not existed


def _prepare_output_directories(*directories: Path) -> None:
    """依次探测产物与内部目录；失败时回收本次新建的空目录。"""
    prepared: set[Path] = set()
    created: list[Path] = []
    try:
        for directory in directories:
            resolved = directory.resolve()
            if resolved in prepared:
                continue
            if _prepare_writable_directory(resolved):
                created.append(resolved)
            prepared.add(resolved)
    except OSError:
        for directory in reversed(created):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise


def prepare_run_directories(
    artifact_dir: Path, internal_dir: Path, *, resume: bool = False, owned: list[Path] | None = None,
) -> None:
    """Claim new run directories exclusively before writing any run files."""
    created: list[Path] = []
    try:
        if not resume and artifact_dir != internal_dir:
            artifact_dir.mkdir(parents=True, exist_ok=False)
            created.append(artifact_dir)
            if owned is not None:
                owned.append(artifact_dir)
        internal_dir.mkdir(parents=True, exist_ok=False)
        created.append(internal_dir)
        if owned is not None:
            owned.append(internal_dir)
        _prepare_output_directories(artifact_dir, internal_dir)
    except OSError:
        for directory in reversed(created):
            try:
                directory.rmdir()
            except OSError:
                pass
        raise


def cleanup_autosave(autosave_dir: str, keep: int = 50) -> None:
    """清理 autosave 目录，仅保留最近 N 个 TOML 文件"""
    try:
        files = sorted(
            [f for f in os.listdir(autosave_dir) if f.endswith(".toml")],
            key=lambda f: os.path.getmtime(os.path.join(autosave_dir, f)),
            reverse=True,
        )
        for old_file in files[keep:]:
            try:
                os.remove(os.path.join(autosave_dir, old_file))
            except OSError:
                pass
    except OSError:
        pass


def write_run_info(run_dir: str, config: dict, train_type: str, timestamp: str, is_resume: bool) -> None:
    """写入人类可读的训练摘要 run_info.txt"""
    try:
        model_path = config.get("pretrained_model_name_or_path") or config.get("dit", "?")
        model_name = os.path.basename(model_path) if model_path else "?"
        dataset = config.get("train_data_dir") or config.get("dataset_config", "?")
        lines = [
            f"Training Run: {os.path.basename(run_dir)}",
            f"Started:      {timestamp}",
            f"Type:         {train_type}",
            f"Resume:       {'yes' if is_resume else 'no'}",
            f"Model:        {model_name}",
            f"Dataset:      {dataset}",
            f"Output Name:  {config.get('output_name', '?')}",
            f"Resolution:   {config.get('resolution', '?')}",
            f"Batch Size:   {config.get('train_batch_size', '?')}",
            f"LR:           {config.get('learning_rate', '?')}"
            + (f"  (unet={config['unet_lr']})" if config.get('unet_lr') else "")
            + (f"  (te={config['text_encoder_lr']})" if config.get('text_encoder_lr') else ""),
            f"Optimizer:    {config.get('optimizer_type', '?')}",
            f"Network Dim:  {config.get('network_dim', '?')}",
            f"Network Alpha:{config.get('network_alpha', '?')}",
            f"Epochs:       {config.get('max_train_epochs', '?')}",
            f"Mixed Prec:   {config.get('mixed_precision', '?')}",
            f"Seed:         {config.get('seed', '?')}",
            "",
            "Full config:  config.toml",
            "Training log: train_*.log",
            f"TensorBoard:  {os.path.join(run_dir, 'log')}",
            f"Artifacts:    {config.get('output_dir', run_dir)}",
            f"Model files:  {os.path.join(str(config.get('output_dir', run_dir)), '*.safetensors')}",
            f"Samples:      {os.path.join(str(config.get('output_dir', run_dir)), 'sample')}",
        ]
        info_path = os.path.join(run_dir, "run_info.txt")
        with open(info_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except OSError as e:
        log.warning(f"Failed to write run_info.txt / 写入失败: {e}")
