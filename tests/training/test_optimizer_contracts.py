import unittest


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


if __name__ == "__main__":
    unittest.main()
