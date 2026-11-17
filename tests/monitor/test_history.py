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

    def test_snapshot_parameters_keep_native_values_separate_from_reuse_conversion(self):
        run = self.make_run(extra={"profile_id": "anima-lora"})
        with (run / "config.toml").open("a", encoding="utf-8") as stream:
            stream.write(
                'network_module = "networks.lora_anima"\n'
                'optimizer_type = "prodigyplus.ProdigyPlusScheduleFree"\n'
                'optimizer_args = ["eps=None"]\n'
                'lr_scheduler = "piecewise_constant"\n'
                'lr_scheduler_args = ["step_rules=\'1:100,0.5\'"]\n'
                'step_rules = "1:200,0.2"\n'
            )
        result = asyncio.run(routes.get_config_from_run("output/demo"))
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertEqual(data["training_profile"], "anima-lora")
        saved = {param["key"]: param for param in data["train_params"]}
        self.assertEqual(saved["optimizer_args.eps"]["value"], "None")
        self.assertEqual(saved["lr_scheduler_args.step_rules"]["string_value"], "1:100,0.5")
        self.assertEqual(data["reuse_params"]["step_rules"], "1:200,0.2")

    def test_run_detail_keeps_log_ownership_when_artifacts_are_shared(self):
        self.make_run("original", task_id="original-task")
        self.make_run("resumed", task_id="resumed-task")
        for name in ("original", "resumed"):
            with self.subTest(name=name):
                response = asyncio.run(routes.monitor_run_detail(f"output/{name}"))
                self.assertEqual(response["status"], "success")
                self.assertEqual(response["data"]["task_id"], f"{name}-task")
                self.assertEqual(response["data"]["artifact_dir"], str(self.external))
