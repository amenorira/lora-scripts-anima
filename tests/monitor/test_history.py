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

    def test_legacy_copy_converts_native_arguments_and_clears_only_the_copy_resume(self):
        run = self.make_run(extra={"trainer_file": "./vendor/sd-scripts/anima_train_network.py"})
        with (run / "config.toml").open("a", encoding="utf-8") as handle:
            handle.write('resume = "old-state"\nnetwork_module = "lycoris.kohya"\n'
                         'network_args = ["algo=lokr", "preset=attn-mlp", "factor=8", "full_matrix=true"]\n'
                         'optimizer_type = "AdamW"\noptimizer_args = ["weight_decay=0.03", "betas=(0.8, 0.98)"]\n'
                         'lr_scheduler = "warmup_stable_decay"\nlr_scheduler_args = ["decay_type=\'1-sqrt\'"]\n')
        response = asyncio.run(routes.get_config_from_run("output/demo"))
        self.assertEqual(response["status"], "success")
        snapshot = response["data"]
        form = snapshot["reuse_params"]
        self.assertEqual(form["model_train_type"], "anima-lora")
        self.assertEqual(form["lycoris_algo"], "lokr")
        self.assertEqual(form["lokr_factor"], 8)
        self.assertTrue(form["full_matrix"])
        self.assertEqual(form["weight_decay"], 0.03)
        self.assertEqual(form["decay_type"], "1-sqrt")
        self.assertEqual(form["resume"], "")
        self.assertEqual(form["output_dir"], str(self.external.parent))
        self.assertEqual(snapshot["params"]["resume"], "old-state")
        self.assertIn('resume = "old-state"', snapshot["content"])


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
        self.assertTrue(history.scan_history()[0]["deletion_pending"])
        self.assertEqual(history.scan_history()[0]["name"], "demo")
        self.assertTrue(log.exists())
        result = asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))
        self.assertEqual(result["status"], "success")
        self.assertEqual(history.scan_history(), [])
        self.assertEqual(model.read_bytes(), b"model")
        self.assertFalse(log.exists())
