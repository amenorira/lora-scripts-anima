import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from backend.training.cache import krea2_cache_runner as runner
from backend.training.core_registry import MUSUBI_TUNER_DIR
from backend.training.cache.krea2_cache import complete_stage, get_krea2_cache_status, mark_cache_manifest, prepare_cache_manifest
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
