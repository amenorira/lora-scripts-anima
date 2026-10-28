import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from backend.training.execution.preparation import discard_preparation


class TrainingPreparationCleanupTests(unittest.TestCase):

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
