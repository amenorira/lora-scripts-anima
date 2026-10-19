from contextlib import nullcontext
import ast
import asyncio
import glob
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import toml

from backend.training.musubi_krea2 import KREA2_FIELDS, build_krea2_dataset_config, build_krea2_train_config, cache_manifest_path, estimate_krea2_steps, get_krea2_cache_status, krea2_cache_fingerprint, krea2_preflight, mark_cache_manifest, prepare_cache_manifest, validate_krea2_config
from backend.server.routes import training as training_routes
from backend.tasks import TaskManager, TaskStatus
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
    def test_cache_final_validation_settles_manifest_result_and_task_together(self):
        async def exercise(root, defect):
            config = krea2_config(root)
            manager = TaskManager()
            process = Mock(args=["cache"], returncode=0)
            worker_futures = []
            loop = asyncio.get_running_loop()
            submit = loop.run_in_executor

            def capture_worker(executor, func, *args):
                future = submit(executor, func, *args)
                if getattr(func, "__name__", "") == "_run":
                    worker_futures.append(future)
                return future

            def encode(**_kwargs):
                cache = Path(config["dataset_cache_dir"])
                (cache / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
                if defect != "missing":
                    (cache / "portrait_krea2_te.safetensors").write_bytes(b"text")
                if defect == "extra":
                    (cache / "foreign_0001x0001_krea2.safetensors").write_bytes(b"old")
                elif defect == "dataset":
                    (Path(config["train_data_dir"]) / "portrait.txt").write_text("changed", encoding="utf-8")
                return None, None

            process.communicate.side_effect = encode
            validation = patch(
                "backend.training.musubi_krea2.get_krea2_cache_status", side_effect=OSError("cache unreadable"),
            ) if defect == "validation" else nullcontext()
            with patch.object(training_routes, "tm", manager), \
                 patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": []}), \
                 patch.object(loop, "run_in_executor", side_effect=capture_worker), \
                 patch("backend.tasks.subprocess.Popen", return_value=process), \
                 stub_supervisor(), validation:
                response = await training_routes.create_krea2_cache(json_request(dict(config)))
                self.assertEqual(response["status"], "success")
                self.assertEqual(len(worker_futures), 1)
                await asyncio.wait_for(worker_futures[0], 5)

            run_dir, = (root / "runs").iterdir()
            result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            task, = manager.tasks.values()
            completed = defect is None
            expected = "completed" if completed else "failed"
            self.assertEqual(result["exit_code"], 0)
            self.assertEqual(result["status"], expected)
            self.assertEqual(manifest["stages"], {"latents": expected, "text_encoder": expected})
            self.assertIs(task.status, TaskStatus.FINISHED if completed else TaskStatus.FAILED)
            self.assertEqual(get_krea2_cache_status(config)["ready"], completed)
            if completed:
                self.assertIsNone(result["error"])
            else:
                error = {"dataset": "发生变化", "validation": "cache unreadable"}.get(defect, "缓存文件")
                self.assertIn(error, result["error"])
                self.assertEqual(manifest["error"], result["error"])
                self.assertIn(result["error"], (run_dir / "error.log").read_text(encoding="utf-8"))
            self.assertIsNotNone(manager.reserve_task())

        for defect in (None, "missing", "extra", "dataset", "validation"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                asyncio.run(exercise(Path(directory), defect))

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

    def test_cache_stop_or_http_cancel_after_manifest_settles_failed(self):
        for cancellation in ("stop", "http"):
            with self.subTest(cancellation=cancellation), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                config = krea2_config(root)
                entered, release = threading.Event(), threading.Event()
                manager = TaskManager()

                def write_run_info(*_args, **_kwargs):
                    entered.set()
                    if not release.wait(5):
                        raise TimeoutError("cache preparation was not released")

                async def exercise():
                    request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    task_id = next(iter(manager.tasks))
                    if cancellation == "stop":
                        manager.terminate_task(task_id)
                    else:
                        request.cancel()
                    self.assertIsNone(manager.reserve_task())
                    release.set()
                    if cancellation == "http":
                        with self.assertRaises(asyncio.CancelledError):
                            await request
                        return None
                    return await request

                with patch.object(training_routes, "tm", manager), \
                     patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                     patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                     patch.object(training_routes, "_write_run_info", side_effect=write_run_info), \
                     patch.object(training_routes, "run_train") as launch:
                    try:
                        response = asyncio.run(exercise())
                    finally:
                        release.set()

                if cancellation == "stop":
                    self.assertEqual(response.status, "fail")
                    self.assertEqual(response.message, "Training preparation cancelled / 训练准备已取消")
                launch.assert_not_called()
                self.assertIsNotNone(manager.reserve_task())
                manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
                self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})

    def test_cache_launcher_failure_marks_manifest_before_releasing_slot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            manager = TaskManager()
            entered, release = threading.Event(), threading.Event()

            def settle_manifest(config, status):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("manifest settlement was not released")
                mark_cache_manifest(config, status)

            async def exercise():
                request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                self.assertIsNone(manager.reserve_task())
                release.set()
                return await request

            with patch.object(training_routes, "tm", manager), \
                 patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(training_routes, "mark_cache_manifest", side_effect=settle_manifest), \
                 patch.object(training_routes, "run_train", return_value={"status": "error", "message": "launcher failed"}):
                try:
                    response = asyncio.run(exercise())
                finally:
                    release.set()

            self.assertEqual(response.status, "fail")
            self.assertEqual(response.message, "launcher failed")
            self.assertIsNotNone(manager.reserve_task())
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})


class Krea2CodecTests(unittest.TestCase):
    def test_nested_images_get_separate_cache_directories(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            root = Path(config["train_data_dir"])
            for name in ("a", "b/deep"):
                directory = root / name
                directory.mkdir(parents=True)
                (directory / "portrait.png").write_bytes(b"image")
                (directory / "portrait.txt").write_text("caption", encoding="utf-8")
                (directory / "orphan.png").write_bytes(b"image")
                (directory / "case.png").write_bytes(b"image")
                (directory / "CASE.txt").write_text("caption", encoding="utf-8")
            # Cache contents must never become training inputs.
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            (cache / "ignored.png").write_bytes(b"image")
            (cache / "ignored.txt").write_text("caption", encoding="utf-8")
            datasets = build_krea2_dataset_config(config)["datasets"]
            self.assertEqual(len(datasets), 3)
            self.assertEqual(len({row["cache_directory"] for row in datasets}), 3)
            self.assertEqual({row["image_directory"] for row in datasets}, {str(root), str(root / "a"), str(root / "b/deep")})
            # Exercise upstream's real glob function without loading its GPU/media dependencies.
            source = Path(__file__).resolve().parents[2] / "vendor/musubi-tuner/src/musubi_tuner/dataset/media_utils.py"
            tree = ast.parse(source.read_text(encoding="utf-8"))
            function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "glob_images")
            extensions = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "IMAGE_EXTENSIONS" for target in node.targets))
            namespace = {"glob": glob, "os": os, "IMAGE_EXTENSIONS": ast.literal_eval(extensions)}
            exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
            upstream_images = [
                image for row in datasets
                for image in namespace["glob_images"](row["image_directory"], caption_extension=config["caption_extension"])
            ]
            self.assertEqual({Path(image) for image in upstream_images}, {root / "portrait.png", root / "a/portrait.png", root / "b/deep/portrait.png"})
            self.assertEqual(estimate_krea2_steps(config)["original_images"], 3)
            config["train_batch_size"] = 2
            self.assertEqual(estimate_krea2_steps(config)["batches_per_epoch"], 3)
            prepare_cache_manifest(config)
            for row in datasets:
                target = Path(row["cache_directory"])
                target.mkdir(parents=True, exist_ok=True)
                (target / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
                (target / "portrait_krea2_te.safetensors").write_bytes(b"text")
            mark_cache_manifest(config, "completed")
            self.assertTrue(get_krea2_cache_status(config)["ready"])
            # Extra files in one subset cannot hide missing files in another.
            (cache / "extra_0001x0001_krea2.safetensors").write_bytes(b"latent")
            (cache / "extra_krea2_te.safetensors").write_bytes(b"text")
            (Path(datasets[-1]["cache_directory"]) / "portrait_krea2_te.safetensors").unlink()
            self.assertFalse(get_krea2_cache_status(config)["ready"])

    def test_caption_filter_and_custom_extension_are_shared(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            root = Path(config["train_data_dir"])
            before = krea2_cache_fingerprint(config)
            (root / "unlabelled.png").write_bytes(b"image")
            (root / "unsupported.tiff").write_bytes(b"image")
            (root / "unsupported.txt").write_text("caption", encoding="utf-8")
            self.assertEqual(krea2_cache_fingerprint(config), before)
            self.assertEqual(get_krea2_cache_status(config)["image_count"], 1)
            config["caption_extension"] = ".caption"
            with patch("backend.training.musubi_krea2.shared_runtime_status", return_value={"errors": []}):
                result = krea2_preflight(config, require_cache=False)
            self.assertTrue(any("同名标注" in error for error in result["errors"]))
            self.assertEqual(build_krea2_dataset_config(config)["datasets"], [])
            (root / "unlabelled.caption").write_text("caption", encoding="utf-8")
            self.assertEqual(get_krea2_cache_status(config)["image_count"], 1)
            self.assertEqual(estimate_krea2_steps(config)["original_images"], 1)
            self.assertNotEqual(krea2_cache_fingerprint(config), before)

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


    def test_rejects_unsafe_turbo_and_h2d_block_swap_combinations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "enable_krea_samples": True,
                    "krea_sample_prompts": "A fox in snow.",
                    "turbo_dit": str(root / "models" / "turbo.safetensors"),
                    "blocks_to_swap": 1,
                }
            )
            errors = validate_krea2_config(config)
            self.assertTrue(any("turbo_dit: cannot be combined" in error for error in errors))

            config = krea2_config(root / "h2d")
            config.update({"blocks_to_swap": 1, "block_swap_h2d_only": True, "gradient_checkpointing": False})
            errors = validate_krea2_config(config)

        self.assertTrue(any("block_swap_h2d_only: requires gradient_checkpointing" in error for error in errors))

    def test_launch_writes_managed_krea_sample_prompt_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "enable_krea_samples": True,
                    "krea_sample_prompts": "# stable regression prompt\nA fox in snow. --w 1024 --h 1024 --s 8 --l 1 --d 0",
                }
            )
            timestamp = "20260723-153000"
            with patch(
                "backend.server.routes.training.krea2_preflight",
                return_value={"ok": True, "errors": [], "cache": {"ready": True}},
            ), patch(
                "backend.server.routes.training.run_train", return_value={"status": "success"}
            ), patch.object(training_routes, "OUTPUT_DIR", root / "runs"), patch(
                "backend.server.routes.training.os.getcwd", return_value=str(root)
            ), patch.object(training_routes, "AUTOSAVE_DIR", root / "config" / "autosave"), patch.object(
                training_routes, "tm", TaskManager()
            ):
                result = asyncio.run(training_routes._prepare_training(
                    training_routes._create_krea2_run, config, None, timestamp, dict(config),
                ))

            run_dirs = list((root / "runs").glob(f"krea2_test_{timestamp}_*"))
            self.assertEqual(len(run_dirs), 1)
            run_dir = run_dirs[0]
            prompt_file = run_dir / "sample_prompts.txt"
            train_config = toml.loads((run_dir / "config.toml").read_text(encoding="utf-8"))
            prompt_text = prompt_file.read_text(encoding="utf-8")
            points_to_prompt_file = os.path.samefile(train_config["sample_prompts"], prompt_file)

        self.assertEqual(result["status"], "success")
        self.assertEqual(
            prompt_text,
            "# stable regression prompt\nA fox in snow. --w 1024 --h 1024 --s 8 --l 1 --d 0\n",
        )
        self.assertTrue(points_to_prompt_file)
        self.assertEqual(train_config["text_encoder"], config["text_encoder"])
        self.assertNotIn("krea_sample_prompts", train_config)

    def test_cache_manifest_detects_caption_changes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            (cache / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
            (cache / "portrait_krea2_te.safetensors").write_bytes(b"text")
            prepare_cache_manifest(config)
            mark_cache_manifest(config, "completed")

            self.assertTrue(get_krea2_cache_status(config)["ready"])
            (Path(config["train_data_dir"]) / "portrait.txt").write_text("changed portrait caption", encoding="utf-8")
            self.assertFalse(get_krea2_cache_status(config)["ready"])

    def test_cache_files_must_correspond_to_current_images(self):
        for mismatch in ("replacement", "extra", "duplicate_size", "text", "malformed"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as temp_dir:
                config = krea2_config(Path(temp_dir))
                cache = Path(config["dataset_cache_dir"])
                cache.mkdir()
                latent = cache / "portrait_0001x0001_krea2.safetensors"
                text = cache / "portrait_krea2_te.safetensors"
                latent.write_bytes(b"latent")
                text.write_bytes(b"text")
                prepare_cache_manifest(config)
                mark_cache_manifest(config, "completed")
                self.assertTrue(get_krea2_cache_status(config)["ready"])
                if mismatch == "replacement":
                    latent.rename(cache / "foreign_0001x0001_krea2.safetensors")
                    text.rename(cache / "foreign_krea2_te.safetensors")
                elif mismatch == "extra":
                    (cache / "foreign_0001x0001_krea2.safetensors").write_bytes(b"latent")
                    (cache / "foreign_krea2_te.safetensors").write_bytes(b"text")
                elif mismatch == "duplicate_size":
                    (cache / "portrait_0002x0002_krea2.safetensors").write_bytes(b"latent")
                elif mismatch == "text":
                    text.rename(cache / "foreign_krea2_te.safetensors")
                else:
                    latent.rename(cache / "portrait_badsize_krea2.safetensors")
                status = get_krea2_cache_status(config)
                self.assertTrue(status["fingerprint_matches"])
                self.assertFalse(status["files_match"])
                self.assertFalse(status["ready"])
                # A zero process exit code cannot certify an invalid cache set.
                mark_cache_manifest(config, "completed")
                self.assertEqual(get_krea2_cache_status(config)["stages"], {
                    "latents": "failed", "text_encoder": "failed",
                })

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

    def test_deleted_image_caches_block_readiness_until_rebuilt(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            train = Path(config["train_data_dir"])
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            for stem in ("portrait", "removed"):
                (train / f"{stem}.png").write_bytes(b"image")
                (train / f"{stem}.txt").write_text("caption", encoding="utf-8")
                (cache / f"{stem}_0001x0001_krea2.safetensors").write_bytes(b"latent")
                (cache / f"{stem}_krea2_te.safetensors").write_bytes(b"text")
            prepare_cache_manifest(config)
            mark_cache_manifest(config, "completed")
            self.assertTrue(get_krea2_cache_status(config)["ready"])
            (train / "removed.png").unlink()
            (train / "removed.txt").unlink()
            self.assertFalse(get_krea2_cache_status(config)["ready"])
            prepare_cache_manifest(config)
            mark_cache_manifest(config, "completed")
            self.assertFalse(get_krea2_cache_status(config)["ready"])
            # Model the upstream cleanup; other architectures and namespaces
            # are outside the active dataset's flat cache reader.
            for path in cache.glob("removed_*.safetensors"):
                path.unlink()
            (cache / "foreign_anima.safetensors").write_bytes(b"unrelated")
            unused = cache / "subsets" / "unused"
            unused.mkdir(parents=True)
            (unused / "removed_0001x0001_krea2.safetensors").write_bytes(b"old subset")
            mark_cache_manifest(config, "completed")
            self.assertTrue(get_krea2_cache_status(config)["ready"])
            self.assertTrue((cache / "foreign_anima.safetensors").exists())
            self.assertTrue((unused / "removed_0001x0001_krea2.safetensors").exists())

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
