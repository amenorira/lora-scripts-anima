import json
import unittest
from pathlib import Path

import torch

from backend.training.adapter import adapt_config
from backend.training.field_registry import (
    AUTOMAGIC_OPTIMIZER_TYPE,
    FIELDS,
    get_fields_json,
)
from backend.training.validation import validate_training_config
from tools.python_startup.lr_logging import read_learning_rates
from vendor.automagic_optimizer.integration import Automagic3


def valid_automagic_config() -> dict:
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update(
        {
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "pretrained_model_name_or_path": "model.safetensors",
            "vae": "vae.safetensors",
            "qwen3": "qwen3.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,768",
            "output_name": "test",
            "output_dir": "output",
            "optimizer_type": AUTOMAGIC_OPTIMIZER_TYPE,
            "learning_rate": "1e-4",
        }
    )
    return config


class AutomagicFieldContractTests(unittest.TestCase):
    def test_registry_exposes_experimental_optimizer_and_fields(self):
        sections = get_fields_json()["sections"]
        fields = {
            field["key"]: field
            for section in sections
            for field in section["fields"]
        }
        optimizer_options = [
            option
            for group in fields["optimizer_type"]["groups"]
            for option in group["options"]
        ]
        self.assertTrue(any(option["v"] == AUTOMAGIC_OPTIMIZER_TYPE for option in optimizer_options))
        self.assertNotIn("lr_scheduler_type", fields)
        self.assertEqual(fields["automagic_max_lr"]["default"], "1e3")
        self.assertEqual(fields["automagic_max_lr"]["hintKey"], "field.automagic_max_lrHint")
        for key in (
            "automagic_min_lr",
            "automagic_max_lr",
            "automagic_beta2",
            "automagic_clip_threshold",
            "automagic_polarity_history",
            "automagic_fused",
        ):
            self.assertEqual(fields[key]["showIf"]["eq"], AUTOMAGIC_OPTIMIZER_TYPE)
        self.assertEqual(fields["full_bf16"]["readonlyIf"]["eq"], AUTOMAGIC_OPTIMIZER_TYPE)
        self.assertFalse(fields["automagic_fused"]["default"])
        self.assertFalse(fields["automagic_fused"]["autoValue"][0]["set"])
        self.assertEqual(
            fields["automagic_fused"]["readonlyIfAny"],
            [
                {"key": "gradient_accumulation_steps", "neq": 1},
                {"key": "max_grad_norm", "neq": 0},
                {"key": "mixed_precision", "eq": "fp16"},
            ],
        )
        self.assertEqual(
            fields["automagic_fused"]["readonlyReasonKey"],
            "field.automagic_fusedLocked",
        )

    def test_frontend_contract_contains_merge_rules_and_translations(self):
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        training_core = Path("frontend/js/training-core.js").read_text(encoding="utf-8")
        constants = Path("frontend/js/constants.js").read_text(encoding="utf-8")
        self.assertIn("automagic_polarity_history', arg: 'polarity_history'", training_toml)
        self.assertIn("automagic_fused', arg: 'fused'", training_toml)
        self.assertIn(AUTOMAGIC_OPTIMIZER_TYPE, constants)
        self.assertIn("_automagicFusedHasConflict", training_core)
        self.assertIn("_automagicFusedConflicts", training_core)
        self.assertIn("automagic_fusedAutoDisabled", training_core)
        self.assertIn("this.form.automagic_fused = false", training_core)
        route = Path("backend/server/routes/training.py").read_text(encoding="utf-8")
        self.assertIn("validate_training_config(config, gpu_ids=gpu_ids)", route)
        self.assertIn("adapt_config(config, gpu_ids=gpu_ids)", route)
        for locale in ("zh-CN", "en-US"):
            messages = json.loads(Path(f"frontend/i18n/{locale}.json").read_text(encoding="utf-8"))
            self.assertIn("optimizer_type_Automagic3", messages["opt"])
            self.assertIn("automagic_max_lr", messages["field"])
            self.assertIn("1e3", messages["field"]["automagic_max_lrHint"])
            self.assertIn("automagic_fusedLocked", messages["field"])
            self.assertIn("automagic_fusedAutoDisabled", messages["field"])
            self.assertIn("{details}", messages["field"]["automagic_fusedAutoDisabled"])
            self.assertIn("{parameter}", messages["field"]["automagic_fusedConflictValue"])


class AutomagicValidationTests(unittest.TestCase):
    def test_accepts_safe_defaults(self):
        self.assertEqual(validate_training_config(valid_automagic_config()), [])

    def test_rejects_invalid_bounds_and_component_learning_rate(self):
        config = valid_automagic_config()
        config["automagic_min_lr"] = 1e-5
        config["automagic_max_lr"] = 1e-4
        config["unet_lr"] = "1e-3"
        errors = validate_training_config(config)
        self.assertTrue(any("unet_lr" in error for error in errors), errors)

        config["automagic_min_lr"] = 1e-3
        errors = validate_training_config(config)
        self.assertTrue(any("min_lr" in error for error in errors), errors)

    def test_rejects_loraplus_effective_rate_above_maximum(self):
        config = valid_automagic_config()
        config.update(
            {
                "enable_loraplus": True,
                "loraplus_lr_ratio": 2.0,
                "learning_rate": "1e-3",
                "automagic_min_lr": "1e-8",
                "automagic_max_lr": "1e-3",
            }
        )
        errors = validate_training_config(config)
        self.assertTrue(
            any("effective UNet/DiT LoRA+ LR" in error for error in errors),
            errors,
        )

        config["loraplus_lr_ratio"] = 1.0
        self.assertEqual(validate_training_config(config), [])

    def test_loraplus_effective_rate_uses_sd_scripts_component_defaults(self):
        config = valid_automagic_config()
        config.pop("network_train_unet_only", None)
        config.pop("network_train_text_encoder_only", None)
        config.update(
            {
                "enable_loraplus": True,
                "loraplus_lr_ratio": 1.0,
                "loraplus_text_encoder_lr_ratio": 20.0,
                "learning_rate": "1e-4",
                "automagic_max_lr": "1e-3",
            }
        )

        errors = validate_training_config(config)
        self.assertTrue(
            any("effective text encoder LoRA+ LR" in error for error in errors),
            errors,
        )

    def test_loraplus_effective_rate_mirrors_cache_target_normalization(self):
        config = valid_automagic_config()
        config.update(
            {
                "network_train_unet_only": False,
                "network_train_text_encoder_only": True,
                "cache_text_encoder_outputs": True,
                "enable_loraplus": True,
                "loraplus_lr_ratio": 1.0,
                "loraplus_unet_lr_ratio": 20.0,
                "loraplus_text_encoder_lr_ratio": 1.0,
                "learning_rate": "1e-4",
                "automagic_max_lr": "1e-3",
            }
        )

        errors = validate_training_config(config)
        self.assertTrue(
            any("effective UNet/DiT LoRA+ LR" in error for error in errors),
            errors,
        )

    def test_rejects_invalid_custom_optimizer_literals(self):
        config = valid_automagic_config()
        for key in (
            "automagic_min_lr",
            "automagic_max_lr",
            "automagic_beta2",
            "automagic_clip_threshold",
            "automagic_polarity_history",
        ):
            config.pop(key, None)
        config["optimizer_args"] = ["max_lr=not-a-number", "polarity_history=1"]
        errors = validate_training_config(config)
        self.assertTrue(any("Python literal" in error for error in errors), errors)
        self.assertTrue(any("polarity_history" in error for error in errors), errors)

    def test_validates_custom_text_and_rejects_unknown_arguments(self):
        config = valid_automagic_config()
        config["optimizer_args_custom"] = "weight_decay=-0.1\nunknown_option=1"
        errors = validate_training_config(config)
        self.assertTrue(any("weight_decay" in error for error in errors), errors)
        self.assertTrue(any("unknown_option" in error for error in errors), errors)

    def test_accepts_fused_when_execution_mode_is_safe(self):
        config = valid_automagic_config()
        config.update(
            {
                "automagic_fused": True,
                "gradient_accumulation_steps": 1,
                "max_grad_norm": 0,
                "mixed_precision": "bf16",
            }
        )
        self.assertEqual(validate_training_config(config, gpu_ids=[0]), [])

    def test_rejects_each_fused_conflict(self):
        cases = (
            ("accumulation", {"gradient_accumulation_steps": 2}, [0], "gradient_accumulation_steps"),
            ("clipping", {"max_grad_norm": 1}, [0], "max_grad_norm"),
            ("fp16", {"mixed_precision": "fp16"}, [0], "mixed_precision"),
            ("multi_gpu", {}, [0, 1], "one GPU"),
        )
        for name, updates, gpu_ids, expected in cases:
            with self.subTest(name=name):
                config = valid_automagic_config()
                config.update(
                    {
                        "automagic_fused": True,
                        "gradient_accumulation_steps": 1,
                        "max_grad_norm": 0,
                        "mixed_precision": "bf16",
                    }
                )
                config.update(updates)
                errors = validate_training_config(config, gpu_ids=gpu_ids)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_custom_fused_uses_the_same_checks_and_guard_is_reserved(self):
        config = valid_automagic_config()
        config.pop("automagic_fused", None)
        config["optimizer_args"] = ["fused=True"]
        config["max_grad_norm"] = 0
        errors = validate_training_config(config)
        self.assertEqual(errors, [])

        config["max_grad_norm"] = 1
        errors = validate_training_config(config)
        self.assertTrue(any("max_grad_norm" in error for error in errors), errors)

        config["optimizer_args"] = ["fused=False", "fused_guard=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("fused_guard" in error for error in errors), errors)


class AutomagicAdapterTests(unittest.TestCase):
    def test_forces_compatibility_mode_without_external_scheduler(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": AUTOMAGIC_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "full_bf16": True,
                "lr_scheduler": "cosine",
                "lr_scheduler_type": "legacy.external.Scheduler",
                "lr_warmup_steps": 100,
                "automagic_min_lr": 1e-7,
                "automagic_max_lr": 2e-3,
                "automagic_fused": True,
                "max_grad_norm": 1,
                "optimizer_args": ["max_lr=1e-2", "beta2=0.99"],
            }
        )
        self.assertNotIn("lr_scheduler_type", adapted)
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertNotIn("full_bf16", adapted)
        self.assertIn("fused=False", adapted["optimizer_args"])
        self.assertNotIn("fused=True", adapted["optimizer_args"])
        self.assertIn("min_lr=1e-07", adapted["optimizer_args"])
        self.assertIn("max_lr=0.002", adapted["optimizer_args"])
        self.assertEqual(sum(item.startswith("max_lr=") for item in adapted["optimizer_args"]), 1)
        self.assertTrue(any("fused" in warning for warning in warnings), warnings)
        self.assertTrue(any("full_bf16" in warning for warning in warnings), warnings)

    def test_preserves_safe_fused_and_injects_runtime_guard(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": AUTOMAGIC_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "gradient_accumulation_steps": 1,
                "max_grad_norm": 0,
                "mixed_precision": "bf16",
                "automagic_fused": True,
            },
            gpu_ids=[0],
        )
        self.assertIn("fused=True", adapted["optimizer_args"])
        self.assertIn("fused_guard=True", adapted["optimizer_args"])
        self.assertFalse(any("fused disabled" in warning for warning in warnings), warnings)

    def test_multi_gpu_fused_is_disabled_by_adapter(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": AUTOMAGIC_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "gradient_accumulation_steps": 1,
                "max_grad_norm": 0,
                "mixed_precision": "bf16",
                "automagic_fused": True,
            },
            gpu_ids=[0, 1],
        )
        self.assertIn("fused=False", adapted["optimizer_args"])
        self.assertFalse(any(item.startswith("fused_guard=") for item in adapted["optimizer_args"]))
        self.assertTrue(any("one GPU" in warning for warning in warnings), warnings)


class AutomagicRuntimeTests(unittest.TestCase):
    def test_dynamic_lr_reporting_and_resume(self):
        parameter = torch.nn.Parameter(torch.tensor([1.0, -1.0], dtype=torch.float32))
        optimizer = Automagic3([parameter], lr=1e-4)

        for _ in range(10):
            parameter.square().mean().backward()
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)

        self.assertFalse(optimizer.fused)
        self.assertEqual(optimizer._hook_handles, [])
        self.assertEqual(read_learning_rates(optimizer=optimizer), optimizer.get_learning_rates())

        state = optimizer.state_dict()
        restored_parameter = torch.nn.Parameter(parameter.detach().clone())
        restored = Automagic3([restored_parameter], lr=1e-4)
        restored.load_state_dict(state)
        self.assertAlmostEqual(restored.get_avg_learning_rate(), optimizer.get_avg_learning_rate(), places=12)

    def test_runtime_requires_guard_and_fused_updates_during_backward(self):
        fp32 = torch.nn.Parameter(torch.ones(2, dtype=torch.float32))
        with self.assertRaisesRegex(ValueError, "validated fused_guard"):
            Automagic3([fp32], fused=True)
        with self.assertRaisesRegex(ValueError, "validated fused_guard"):
            Automagic3([fp32], fused=True, fused_guard="True")
        with self.assertRaisesRegex(ValueError, "fused must be a boolean"):
            Automagic3([fp32], fused="False")

        parameter = torch.nn.Parameter(torch.tensor([1.0, -1.0], dtype=torch.float32))
        optimizer = Automagic3([parameter], lr=1e-4, fused=True, fused_guard=True)
        before = parameter.detach().clone()
        parameter.square().mean().backward()
        self.assertTrue(optimizer.fused)
        self.assertTrue(optimizer._hook_handles)
        self.assertFalse(torch.equal(parameter.detach(), before))

    def test_runtime_rejects_low_precision_and_unsafe_group_lr(self):
        fp32 = torch.nn.Parameter(torch.ones(2, dtype=torch.float32))

        bf16 = torch.nn.Parameter(torch.ones(2, dtype=torch.bfloat16))
        with self.assertRaisesRegex(ValueError, "requires FP32"):
            Automagic3([bf16])

        default_optimizer = Automagic3([fp32])
        self.assertEqual(default_optimizer.param_groups[0]["max_lr"], 1e3)

        with self.assertRaisesRegex(ValueError, "parameter-group lr"):
            Automagic3([{"params": [fp32], "lr": 1e-2}], max_lr=1e-3)

        with self.assertRaisesRegex(ValueError, "weight_decay must be non-negative"):
            Automagic3([fp32], weight_decay=-0.01)


if __name__ == "__main__":
    unittest.main()
