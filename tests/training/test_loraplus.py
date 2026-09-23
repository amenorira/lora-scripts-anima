import unittest


from backend.training.adapter import adapt_config
from backend.training.field_registry import (
    LORAPLUS_INCOMPATIBLE_OPTIMIZERS,
    LORAPLUS_NETWORK_MODULES,
)
from backend.training.optimizer_contracts import ADAFACTOR_OPTIMIZER_TYPE
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

    def test_lycoris_kohya_locon_emits_loraplus_ratios(self):
        adapted, warnings = adapt_config({
            "model_train_type": "sdxl-lora",
            "network_module": "lycoris.kohya",
            "lycoris_algo": "lora",
            "enable_loraplus": True,
            "loraplus_lr_ratio": 2.0,
            "loraplus_unet_lr_ratio": 3.0,
        })

        self.assertEqual(warnings, [])
        self.assertIn("loraplus_lr_ratio=2.0", adapted["network_args"])
        self.assertIn("loraplus_unet_lr_ratio=3.0", adapted["network_args"])
        self.assertIn("algo=lora", adapted["network_args"])
        self.assertNotIn("enable_loraplus", adapted)

    def test_lycoris_kohya_other_algos_drop_loraplus(self):
        for algo in ("lokr", "loha"):
            with self.subTest(algo=algo):
                adapted, warnings = adapt_config({
                    "model_train_type": "sdxl-lora",
                    "network_module": "lycoris.kohya",
                    "lycoris_algo": algo,
                    "enable_loraplus": True,
                    "loraplus_lr_ratio": 2.0,
                })
                self.assertEqual(warnings, [])
                self.assertFalse(
                    any(item.startswith("loraplus_") for item in adapted.get("network_args", [])),
                    adapted,
                )

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

    def test_incompatible_optimizers_are_rejected_with_loraplus(self):
        for optimizer_type in LORAPLUS_INCOMPATIBLE_OPTIMIZERS:
            with self.subTest(optimizer_type=optimizer_type):
                config = valid_loraplus_config(optimizer_type)
                errors = validate_training_config(config)
                self.assertTrue(any("incompatible with LoRA+" in error for error in errors), errors)

    def test_adafactor_requires_manual_learning_rate_mode(self):
        relative = valid_loraplus_config(ADAFACTOR_OPTIMIZER_TYPE)
        relative["adafactor_relative_step"] = True
        errors = validate_training_config(relative)
        self.assertTrue(any("AdaFactor relative_step=True" in error for error in errors), errors)

        manual = valid_loraplus_config(ADAFACTOR_OPTIMIZER_TYPE)
        manual.update(
            {
                "adafactor_relative_step": False,
                "adafactor_scale_parameter": False,
                "adafactor_warmup_init": False,
            }
        )
        self.assertEqual(validate_training_config(manual), [])

        manual["adafactor_warmup_init"] = True
        errors = validate_training_config(manual)
        self.assertTrue(any("warmup_init=True" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
