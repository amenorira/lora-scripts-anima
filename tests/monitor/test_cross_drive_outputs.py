import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.monitor import history, run_registry


class CrossDriveSandbox(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        self.output = self.root / "output"
        self.autosave = self.root / "config" / "autosave"
        self.external = self.root / "external-output"
        self.output.mkdir(parents=True)
        self.autosave.mkdir(parents=True)
        self.external.mkdir(parents=True)

        self._patches = ExitStack()
        self._patches.enter_context(patch.object(run_registry, "REPO_ROOT", self.root))
        self._patches.enter_context(patch.object(run_registry, "OUTPUT_DIR", self.output))
        self._patches.enter_context(patch.object(run_registry, "AUTOSAVE_DIR", self.autosave))
        history.invalidate_history_cache()

    def tearDown(self):
        self._patches.close()
        history.invalidate_history_cache()
        self._temp.cleanup()

    @staticmethod
    def _write_config(path: Path, artifact_dir: Path, name: str = "demo") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f'output_name = "{name}"\n'
            f'output_dir = "{artifact_dir.as_posix()}"\n'
            'pretrained_model_name_or_path = "model.safetensors"\n'
            'learning_rate = 0.0001\n'
            'network_dim = 32\n'
            'max_train_epochs = 2\n',
            encoding="utf-8",
        )


class RunRegistryTests(CrossDriveSandbox):
    def test_deleting_history_keeps_models_checkpoints_and_previews(self):
        for suffix, external in (("external", True), ("default", False)):
            with self.subTest(storage=suffix):
                internal = self.output / f"delete_{suffix}"
                artifact = (self.external / internal.name) if external else internal
                artifact.mkdir(parents=True)
                self._write_config(internal / "config.toml", artifact, suffix)
                run_registry.write_run_record(internal, artifact_dir=artifact, task_id=f"task-{suffix}")

                (internal / "train_task.log").write_text("log", encoding="utf-8")
                (internal / "result.json").write_text("{}", encoding="utf-8")
                (internal / "output_dir.txt").write_text(str(artifact), encoding="utf-8")
                (internal / "log").mkdir()
                (internal / "log" / "events.out.tfevents.test").write_bytes(b"tb")
                (artifact / "sample").mkdir(exist_ok=True)
                (artifact / "sample" / "preview.png").write_bytes(b"image")
                (artifact / "demo.safetensors").write_bytes(b"weights")
                (artifact / "demo-state").mkdir()
                (artifact / "demo-state" / "state.json").write_text("{}", encoding="utf-8")

                self.assertTrue(run_registry.mark_run_deleted(internal))
                self.assertFalse((internal / "config.toml").exists())
                self.assertFalse((internal / "train_task.log").exists())
                self.assertFalse((internal / "output_dir.txt").exists())
                self.assertFalse((internal / "log").exists())
                self.assertTrue((artifact / "demo.safetensors").exists())
                self.assertTrue((artifact / "sample" / "preview.png").exists())
                self.assertTrue((artifact / "demo-state" / "state.json").exists())
                tombstone = json.loads((internal / "task_meta.json").read_text(encoding="utf-8"))
                self.assertTrue(tombstone["deleted"])
                self.assertIsNone(run_registry.load_run_record(internal))


if __name__ == "__main__":
    unittest.main()
