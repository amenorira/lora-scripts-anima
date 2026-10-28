import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

from backend.monitor import history, routes, run_registry
from backend.training.supervisor import _write_result_json
from backend.training.training_config import build_training_config, write_training_config
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

    def test_unknown_legacy_profile_is_viewable_but_not_silently_reused(self):
        self.make_run()
        snapshot = asyncio.run(routes.get_config_from_run("output/demo"))["data"]
        self.assertTrue(snapshot["content"])
        self.assertIsNone(snapshot["reuse_params"])
        self.assertIn("训练类型", snapshot["reuse_error"])

    def test_yaml_copy_keeps_snapshot_and_preview_settings_without_resuming(self):
        run = self.make_run()
        document = build_training_config({
            "model_train_type": "anima-lora", "resume": "old-state", "output_dir": str(self.external),
            "enable_preview": True, "positive_prompts": "a character", "network_dim": 16,
        }, profile_id="anima-lora")
        write_training_config(run / "training.yaml", document)
        snapshot = asyncio.run(routes.get_config_from_run("output/demo"))["data"]
        self.assertEqual(snapshot["config_format"], "yaml")
        self.assertEqual(snapshot["params"]["resume"], "old-state")
        self.assertEqual(snapshot["reuse_params"]["resume"], "")
        self.assertEqual(snapshot["reuse_params"]["output_dir"], str(self.external.parent))
        self.assertEqual(snapshot["reuse_params"]["positive_prompts"], "a character")
        self.assertTrue(snapshot["reuse_params"]["enable_preview"])

    def test_invalid_yaml_network_is_viewable_but_cannot_be_reused(self):
        run = self.make_run()
        document = build_training_config({
            "model_train_type": "anima-lora", "network_module": "lycoris.kohya",
            "lycoris_preset": "attn-only", "lycoris_algo": "lokr",
        }, profile_id="anima-lora")
        write_training_config(run / "training.yaml", document)
        snapshot = asyncio.run(routes.get_config_from_run("output/demo"))["data"]
        self.assertEqual(snapshot["config_format"], "yaml")
        self.assertTrue(snapshot["content"])
        self.assertEqual(snapshot["params"]["lycoris_preset"], "attn-only")
        self.assertIn("Anima", snapshot["reuse_error"])
        self.assertIsNone(snapshot["reuse_params"])

    def test_malformed_result_and_extra_do_not_hide_other_records(self):
        run = self.make_run("bad")
        (run / "result.json").write_text("[]", encoding="utf-8")
        (run / "task_meta.json").write_text('{"extra": [1, 2]}', encoding="utf-8")
        good = self.make_run("good")
        (good / "result.json").write_text('{"status": "timeout"}', encoding="utf-8")
        items = {item["name"]: item for item in history.scan_history()}
        self.assertEqual(items["bad"]["status"], "unknown")
        self.assertEqual(items["bad"]["warning"], "result_unreadable")
        self.assertEqual(items["good"]["status"], "failed")

    def test_active_run_is_not_duplicated_and_finishing_invalidates_cache(self):
        run = self.make_run(task_id="active")
        history.scan_history()
        with patch.object(routes.tm, "training_dump", return_value=[{"id": "active", "status": "RUNNING"}]):
            data = asyncio.run(routes.monitor_history())["data"]
        self.assertEqual(data["history"], [])
        self.assertEqual(data["running"]["run_dir"], "output/demo")
        _write_result_json(run, "active", "error", 1, "failure", 42)
        self.assertEqual(history.scan_history()[0]["status"], "failed")
        self.make_run("new")
        self.assertEqual(len(history.scan_history()), 2)

    def test_record_date_survives_config_mtime_changes(self):
        run = self.make_run()
        meta = json.loads((run / "task_meta.json").read_text(encoding="utf-8"))
        meta.pop("created_at")
        meta["snapshot_time"] = "2026-07-04T13:49:34"
        (run / "task_meta.json").write_text(json.dumps(meta), encoding="utf-8")
        os.utime(run / "config.toml", (100, 100))
        self.assertEqual(history.scan_history()[0]["time"], "2026-07-04 13:49")

    def test_external_legacy_import_keeps_training_time_and_profile_metadata(self):
        self._write_config(self.external / "config.toml", self.external)
        self._write_config(self.autosave / "external.toml", self.external)
        (self.external / "task_meta.json").write_text(json.dumps({
            "snapshot_time": "2026-07-04T13:49:34",
            "extra": {"trainer_file": "./vendor/sd-scripts/sdxl_train_network.py"},
        }), encoding="utf-8")
        item = history.scan_history()[0]
        self.assertEqual(item["time"], "2026-07-04 13:49")
        self.assertEqual(item["profile_id"], "sdxl-lora")
        snapshot = asyncio.run(routes.get_config_from_run(item["run_dir"]))["data"]
        self.assertEqual(snapshot["reuse_params"]["model_train_type"], "sdxl-lora")

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
