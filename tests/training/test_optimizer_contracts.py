import ast
import unittest


from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.config.optimizer_contracts import (
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    LORA_MUON_OPTIMIZER_TYPE,
    MUON_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    SOAP_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)
from backend.training.config.validation import validate_training_config
from tests.helpers import valid_training_config


def valid_config(optimizer_type: str, train_type: str = "anima-lora") -> dict:
    config = valid_training_config(
        train_type, resolution="1024,1024", optimizer_type=optimizer_type,
        gradient_accumulation_steps=1, mixed_precision="bf16",
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
            ("PagedAdamW8bit", {"bnb_min_8bit_size": -1}, "min_8bit_size"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_steps": 0}, "ns_steps"),
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


    def test_muon_network_validation_matches_adapted_arguments(self):
        for key in ("use_scalar", "train_norm"):
            cases = (
                ({"network_args": [f"{key}=true", f"{key}=false"]}, False),
                ({"network_args": [f"{key}=false", f"{key}=true"]}, True),
                ({"network_args": [f"{key}=false"], "network_args_custom": f"{key}=true"}, True),
                ({"network_args": [f"{key}=true"], "network_args_custom": f"{key}=false"}, False),
                ({key: False, "network_args_custom": f"{key}=true"}, False),
                ({key: True, "network_args_custom": f"{key}=false"}, True),
                ({"network_args": [f" {key} = FALSE ", f"{key}=NaN"]}, False),
                ({"network_args_custom": f"{key}=0"}, True),
            )
            for values, enabled in cases:
                with self.subTest(key=key, values=values):
                    config = valid_config(MUON_OPTIMIZER_TYPE)
                    config.update(network_module="lycoris.kohya", lycoris_algo="lora")
                    config.pop(key)
                    config.update(values)
                    adapted, _ = adapt_config(config)
                    args = dict(item.split("=", 1) for item in adapted["network_args"])
                    self.assertEqual(args[key].lower() != "false", enabled)
                    errors = validate_training_config(config)
                    self.assertEqual(any("non-2D" in error for error in errors), enabled, errors)


class OptimizerAdapterTests(unittest.TestCase):
    def test_removed_bnb_clipping_is_cleaned_from_old_configs(self):
        cases = (
            ({}, False),
            ({"bnb_percentile_clipping": 100}, False),
            ({"bnb_percentile_clipping": "99"}, True),
            ({"optimizer_args": ["percentile_clipping=100"]}, False),
            ({"optimizer_args": ["percentile_clipping=99"]}, True),
            ({"optimizer_args_custom": "percentile_clipping=99"}, True),
            ({"bnb_percentile_clipping": 100, "optimizer_args_custom": "percentile_clipping=99"}, True),
        )
        for optimizer in ("AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"):
            for updates, should_warn in cases:
                with self.subTest(optimizer=optimizer, updates=updates):
                    config = {**valid_config(optimizer), "bnb_min_8bit_size": 128, **updates}
                    self.assertEqual(validate_training_config(config), [])
                    adapted, warnings = adapt_config(config)
                    self.assertNotIn("bnb_percentile_clipping", adapted)
                    self.assertIn("min_8bit_size=128", adapted["optimizer_args"])
                    self.assertFalse(any("percentile_clipping" in arg for arg in adapted["optimizer_args"]))
                    self.assertEqual(any("percentile_clipping" in warning for warning in warnings), should_warn)
                    capture = self.assertLogs if should_warn else self.assertNoLogs
                    with capture("anima-trainer", level="WARNING"):
                        restored = import_native_training_form(config)
                    self.assertNotIn("bnb_percentile_clipping", restored)
                    self.assertNotIn("percentile_clipping", restored.get("optimizer_args_custom", ""))

    def test_custom_optimizer_retains_its_own_percentile_argument(self):
        config = {**valid_config("custom.Optimizer"), "optimizer_args": ["percentile_clipping=99"]}
        adapted, warnings = adapt_config(config)
        self.assertIn("percentile_clipping=99", adapted["optimizer_args"])
        self.assertFalse(any("percentile_clipping" in warning for warning in warnings))

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
                actual = dict(item.split("=", 1) for item in adapted["optimizer_args"])
                for argument in ["weight_decay=0", *expected]:
                    key, literal = argument.split("=", 1)
                    self.assertEqual(ast.literal_eval(actual[key]), ast.literal_eval(literal))
                self.assertEqual(len(actual), len(adapted["optimizer_args"]))
                self.assertFalse(any("lora_muon_" in argument for argument in adapted["optimizer_args"]))
        self.assertEqual(validate_training_config(valid_config(SOAP_OPTIMIZER_TYPE, "sdxl-lora")), [])


if __name__ == "__main__":
    unittest.main()
