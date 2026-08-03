import shutil
import subprocess
import unittest
from pathlib import Path

import torch
from transformers.optimization import Adafactor

from backend.training.adapter import adapt_config
from backend.training.field_registry import (
    EMOSENS_OPTIMIZER_TYPE,
    FIELDS,
    LORAPLUS_INCOMPATIBLE_OPTIMIZERS,
    LORAPLUS_NETWORK_MODULES,
    get_fields_json,
)
from backend.training.optimizer_contracts import ADAFACTOR_OPTIMIZER_TYPE
from backend.training.validation import validate_training_config
from vendor.emo_optimizer.emosens import EmoSens


def valid_loraplus_config(optimizer_type: str = "AdamW") -> dict:
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
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
        auto_disabled = {
            rule.get("when")
            for rule in toggle["autoValue"]
            if rule.get("watch") == "optimizer_type"
        }
        self.assertEqual(auto_disabled, set(LORAPLUS_INCOMPATIBLE_OPTIMIZERS))
        self.assertTrue(
            any(
                rule.get("watch")
                == {
                    "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                    "adafactor_relative_step": True,
                }
                and rule.get("set") is False
                for rule in toggle["autoValue"]
            )
        )
        self.assertTrue(
            any(
                rule.get("watch")
                == {
                    "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                    "adafactor_warmup_init": True,
                }
                and rule.get("set") is False
                for rule in toggle["autoValue"]
            )
        )
        readonly_groups = toggle["readonlyIfAny"]
        self.assertTrue(
            any(
                isinstance(group, list)
                and {condition["key"] for condition in group}
                == {"optimizer_type", "adafactor_relative_step"}
                for group in readonly_groups
            )
        )
        self.assertTrue(
            any(
                isinstance(group, list)
                and {condition["key"] for condition in group}
                == {"optimizer_type", "adafactor_warmup_init"}
                for group in readonly_groups
            )
        )
        self.assertIn(
            {"key": "optimizer_type", "eq": EMOSENS_OPTIMIZER_TYPE},
            readonly_groups,
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_frontend_preview_ignores_custom_loraplus_args_when_disabled(self):
        script = r"""
global.window = {};
global.document = { getElementById() { return null; } };
window.getVisibleSections = () => [{ key: 'network', fields: [] }];
require('./frontend/js/training-toml.js');
const ctx = Object.assign({}, window.trainingTomlMixin, {
  form: {
    model_train_type: 'sdxl-lora',
    network_module: 'networks.lora',
    enable_loraplus: false,
    network_args_custom: 'loraplus_lr_ratio=8\ncustom_flag=1',
  },
  t() { return 'none'; },
  esc(value) { return String(value); },
  findFieldDef() { return null; },
});
ctx.updateToml();
console.log(ctx.tomlRaw);
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        self.assertIn('network_args = ["custom_flag=1"]', result.stdout)
        self.assertNotIn("loraplus_lr_ratio", result.stdout)


class LoRAPlusOptimizerBehaviorTests(unittest.TestCase):
    @staticmethod
    def _adafactor_update(relative_step: bool) -> tuple[float, float]:
        regular = torch.nn.Parameter(torch.tensor([1.0]))
        plus = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = Adafactor(
            [
                {"params": [regular], "lr": 1e-4},
                {"params": [plus], "lr": 2e-4},
            ],
            lr=None if relative_step else 1e-4,
            relative_step=relative_step,
            scale_parameter=False,
            warmup_init=False,
        )
        regular.grad = torch.tensor([0.1])
        plus.grad = torch.tensor([0.1])
        optimizer.step()
        return 1.0 - regular.item(), 1.0 - plus.item()

    def test_adafactor_relative_step_erases_group_update_ratio(self):
        relative_regular, relative_plus = self._adafactor_update(True)
        self.assertAlmostEqual(relative_regular, relative_plus, places=7)

        manual_regular, manual_plus = self._adafactor_update(False)
        self.assertAlmostEqual(manual_plus / manual_regular, 2.0, delta=1e-3)

    def test_emosens_rewrites_distinct_group_rates_to_one_value(self):
        regular = torch.nn.Parameter(torch.tensor([1.0]))
        plus = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = EmoSens(
            [
                {"params": [regular], "lr": 1e-4},
                {"params": [plus], "lr": 2e-4},
            ],
            lr=1e-4,
            notify=False,
        )
        regular.grad = torch.tensor([0.1])
        plus.grad = torch.tensor([0.1])
        optimizer.step()
        self.assertEqual(optimizer.param_groups[0]["lr"], optimizer.param_groups[1]["lr"])


if __name__ == "__main__":
    unittest.main()
