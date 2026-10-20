"""Generation recovery, cancellation, and output preservation regressions."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

from backend.regularization import planning, service, storage, worker
from backend.tasks import TaskManager


class FakeRunner:
    def __init__(self, settings, report, check):
        self.check = check
    def generate(self, item):
        self.check()
        return Image.new("RGB", (item["width"], item["height"]), "red")


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "chara"
        subset = self.source / "2_face"
        subset.mkdir(parents=True)
        Image.new("RGB", (64, 96), "white").save(subset / "a.png")
        self.caption_path = subset / "a.txt"
        self.caption_path.write_text("trigger, Blue_Hair, 多词 标签, masterpiece\nignored line", encoding="utf-8")
        models = {}
        for key in ("dit", "text_encoder", "vae"):
            path = self.root / f"{key}.safetensors"
            path.write_bytes(b"model")
            models[key] = str(path)
        self.settings = dict(source_dir=str(self.source), **models, size_mode="fixed", width=64, height=64)
        for module, key, value in [(storage, "OUTPUT_ROOT", self.root / "output"), (service, "tm", TaskManager()),
                                   (service, "_plans", {}), (service, "_tasks", {}), (service, "_recovery_started", False)]:
            mocked = patch.object(module, key, value)
            mocked.start(); self.addCleanup(mocked.stop)

    def stored_run(self, status="completed", quantity=1, source_names=False):
        settings = planning.Settings(**self.settings, seed=19, per_image=quantity)
        source, sources = planning.scan(settings)
        config, fingerprint = planning.identity(settings, source, sources)
        root = storage.run_path("reg_chara")
        root.mkdir(parents=True)
        items = planning.make_items(sources, 19)
        for item in items:
            item["status"] = status
            if not source_names:
                item.pop("filename")  # Existing manifests used sequential names.
        manifest = dict(task_id="old", run_key=root.name, fingerprint=fingerprint, settings=config, sources=sources,
                        items=items, master_seed=19, status="finished", updated_at=1)
        if status == "completed":
            (root / "1_reg").mkdir()
            for item in items:
                Image.new("RGB", (64, 64), "white").save(storage.item_path(root, item))
                storage.atomic_write(storage.item_path(root, item, ".txt"), item["caption"].encode())
        storage.save_manifest(root, manifest)
        return root, manifest


    def test_added_sources_extend_existing_run_without_touching_completed_pairs(self):
        root, old = self.stored_run(source_names=True)
        original = (root / "1_reg/a.png").read_bytes()
        # A new, earlier-sorting source with the same stem must not rename a.png.
        subset = self.source / "1_new"
        subset.mkdir()
        Image.new("RGB", (64, 64)).save(subset / "a.jpg")
        (subset / "a.txt").write_text("new caption")
        body = {"settings": old["settings"]}
        plan = service.preview(body)
        self.assertEqual((plan["run_key"], plan["completed"], plan["pending"]), (root.name, 1, 1))
        def launch(task, output, manifest):
            storage.save_manifest(output, manifest)
            service.tm.release_reserved(task)
            return manifest
        with patch.object(service, "_launch", launch):
            manifest = service.start(plan["token"])
        self.assertEqual(manifest["items"][0], old["items"][0])
        self.assertEqual(manifest["items"][1]["filename"], "a_001.png")
        worker.run(root, FakeRunner)
        self.assertEqual((root / "1_reg/a.png").read_bytes(), original)
        self.assertEqual(service.preview(body)["pending"], 0)
        self.assertNotEqual(service.preview(dict(body, new_round=True))["run_key"], root.name)


    def test_output_names_cannot_escape_result_directory(self):
        for name in ("../a.png", "..\\a.png", "C:a.png", "/tmp/a.png"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                storage.item_path(self.root, {"index": 1, "filename": name})


    def test_all_failed_and_partial_failure_have_truthful_task_status(self):
        root, manifest = self.stored_run("pending", 2)
        class Failed(FakeRunner):
            def generate(self, item):
                raise ValueError("invalid generation")
        self.assertEqual(worker.run(root, Failed), 1)
        self.assertEqual(service.summary(root)["status"], "failed")
        self.assertIn("2 failed", service.summary(root)["error"])
        class Partial(FakeRunner):
            def generate(self, item):
                if item["index"] == 2:
                    raise ValueError("invalid generation")
                return super().generate(item)
        self.assertEqual(worker.run(root, Partial), 0)
        result = service.summary(root)
        self.assertEqual((result["status"], result["completed"], result["failed"]), ("finished", 1, 1))
        self.assertIn("1 failed", result["error"])


    def test_worker_launch_failure_is_terminal_and_releases_preparation(self):
        plan = service.preview({"settings": self.settings})
        with patch.object(service, "REPO_ROOT", self.root):
            with self.assertRaises(RuntimeError):
                service.start(plan["token"])
        manifest = storage.read_manifest(storage.run_path(plan["run_key"]))
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(service.tm.tasks, {})

    def test_old_task_id_keeps_terminal_snapshot_and_cannot_cancel_replacement(self):
        root, manifest = self.stored_run("pending")
        task = service._reserve()
        with patch.object(service, "REPO_ROOT", self.root):
            with self.assertRaises(RuntimeError):
                service._launch(task, root, manifest)
        service.tm.release_reserved(task)
        self.assertEqual(service.task_snapshot("old")["status"], "finished")
        with self.assertRaises(ValueError):
            service.cancel("old")
        self.assertFalse((root / ".cancel").exists())


    def test_gpu_and_mutation_exclusion(self):
        root, _ = self.stored_run()
        reserved = service.tm.reserve_task()
        with self.assertRaises(RuntimeError):
            service.start(service.preview({"settings": self.settings})["token"])
        with self.assertRaises(RuntimeError):
            service.mutate(root.name, 1, "regenerate")
        with self.assertRaises(RuntimeError):
            service.mutate(root.name, 1, "exclude")
        with self.assertRaises(RuntimeError):
            service.resume(root.name)
        service.tm.release_reserved(reserved)
        self.assertTrue(service.tm.claim_external("tagger"))
        with self.assertRaises(RuntimeError):
            service.start(service.preview({"settings": self.settings})["token"])
        service.tm.release_external("tagger")


    def test_ordinary_failure_continues_and_oom_preserves_completed(self):
        root, manifest = self.stored_run("pending", 3)
        class Failing(FakeRunner):
            def generate(self, item):
                if item["index"] == 2:
                    raise RuntimeError("ordinary")
                return super().generate(item)
        worker.run(root, Failing)
        self.assertEqual([i["status"] for i in storage.read_manifest(root)["items"]], ["completed", "failed", "completed"])
        manifest["items"][0]["status"] = "completed"
        storage.save_manifest(root, manifest)
        class OOM(FakeRunner):
            def generate(self, item):
                raise torch.cuda.OutOfMemoryError("OOM")
        self.assertEqual(worker.run(root, OOM), 1)
        result = storage.read_manifest(root)
        self.assertEqual(result["status"], "failed")
        self.assertEqual([i["status"] for i in result["items"]], ["completed", "pending", "pending"])

    def test_cooperative_cancel_retains_seed(self):
        root, manifest = self.stored_run("pending")
        (root / ".cancel").write_text("stop")
        worker.run(root, FakeRunner)
        result = storage.read_manifest(root)
        self.assertEqual(result["status"], "terminated")
        self.assertEqual(result["items"][0]["seed"], manifest["items"][0]["seed"])


if __name__ == "__main__":
    unittest.main()
