import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.training.config.musubi_krea2 import KREA2_FIELDS
from backend.training.datasets.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.execution.krea2_preflight import krea2_preflight
from backend.training.cache.krea2_cache import (
    cache_manifest_path, get_krea2_cache_status, mark_cache_manifest, prepare_cache_manifest,
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


class Krea2EstimateLocalizationTests(unittest.TestCase):
    def test_specific_error_codes_preserve_distinct_causes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            cases = [
                ({"resolution": "1024"}, "krea2ResolutionFormat"),
                ({"resolution": "wrong,1024"}, "krea2ResolutionIntegers"),
                ({"resolution": "1000,1000"}, "krea2ResolutionMultiple16"),
                ({"train_data_dir": str(Path(temp_dir) / "missing")}, "krea2NoCaptionedImages"),
                ({"train_batch_size": "bad"}, "krea2BatchIntegers"),
                ({"train_batch_size": 0}, "krea2BatchPositive"),
                ({"max_train_epochs": 0}, "krea2EpochsPositive"),
                ({"krea_training_duration_mode": "steps", "max_train_steps": 0}, "krea2StepsPositive"),
            ]
            for overrides, code in cases:
                with self.subTest(code=code), self.assertRaises(StepEstimateError) as caught:
                    estimate_training_steps({**config, **overrides})
                self.assertEqual(caught.exception.code, code)

    def test_estimate_route_returns_the_specific_error_code(self):
        response = asyncio.run(training_routes.estimate_steps(json_request({
            "model_train_type": "krea2-lora", "resolution": "1000,1000", "train_data_dir": "missing",
        })))
        self.assertEqual(response.status, "fail")
        self.assertEqual(response.data["errorCode"], "krea2ResolutionMultiple16")


class Krea2PreparationLifecycleTests(unittest.TestCase):

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
                 patch.object(training_routes.launch_krea2, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes.launch_krea2, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(training_routes.preparation, "mark_cache_manifest", side_effect=settle_manifest), \
                 stub_supervisor():
                try:
                    response = asyncio.run(exercise())
                finally:
                    release.set()

            self.assertEqual(response.status, "fail")
            self.assertIn("executor shutdown", response.message)
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})
            self.assertEqual(list((root / "runs").iterdir()), [])
            self.assertIsNotNone(manager.reserve_task())


class Krea2CodecTests(unittest.TestCase):


    def test_invalid_runtime_options_are_rejected_before_preflight_and_release_task_slot(self):
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
        cases = (
            ({"optimizer_type": "AdaFactor", "krea_adafactor_relative_step": False,
              "krea_adafactor_warmup_init": True}, "krea_adafactor_warmup_init"),
            ({"mixed_precision": "no"}, "bf16 或 fp16"),
            ({"krea_attention_backend": "sage_attn"}, "训练不支持 SageAttention"),
            ({"optimizer_type": "AdamW", "optimizer_args_custom": "weight_decay=None"},
             "optimizer_args weight_decay: must be a number"),
        )
        app = FastAPI()
        app.include_router(training_routes.router, prefix="/api")
        manager = TaskManager(max_concurrent=1)
        with patch.object(training_routes, "tm", manager), \
             patch.object(training_routes.launch_krea2, "krea2_preflight", side_effect=AssertionError("preflight must not run")) as preflight, \
             patch.object(training_routes.run_files, "prepare_run_directories") as prepare, \
             patch.object(training_routes, "run_train") as launch, TestClient(app) as client:
            for endpoint in ("/api/run", "/api/training/krea2/cache"):
                for changes, message in cases:
                    with self.subTest(endpoint=endpoint, changes=changes):
                        config = {**defaults, "model_train_type": "krea2-lora", **changes}
                        response = client.post(endpoint, json=config)
                        self.assertEqual(response.status_code, 200)
                        result = response.json()
                        self.assertEqual(result["status"], "fail")
                        self.assertEqual(result["data"]["errorCode"], "invalidKrea2Config")
                        self.assertIn(message, result["message"])
                        reserved = manager.reserve_task()
                        self.assertIsNotNone(reserved, "Rejected configuration must release the training slot")
                        manager.release_reserved(reserved)
        preflight.assert_not_called()
        prepare.assert_not_called()
        launch.assert_not_called()


    def test_same_stem_images_are_rejected_before_cache_launch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            (Path(config["train_data_dir"]) / "portrait.jpg").write_bytes(b"image")
            with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}), \
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
