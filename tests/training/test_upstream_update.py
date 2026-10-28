"""Product regressions for sd-scripts 0.12.2 integration."""
import unittest


from backend.training.config.adapter import adapt_config
from backend.training.config.training_config import build_training_config, extract_training_form
from tests.training.test_moss_image import moss_config


class BlockSwapConfigTests(unittest.TestCase):

    def test_h2d_options_survive_saved_config_and_toml_for_both_profiles(self):
        for profile, module in (("anima-lora", "networks.lora_anima"),
                                ("moss-image-lora", "networks.lora_generic")):
            with self.subTest(profile=profile):
                config = moss_config(model_train_type=profile, network_module=module,
                                     blocks_to_swap=4, block_swap_h2d_only=True,
                                     block_swap_ring_size=1, use_pinned_memory_for_block_swap=True)
                saved = build_training_config(config, profile_id=profile)
                restored = extract_training_form(saved)
                native, _ = adapt_config(restored)
                self.assertTrue(native["block_swap_h2d_only"])
                self.assertTrue(native["gradient_checkpointing"])
                self.assertEqual(native["block_swap_ring_size"], 1)
                self.assertTrue(native["use_pinned_memory_for_block_swap"])
                native, _ = adapt_config({**restored, "block_swap_h2d_only": False})
                self.assertNotIn("block_swap_ring_size", native)
                self.assertNotIn("use_pinned_memory_for_block_swap", native)
