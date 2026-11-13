import asyncio
from pathlib import Path
from unittest.mock import patch

from backend.monitor import history, routes, run_registry
from tests.helpers import json_request
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


class HistoryTests(CrossDriveSandbox):
    def make_run(self, name="demo", **kwargs):
        run = self.output / name
        self._write_config(run / "config.toml", self.external, name)
        run_registry.write_run_record(run, artifact_dir=self.external, **kwargs)
        return run

    def test_partial_delete_stays_visible_and_retry_preserves_artifacts(self):
        run = self.make_run()
        log = run / "train_demo.log"
        log.write_text("log", encoding="utf-8")
        model = self.external / "model.safetensors"
        model.write_bytes(b"model")
        original = Path.unlink

        def locked(path, *args, **kwargs):
            if path == log:
                raise PermissionError("locked")
            return original(path, *args, **kwargs)

        with patch.object(Path, "unlink", locked):
            result = asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["data"]["retryable"])
        self.assertEqual(result["error_code"], "monitorCleanupFailed")
        self.assertEqual(result["error_details"], "train_demo.log")
        self.assertTrue(history.scan_history()[0]["deletion_pending"])
        self.assertEqual(history.scan_history()[0]["name"], "demo")
        self.assertTrue(log.exists())
        result = asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))
        self.assertEqual(result["status"], "success")
        self.assertEqual(history.scan_history(), [])
        self.assertEqual(model.read_bytes(), b"model")
        self.assertFalse(log.exists())
