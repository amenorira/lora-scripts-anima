"""UI option dependencies must survive adaptation into native sd-scripts args."""
import copy
import unittest
from unittest.mock import patch

from backend.training.adapter import adapt_config
from backend.training.validation import validate_training_config
from tests.helpers import valid_training_config
from tests.training.test_moss_image import moss_config


class OptionDependencyTests(unittest.TestCase):
    def test_moss_preview_requires_prompts_before_launch(self):
        for mode, at_first in (("epochs", False), ("steps", False), ("none", True)):
            for prompt in ("", " \n\t "):
                config = moss_config(enable_preview=True, sample_interval_mode=mode,
                                     sample_at_first=at_first, positive_prompts=prompt)
                with self.subTest(mode=mode, at_first=at_first, prompt=prompt):
                    self.assertTrue(any("positive_prompts" in error for error in validate_training_config(config)))
                    with self.assertRaisesRegex(ValueError, "positive_prompts"):
                        adapt_config(config)
                    config["positive_prompts"] = "first line\nsecond line"
                    self.assertEqual(validate_training_config(config), [])
                    adapt_config(config)
        for overrides in ({"enable_preview": False},
                          {"enable_preview": True, "sample_interval_mode": "none", "sample_at_first": False}):
            self.assertEqual(validate_training_config(moss_config(**overrides)), [])

    def test_native_moss_prompt_sources_remain_supported(self):
        config = moss_config(sample_every_n_steps=100, sample_at_first=True)
        for key in ("enable_preview", "sample_interval_mode", "sample_every_n_epochs"):
            config.pop(key, None)
        self.assertTrue(any("positive_prompts" in error for error in validate_training_config(config)))
        for source in ("positive_prompts", "prompt_file", "sample_prompts"):
            with self.subTest(source=source):
                supplied = {**config, source: "test"}
                self.assertEqual(validate_training_config(supplied), [])
                adapt_config(supplied)

    def test_preview_modes_emit_only_the_selected_interval(self):
        for profile in ("anima-lora", "sdxl-lora", "moss-image-lora"):
            for mode, expected in (("epochs", {"sample_every_n_epochs": 2}),
                                   ("steps", {"sample_every_n_steps": 100}), ("none", {})):
                with self.subTest(profile=profile, mode=mode):
                    config = moss_config() if profile == "moss-image-lora" else valid_training_config()
                    config.update(model_train_type=profile, enable_preview=True, positive_prompts="test", sample_interval_mode=mode,
                                  sample_every_n_epochs=2, sample_every_n_steps=100, sample_at_first=True)
                    original = copy.deepcopy(config)
                    adapted, _ = adapt_config(config)
                    self.assertEqual(config, original)
                    self.assertNotIn("sample_interval_mode", adapted)
                    self.assertEqual({key: adapted[key] for key in (
                        "sample_every_n_epochs", "sample_every_n_steps") if key in adapted}, expected)
                    self.assertTrue(adapted["sample_at_first"])

    def test_legacy_intervals_keep_native_epoch_priority(self):
        config = moss_config(enable_preview=True, positive_prompts="test", sample_every_n_epochs=2, sample_every_n_steps=100)
        config.pop("sample_interval_mode")
        adapted, _ = adapt_config(config)
        self.assertEqual(adapted["sample_every_n_epochs"], 2)
        self.assertNotIn("sample_every_n_steps", adapted)
        config.pop("sample_every_n_epochs")
        adapted, _ = adapt_config(config)
        self.assertEqual(adapted["sample_every_n_steps"], 100)
        self.assertNotIn("sample_every_n_epochs", adapted)

    def test_moss_native_scheduler_reaches_step_based_preview(self):
        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library import moss_image_train_utils
        from moss_image_train_network import setup_parser
        for mode, epoch, steps, expected in (
            ("steps", None, 100, True), ("steps", None, 99, False),
            ("steps", 2, 100, False), ("epochs", 2, 100, True),
            ("epochs", None, 100, False), ("none", None, 100, False),
            ("none", 0, 0, True),
        ):
            with self.subTest(mode=mode, epoch=epoch, steps=steps):
                adapted, _ = adapt_config(moss_config(enable_preview=True, positive_prompts="test", sample_interval_mode=mode,
                    sample_every_n_epochs=2, sample_every_n_steps=100, sample_at_first=True))
                args = setup_parser().parse_args([])
                vars(args).update(adapted)
                args.sample_prompts = "missing-test-prompts.txt"
                # The prompt check is the first operation after the scheduling gate.
                with patch.object(moss_image_train_utils.os.path, "isfile", return_value=False) as prompt_check:
                    moss_image_train_utils.sample_images(None, args, epoch, steps, None, None, None, None, None)
                self.assertEqual(prompt_check.called, expected)

    def test_offload_enables_required_checkpointing_in_validation_and_adapter(self):
        for offload in ("cpu_offload_checkpointing", "unsloth_offload_checkpointing"):
            for builder in (valid_training_config, moss_config):
                with self.subTest(offload=offload, profile=builder.__name__):
                    config = builder()
                    config.update(gradient_checkpointing=False, **{offload: True})
                    adapted, _ = adapt_config(config)
                    self.assertTrue(adapted["gradient_checkpointing"])
                    self.assertFalse(config["gradient_checkpointing"])
                    self.assertEqual(validate_training_config(config), [])
                    self.assertTrue(config["gradient_checkpointing"])

    def test_anima_and_moss_reject_conflicting_offloads_without_silent_changes(self):
        for builder, maximum in ((valid_training_config, 26), (moss_config, 40)):
            for options in ({"cpu_offload_checkpointing": True, "unsloth_offload_checkpointing": True},
                            {"cpu_offload_checkpointing": True, "blocks_to_swap": 1},
                            {"unsloth_offload_checkpointing": True, "blocks_to_swap": 1},
                            {"compile": True, "compile_fullgraph": True, "blocks_to_swap": 1}):
                with self.subTest(profile=builder.__name__, options=options):
                    config = {**builder(), **options}
                    original = copy.deepcopy(config)
                    self.assertTrue(validate_training_config(copy.deepcopy(config)))
                    with self.assertRaises(ValueError):
                        adapt_config(config)
                    self.assertEqual(config, original)
            for blocks in (0, 9, maximum):
                config = {**builder(), "blocks_to_swap": blocks, "compile": True, "compile_fullgraph": False}
                with self.subTest(profile=builder.__name__, blocks=blocks):
                    self.assertEqual(validate_training_config(config), [])
                    adapted, warnings = adapt_config(config)
                    self.assertTrue(adapted["compile"])
                    self.assertEqual(adapted["blocks_to_swap"], blocks)
                    self.assertFalse(any("disabling compile" in warning for warning in warnings))
            self.assertTrue(validate_training_config({**builder(), "blocks_to_swap": maximum + 1}))

    def test_preview_and_distribution_bounds_reject_invalid_imports(self):
        for key, value in (("sample_steps", 0), ("sample_steps", 1.5), ("sample_flow_shift", 0),
                           ("logit_std", -0.1), ("sample_every_n_steps", 0)):
            with self.subTest(key=key, value=value):
                config = moss_config(enable_preview=True, sample_interval_mode="steps", **{key: value})
                self.assertTrue(any(key in error for error in validate_training_config(config)))
        self.assertEqual(validate_training_config(moss_config(logit_std=0)), [])
        config = moss_config(enable_preview=True, sample_interval_mode="steps", sample_every_n_steps="")
        self.assertTrue(any("sample_every_n_steps" in error for error in validate_training_config(config)))
        with self.assertRaisesRegex(ValueError, "sample_every_n_steps"):
            adapt_config(config)


if __name__ == "__main__":
    unittest.main()
