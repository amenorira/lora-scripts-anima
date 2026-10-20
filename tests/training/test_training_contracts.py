import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend.training.adapter import adapt_config
from backend.training.step_estimator import estimate_training_steps
from backend.training.validation import validate_training_config
from backend.server.routes.training import get_sample_prompts
from tests.helpers import valid_training_config as valid_anima_config


class TrainingValidationTests(unittest.TestCase):
    def test_input_normalization_uses_schema_types_instead_of_text_contents(self):
        config = dict(valid_anima_config(), learning_rate="1e-4", unet_lr="2e-4", lora_muon_momentum=0.9,
                      output_name="00123", positive_prompts="123", resolution="1024")
        self.assertEqual(validate_training_config(config), [])
        self.assertEqual(config["learning_rate"], 1e-4)
        self.assertEqual(config["unet_lr"], 2e-4)
        self.assertEqual(config["output_name"], "00123")
        self.assertEqual(config["positive_prompts"], "123")
        self.assertEqual(config["resolution"], "1024")
        self.assertNotIn("lora_muon_momentum", config)
        adapted, _ = adapt_config(config)
        self.assertEqual(adapted["learning_rate"], 1e-4)
        self.assertTrue(get_sample_prompts(config).startswith("123 --n "))


    def test_invalid_advanced_optimizer_args_are_not_silently_discarded(self):
        for custom in ("eps=unquoted", "missing_separator"):
            config = dict(valid_anima_config(), optimizer_type="AdamW", optimizer_args_custom=custom)
            self.assertTrue(any("optimizer_args" in error for error in validate_training_config(config)))
            with self.assertRaises(ValueError):
                adapt_config(config)


    def test_image_augmentation_cache_contracts(self):
        for profile, module in (("anima-lora", "networks.lora_anima"), ("sdxl-lora", "networks.lora")):
            with self.subTest(profile=profile):
                config = dict(valid_anima_config(), model_train_type=profile, network_module=module)
                # Flipping remains compatible with both kinds of latent caching.
                config["flip_aug"] = True
                self.assertEqual(validate_training_config(config), [])
                for cache_key in ("cache_latents", "cache_latents_to_disk"):
                    conflicting = dict(config, random_crop=True, cache_latents=False, cache_latents_to_disk=False)
                    conflicting[cache_key] = True
                    errors = validate_training_config(conflicting)
                    self.assertTrue(any("random_crop" in error and cache_key in error for error in errors), errors)

                config.update(random_crop=True, cache_latents=False, cache_latents_to_disk=False)
                self.assertEqual(validate_training_config(config), [])
                adapted, warnings = adapt_config(config)
                for key in ("flip_aug", "random_crop"):
                    self.assertIs(adapted[key], True)
                    self.assertFalse(any("Unknown field" in warning and key in warning for warning in warnings), warnings)
                self.assertIs(adapted["cache_latents"], False)
                self.assertIs(adapted["cache_latents_to_disk"], False)


    def test_text_cache_caption_contracts_are_profile_specific(self):
        anima = valid_anima_config()
        anima["caption_dropout_rate"] = 0.1
        self.assertEqual(validate_training_config(anima), [])

        for key, value in (("shuffle_caption", True), ("caption_tag_dropout_rate", 0.1)):
            with self.subTest(train_type="anima-lora", key=key):
                errors = validate_training_config(dict(valid_anima_config(), **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)

        sdxl = dict(
            valid_anima_config(),
            model_train_type="sdxl-lora",
            network_module="networks.lora",
            resolution="1024,1024",
        )
        for key, value in (
            ("caption_dropout_rate", 0.1),
            ("shuffle_caption", True),
            ("caption_tag_dropout_rate", 0.1),
        ):
            with self.subTest(train_type="sdxl-lora", key=key):
                errors = validate_training_config(dict(sdxl, **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)


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


if __name__ == "__main__":
    unittest.main()
