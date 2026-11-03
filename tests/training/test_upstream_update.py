"""Product configuration regressions for sd-scripts updates."""
import unittest


from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.config.validation import validate_training_config
from backend.training.fields.field_registry import get_fields_json, field_applies_to_profile
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

    def test_partial_checkpointing_survives_native_and_saved_config_round_trips(self):
        for profile, module, maximum in (("anima-lora", "networks.lora_anima", 28),
                                         ("moss-image-lora", "networks.lora_generic", 42)):
            with self.subTest(profile=profile):
                config = moss_config(model_train_type=profile, network_module=module,
                                     gradient_checkpointing=True, gradient_checkpointing_skip_blocks=maximum)
                restored = extract_training_form(build_training_config(config, profile_id=profile))
                native, _ = adapt_config(restored)
                self.assertEqual(native["gradient_checkpointing_skip_blocks"], maximum)
                imported = import_native_training_form(native, profile_id=profile)
                self.assertEqual(imported["gradient_checkpointing_skip_blocks"], maximum)

    def test_text_encoder_swap_survives_config_round_trips_without_caching(self):
        config = moss_config(text_encoder_blocks_to_swap=32, cache_text_encoder_outputs=False,
                             cache_text_encoder_outputs_to_disk=False)
        restored = extract_training_form(build_training_config(config, profile_id="moss-image-lora"))
        native, _ = adapt_config(restored)
        self.assertEqual(native["text_encoder_blocks_to_swap"], 32)
        self.assertEqual(import_native_training_form(native)["text_encoder_blocks_to_swap"], 32)

    def test_profile_visibility_and_export_remove_other_profiles_leftovers(self):
        fields = {field["key"]: field for section in get_fields_json()["sections"] for field in section["fields"]}
        skip, text_swap = fields["gradient_checkpointing_skip_blocks"], fields["text_encoder_blocks_to_swap"]
        self.assertEqual(skip["default"], 0)
        self.assertTrue(skip["omitDefault"])
        self.assertEqual(skip["max"], 28)
        self.assertEqual(skip["constraintsByGroup"]["moss_image"]["max"], 42)
        self.assertEqual(text_swap["default"], "")
        self.assertEqual(text_swap["max"], 32)
        for profile, has_skip, has_text_swap in (("anima-lora", True, False),
                                               ("moss-image-lora", True, True),
                                               ("sdxl-lora", False, False),
                                               ("krea2-lora", False, False)):
            with self.subTest(profile=profile):
                self.assertEqual(field_applies_to_profile(skip, profile), has_skip)
                self.assertEqual(field_applies_to_profile(text_swap, profile), has_text_swap)
                if profile == "krea2-lora":
                    continue  # Musubi does not use the sd-scripts adapter.
                config = moss_config(model_train_type=profile, gradient_checkpointing=True,
                                     gradient_checkpointing_skip_blocks=2, text_encoder_blocks_to_swap=4)
                native, _ = adapt_config(config)
                self.assertEqual("gradient_checkpointing_skip_blocks" in native, has_skip)
                self.assertEqual("text_encoder_blocks_to_swap" in native, has_text_swap)

    def test_disabled_checkpointing_omits_skip_but_offload_retains_it(self):
        for offload in (None, "cpu_offload_checkpointing", "unsloth_offload_checkpointing"):
            with self.subTest(offload=offload):
                config = moss_config(gradient_checkpointing=False, gradient_checkpointing_skip_blocks=3)
                if offload:
                    config[offload] = True
                self.assertEqual(validate_training_config(config), [])
                native, _ = adapt_config(config)
                if offload:
                    self.assertTrue(native["gradient_checkpointing"])
                    self.assertEqual(native["gradient_checkpointing_skip_blocks"], 3)
                else:
                    self.assertNotIn("gradient_checkpointing_skip_blocks", native)
