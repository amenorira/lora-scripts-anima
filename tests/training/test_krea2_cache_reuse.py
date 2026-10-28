import asyncio
import json
from pathlib import Path
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.training import krea2_cache_runner as runner
from backend.training.core_registry import MUSUBI_TUNER_DIR
from backend.training.krea2_cache import (
    complete_stage, cache_manifest_path, get_krea2_cache_status,
    mark_cache_manifest, prepare_cache_manifest,
)
from tests.training.test_multi_core_krea2 import krea2_config


class Krea2CacheReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = krea2_config(self.root)
        self.cache = Path(self.config["dataset_cache_dir"])
        self.latent = self.cache / "portrait_0128x0128_kr2.safetensors"
        self.text = self.cache / "portrait_kr2_te.safetensors"

    def finish_cache(self):
        prepare_cache_manifest(self.config)
        self.latent.write_bytes(b"image-cache")
        self.text.write_bytes(b"text-cache")
        complete_stage(self.config, "latents")
        complete_stage(self.config, "text_encoder")
        self.assertIsNone(mark_cache_manifest(self.config, "completed"))
        self.assertTrue(get_krea2_cache_status(self.config)["ready"])

    def test_unchanged_inputs_skip_both_model_loads(self):
        self.finish_cache()
        prepared = prepare_cache_manifest(self.config)
        self.assertEqual(prepared["stages"], {"latents": "completed", "text_encoder": "completed"})
        with patch.object(sys, "argv", self.runner_args()), patch.object(runner, "_run") as launch:
            runner.main()
        launch.assert_not_called()

    def test_changed_inputs_invalidate_only_the_affected_stage(self):
        cases = ("caption", "image", "vae", "text_encoder", "tiling", "force")
        for case in cases:
            with self.subTest(case=case):
                self.config["krea_cache_reuse"] = True
                self.config["krea_cache_vae_tiling"] = False
                self.finish_cache()
                expected = {"latents": "completed", "text_encoder": "completed"}
                if case in ("caption", "image"):
                    path = Path(self.config["train_data_dir"]) / ("portrait.txt" if case == "caption" else "portrait.png")
                    path.write_bytes(path.read_bytes() + b"changed")
                    expected["text_encoder" if case == "caption" else "latents"] = "pending"
                elif case in ("vae", "text_encoder"):
                    path = Path(self.config[case])
                    path.write_bytes(path.read_bytes() + b"changed")
                    expected["latents" if case == "vae" else "text_encoder"] = "pending"
                elif case == "tiling":
                    self.config["krea_cache_vae_tiling"] = True
                    expected["latents"] = "pending"
                else:
                    self.config["krea_cache_reuse"] = False
                    expected = dict.fromkeys(expected, "pending")
                self.assertEqual(prepare_cache_manifest(self.config)["stages"], expected)

    def test_failed_text_stage_retains_completed_image_stage(self):
        prepare_cache_manifest(self.config)
        self.latent.write_bytes(b"image-cache")
        complete_stage(self.config, "latents")
        mark_cache_manifest(self.config, "failed")
        self.assertEqual(prepare_cache_manifest(self.config)["stages"],
                         {"latents": "completed", "text_encoder": "pending"})

    def test_modified_output_is_rebuilt_and_changed_input_cannot_finish(self):
        self.finish_cache()
        self.text.write_bytes(b"truncated")
        self.assertFalse(get_krea2_cache_status(self.config)["ready"])
        self.assertEqual(prepare_cache_manifest(self.config)["stages"]["text_encoder"], "pending")
        caption = Path(self.config["train_data_dir"]) / "portrait.txt"
        caption.write_text("new caption", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            complete_stage(self.config, "text_encoder")
        self.assertIsNotNone(mark_cache_manifest(self.config, "completed"))
        self.assertFalse(get_krea2_cache_status(self.config)["ready"])

    def runner_args(self):
        request = self.root / "request.json"
        request.write_text(json.dumps(self.config), encoding="utf-8")
        dataset = self.root / "dataset.toml"
        dataset.write_text('[general]\nbatch_size = 1\n[[datasets]]\nimage_directory = "images"\nbatch_size = 1\n', encoding="utf-8")
        return ["runner", "--musubi-root", str(MUSUBI_TUNER_DIR), "--dataset-config", str(dataset),
                "--vae", self.config["vae"], "--text-encoder", self.config["text_encoder"],
                "--request-file", str(request), "--latent-device", "cpu", "--text-device", "cuda",
                "--latent-cache-batch-size", "2", "--text-cache-batch-size", "3", "--num-workers", "4", "--vae-tiling"]

    def test_runner_routes_settings_to_each_stage(self):
        self.config["krea_cache_vae_tiling"] = True
        prepare_cache_manifest(self.config)
        commands = []

        def run(label, command):
            commands.append(command)
            (self.latent if command[command.index("--stage") + 1] == "latents" else self.text).write_bytes(b"cache")

        with patch.object(sys, "argv", self.runner_args()), patch.object(runner, "_run", side_effect=run):
            runner.main()
        latent, text = commands
        self.assertEqual(latent[latent.index("--device") + 1], "cpu")
        self.assertEqual(text[text.index("--device") + 1], "cuda")
        self.assertEqual(latent[latent.index("--batch_size") + 1], "2")
        self.assertEqual(text[text.index("--batch_size") + 1], "3")
        self.assertIn("--vae-tiling", latent)
        self.assertNotIn("--vae-tiling", text)
        self.assertTrue(all(command[command.index("--num_workers") + 1] == "4" for command in commands))
        for command, expected_batch in ((latent, 2), (text, 3)):
            dataset = tomllib.loads(Path(command[command.index("--dataset_config") + 1]).read_text(encoding="utf-8"))
            self.assertEqual(dataset["general"]["batch_size"], expected_batch)
            self.assertEqual(dataset["datasets"][0]["batch_size"], expected_batch)
        self.assertIsNone(mark_cache_manifest(self.config, "completed"))

    def test_completion_rejects_changed_or_empty_outputs(self):
        self.finish_cache()
        self.text.write_bytes(b"changed after stage completion")
        self.assertIn("outputs changed", mark_cache_manifest(self.config, "completed"))
        self.assertFalse(get_krea2_cache_status(self.config)["ready"])
        prepare_cache_manifest(self.config)
        self.text.write_bytes(b"")
        self.assertIn("Empty cache file", mark_cache_manifest(self.config, "completed"))

    def test_legacy_manifest_can_train_but_rebuilds_before_reuse(self):
        self.finish_cache()
        path = cache_manifest_path(self.cache)
        legacy = json.loads(path.read_text(encoding="utf-8"))
        for key in ("outputs", "stage_fingerprints"):
            legacy.pop(key)
        legacy["schema"] = 1
        path.write_text(json.dumps(legacy), encoding="utf-8")
        self.assertTrue(get_krea2_cache_status(self.config)["ready"])
        self.assertEqual(prepare_cache_manifest(self.config)["stages"],
                         {"latents": "pending", "text_encoder": "pending"})

    def test_worker_preserves_native_vae_argument_and_enables_requested_tiling(self):
        from backend.training import krea2_cache_worker as worker

        for tiling in (False, True):
            with self.subTest(tiling=tiling):
                vae = Mock()
                loader = Mock(return_value=vae)
                fake = SimpleNamespace(qwen_image_utils=SimpleNamespace(load_vae=loader))
                forwarded = []

                def main():
                    forwarded.extend(sys.argv[1:])
                    fake.qwen_image_utils.load_vae("model.safetensors", device="cpu")

                fake.main = main
                argv = ["worker", "--stage", "latents", "--musubi-root", str(MUSUBI_TUNER_DIR),
                        "--vae", "model.safetensors", "--device", "cpu"]
                if tiling:
                    argv.append("--vae-tiling")
                with patch.object(sys, "argv", argv), patch.object(sys, "path", list(sys.path)), \
                     patch.dict(sys.modules, {"musubi_tuner": SimpleNamespace(krea2_cache_latents=fake)}):
                    worker.main()
                self.assertEqual(forwarded, ["--vae", "model.safetensors", "--device", "cpu"])
                loader.assert_called_once_with("model.safetensors", device="cpu")
                self.assertEqual(vae.enable_tiling.call_count, int(tiling))

    def test_cache_endpoint_passes_settings_and_writes_request(self):
        from backend.server.routes import training as routes
        from backend.tasks import TaskManager
        from tests.helpers import json_request

        self.config.update(krea_latent_cache_device="cpu", krea_text_cache_device="cpu",
                           krea_latent_cache_batch_size=2, krea_cache_num_workers=3, krea_cache_vae_tiling=True)
        with patch.object(routes, "tm", TaskManager()), patch.object(routes, "OUTPUT_DIR", self.root / "runs"), \
             patch.object(routes, "krea2_preflight", return_value={"ok": True}), \
             patch.object(routes, "run_train", return_value={"status": "success", "data": {}}) as launch:
            result = asyncio.run(routes.create_krea2_cache(json_request(dict(self.config))))
        self.assertEqual(result["status"], "success")
        arguments = launch.call_args.kwargs["extra_args"]
        self.assertEqual(arguments[arguments.index("--latent-device") + 1], "cpu")
        self.assertEqual(arguments[arguments.index("--text-device") + 1], "cpu")
        self.assertEqual(arguments[arguments.index("--latent-cache-batch-size") + 1], "2")
        self.assertEqual(arguments[arguments.index("--num-workers") + 1], "3")
        self.assertIn("--vae-tiling", arguments)
        request = json.loads(Path(arguments[arguments.index("--request-file") + 1]).read_text(encoding="utf-8"))
        self.assertTrue(request["krea_cache_vae_tiling"])
