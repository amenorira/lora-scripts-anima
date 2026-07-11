import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.monitor import artifacts
from backend.tasks import TaskManager
from backend.training.field_registry import FIELDS
from backend.training.validation import validate_training_config
from backend.utils.train_utils import count_images


def valid_anima_config() -> dict:
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update({
        "model_train_type": "anima-lora",
        "network_module": "networks.lora_anima",
        "pretrained_model_name_or_path": "model.safetensors",
        "vae": "vae.safetensors",
        "qwen3": "qwen3.safetensors",
        "train_data_dir": "train",
        "resolution": "1024,768",
        "output_name": "test",
        "output_dir": "output",
    })
    return config


class TrainingValidationTests(unittest.TestCase):
    def test_valid_anima_config(self):
        self.assertEqual(validate_training_config(valid_anima_config()), [])

    def test_rejects_unsafe_anima_values(self):
        cases = {
            "blocks_to_swap": 9,
            "rank_dropout": 1,
            "caption_dropout_rate": 1.01,
            "caption_tag_dropout_rate": -0.01,
            "vae_chunk_size": 3,
            "qwen3_max_token_length": 0,
        }
        for key, value in cases.items():
            with self.subTest(key=key):
                config = valid_anima_config()
                config[key] = value
                errors = validate_training_config(config)
                self.assertTrue(any(key in error for error in errors), errors)

    def test_validates_resolution_by_train_type(self):
        config = valid_anima_config()
        config["resolution"] = "1000,1024"
        self.assertTrue(any("resolution" in error for error in validate_training_config(config)))

        config["resolution"] = "1008,1024"
        self.assertEqual(validate_training_config(config), [])

        config["model_train_type"] = "sdxl-lora"
        self.assertTrue(any("resolution" in error for error in validate_training_config(config)))

    def test_normalizes_numeric_strings(self):
        config = valid_anima_config()
        config["blocks_to_swap"] = "8"
        self.assertEqual(validate_training_config(config), [])
        self.assertEqual(config["blocks_to_swap"], 8)

        config["model_train_type"] = "sdxl-lora"
        config["network_module"] = "networks.lora"
        config["max_token_length"] = "225"
        config["resolution"] = "1024,1024"
        self.assertEqual(validate_training_config(config), [])
        self.assertEqual(config["max_token_length"], 225)

    def test_rejects_network_module_from_other_train_type(self):
        config = valid_anima_config()
        config["network_module"] = "networks.lora"
        errors = validate_training_config(config)
        self.assertTrue(any("network_module" in error for error in errors))

    def test_base_weight_multiplier_count_must_match(self):
        config = valid_anima_config()
        config["base_weights"] = "a.safetensors,b.safetensors"
        config["base_weights_multiplier"] = "1"
        errors = validate_training_config(config)
        self.assertTrue(any("base_weights_multiplier" in error for error in errors))


class TaskManagerTests(unittest.TestCase):
    def test_created_task_reserves_concurrency_slot(self):
        manager = TaskManager(max_concurrent=1)
        self.assertIsNotNone(manager.create_task(["noop"]))
        self.assertIsNone(manager.create_task(["noop"]))


class ScanOptimizationTests(unittest.TestCase):
    def test_count_images_stops_at_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(205):
                (root / f"{index}.png").touch()
            self.assertEqual(count_images(root, stop_after=201), 201)
            self.assertEqual(count_images(root), 205)

    def test_preview_scan_uses_known_output_locations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir) / "output"
            run_dir = output_root / "run"
            sample_dir = run_dir / "sample"
            unrelated_dir = run_dir / "other"
            sample_dir.mkdir(parents=True)
            unrelated_dir.mkdir()
            (sample_dir / "sample.png").touch()
            (run_dir / "root.png").touch()
            (unrelated_dir / "unrelated.png").touch()

            with patch.object(artifacts, "OUTPUT_DIR", output_root), patch.object(
                artifacts, "REPO_ROOT", Path(temp_dir)
            ):
                previews = artifacts.newest_previews(str(run_dir), force_refresh=True)

            self.assertEqual({item["name"] for item in previews}, {"sample.png", "root.png"})


if __name__ == "__main__":
    unittest.main()
