import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.musubi_krea2 import (
    KREA2_FIELDS, build_krea2_dataset_config, build_krea2_train_config,
    cache_manifest_path, get_krea2_cache_status, krea2_preflight,
    mark_cache_manifest, prepare_cache_manifest, validate_krea2_config,
)
from backend.server.routes import training as training_routes
from backend.tasks import TaskManager
from tests.helpers import json_request, stub_supervisor


def krea2_config(root: Path) -> dict:
    config = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
    models = root / "models"
    models.mkdir(parents=True)
    for name in ("raw.safetensors", "vae.safetensors", "qwen3vl.safetensors"):
        (models / name).write_bytes(b"test")
    train = root / "train"
    train.mkdir()
    (train / "portrait.png").write_bytes(b"not-decoded-by-schema-tests")
    (train / "portrait.txt").write_text("a portrait", encoding="utf-8")
    config.update(
        {
            "model_train_type": "krea2-lora",
            "dit": str(models / "raw.safetensors"),
            "vae": str(models / "vae.safetensors"),
            "text_encoder": str(models / "qwen3vl.safetensors"),
            "train_data_dir": str(train),
            "dataset_cache_dir": str(train / ".krea2-cache"),
            "output_dir": str(root / "output"),
            "output_name": "krea2_test",
        }
    )
    return config


class Krea2PreparationLifecycleTests(unittest.TestCase):
    def test_cache_status_enumerates_once_and_prunes_cache_subtrees(self):
        from backend.training import musubi_krea2 as krea
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            (cache / "ignored.png").touch()
            (cache / "ignored.txt").touch()
            visited = []
            real_walk = krea.os.walk
            def walk(*args, **kwargs):
                for entry in real_walk(*args, **kwargs):
                    visited.append(Path(entry[0]))
                    yield entry
            with patch.object(krea.os, "walk", side_effect=walk), patch.object(krea, "image_files", wraps=krea.image_files) as scan:
                status = krea.get_krea2_cache_status(config)
                self.assertEqual(status["image_count"], 1)
                scan.assert_called_once()
            self.assertNotIn(cache, visited)
            images = krea.image_files(config["train_data_dir"], cache)
            self.assertEqual(krea.krea2_cache_fingerprint(config), krea.krea2_cache_fingerprint(config, images))

    def test_real_launcher_rejection_keeps_slot_through_manifest_rollback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            manager = TaskManager()
            settling, release = threading.Event(), threading.Event()

            def settle_manifest(config, status):
                settling.set()
                if not release.wait(5):
                    raise TimeoutError("manifest settlement was not released")
                mark_cache_manifest(config, status)

            async def exercise():
                loop = asyncio.get_running_loop()
                real_submit = loop.run_in_executor

                def submit(executor, func, *args):
                    if getattr(func, "__name__", "") == "_run":
                        raise RuntimeError("executor shutdown")
                    return real_submit(executor, func, *args)

                with patch.object(loop, "run_in_executor", side_effect=submit):
                    request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                    self.assertTrue(await asyncio.to_thread(settling.wait, 5))
                    self.assertIsNone(manager.reserve_task())
                    self.assertFalse(manager.begin_dataset_mutation())
                    release.set()
                    return await request

            with patch.object(training_routes, "tm", manager), \
                 patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(training_routes, "mark_cache_manifest", side_effect=settle_manifest), \
                 stub_supervisor():
                try:
                    response = asyncio.run(exercise())
                finally:
                    release.set()

            self.assertEqual(response.status, "fail")
            self.assertIn("executor shutdown", response.message)
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})
            self.assertIsNotNone(manager.reserve_task())


class Krea2CodecTests(unittest.TestCase):
    def test_generates_separate_dataset_and_train_tomls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update({"network_alpha": 2, "network_dropout": 1.0})

            self.assertEqual(validate_krea2_config(config), [])
            dataset = build_krea2_dataset_config(config)
            train = build_krea2_train_config(config, root / "run" / "dataset.toml", root / "artifact", root / "run" / "log")

            config["network_alpha"] = 1.5
            errors = validate_krea2_config(config)
            self.assertTrue(any("network_alpha" in error and "整数" in error for error in errors), errors)

        self.assertEqual(dataset["general"]["resolution"], [1024, 1024])
        self.assertEqual(train["network_alpha"], 2)
        self.assertEqual(train["network_dropout"], 1.0)
        self.assertEqual(dataset["datasets"][0]["cache_directory"], config["dataset_cache_dir"])
        self.assertEqual(train["network_module"], "networks.lora_krea2")
        self.assertNotIn("text_encoder", train)
        self.assertNotIn("train_batch_size", train)
        self.assertNotIn("save_model_as", train)
        self.assertNotIn("attn_mode", train)
        self.assertEqual(train["sigmoid_scale"], 1.0)
        self.assertTrue(train["sdpa"])


    def test_same_stem_images_are_rejected_before_cache_launch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            (Path(config["train_data_dir"]) / "portrait.jpg").write_bytes(b"image")
            with patch("backend.training.musubi_krea2.shared_runtime_status", return_value={"errors": []}), \
                 patch.object(training_routes, "tm", TaskManager()), \
                 patch.object(training_routes, "run_train") as launch:
                for require_cache in (False, True):
                    result = krea2_preflight(config, require_cache=require_cache)
                    self.assertFalse(result["ok"])
                    conflict = next(error for error in result["errors"] if "缓存名称冲突" in error)
                    self.assertIn("portrait.png", conflict)
                    self.assertIn("portrait.jpg", conflict)
                response = asyncio.run(training_routes.create_krea2_cache(json_request(dict(config))))
            self.assertEqual(response.status, "fail")
            launch.assert_not_called()
            self.assertFalse(cache_manifest_path(config["dataset_cache_dir"]).exists())


    def test_cache_completion_rejects_dataset_changes_during_encoding(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            prepare_cache_manifest(config)
            (cache / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
            (cache / "portrait_krea2_te.safetensors").write_bytes(b"text")
            (Path(config["train_data_dir"]) / "portrait.txt").write_text("changed", encoding="utf-8")
            mark_cache_manifest(config, "completed")
            status = get_krea2_cache_status(config)
            self.assertTrue(status["files_match"])
            self.assertFalse(status["fingerprint_matches"])
            self.assertFalse(status["ready"])
            self.assertEqual(status["stages"], {"latents": "failed", "text_encoder": "failed"})

    def test_missing_dataset_path_never_scans_the_working_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = {"dataset_cache_dir": temp_dir}
            with patch.object(Path, "rglob", side_effect=AssertionError("unexpected dataset scan")):
                prepare_cache_manifest(config)
                mark_cache_manifest(config, "completed")
                status = get_krea2_cache_status(config)
            self.assertEqual(status["image_count"], 0)
            self.assertFalse(status["ready"])
            self.assertEqual(status["stages"], {"latents": "failed", "text_encoder": "failed"})


if __name__ == "__main__":
    unittest.main()
