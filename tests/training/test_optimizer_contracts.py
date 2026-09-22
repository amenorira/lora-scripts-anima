import unittest


from backend.training.adapter import adapt_config
from backend.training.optimizer_contracts import (
    ADAFACTOR_OPTIMIZER_TYPE,
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    LORA_MUON_OPTIMIZER_TYPE,
    LORARITE_OPTIMIZER_TYPE,
    MUON_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    SOAP_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)
from backend.training.validation import validate_training_config
from tests.helpers import config_from_field_defaults


def valid_config(optimizer_type: str, train_type: str = "anima-lora") -> dict:
    config = config_from_field_defaults()
    config.update(
        {
            "model_train_type": train_type,
            "network_module": (
                "networks.lora_anima" if train_type == "anima-lora" else "networks.lora"
            ),
            "pretrained_model_name_or_path": "model.safetensors",
            "vae": "vae.safetensors",
            "qwen3": "qwen3.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,1024",
            "output_name": "test",
            "output_dir": "output",
            "optimizer_type": optimizer_type,
            "gradient_accumulation_steps": 1,
            "mixed_precision": "bf16",
        }
    )
    if optimizer_type in {PRODIGY_OPTIMIZER_TYPE, PRODIGYPLUS_OPTIMIZER_TYPE}:
        config["learning_rate"] = "1.0"
    return config


class OptimizerValidationTests(unittest.TestCase):
    def test_validates_optimizer_specific_parameter_domains(self):
        cases = (
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999"}, "exactly 3"),
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999, 1.1"}, "item 2"),
            (PRODIGY_OPTIMIZER_TYPE, {"prodigy_d0": "0"}, "d0"),
            ("AdamW", {"weight_decay": -0.01}, "weight_decay"),
            ("AdamW8bit", {"optimizer_args": ["optim_bits=8"]}, "one of"),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, {"schedulefree_warmup_steps": 1.5}, "integer"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9"}, "exactly 2"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9, 1.0"}, "item 1"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"eps": "-1e-8"}, "eps"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"stableadamw_kahan_sum": "yes"}, "true or false"),
            ("AdamW8bit", {"bnb_percentile_clipping": 0}, "percentile_clipping"),
            ("Lion8bit", {"bnb_percentile_clipping": 101}, "percentile_clipping"),
            ("PagedAdamW8bit", {"bnb_min_8bit_size": -1}, "min_8bit_size"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_steps": 0}, "ns_steps"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_steps": 100}, "ns_steps"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_coefficients": "1, 2"}, "exactly 3"),
            (MUON_OPTIMIZER_TYPE, {"muon_adjust_lr_fn": "unknown"}, "one of"),
            (LORA_MUON_OPTIMIZER_TYPE, {"ns_steps": 0}, "ns_steps"),
            (LORA_MUON_OPTIMIZER_TYPE, {"inv_sqrt_steps": 8}, "inv_sqrt_steps"),
            (LORA_MUON_OPTIMIZER_TYPE, {"momentum": 1.0}, "momentum"),
            (SOAP_OPTIMIZER_TYPE, {"max_precondition_dim": 0}, "max_precondition_dim"),
            (SOAP_OPTIMIZER_TYPE, {"precondition_frequency": 0}, "precondition_frequency"),
            (SOAP_OPTIMIZER_TYPE, {"shampoo_beta": 1.0}, "shampoo_beta"),
            (SOAP_OPTIMIZER_TYPE, {"betas": "0.95"}, "exactly 2"),
            (SOAP_OPTIMIZER_TYPE, {"precondition_1d": "yes"}, "true or false"),
        )
        for optimizer_type, updates, expected in cases:
            with self.subTest(optimizer_type=optimizer_type, updates=updates):
                config = valid_config(optimizer_type)
                config.update(updates)
                errors = validate_training_config(config)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_rejects_unknown_arguments_for_known_optimizers(self):
        config = valid_config("AdamW")
        config["optimizer_args"] = ["silently_ignored_option=1"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_native_muon_is_limited_to_anima_profile(self):
        anima = valid_config(MUON_OPTIMIZER_TYPE, "anima-lora")
        self.assertEqual(validate_training_config(anima), [])

        sdxl = valid_config(MUON_OPTIMIZER_TYPE, "sdxl-lora")
        errors = validate_training_config(sdxl)
        self.assertTrue(any("only for Anima LoRA" in error for error in errors), errors)

    def test_lora_muon_requires_anima_native_network(self):
        valid = valid_config(LORA_MUON_OPTIMIZER_TYPE, "anima-lora")
        self.assertEqual(validate_training_config(valid), [])

        wrong_module = valid_config(LORA_MUON_OPTIMIZER_TYPE, "anima-lora")
        wrong_module["network_module"] = "networks.lora"
        errors = validate_training_config(wrong_module)
        self.assertTrue(any("LoRA-Muon" in error for error in errors), errors)

        sdxl = valid_config(LORA_MUON_OPTIMIZER_TYPE, "sdxl-lora")
        errors = validate_training_config(sdxl)
        self.assertTrue(any("LoRA-Muon" in error for error in errors), errors)

    def test_lora_muon_and_loraplus_are_rejected_together(self):
        config = valid_config(LORA_MUON_OPTIMIZER_TYPE)
        config.update(
            {
                "enable_loraplus": True,
                "loraplus_lr_ratio": 2,
            }
        )
        errors = validate_training_config(config)
        self.assertTrue(any("incompatible with LoRA+" in error for error in errors), errors)

        config = valid_config(STABLE_ADAMW_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["unknown_stability_knob=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_rejects_prodigyplus_fused_modes(self):
        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["fused_back_pass=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("skip all updates" in error for error in errors), errors)

        config["optimizer_args"] = ["fused_backward_pass=False"]
        errors = validate_training_config(config)
        self.assertTrue(any("not a valid optimizer argument" in error for error in errors), errors)

        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["fused_backward_pass"] = True
        errors = validate_training_config(config)
        self.assertTrue(any("fused_backward_pass" in error for error in errors), errors)


class OptimizerAdapterTests(unittest.TestCase):
    def test_optimizer_argument_serialization(self):
        cases = [
            (MUON_OPTIMIZER_TYPE, {
                "muon_momentum": 0.95, "muon_nesterov": True, "muon_ns_steps": 5,
                "muon_ns_coefficients": "3.4445, -4.775, 2.0315",
                "muon_adjust_lr_fn": "match_rms_adamw", "eps": "1e-7",
            }, ["momentum=0.95", "nesterov=True", "ns_steps=5", "eps=1e-7",
                "ns_coefficients=(3.4445, -4.775, 2.0315)", "adjust_lr_fn='match_rms_adamw'"]),
            (SOAP_OPTIMIZER_TYPE, {
                "betas": "0.95, 0.95", "eps": "1e-8", "max_precondition_dim": 256,
                "precondition_frequency": 10, "shampoo_beta": 0.9,
                "normalize_gradient": False, "correct_bias": False, "precondition_1d": True,
            }, ["betas=0.95, 0.95", "eps=1e-8", "max_precondition_dim=256",
                "precondition_frequency=10", "shampoo_beta=0.9", "normalize_gradient=False",
                "correct_bias=False", "precondition_1d=True"]),
            (LORA_MUON_OPTIMIZER_TYPE, {
                "momentum": 0.9, "ns_steps": 8, "inv_sqrt_steps": 7, "msign_eps": "1e-20",
                "inv_sqrt_eps": "1e-5", "inv_sqrt_gamma": "1.001", "gauge_rebalance": False,
                "gauge_rebalance_alpha": 1.0, "gauge_rebalance_interval": 1, "gauge_power_steps": 2,
            }, ["momentum=0.9", "ns_steps=8", "inv_sqrt_steps=7", "msign_eps=1e-20",
                "inv_sqrt_eps=1e-5", "inv_sqrt_gamma=1.001", "gauge_rebalance=False",
                "gauge_rebalance_alpha=1.0", "gauge_rebalance_interval=1", "gauge_power_steps=2"]),
        ]
        for optimizer, values, expected in cases:
            with self.subTest(optimizer=optimizer):
                adapted, warnings = adapt_config({
                    "model_train_type": "anima-lora", "network_module": "networks.lora_anima",
                    "optimizer_type": optimizer, "learning_rate": "2e-5", "weight_decay": 0, **values,
                })
                self.assertEqual(adapted["optimizer_type"], optimizer)
                self.assertEqual(warnings, [])
                for argument in ["weight_decay=0", *expected]:
                    self.assertIn(argument, adapted["optimizer_args"])
                self.assertFalse(any("lora_muon_" in argument for argument in adapted["optimizer_args"]))
        self.assertEqual(validate_training_config(valid_config(SOAP_OPTIMIZER_TYPE, "sdxl-lora")), [])

    def test_lora_muon_accepts_legacy_form_keys_without_leaking_them(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "learning_rate": "2e-5",
                "lora_muon_momentum": 0.85,
                "lora_muon_ns_steps": 6,
            }
        )
        self.assertIn("momentum=0.85", adapted["optimizer_args"])
        self.assertIn("ns_steps=6", adapted["optimizer_args"])
        self.assertFalse(any("lora_muon_" in item for item in adapted["optimizer_args"]))
        self.assertEqual(warnings, [])

    def test_bitsandbytes_form_controls_only_apply_to_supported_optimizers(self):
        values = {
            "bnb_percentile_clipping": 99,
            "bnb_min_8bit_size": 16384,
        }
        for optimizer_type in ("AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"):
            adapted, _ = adapt_config({"optimizer_type": optimizer_type, **values})
            self.assertIn("percentile_clipping=99", adapted["optimizer_args"])
            self.assertIn("min_8bit_size=16384", adapted["optimizer_args"])

        adapted, _ = adapt_config({"optimizer_type": "AdamW", **values})
        self.assertNotIn("optimizer_args", adapted)

    def test_adafactor_relative_and_manual_modes(self):
        relative, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 50,
                "max_grad_norm": 1,
                "adafactor_relative_step": True,
                "adafactor_scale_parameter": True,
                "adafactor_warmup_init": False,
                "adafactor_clip_threshold": 1.0,
                "adafactor_eps": "1e-30, 1e-3",
            }
        )
        self.assertEqual(relative["lr_scheduler"], "constant")
        self.assertEqual(relative["lr_warmup_steps"], 0)
        self.assertEqual(relative["max_grad_norm"], 0)
        self.assertIn("relative_step=True", relative["optimizer_args"])
        self.assertIn("eps=1e-30, 1e-3", relative["optimizer_args"])
        self.assertTrue(any("relative_step" in warning for warning in warnings), warnings)

        manual, _ = adapt_config(
            {
                "model_train_type": "sdxl-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 25,
                "max_grad_norm": 1,
                "adafactor_relative_step": False,
                "adafactor_scale_parameter": False,
            }
        )
        self.assertEqual(manual["lr_scheduler"], "cosine")
        self.assertEqual(manual["lr_warmup_steps"], 25)
        self.assertEqual(manual["max_grad_norm"], 0)
        self.assertIn("relative_step=False", manual["optimizer_args"])
        self.assertIn("scale_parameter=False", manual["optimizer_args"])

    def test_schedulefree_uses_internal_warmup(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                "learning_rate": "0.0025",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "schedulefree_warmup_steps": 250,
            }
        )
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertIn("warmup_steps=250", adapted["optimizer_args"])
        self.assertTrue(any("external lr_warmup_steps" in warning for warning in warnings))

    def test_prodigy_injects_warmup_safeguard(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGY_OPTIMIZER_TYPE,
                "learning_rate": "0.5",
                "unet_lr": "0.25",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "prodigy_safeguard_warmup": False,
                "max_grad_norm": 1,
            }
        )
        self.assertEqual(adapted["learning_rate"], 1.0)
        self.assertEqual(adapted["unet_lr"], 1.0)
        self.assertIn("safeguard_warmup=True", adapted["optimizer_args"])
        self.assertNotIn("safeguard_warmup=False", adapted["optimizer_args"])
        self.assertTrue(any("gradient clipping" in warning for warning in warnings), warnings)

    def test_prodigyplus_gradient_clip_branches(self):
        cases = (
            ({}, 0),
            ({"prodigyplus_use_stableadamw": False, "eps": "1e-8"}, 1),
            ({"prodigyplus_use_stableadamw": False, "eps": "None"}, 0),
        )
        for updates, expected in cases:
            with self.subTest(updates=updates):
                config = {
                    "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                    "learning_rate": "1.0",
                    "lr_scheduler": "constant",
                    "max_grad_norm": 1,
                }
                config.update(updates)
                adapted, _ = adapt_config(config)
                self.assertEqual(adapted["max_grad_norm"], expected)

    def test_adapter_sanitizes_prodigyplus_fused_flags(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                "learning_rate": "1.0",
                "optimizer_args": [
                    "fused_back_pass=True",
                    "fused_backward_pass=False",
                ],
                "fused_backward_pass": True,
            }
        )
        self.assertIn("fused_back_pass=False", adapted["optimizer_args"])
        self.assertFalse(
            any(item.startswith("fused_backward_pass=") for item in adapted["optimizer_args"])
        )
        self.assertNotIn("fused_backward_pass", adapted)
        self.assertTrue(any("fused" in warning for warning in warnings), warnings)


class LorariteImportContractTests(unittest.TestCase):
    def test_rejects_incompatible_networks_before_launch(self):
        for network in ("networks.loha", "networks.lokr", "lycoris.kohya"):
            with self.subTest(network=network):
                config = valid_config(LORARITE_OPTIMIZER_TYPE)
                config["network_module"] = network
                errors = validate_training_config(config)
                self.assertTrue(any("LoRA-RITE" in error for error in errors), errors)
        self.assertEqual(validate_training_config(valid_config(LORARITE_OPTIMIZER_TYPE)), [])

    def test_integer_optimizer_args_reject_float_and_string_literals(self):
        for value in ("5.0", "'5'", "True"):
            with self.subTest(value=value):
                config = valid_config(MUON_OPTIMIZER_TYPE)
                config.pop("muon_ns_steps", None)
                config["optimizer_args_custom"] = f"ns_steps={value}"
                errors = validate_training_config(config)
                self.assertTrue(any("ns_steps" in error for error in errors), errors)
        config = valid_config(MUON_OPTIMIZER_TYPE)
        config["muon_ns_steps"] = "5"
        self.assertEqual(validate_training_config(config), [])


if __name__ == "__main__":
    unittest.main()
