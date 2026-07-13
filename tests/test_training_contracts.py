import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.monitor import artifacts
from backend.tasks import TaskManager
from backend.training.field_registry import FIELDS
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
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


class TrainingStepEstimatorTests(unittest.TestCase):
    @staticmethod
    def _write_images(directory: Path, count: int, size: tuple[int, int]) -> None:
        directory.mkdir(parents=True)
        for index in range(count):
            Image.new("RGB", size, "white").save(directory / f"{index}.png")

    @staticmethod
    def _config(train_dir: Path, **overrides) -> dict:
        config = {
            "train_data_dir": str(train_dir),
            "resolution": "512,512",
            "enable_bucket": False,
            "bucket_no_upscale": True,
            "min_bucket_reso": 256,
            "max_bucket_reso": 1024,
            "bucket_reso_steps": 64,
            "train_batch_size": 3,
            "gradient_accumulation_steps": 2,
            "max_train_epochs": 4,
        }
        config.update(overrides)
        return config

    def test_fixed_resolution_counts_images_repeats_batch_and_accumulation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "5_character", 2, (512, 768))
            self._write_images(root / "2_outfit", 3, (768, 512))
            self._write_images(root / "invalid_folder", 4, (512, 512))
            Image.new("RGB", (512, 512), "white").save(root / "root.png")

            estimate = estimate_training_steps(self._config(root))

            self.assertEqual(estimate["original_images"], 5)
            self.assertEqual(estimate["repeated_samples"], 16)
            self.assertEqual(estimate["batches_per_epoch"], 6)
            self.assertEqual(estimate["steps_per_epoch"], 3)
            self.assertEqual(estimate["total_steps"], 12)
            self.assertEqual(
                [(subset["name"], subset["image_count"], subset["repeats"]) for subset in estimate["subsets"]],
                [("2_outfit", 3, 2), ("5_character", 2, 5)],
            )

    def test_bucket_batches_round_up_each_bucket_like_sd_scripts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portrait = root / "2_portrait"
            landscape = root / "3_landscape"
            self._write_images(portrait, 3, (512, 768))
            self._write_images(landscape, 2, (768, 512))
            config = self._config(
                root,
                enable_bucket=True,
                train_batch_size=4,
                gradient_accumulation_steps=2,
                max_train_epochs=5,
            )

            estimate = estimate_training_steps(config)

            self.assertEqual(estimate["repeated_samples"], 12)
            self.assertEqual(estimate["bucket_count"], 2)
            self.assertEqual([bucket["sample_count"] for bucket in estimate["buckets"]], [6, 6])
            self.assertEqual([bucket["batch_count"] for bucket in estimate["buckets"]], [2, 2])
            self.assertEqual(estimate["batches_per_epoch"], 4)
            self.assertEqual(estimate["steps_per_epoch"], 2)
            self.assertEqual(estimate["total_steps"], 10)

            from library.config_util import DreamBoothSubsetParams
            from library.dreambooth_dataset import DreamBoothDataset
            from library.subset import DreamBoothSubset

            subsets = [
                DreamBoothSubset(
                    **asdict(
                        DreamBoothSubsetParams(
                            image_dir=str(portrait), num_repeats=2, class_tokens="portrait"
                        )
                    )
                ),
                DreamBoothSubset(
                    **asdict(
                        DreamBoothSubsetParams(
                            image_dir=str(landscape), num_repeats=3, class_tokens="landscape"
                        )
                    )
                ),
            ]
            dataset = DreamBoothDataset(
                subsets=subsets,
                is_training_dataset=True,
                batch_size=4,
                resolution=(512, 512),
                network_multiplier=1.0,
                enable_bucket=True,
                min_bucket_reso=256,
                max_bucket_reso=1024,
                bucket_reso_steps=64,
                bucket_no_upscale=True,
                prior_loss_weight=1.0,
                train_inpainting=False,
                debug_dataset=False,
                validation_split=0.0,
                validation_seed=0,
                resize_interpolation=None,
            )
            dataset.make_buckets()

            self.assertEqual(estimate["batches_per_epoch"], len(dataset))

    def test_gpu_processes_follow_sd_scripts_ceiling_order(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "1_character", 17, (512, 512))

            estimate = estimate_training_steps(
                self._config(
                    root,
                    train_batch_size=2,
                    gradient_accumulation_steps=2,
                    max_train_epochs=3,
                    gpu_ids=[0, 1],
                )
            )

            self.assertEqual(estimate["batches_per_epoch"], 9)
            self.assertEqual(estimate["gpu_processes"], 2)
            self.assertEqual(estimate["steps_per_epoch"], 3)
            self.assertEqual(estimate["total_steps"], 9)

    def test_rejects_dataset_without_repeat_folders(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "character", 1, (512, 512))

            with self.assertRaises(StepEstimateError):
                estimate_training_steps(self._config(root))

    def test_missing_dataset_exposes_localizable_error_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing_dataset"

            with self.assertRaises(StepEstimateError) as context:
                estimate_training_steps(self._config(missing))

            self.assertEqual(context.exception.code, "datasetNotFound")
            self.assertEqual(context.exception.params, {"path": str(missing)})


class MonitorFrontendContractTests(unittest.TestCase):
    def test_leaving_history_clears_cached_logs(self):
        monitor_core = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")
        reset_body = monitor_core.split("resetRunDetailState() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("this.logLines = [];", reset_body)
        self.assertIn("this.logFullLines = [];", reset_body)
        self.assertIn("this._logSliceRequestSeq++;", reset_body)

    def test_route_exit_uses_history_state_reset(self):
        app_js = Path("frontend/js/app.js").read_text(encoding="utf-8")
        self.assertIn("this.resetRunDetailState();", app_js)

    def test_step_estimate_refreshes_with_form_and_before_training(self):
        training_core = Path("frontend/js/training-core.js").read_text(encoding="utf-8")
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")

        watcher = training_core.split("self._formWatcher = self.$watch('form'", 1)[1].split("});", 1)[0]
        scheduled_refresh = training_core.split("scheduleStepEstimate() {", 1)[1].split("\n  },", 1)[0]
        forced_refresh = training_core.split("async refreshStepEstimate(force) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("self.scheduleStepEstimate();", watcher)
        self.assertIn("fetch('/api/training/estimate'", training_core)
        self.assertIn("stepEstimate.errors.${code}", training_core)
        self.assertIn('x-text="stepEstimateErrorText()"', training_core)
        self.assertIn("const estimate = await this.refreshStepEstimate(true);", training_toml)
        self.assertEqual(scheduled_refresh.count("this.stepEstimate = null;"), 1)
        self.assertEqual(forced_refresh.count("this.stepEstimate = null;"), 1)
        self.assertIn("effectiveBatch:", training_core)

if __name__ == "__main__":
    unittest.main()
