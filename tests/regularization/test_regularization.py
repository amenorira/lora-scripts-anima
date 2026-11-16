"""Generation failures preserve already completed output pairs."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

from backend.regularization import planning, storage, worker


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
        self.enterContext(patch.object(storage, "OUTPUT_ROOT", self.root / "output"))

    def stored_run(self):
        settings = planning.Settings(**self.settings, seed=19, per_image=3)
        source, sources = planning.scan(settings)
        config, fingerprint = planning.identity(settings, source, sources)
        root = storage.run_path("reg_chara")
        root.mkdir(parents=True)
        items = planning.make_items(sources, 19)
        for item in items:
            item["status"] = "pending"
            item.pop("filename")  # Existing manifests used sequential names.
        manifest = dict(task_id="old", run_key=root.name, fingerprint=fingerprint, settings=config, sources=sources,
                        items=items, master_seed=19, status="finished", updated_at=1)
        storage.save_manifest(root, manifest)
        return root, manifest

    def test_ordinary_failure_continues_and_oom_preserves_completed(self):
        root, manifest = self.stored_run()
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


if __name__ == "__main__":
    unittest.main()
