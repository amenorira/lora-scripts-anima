import unittest


from backend.training.config.validation import validate_training_config
from backend.training.config.adapter import adapt_config
from backend.training.config.option_contracts import validate_sd_option_dependencies
from tests.helpers import valid_training_config as valid_anima_config
from tests.training.test_moss_image import moss_config


class TrainingValidationTests(unittest.TestCase):

    def test_sdxl_text_cache_requires_backbone_only_at_both_backend_boundaries(self):
        for disk in (False, True):
            for unet_only, te_only in ((False, False), (False, True), (True, True), (True, False)):
                with self.subTest(disk=disk, unet_only=unet_only, te_only=te_only):
                    config = dict(valid_anima_config(), model_train_type="sdxl-lora",
                                  network_module="networks.lora", network_train_unet_only=unet_only,
                                  network_train_text_encoder_only=te_only,
                                  cache_text_encoder_outputs=not disk,
                                  cache_text_encoder_outputs_to_disk=disk)
                    errors = validate_training_config(config.copy())
                    if unet_only and not te_only:
                        self.assertEqual(errors, [])
                        adapted, _ = adapt_config(config)
                        self.assertTrue(adapted["network_train_unet_only"])
                    else:
                        self.assertTrue(any("SDXL Text Encoder caching" in error for error in errors), errors)
                        with self.assertRaisesRegex(ValueError, "SDXL Text Encoder caching"):
                            adapt_config(config)

    def test_automagic_scope_matches_adapter_for_disk_text_cache(self):
        from backend.training.config.optimizer_contracts import AUTOMAGIC_OPTIMIZER_TYPE

        for disk in (False, True):
            config = dict(valid_anima_config(), optimizer_type=AUTOMAGIC_OPTIMIZER_TYPE,
                          enable_loraplus=True, loraplus_lr_ratio=1,
                          loraplus_text_encoder_lr_ratio=1000000,
                          network_train_unet_only=False, network_train_text_encoder_only=True,
                          cache_text_encoder_outputs=not disk, cache_text_encoder_outputs_to_disk=disk)
            errors = validate_training_config(config.copy())
            self.assertFalse(any("effective text encoder LoRA+ LR" in error for error in errors), errors)
            adapted, _ = adapt_config(config)
            self.assertTrue(adapted["network_train_unet_only"])
            self.assertFalse(adapted["network_train_text_encoder_only"])


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

    def test_partial_checkpointing_ranges_follow_each_model(self):
        for factory, maximum in ((valid_anima_config, 28), (moss_config, 42)):
            for value in (0, maximum):
                with self.subTest(profile=factory.__name__, value=value):
                    config = factory()
                    config.update(gradient_checkpointing=True, gradient_checkpointing_skip_blocks=value)
                    self.assertEqual(validate_training_config(config), [])
            for value in (-1, maximum + 1, 0.5, True, float("inf"), "invalid"):
                with self.subTest(profile=factory.__name__, value=value):
                    config = factory()
                    config.update(gradient_checkpointing=True, gradient_checkpointing_skip_blocks=value)
                    errors = validate_training_config(config)
                    self.assertTrue(any("gradient_checkpointing_skip_blocks" in error for error in errors), errors)

    def test_text_encoder_swap_range_and_freeze_contract_without_cache(self):
        for value in ("", 0, 32):
            with self.subTest(value=value):
                self.assertEqual(validate_training_config(moss_config(
                    text_encoder_blocks_to_swap=value, cache_text_encoder_outputs=False,
                    cache_text_encoder_outputs_to_disk=False)), [])
        for value in (-1, 33, 0.5, True, float("inf"), "invalid"):
            with self.subTest(value=value):
                errors = validate_training_config(moss_config(text_encoder_blocks_to_swap=value))
                self.assertTrue(any("text_encoder_blocks_to_swap" in error for error in errors), errors)
        # Frozen encoding can stream without checkpointing, with DiT swap or with INT8.
        self.assertEqual(validate_training_config(moss_config(
            text_encoder_blocks_to_swap=28, cache_text_encoder_outputs=False,
            cache_text_encoder_outputs_to_disk=False, gradient_checkpointing=False,
            blocks_to_swap=4, convrot_int8_text_encoder=True)), [])
        for overrides in ({"network_train_unet_only": False}, {"network_train_text_encoder_only": True}):
            with self.subTest(overrides=overrides):
                config = moss_config(text_encoder_blocks_to_swap=1, cache_text_encoder_outputs=False,
                                     cache_text_encoder_outputs_to_disk=False, **overrides)
                errors = validate_training_config(config)
                self.assertTrue(any("text_encoder_blocks_to_swap" in error for error in errors), errors)
                with self.assertRaisesRegex(ValueError, "text_encoder_blocks_to_swap"):
                    adapt_config(config)

    def test_partial_checkpointing_h2d_guard_preserves_safe_ring_configurations(self):
        for factory in (valid_anima_config, moss_config):
            for swapped, skipped, ring, h2d, blocked in (
                (6, 4, 2, True, True), (8, 8, 2, True, True),
                (6, 0, 2, True, False), (6, 2, 2, True, False),
                (6, 3, 3, True, False), (6, 8, 6, True, False),
                (6, 8, 2, False, False),
            ):
                with self.subTest(profile=factory.__name__, swapped=swapped, skipped=skipped, ring=ring, h2d=h2d):
                    config = factory()
                    config.update(gradient_checkpointing=True, blocks_to_swap=swapped,
                                  gradient_checkpointing_skip_blocks=skipped, block_swap_ring_size=ring,
                                  block_swap_h2d_only=h2d)
                    original = config.copy()
                    errors = validate_training_config(config)
                    self.assertEqual(any("gradient_checkpointing_skip_blocks" in error for error in errors), blocked, errors)
                    if blocked:
                        with self.assertRaisesRegex(ValueError, "gradient_checkpointing_skip_blocks"):
                            adapt_config(original)
                    else:
                        self.assertEqual(errors, [])
                        native, _ = adapt_config(original)
                        self.assertEqual(native["gradient_checkpointing_skip_blocks"], skipped)
                    self.assertEqual(original["gradient_checkpointing_skip_blocks"], skipped)
                    self.assertEqual(original["block_swap_ring_size"], ring)

    def test_partial_checkpointing_h2d_guard_uses_effective_checkpointing_and_valid_counts(self):
        base = moss_config(gradient_checkpointing=False, blocks_to_swap=6,
                           gradient_checkpointing_skip_blocks=4, block_swap_ring_size=2,
                           block_swap_h2d_only=True)
        errors = validate_sd_option_dependencies(base)
        self.assertFalse(any("gradient_checkpointing_skip_blocks" in error for error in errors), errors)
        for offload in ("cpu_offload_checkpointing", "unsloth_offload_checkpointing"):
            errors = validate_sd_option_dependencies({**base, offload: True})
            self.assertTrue(any("gradient_checkpointing_skip_blocks" in error for error in errors), errors)
        for key in ("blocks_to_swap", "gradient_checkpointing_skip_blocks", "block_swap_ring_size"):
            for value in (True, -1, 0.5, float("inf"), "invalid"):
                with self.subTest(key=key, value=value):
                    errors = validate_sd_option_dependencies({**base, "gradient_checkpointing": True, key: value})
                    self.assertFalse(any("gradient_checkpointing_skip_blocks" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
