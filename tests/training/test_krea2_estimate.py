import tempfile
import unittest
from pathlib import Path

from backend.training.datasets.step_estimator import estimate_training_steps


class Krea2EstimateTests(unittest.TestCase):
    def test_caption_extension_and_common_formula_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, extension in (("a", ".caption"), ("b", ".caption"), ("c", ".txt")):
                (root / f"{name}.png").touch()
                (root / f"{name}{extension}").write_text("caption", encoding="utf-8")
            config = dict(model_train_type="krea2-lora", train_data_dir=str(root),
                          dataset_cache_dir=str(root / ".krea2-cache"), caption_extension=".caption",
                          resolution="1024,1024", krea_num_repeats=2, max_train_epochs=3)
            result = estimate_training_steps(config)
            self.assertEqual(result["original_images"], 2)
            self.assertEqual(result["total_steps"], 12)
            self.assertEqual(result["epochs"], 3)
            self.assertEqual(result["subsets"][0]["sample_count"], 4)
            self.assertIs(result["subsets"][0]["is_reg"], False)
            explicit = estimate_training_steps({**config, "krea_training_duration_mode": "steps", "max_train_steps": 5})
            self.assertEqual(explicit["duration_mode"], "steps")
            self.assertEqual(explicit["epochs"], 2)
            self.assertEqual(explicit["total_steps"], 5)
