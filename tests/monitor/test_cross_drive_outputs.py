import asyncio
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.monitor import history, run_registry
from backend.monitor.artifacts import newest_previews
from backend.monitor.monitor import TaskMonitor


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
    def test_artifact_count_change_refreshes_older_preview_before_notice(self):
        sample = self.external / "sample"
        sample.mkdir()
        (sample / "demo_000002_00_20261114090002.png").write_bytes(b"latest")
        record = {"artifact_available": True, "artifact_path": self.external}
        monitor = TaskMonitor()
        clock = SimpleNamespace(monotonic=lambda: 10.0)

        async def collect():
            with (
                patch("backend.monitor.monitor.time", clock),
                patch("backend.monitor.monitor.realtime_hub.subscriber_count", return_value=1),
                patch("backend.monitor.monitor.realtime_hub.publish") as publish,
            ):
                await monitor._collect_artifact_update("sample", record)
                (sample / "demo_000001_00_20261114090001.png").write_bytes(b"earlier")
                clock.monotonic = lambda: 12.0
                await monitor._collect_artifact_update("sample", record)
                clock.monotonic = lambda: 14.0
                await monitor._collect_artifact_update("sample", record)
                (self.external / "model.safetensors").write_bytes(b"model")
                clock.monotonic = lambda: 16.0
                await monitor._collect_artifact_update("sample", record)
                clock.monotonic = lambda: 18.0
                await monitor._collect_artifact_update("sample", record)
                self.assertEqual(
                    [(args.args[2]["output_count"], args.args[2]["previews_changed"]) for args in publish.await_args_list],
                    [(2, True), (3, False)],
                )

        asyncio.run(collect())
        previews = newest_previews(str(self.external))
        self.assertEqual(len(previews), 2)
        self.assertIn("000002", previews[-1]["name"])

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


    def test_live_log_cursor_keeps_overwrites_and_resets(self):
        log = self.output / "train_tail.log"
        log.write_bytes(b"log\n" * 1100 + b"open frame")
        monitor = TaskMonitor()
        with patch("backend.monitor.monitor.find_train_log_path", return_value=log):
            initial = monitor._read_log_delta("tail")
            self.assertEqual((initial["total"], len(initial["lines"])), (1101, 1000))
            self.assertTrue(initial["truncated"])
            with log.open("ab") as stream:
                stream.write(b" completed\nnext\n")
            delta = monitor._read_log_delta("tail")
            self.assertEqual((delta["offset"], delta["lines"]), (1100, ["open frame completed", "next"]))
            log.write_bytes(b"replacement\n")
            reset = monitor._read_log_delta("tail")
            self.assertTrue(reset["reset"])
            self.assertEqual((reset["offset"], reset["lines"]), (0, ["replacement"]))


if __name__ == "__main__":
    unittest.main()
