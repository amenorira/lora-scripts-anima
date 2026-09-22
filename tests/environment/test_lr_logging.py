import math
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch

from tools.python_startup.lr_logging import (
    EffectiveLrNoOpScheduler,
    _patch_network_trainer_module,
    _patch_optimizer_module,
    read_learning_rates,
)


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

    def test_real_prodigy_bias_correction_reports_last_step_rate(self):
        from prodigyopt import Prodigy

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = Prodigy([parameter], lr=1.0, d0=1e-3, use_bias_correction=True)
        parameter.square().backward()
        optimizer.step()

        group = optimizer.param_groups[0]
        beta1, beta2 = group["betas"]
        step = max(int(group["k"]), 1)
        expected = group["d"] * group["lr"] * math.sqrt(1.0 - beta2**step) / (1.0 - beta1**step)
        self.assertAlmostEqual(read_learning_rates(optimizer=optimizer)[0], expected)

    def test_real_prodigy_plus_uses_its_effective_rate_api(self):
        from prodigyplus import ProdigyPlusScheduleFree

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = ProdigyPlusScheduleFree([parameter], lr=1.0, d0=1e-3)
        parameter.square().backward()
        optimizer.step()

        expected = optimizer.get_dlr(optimizer.param_groups[0])
        self.assertEqual(read_learning_rates(optimizer=optimizer), [expected])

    def test_real_adafactor_reports_internal_relative_rate(self):
        from transformers.optimization import Adafactor

        parameter = torch.nn.Parameter(torch.tensor([2.0]))
        optimizer = Adafactor([parameter], lr=None, relative_step=True, scale_parameter=True)
        parameter.square().backward()
        optimizer.step()

        group = optimizer.param_groups[0]
        expected = float(optimizer._get_lr(group, optimizer.state[parameter]))
        self.assertEqual(read_learning_rates(optimizer=optimizer), [expected])


class SdScriptsPatchTests(unittest.TestCase):
    def test_network_trainer_patch_supports_keyword_arguments(self):
        class NetworkTrainer:
            def generate_step_logs(
                self,
                args,
                current_loss,
                average_loss,
                lr_scheduler,
                descriptions,
                optimizer=None,
            ):
                return {"loss/current": current_loss, "lr/unet": lr_scheduler.get_last_lr()[0]}

        module = types.SimpleNamespace(NetworkTrainer=NetworkTrainer)
        _patch_network_trainer_module(module)
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.125}],
        )
        scheduler = types.SimpleNamespace(get_last_lr=lambda: [1.0], optimizer=optimizer)
        logs = NetworkTrainer().generate_step_logs(
            args=None,
            current_loss=0.4,
            average_loss=0.5,
            lr_scheduler=scheduler,
            descriptions=None,
            optimizer=optimizer,
        )
        self.assertEqual(logs["lr/unet"], 0.125)

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

    def test_actual_rate_round_trips_through_tensorboard_event(self):
        from tensorboard.backend.event_processing import event_accumulator
        from torch.utils.tensorboard import SummaryWriter

        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.125}],
        )
        actual_rate = read_learning_rates(optimizer=optimizer)[0]
        with tempfile.TemporaryDirectory() as log_dir:
            writer = SummaryWriter(log_dir)
            writer.add_scalar("lr/unet", actual_rate, 1)
            writer.close()

            accumulator = event_accumulator.EventAccumulator(log_dir)
            accumulator.Reload()
            event = accumulator.Scalars("lr/unet")[-1]
        self.assertAlmostEqual(event.value, actual_rate)


if __name__ == "__main__":
    unittest.main()
