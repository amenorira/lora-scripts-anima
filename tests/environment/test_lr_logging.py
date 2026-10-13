import os
import subprocess
import sys
import unittest
from pathlib import Path

import torch

from tools.python_startup.lr_logging import read_learning_rates


ROOT = Path(__file__).parents[2]


class InstalledOptimizerTests(unittest.TestCase):
    def test_real_adamw_schedulefree_reports_warmup_rate(self):
        from schedulefree import AdamWScheduleFree

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = AdamWScheduleFree([parameter], lr=0.1, warmup_steps=4)
        optimizer.train()
        parameter.square().backward()
        optimizer.step()

        expected = optimizer.param_groups[0]["scheduled_lr"]
        self.assertEqual(expected, 0.025)
        self.assertEqual(read_learning_rates(optimizer=optimizer), [expected])
        self.assertNotEqual(expected, optimizer.param_groups[0]["lr"])


class SdScriptsPatchTests(unittest.TestCase):
    def test_training_subprocess_installs_import_hook(self):
        env = os.environ.copy()
        env["LORA_SCRIPTS_TRUE_LR_LOGGING"] = "1"
        env["PYTHONPATH"] = os.pathsep.join(
            [
                str(ROOT / "tools" / "python_startup"),
                str(ROOT / "vendor" / "sd-scripts"),
                str(ROOT),
            ]
        )
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import library.optimizer as m; print(bool(getattr(m, '_lora_scripts_true_lr_logging', False)))",
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        self.assertIn("True", result.stdout)


if __name__ == "__main__":
    unittest.main()
