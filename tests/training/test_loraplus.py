import unittest


from backend.training.adapter import adapt_config
from backend.training.field_registry import (
    LORAPLUS_INCOMPATIBLE_OPTIMIZERS,
    LORAPLUS_NETWORK_MODULES,
)
from backend.training.validation import validate_training_config
from tests.helpers import config_from_field_defaults


def valid_loraplus_config(optimizer_type: str = "AdamW") -> dict:
    config = config_from_field_defaults()
    config.update(
        {
            "model_train_type": "sdxl-lora",
            "pretrained_model_name_or_path": "model.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,1024",
            "output_name": "test",
            "output_dir": "output",
            "network_module": "networks.lora",
            "optimizer_type": optimizer_type,
            "enable_loraplus": True,
            "loraplus_lr_ratio": 2.0,
        }
    )
    return config


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

    def test_disabled_switch_removes_custom_and_raw_managed_args(self):
        adapted, warnings = adapt_config({
            "model_train_type": "sdxl-lora",
            "network_module": "networks.lora",
            "enable_loraplus": False,
            "network_args": ["loraplus_unet_lr_ratio=4", "base_flag=1"],
            "network_args_custom": "loraplus_lr_ratio=8\ncustom_flag=1",
        })

        self.assertEqual(warnings, [])
        self.assertEqual(adapted["network_args"], ["base_flag=1", "custom_flag=1"])


class LoRAPlusValidationTests(unittest.TestCase):
    def test_incompatible_optimizers_are_rejected_with_loraplus(self):
        for optimizer_type in LORAPLUS_INCOMPATIBLE_OPTIMIZERS:
            with self.subTest(optimizer_type=optimizer_type):
                config = valid_loraplus_config(optimizer_type)
                errors = validate_training_config(config)
                self.assertTrue(any("incompatible with LoRA+" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
