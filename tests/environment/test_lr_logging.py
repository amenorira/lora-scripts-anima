import os
import subprocess
import sys
import types
import unittest
from pathlib import Path

import torch

from tools.python_startup.lr_logging import EffectiveLrNoOpScheduler, _patch_optimizer_module, read_learning_rates


ROOT = Path(__file__).parents[2]


def named_optimizer(name, **attrs):
    return type(name, (), attrs)()


class LearningRateReaderTests(unittest.TestCase):
    def test_broken_custom_reader_falls_back_without_interrupting_training(self):
        optimizer = named_optimizer(
            "FutureAdaptiveOptimizer",
            param_groups=[{"lr": 0.125}],
            get_learning_rates=lambda self: (_ for _ in ()).throw(RuntimeError("not initialized")),
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.125])


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
    def test_internal_lr_owner_gets_effective_noop_scheduler(self):
        module = types.SimpleNamespace(
            get_scheduler_fix=lambda args, optimizer, num_processes: "external-scheduler",
        )
        _patch_optimizer_module(module)
        automagic = named_optimizer(
            "Automagic3",
            param_groups=[{"lr": 1e-4}],
            get_learning_rates=lambda self: [1e-4],
        )
        scheduler = module.get_scheduler_fix(None, automagic, 1)
        self.assertIsInstance(scheduler, EffectiveLrNoOpScheduler)
        self.assertIs(scheduler.optimizer, automagic)
        self.assertEqual(scheduler.get_last_lr(), [1e-4])

    def test_external_scheduler_is_unchanged_for_regular_optimizer(self):
        external_scheduler = object()
        module = types.SimpleNamespace(
            get_scheduler_fix=lambda args, optimizer, num_processes: external_scheduler,
        )
        _patch_optimizer_module(module)
        optimizer = named_optimizer("AdamW", param_groups=[{"lr": 1e-4}])

        self.assertIs(module.get_scheduler_fix(None, optimizer, 1), external_scheduler)

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
