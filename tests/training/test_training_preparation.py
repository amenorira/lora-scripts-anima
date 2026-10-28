import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from backend.tasks import TaskManager
from backend.training.krea2_network import KREA2_PRESET_FILENAME
from backend.training.preparation import discard_preparation, prepare_training


class TrainingPreparationCleanupTests(unittest.TestCase):
    def test_rejected_launch_removes_all_generated_engine_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manager = TaskManager()

            async def prepare(reservation):
                run_dir = root / f"run_{reservation.task_id[:12]}"
                run_dir.mkdir()
                reservation.owned_run_paths.append(run_dir)
                for name in ("config.toml", "prompts.json", "cache-request.json", KREA2_PRESET_FILENAME):
                    (run_dir / name).write_text("generated", encoding="utf-8")
                return reservation.launch()

            result = asyncio.run(prepare_training(
                prepare, task_manager=manager,
                launcher=lambda **kwargs: {"status": "error", "message": "launch rejected"},
            ))

            self.assertEqual(result["message"], "launch rejected")
            self.assertEqual(list(root.iterdir()), [])
            self.assertIsNotNone(manager.reserve_task())

    def test_unexpected_artifacts_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            task_id = "abcdef0123456789"
            run_dir = Path(temp_dir) / f"run_{task_id[:12]}"
            run_dir.mkdir()
            (run_dir / "config.toml").write_text("generated", encoding="utf-8")
            model = run_dir / "model.safetensors"
            model.write_bytes(b"user model")
            discard_preparation(SimpleNamespace(
                task_id=task_id, owned_autosave=None, owned_run_paths=[run_dir],
            ))
            self.assertEqual(model.read_bytes(), b"user model")
            self.assertFalse((run_dir / "config.toml").exists())

    def test_directory_without_task_suffix_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            run_dir = Path(temp_dir)
            config = run_dir / "config.toml"
            config.write_text("existing", encoding="utf-8")
            discard_preparation(SimpleNamespace(
                task_id="abcdef0123456789", owned_autosave=None, owned_run_paths=[run_dir],
            ))
            self.assertEqual(config.read_text(encoding="utf-8"), "existing")
