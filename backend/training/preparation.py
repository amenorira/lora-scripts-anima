"""Own a training reservation and its generated files until launch succeeds.

The HTTP boundary supplies the task manager and launcher; this module returns
plain results and does not depend on FastAPI or route modules.
"""
from pathlib import Path

from backend.async_utils import settled_to_thread as _settled_to_thread
from backend.log import log
from backend.training.krea2_cache import mark_cache_manifest, prepare_cache_manifest


def training_error(message: str, data: dict | None = None) -> dict:
    return {"status": "error", "message": message, "data": data}


class TrainingPreparation:
    """Owns generated files until the launcher accepts the reserved task."""

    def __init__(self, task, launcher):
        self._launcher = launcher
        self.task = task
        self.task_id = task.task_id
        self.owned_run_paths: list[Path] = []
        self.owned_autosave: Path | None = None
        self.owned_cache_manifest: dict | None = None
        self.launched = False

    async def prepare_cache_manifest(self, config: dict) -> None:
        def write_manifest():
            prepare_cache_manifest(config)
            self.owned_cache_manifest = config

        await _settled_to_thread(write_manifest)

    def launch(self, *args, **kwargs):
        if self.task.stop_requested:
            return training_error("Training preparation cancelled / 训练准备已取消")
        result = self._launcher(*args, reserved_task=self.task, **kwargs)
        self.launched = result.get("status") == "success"
        return result


async def prepare_training(helper, *args, task_manager, launcher):
    task = task_manager.reserve_task()
    if task is None:
        return training_error(
            "Training, tagging or generation task is active / 训练、打标或正则生成任务正在运行",
            {"errorCode": "taskActive"},
        )
    preparation = TrainingPreparation(task, launcher)
    try:
        result = await helper(*args, preparation)
        if task.stop_requested and not preparation.launched:
            result = training_error("Training preparation cancelled / 训练准备已取消")
    except Exception as exc:
        log.exception("Failed to prepare training / 训练准备失败")
        result = training_error(f"Failed to prepare training / 训练准备失败: {exc}")
    finally:
        if not preparation.launched:
            try:
                if preparation.owned_cache_manifest is not None:
                    try:
                        await _settled_to_thread(mark_cache_manifest, preparation.owned_cache_manifest, "failed")
                    except Exception as exc:
                        log.exception("Failed to settle Krea 2 cache manifest / 无法结算 Krea 2 缓存记录")
                        result = training_error(f"Failed to settle Krea 2 cache / 无法结算 Krea 2 缓存: {exc}")
            finally:
                discard_preparation(preparation)
                task_manager.release_reserved(task)
    return result


def discard_preparation(task) -> None:
    """Remove only files made in exclusively claimed, unlaunched run folders."""
    autosave = task.owned_autosave
    if autosave is not None and task.task_id[:12] in autosave.name:
        try:
            autosave.unlink(missing_ok=True)
        except OSError:
            log.warning("Could not remove failed autosave / 无法清理失败的自动保存: %s", autosave)
    created = list(dict.fromkeys(task.owned_run_paths))
    generated = {
        "config.toml", "training.yaml", "dataset.toml", "sample_prompts.txt",
        "prompts.txt", "run_info.txt", "output_dir.txt",
    }
    for directory in reversed(created):
        # A unique task suffix and an exclusive mkdir are required for ownership.
        if task.task_id[:12] not in directory.name or directory.is_symlink():
            continue
        if not directory.exists():
            continue
        try:
            for name in generated:
                (directory / name).unlink(missing_ok=True)
            directory.rmdir()
        except OSError:
            # Any unexpected content is left in place rather than recursively deleted.
            log.warning("Incomplete run preparation retained / 保留未完成的运行目录: %s", directory)
