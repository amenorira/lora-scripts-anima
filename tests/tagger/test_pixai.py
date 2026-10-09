import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from PIL import Image

from backend.tagger import workspace
from backend.tagger.interrogators.pixai import PixAITaggerInterrogator


class PixAITests(unittest.TestCase):
    def test_precision_switches_cached_model_and_falls_back(self):
        import torch

        tagger = PixAITaggerInterrogator("test")
        tagger.model = SimpleNamespace(device=torch.device("cuda"))
        with patch.object(torch.cuda, "is_bf16_supported", return_value=True):
            for precision, expected in [("auto", torch.bfloat16), ("fp32", torch.float32),
                                        ("bf16", torch.bfloat16), ("fp32", torch.float32),
                                        ("auto", torch.bfloat16)]:
                tagger._configure_precision(precision)
                self.assertEqual(tagger.autocast_dtype, expected)
        with patch.object(torch.cuda, "is_bf16_supported", return_value=False), patch(
            "backend.tagger.interrogators.pixai.log.warning"
        ) as warning:
            tagger._configure_precision("bf16")
            self.assertEqual(tagger.autocast_dtype, torch.float32)
            warning.assert_called_once()
        tagger.model.device = torch.device("cpu")
        tagger._configure_precision("auto")
        self.assertEqual(tagger.autocast_dtype, torch.float32)
        with self.assertRaisesRegex(ValueError, "precision"):
            tagger.interrogate(Image.new("RGB", (2, 2)), precision="fp16")


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


    def test_pytorch_single_image_reserves_training_resource(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "image.png"
            Image.new("RGB", (2, 2)).save(path)
            source = workspace.scan_source(str(path), False)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace.tm, "claim_external", return_value=False
            ) as claim:
                with self.assertRaisesRegex(RuntimeError, "task is active"):
                    workspace.create_task({"model_id": "pixai-tagger-v1.0",
                                           "source_token": source["source_token"], "write_captions": False})
            claim.assert_called_once()
