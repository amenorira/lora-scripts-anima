import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

from PIL import Image

from backend.training.adapter import adapt_config
from backend.training.step_estimator import estimate_training_steps
from backend.training.validation import validate_training_config
from tests.helpers import config_from_field_defaults


def valid_anima_config() -> dict:
    config = config_from_field_defaults()
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


if __name__ == "__main__":
    unittest.main()
