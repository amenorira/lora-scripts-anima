import json
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

from PIL import Image

from backend.training.adapter import adapt_config
from backend.training.field_registry import get_all_fields
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
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

    def test_adapter_does_not_silently_clear_caption_conflicts(self):
        config = valid_anima_config()
        config.update(shuffle_caption=True, caption_tag_dropout_rate=0.1)

        adapted, warnings = adapt_config(config)

        self.assertTrue(adapted["shuffle_caption"])
        self.assertEqual(adapted["caption_tag_dropout_rate"], 0.1)
        self.assertFalse(any("cleared by backend" in warning for warning in warnings))

    def test_checkpoint_offload_conflict_order_matches_form_contract(self):
        adapted, warnings = adapt_config(
            dict(
                valid_anima_config(),
                cpu_offload_checkpointing=True,
                unsloth_offload_checkpointing=True,
                blocks_to_swap=0,
            )
        )
        self.assertFalse(adapted["cpu_offload_checkpointing"])
        self.assertTrue(adapted["unsloth_offload_checkpointing"])
        self.assertTrue(any("cpu_offload_checkpointing" in warning for warning in warnings))

        adapted, warnings = adapt_config(
            dict(
                valid_anima_config(),
                cpu_offload_checkpointing=True,
                unsloth_offload_checkpointing=True,
                blocks_to_swap=1,
            )
        )
        self.assertFalse(adapted["cpu_offload_checkpointing"])
        self.assertFalse(adapted["unsloth_offload_checkpointing"])
        self.assertTrue(any("blocks_to_swap" in warning for warning in warnings))

        adapted, warnings = adapt_config(
            dict(
                valid_anima_config(),
                cpu_offload_checkpointing=True,
                unsloth_offload_checkpointing=False,
                blocks_to_swap=1,
            )
        )
        self.assertTrue(adapted["cpu_offload_checkpointing"])
        self.assertFalse(any("cpu_offload_checkpointing" in warning for warning in warnings))

    def test_keep_tokens_is_emitted_only_when_caption_tag_randomization_is_active(self):
        cases = (
            (False, 0, False),
            (True, 0, True),
            (False, 0.1, True),
            (True, 0.1, True),
        )
        for shuffle, dropout, expected_keep_tokens in cases:
            with self.subTest(shuffle=shuffle, dropout=dropout):
                adapted, _ = adapt_config(
                    {
                        "model_train_type": "anima-lora",
                        "shuffle_caption": shuffle,
                        "caption_tag_dropout_rate": dropout,
                        "keep_tokens": 3,
                    }
                )
                self.assertEqual("keep_tokens" in adapted, expected_keep_tokens)
                self.assertEqual("caption_tag_dropout_rate" in adapted, dropout > 0)
                if expected_keep_tokens:
                    self.assertEqual(adapted["keep_tokens"], 3)

class TrainingFieldSchemaTests(unittest.TestCase):
    @staticmethod
    def _lookup(messages: dict, key: str):
        value = messages
        for part in key.split("."):
            if not isinstance(value, dict) or part not in value:
                return None
            value = value[part]
        return value

    @staticmethod
    def _walk(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from TrainingFieldSchemaTests._walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from TrainingFieldSchemaTests._walk(child)

    def test_all_field_i18n_references_exist_in_both_locales(self):
        reference_keys = {
            item[key]
            for item in self._walk(get_all_fields())
            if isinstance(item, dict)
            for key in ("desc_key", "hint_key", "readonly_reason_key", "reason_key", "dk", "label_key")
            if isinstance(item.get(key), str) and item[key]
        }
        reference_keys.update(
            hint_key
            for field in get_all_fields()
            for hint_key in (field.get("hint_key_by") or {}).get("values", {}).values()
        )
        for locale in ("zh-CN", "en-US"):
            messages = json.loads(Path(f"frontend/i18n/{locale}.json").read_text(encoding="utf-8"))
            for key in reference_keys:
                with self.subTest(locale=locale, key=key):
                    value = self._lookup(messages, key)
                    self.assertIsInstance(value, str)
                    self.assertTrue(value.strip())

    def test_field_conditions_reference_registered_keys(self):
        fields = get_all_fields()
        registered = {field["key"] for field in fields}
        for field in fields:
            for attr in ("show_if", "show_if_any", "readonly_if", "readonly_if_any"):
                for item in self._walk(field.get(attr)):
                    key = item.get("key") if isinstance(item, dict) else None
                    if key:
                        with self.subTest(field=field["key"], attr=attr, key=key):
                            self.assertIn(key, registered)

    def test_layout_parents_reference_fields_in_the_same_section(self):
        fields = get_all_fields()
        by_key = {field["key"]: field for field in fields}
        for field in fields:
            parent_key = field.get("layout_parent")
            if not parent_key:
                continue
            with self.subTest(field=field["key"], parent=parent_key):
                self.assertIn(parent_key, by_key)
                self.assertEqual(field["section"], by_key[parent_key]["section"])

    def test_select_defaults_are_declared_options(self):
        for field in get_all_fields():
            if field.get("type") != "select" or "default" not in field:
                continue
            options = list(field.get("options") or [])
            for group in field.get("groups") or []:
                options.extend(group.get("options") or [])
            values = {option.get("v") for option in options if "v" in option}
            if values:
                with self.subTest(field=field["key"], default=field["default"]):
                    self.assertIn(field["default"], values)


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

    def test_missing_dataset_exposes_localizable_error_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing_dataset"

            with self.assertRaises(StepEstimateError) as context:
                estimate_training_steps(self._config(missing))

            self.assertEqual(context.exception.code, "datasetNotFound")
            self.assertEqual(context.exception.params, {"path": str(missing)})


if __name__ == "__main__":
    unittest.main()
