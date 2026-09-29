import subprocess
import sys
import unittest
from pathlib import Path

from backend.training.field_registry import EMOSENS_OPTIMIZER_TYPE
from backend.training.supervisor import _build_train_env
from backend.training.validation import validate_training_config
from tests.helpers import config_from_field_defaults


def valid_emosens_config() -> dict:
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
            "optimizer_type": EMOSENS_OPTIMIZER_TYPE,
            "learning_rate": "0.1",
            "gradient_accumulation_steps": 1,
            "mixed_precision": "bf16",
        }
    )
    return config


class EmoSensValidationTests(unittest.TestCase):
    def test_rejects_unsupported_execution_modes(self):
        cases = (
            ({"gradient_accumulation_steps": 2}, [0], "gradient_accumulation_steps"),
            ({"mixed_precision": "fp16"}, [0], "mixed_precision"),
            ({}, [0, 1], "one GPU"),
        )
        for updates, gpu_ids, expected in cases:
            with self.subTest(expected=expected):
                config = valid_emosens_config()
                config.update(updates)
                errors = validate_training_config(config, gpu_ids=gpu_ids)
                self.assertTrue(any(expected in error for error in errors), errors)


class EmoSensWindowsTests(unittest.TestCase):
    def test_real_steps_and_state_resume(self):
        # Isolate upstream's global Tensor.backward hook from the test process.
        script = r"""
import copy
import torch
from vendor.emo_optimizer.emosens import EmoSens
for lr, ceiling in [(0.1, 3e-4), (1.0, 3e-3), (10.0, 3e-3), (1e-5, 3e-7)]:
    p = torch.nn.Parameter(torch.tensor([1.0, 2.0], dtype=torch.float64))
    opt = EmoSens([p], lr=lr, notify=False)
    assert abs(opt.max_lim - ceiling) < 1e-12
    loss = p.square().mean()
    loss.backward()
    assert opt._manual_loss == loss.item()
    opt.step()
    assert 1e-8 <= opt.param_groups[0]['lr'] <= ceiling
    assert torch.isfinite(p).all() and not torch.equal(p, torch.tensor([1.0, 2.0]))
    saved = copy.deepcopy(opt.state_dict())
    q = torch.nn.Parameter(p.detach().clone())
    resumed = EmoSens([q], lr=lr, notify=False)
    resumed.load_state_dict(copy.deepcopy(saved))
    for param, optimizer in [(p, opt), (q, resumed)]:
        optimizer.zero_grad()
        param.square().mean().backward()
        optimizer.step()
    torch.testing.assert_close(p, q, rtol=0, atol=0)
    assert opt.param_groups[0]['lr'] == resumed.param_groups[0]['lr']
print('verified')
"""
        result = subprocess.run([sys.executable, "-c", script], cwd=Path.cwd(),
                                env=_build_train_env("artifacts", "task-id"),
                                capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertIn(b"verified", result.stdout)


if __name__ == "__main__":
    unittest.main()
