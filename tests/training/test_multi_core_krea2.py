import ast
import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

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
    def test_adafactor_warmup_requires_relative_step(self):
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
        for optimizer in ("AdaFactor", "adafactor", "AdamW"):
            for relative_step, warmup_init in ((False, False), (False, True), (True, False), (True, True)):
                with self.subTest(optimizer=optimizer, relative_step=relative_step, warmup_init=warmup_init):
                    config = {**defaults, "optimizer_type": optimizer, "lr_scheduler": "cosine",
                              "krea_adafactor_relative_step": relative_step, "krea_adafactor_warmup_init": warmup_init}
                    errors = validate_krea2_config(config)
                    if optimizer != "AdamW" and warmup_init and not relative_step:
                        self.assertTrue(any("krea_adafactor_warmup_init" in error and
                                            "krea_adafactor_relative_step" in error for error in errors), errors)
                        self.assertIs(config["krea_adafactor_relative_step"], False)
                        self.assertEqual(config["lr_scheduler"], "cosine")
                    else:
                        self.assertEqual(errors, [])
                        native = build_krea2_train_config(config, "dataset.toml", "output", "logs")
                        expected_scheduler = "constant" if optimizer != "AdamW" and relative_step else "cosine"
                        self.assertEqual(native["lr_scheduler"], expected_scheduler)
                        if optimizer != "AdamW":
                            self.assertIn(f"relative_step={relative_step}", native["optimizer_args"])
                            self.assertIn(f"warmup_init={warmup_init}", native["optimizer_args"])

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
             patch.object(training_routes, "krea2_preflight", side_effect=AssertionError("preflight must not run")) as preflight, \
             patch.object(training_routes, "_prepare_run_directories") as prepare, \
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

    def test_adafactor_single_missing_boolean_uses_its_default(self):
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
        boolean_defaults = {"relative_step": True, "scale_parameter": True, "warmup_init": False}
        cases = (
            ("relative_step", None, False),
            ("relative_step", None, True),
            ("scale_parameter", False, False),
            ("scale_parameter", False, True),
            ("scale_parameter", True, False),
            ("scale_parameter", True, True),
            ("warmup_init", False, None),
            ("warmup_init", True, None),
        )
        for missing, relative_step, warmup_init in cases:
            with self.subTest(missing=missing, relative_step=relative_step, warmup_init=warmup_init):
                expected = {"relative_step": relative_step, "scale_parameter": False, "warmup_init": warmup_init}
                config = {**defaults, "optimizer_type": "AdaFactor", "lr_scheduler": "cosine",
                          **{f"krea_adafactor_{key}": value for key, value in expected.items()}}
                config.pop(f"krea_adafactor_{missing}")
                expected[missing] = boolean_defaults[missing]
                errors = validate_krea2_config(config)
                for key, value in expected.items():
                    self.assertIs(config[f"krea_adafactor_{key}"], value)
                if expected["warmup_init"] and not expected["relative_step"]:
                    self.assertTrue(any("krea_adafactor_warmup_init" in error and
                                        "krea_adafactor_relative_step" in error for error in errors), errors)
                else:
                    self.assertEqual(errors, [])
                    native = build_krea2_train_config(config, "dataset.toml", "output", "logs")
                    arguments = {key: ast.literal_eval(value) for key, value in
                                 (item.split("=", 1) for item in native["optimizer_args"])}
                    self.assertEqual({key: arguments[key] for key in expected}, expected)
                    self.assertEqual(native["lr_scheduler"], "constant" if expected["relative_step"] else "cosine")

    def test_adafactor_rejects_non_boolean_controls(self):
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
        for key in ("krea_adafactor_relative_step", "krea_adafactor_scale_parameter", "krea_adafactor_warmup_init"):
            for value in (None, "", "False", "True", 0, 1, [], {}):
                with self.subTest(key=key, value=value):
                    config = {**defaults, "optimizer_type": "AdaFactor", key: value}
                    errors = validate_krea2_config(config)
                    self.assertTrue(any(key in error and "布尔值" in error for error in errors), errors)

    def test_adafactor_defaults_and_booleans_match_exported_scheduler(self):
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
        for use_defaults in (True, False):
            with self.subTest(use_defaults=use_defaults):
                config = {**defaults, "optimizer_type": "AdaFactor", "lr_scheduler": "cosine"}
                for name in ("relative_step", "scale_parameter", "warmup_init"):
                    key = f"krea_adafactor_{name}"
                    if use_defaults:
                        config.pop(key)
                    else:
                        config[key] = False
                self.assertEqual(validate_krea2_config(config), [])
                native = build_krea2_train_config(config, "dataset.toml", "output", "logs")
                arguments = {key: ast.literal_eval(value) for key, value in
                             (item.split("=", 1) for item in native["optimizer_args"])}
                self.assertIs(arguments["relative_step"], use_defaults)
                self.assertIs(arguments["scale_parameter"], use_defaults)
                self.assertIs(arguments["warmup_init"], False)
                self.assertEqual(native["lr_scheduler"], "constant" if use_defaults else "cosine")

    def test_generates_separate_dataset_and_train_tomls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update({"network_alpha": 2, "network_dropout": 1.0})

            self.assertEqual(validate_krea2_config(config), [])
            dataset = build_krea2_dataset_config(config)
            train = build_krea2_train_config(config, root / "run" / "dataset.toml", root / "artifact", root / "run" / "log")

            config["network_alpha"] = 1.5
            self.assertEqual(validate_krea2_config(config), [])
            fractional = build_krea2_train_config(config, "dataset.toml", "output", "logs")
            self.assertEqual(fractional["network_alpha"], 1.5)

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
            (cache / "portrait_0001x0001_kr2.safetensors").write_bytes(b"latent")
            (cache / "portrait_kr2_te.safetensors").write_bytes(b"text")
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
