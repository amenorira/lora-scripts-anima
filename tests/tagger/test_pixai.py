import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from PIL import Image

from backend.tagger import registry, workspace
from backend.tagger.interrogators.pixai import PixAITaggerInterrogator
from backend.tagger.tagger_download import tagger_hub_download


class PixAITests(unittest.TestCase):
    def test_default_model_is_last_in_display_order(self):
        from backend.server.models import TaggerInterrogateRequest

        with patch.object(registry, "gpu_info", return_value={}), patch.object(
            registry, "_model_installed", return_value=False
        ):
            payload = registry.model_payload()
        self.assertEqual(payload["default_model_id"], "pixai-tagger-v1.0")
        self.assertEqual(payload["models"][-1]["id"], payload["default_model_id"])
        self.assertEqual(TaggerInterrogateRequest(path="test").interrogator_model, payload["default_model_id"])

    def test_full_scores_keep_low_confidence_tags_and_category_order(self):
        import torch

        tagger = PixAITaggerInterrogator("test")
        tagger.model = MagicMock()
        tagger.model.device = torch.device("cpu")
        tagger.model.config = SimpleNamespace(
            tags=["low", "high", "style_a"], tags_split=[("general", 2), ("style", 1)])
        tagger.model.return_value = torch.tensor([[-10.0, 2.0, 0.0]])
        tagger.processor = MagicMock(return_value={"pixel_values": torch.zeros(1, 3, 2, 2)})
        tagger.autocast_dtype = torch.float32
        result = tagger.interrogate(Image.new("RGB", (2, 2)))
        self.assertEqual([tag for tag, _ in result["general"]], ["high", "low"])
        self.assertLess(result["general"][1][1], 0.001)
        self.assertEqual(result["style"], [("style_a", 0.5)])
        tagger.model.config.tags_split = [("general", 4)]
        with self.assertRaisesRegex(ValueError, "vocabulary"):
            tagger.interrogate(Image.new("RGB", (2, 2)))
        self.assertTrue(tagger.unload())
        self.assertFalse(hasattr(tagger, "processor"))
        self.assertFalse(tagger.unload())

    def test_model_defaults_overrides_and_disabled_categories(self):
        fake = MagicMock()
        fake.interrogate.return_value = {
            "general": [("solo", 0.2)], "character": [("alice", 0.3)],
            "style": [("watercolor", 0.2)], "rating": [("rating:g", 0.5)],
        }
        with patch.dict(workspace.available_interrogators, {"pixai-tagger-v1.0": fake}):
            tags, categories = workspace._local_tags("pixai-tagger-v1.0", Image.new("RGB", (2, 2)), {
                "category_thresholds": {"general": 0.25}, "category_enabled": {"rating": False},
            }, full_categories=True)
        self.assertEqual(set(tags), {"alice", "watercolor"})
        self.assertIn("rating", categories)
        self.assertEqual(categories["general"]["tags"], [["solo", 0.2]])
        with patch.dict(workspace.available_interrogators, {"pixai-tagger-v1.0": fake}):
            tags, _ = workspace._local_tags("pixai-tagger-v1.0", Image.new("RGB", (2, 2)), {
                "threshold": 0.9, "character_threshold": 0.9,
            })
        self.assertEqual(tags, [])

    def test_prefetch_preserves_transparency_for_model_processor(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transparent.png"
            Image.new("RGBA", (3, 5), (100, 50, 0, 0)).save(path)
            queue, thread = workspace._start_image_prefetch([path], False, threading.Event())
            _, _, image, error, _ = queue.get(timeout=2)
            self.assertIsNone(error)
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            image.close()
            self.assertIsNone(queue.get(timeout=2))
            thread.join(timeout=2)

    def test_pytorch_single_image_reserves_training_resource(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "image.png"
            Image.new("RGB", (2, 2)).save(path)
            source = workspace.scan_source(str(path), False)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace.tm, "claim_external", return_value=False
            ) as claim:
                with self.assertRaisesRegex(RuntimeError, "Training or tagging"):
                    workspace.create_task({"model_id": "pixai-tagger-v1.0",
                                           "source_token": source["source_token"], "write_captions": False})
            claim.assert_called_once()

    def test_installation_requires_all_files_in_pinned_snapshot(self):
        spec = registry.MODEL_SPEC_BY_ID["pixai-tagger-v1.0"]
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            registry, "HF_CACHE_DIR", Path(temporary)
        ), patch.object(registry, "_install_cache", {}):
            folder = Path(temporary) / ("models--" + spec.repo_id.replace("/", "--")) / "snapshots" / spec.revision
            folder.mkdir(parents=True)
            for filename in spec.files[:-1]:
                (folder / filename).write_text("test")
            self.assertFalse(registry._model_installed(spec))
            (folder / spec.files[-1]).write_text("weights")
            registry._install_cache.clear()
            self.assertTrue(registry._model_installed(spec))

    def test_downloader_uses_same_revision_in_cache_and_request(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "backend.tagger.tagger_download.download_hf_file"
        ) as download:
            path = tagger_hub_download("org/model", "config.json", cache_dir=temporary, revision="abc123")
            self.assertEqual(path.parent.name, "abc123")
            self.assertEqual(download.call_args.kwargs["revision"], "abc123")
