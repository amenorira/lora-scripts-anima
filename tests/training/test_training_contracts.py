import unittest


from backend.training.config.validation import validate_training_config
from backend.training.config.adapter import adapt_config
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

if __name__ == "__main__":
    unittest.main()
