import unittest

from backend.training.adapter import adapt_config
from backend.training.field_registry import LORAPLUS_NETWORK_MODULES, get_fields_json
from backend.training.validation import validate_training_config


class LoRAPlusAdapterTests(unittest.TestCase):
    def test_supported_modules_emit_native_sd_scripts_network_args(self):
        for module in LORAPLUS_NETWORK_MODULES:
            with self.subTest(module=module):
                adapted, warnings = adapt_config({
                    "model_train_type": "anima-lora" if module == "networks.lora_anima" else "sdxl-lora",
                    "network_module": module,
                    "enable_loraplus": True,
                    "loraplus_lr_ratio": 2.0,
                    "loraplus_unet_lr_ratio": 3.0,
                    "loraplus_text_encoder_lr_ratio": 1.5,
                })

                self.assertEqual(warnings, [])
                self.assertEqual(
                    adapted["network_args"],
                    [
                        "loraplus_lr_ratio=2.0",
                        "loraplus_unet_lr_ratio=3.0",
                        "loraplus_text_encoder_lr_ratio=1.5",
                    ],
                )
                self.assertNotIn("enable_loraplus", adapted)

    def test_disabled_switch_drops_managed_ratio_values(self):
        adapted, warnings = adapt_config({
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "enable_loraplus": False,
            "loraplus_lr_ratio": 2.0,
            "loraplus_unet_lr_ratio": 4.0,
        })

        self.assertEqual(warnings, [])
        self.assertNotIn("network_args", adapted)
        self.assertNotIn("loraplus_lr_ratio", adapted)
        self.assertNotIn("loraplus_unet_lr_ratio", adapted)

    def test_unsupported_module_drops_managed_values_but_keeps_custom_args(self):
        adapted, warnings = adapt_config({
            "model_train_type": "sdxl-lora",
            "network_module": "lycoris.kohya",
            "enable_loraplus": True,
            "loraplus_lr_ratio": 2.0,
            "network_args_custom": "custom_flag=1",
        })

        self.assertEqual(warnings, [])
        self.assertEqual(adapted["network_args"], ["custom_flag=1"])

    def test_managed_ratio_overrides_duplicate_custom_arg(self):
        adapted, warnings = adapt_config({
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "enable_loraplus": True,
            "loraplus_lr_ratio": 2.0,
            "network_args_custom": "loraplus_lr_ratio=8\ncustom_flag=1",
        })

        self.assertEqual(warnings, [])
        self.assertEqual(
            adapted["network_args"],
            ["custom_flag=1", "loraplus_lr_ratio=2.0"],
        )


class LoRAPlusValidationTests(unittest.TestCase):
    def test_enabled_switch_requires_at_least_one_ratio(self):
        config = {
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "enable_loraplus": True,
            "loraplus_lr_ratio": "",
            "loraplus_unet_lr_ratio": "",
            "loraplus_text_encoder_lr_ratio": "",
        }
        errors = validate_training_config(config)
        self.assertTrue(any("at least one LoRA+ ratio" in error for error in errors), errors)

    def test_ratio_must_not_be_less_than_one(self):
        config = {
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "enable_loraplus": True,
            "loraplus_lr_ratio": 0.5,
        }
        errors = validate_training_config(config)
        self.assertTrue(any("loraplus_lr_ratio" in error for error in errors), errors)

    def test_prodigy_optimizers_are_rejected_with_loraplus(self):
        for optimizer_type in ("Prodigy", "prodigyplus.ProdigyPlusScheduleFree"):
            with self.subTest(optimizer_type=optimizer_type):
                config = {
                    "model_train_type": "sdxl-lora",
                    "network_module": "networks.lora",
                    "optimizer_type": optimizer_type,
                    "enable_loraplus": True,
                    "loraplus_lr_ratio": 2.0,
                }
                errors = validate_training_config(config)
                self.assertTrue(any("incompatible with LoRA+" in error for error in errors), errors)

    def test_registry_exposes_doc_targets_and_supported_module_condition(self):
        sections = get_fields_json()["sections"]
        fields = {
            field["key"]: field
            for section in sections
            for field in section["fields"]
        }
        toggle = fields["enable_loraplus"]
        self.assertEqual(toggle["docSlug"], "lora-plus")
        self.assertEqual(toggle["docAnchor"], "overview")
        self.assertEqual(
            {toggle["showIf"]["eq"], *toggle["showIf"]["or"]},
            set(LORAPLUS_NETWORK_MODULES),
        )


if __name__ == "__main__":
    unittest.main()
