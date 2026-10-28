import tempfile
import unittest
from pathlib import Path

from backend.monitor.artifacts import enrich_model_files_with_loss, parse_checkpoint


class CheckpointTests(unittest.TestCase):
    def test_checkpoint_names_keep_epoch_and_step_for_supported_extension_case(self):
        for extension in ("safetensors", "SAFETENSORS", "pt", "PT", "pth", "PTH"):
            for suffix, kind, epoch, step in (("-000003", "epoch", 3, None),
                                              ("-step00001000", "step", None, 1000),
                                              ("", "final", None, None)):
                with self.subTest(extension=extension, suffix=suffix):
                    self.assertEqual(parse_checkpoint(f"demo{suffix}.{extension}"),
                                     {"type": kind, "epoch_no": epoch, "step": step})
        self.assertIsNone(parse_checkpoint("demo.txt"))

    def test_log_fallback_preserves_scientific_and_signed_loss_values(self):
        for literal in ("1.25e-04", "2E-3", "+0.0004", "-.002", "0.000125"):
            with self.subTest(literal=literal), tempfile.TemporaryDirectory() as root:
                log = Path(root) / "train_fixture.log"
                names = ["demo-000003.safetensors", "demo-step00001000.safetensors", "demo.safetensors"]
                log.write_text("\n".join(
                    f"steps: 100% | avr_loss={literal}\nsaving checkpoint: C:\\output\\{name}"
                    for name in names
                ), encoding="utf-8")
                files = [{"name": name, "category": "model"} for name in names]
                enrich_model_files_with_loss(files, [], root)
                for entry in files:
                    self.assertAlmostEqual(entry["ckpt_loss"], float(literal))
                    self.assertEqual(entry["loss_source"], "log")
                    self.assertTrue(entry["loss_approximate"])

    def test_tensorboard_loss_takes_precedence_over_log_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "train_fixture.log").write_text(
                "loss=0.9\nsaving checkpoint: /output/demo-000003.safetensors\n", encoding="utf-8")
            files = [{"name": "demo-000003.safetensors", "category": "model", "ckpt_type": "epoch", "ckpt_epoch": 3}]
            enrich_model_files_with_loss(files, [{"tag": "loss/epoch_average", "points": [{"step": 3, "value": .1}]}], root)
            self.assertEqual(files[0]["ckpt_loss"], .1)
            self.assertEqual(files[0]["loss_source"], "loss/epoch_average")

    def test_log_fallback_uses_only_recent_loss_before_each_save(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "train_fixture.log").write_text(
                "loss=0.9\n" + "unrelated\n" * 5 + "saving checkpoint: /output/demo.safetensors\nloss=0.1\n",
                encoding="utf-8")
            files = [{"name": "demo.safetensors", "category": "model"}]
            enrich_model_files_with_loss(files, [], root)
            self.assertIsNone(files[0]["ckpt_loss"])
