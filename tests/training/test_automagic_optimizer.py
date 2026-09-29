import unittest

import torch

from backend.training.adapter import adapt_config
from backend.training.field_registry import AUTOMAGIC_OPTIMIZER_TYPE
from backend.training.validation import validate_training_config
from tools.python_startup.lr_logging import read_learning_rates
from vendor.automagic_optimizer.integration import Automagic3
from tests.helpers import config_from_field_defaults


def valid_automagic_config() -> dict:
    config = config_from_field_defaults()
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


class AutomagicValidationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
