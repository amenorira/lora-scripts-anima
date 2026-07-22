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
    LearningRateReporter,
    _patch_network_trainer_module,
    _patch_optimizer_module,
    optimizer_owns_schedule,
    read_learning_rates,
    register_learning_rate_reporter,
)


ROOT = Path(__file__).parents[1]


def named_optimizer(name, **attrs):
    return type(name, (), attrs)()


class LearningRateReaderTests(unittest.TestCase):
    def test_schedulefree_uses_scheduled_lr(self):
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.125}],
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.125])

    def test_effective_noop_scheduler_reports_schedulefree_rate_without_mutation(self):
        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"params": [parameter], "lr": 1.0, "scheduled_lr": 0.125}],
        )
        scheduler = EffectiveLrNoOpScheduler(optimizer)
        before_parameter = parameter.detach().clone()
        before_lr = optimizer.param_groups[0]["lr"]

        self.assertEqual(scheduler.get_last_lr(), [0.125])
        self.assertIsNone(scheduler.step())
        self.assertTrue(torch.equal(parameter, before_parameter))
        self.assertEqual(optimizer.param_groups[0]["lr"], before_lr)
        self.assertEqual(scheduler.state_dict(), {})
        self.assertIsNone(scheduler.load_state_dict({}))

    def test_prodigy_uses_adaptive_d_times_lr(self):
        optimizer = named_optimizer(
            "Prodigy",
            param_groups=[{"lr": 1.0, "d": 0.03125}],
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.03125])

    def test_prodigy_plus_uses_optimizer_get_dlr(self):
        optimizer = named_optimizer(
            "ProdigyPlusScheduleFree",
            param_groups=[{"lr": 1.0, "d": 0.5}],
            get_dlr=lambda self, group: 0.0625,
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.0625])

    def test_internal_optimizers_are_marked_as_schedule_owners(self):
        automagic = named_optimizer(
            "Automagic3",
            param_groups=[{"lr": 1e-4}],
            get_learning_rates=lambda self: [2e-5],
        )
        emosens = named_optimizer("EmoSens", param_groups=[{"lr": 3e-5}])
        self.assertTrue(optimizer_owns_schedule(automagic))
        self.assertTrue(optimizer_owns_schedule(emosens))
        self.assertEqual(read_learning_rates(optimizer=automagic), [2e-5])
        self.assertEqual(read_learning_rates(optimizer=emosens), [3e-5])

    def test_adafactor_reads_internal_step_rate(self):
        parameter = object()
        optimizer = named_optimizer(
            "Adafactor",
            param_groups=[{"params": [parameter], "lr": None}],
            state={parameter: {"step": 2, "RMS": 0.75}},
            _get_lr=lambda self, group, state: state["RMS"] / state["step"],
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.375])

    def test_scheduler_optimizer_wrappers_are_supported(self):
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.25}],
        )
        scheduler = types.SimpleNamespace(optimizer=optimizer)
        self.assertEqual(read_learning_rates(scheduler=scheduler), [0.25])

    def test_broken_custom_reader_falls_back_without_interrupting_training(self):
        optimizer = named_optimizer(
            "FutureAdaptiveOptimizer",
            param_groups=[{"lr": 0.125}],
            get_learning_rates=lambda self: (_ for _ in ()).throw(RuntimeError("not initialized")),
        )
        self.assertEqual(read_learning_rates(optimizer=optimizer), [0.125])

    def test_custom_reporter_can_be_registered(self):
        class FutureOptimizer:
            param_groups = [{"lr": 1.0}]

        reporter_name = "test-future-optimizer"
        register_learning_rate_reporter(
            LearningRateReporter(
                reporter_name,
                lambda optimizer: isinstance(optimizer, FutureOptimizer),
                lambda optimizer: [0.007],
            ),
            prepend=True,
        )
        try:
            self.assertEqual(read_learning_rates(optimizer=FutureOptimizer()), [0.007])
        finally:
            # Keep the global registry isolated for the rest of this process.
            from tools.python_startup import lr_logging

            lr_logging._REPORTERS[:] = [
                reporter
                for reporter in lr_logging._REPORTERS
                if reporter.name != reporter_name
            ]


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

    def test_real_prodigy_reports_d_adapted_rate(self):
        from prodigyopt import Prodigy

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = Prodigy([parameter], lr=1.0, d0=1e-3)
        parameter.square().backward()
        optimizer.step()

        expected = optimizer.param_groups[0]["d"] * optimizer.param_groups[0]["lr"]
        self.assertEqual(read_learning_rates(optimizer=optimizer), [expected])

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
    def test_training_environment_uses_model_agnostic_feature_flag(self):
        from backend.training.supervisor import _build_train_env

        env = _build_train_env("output", "task-id")
        self.assertEqual(env["LORA_SCRIPTS_TRUE_LR_LOGGING"], "1")
        self.assertNotIn("ANIMA_TRUE_LR_LOGGING", env)

    def test_optimizer_logging_patch_writes_actual_values(self):
        module = types.SimpleNamespace(
            get_scheduler_fix=lambda args, optimizer, num_processes: "real-scheduler",
            get_dummy_scheduler=lambda optimizer: types.SimpleNamespace(optimizer=optimizer),
            append_lr_to_logs_with_names=lambda *args: None,
        )
        _patch_optimizer_module(module)
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.5}],
        )
        logs = {}
        scheduler = types.SimpleNamespace(optimizer=optimizer)
        module.append_lr_to_logs_with_names(logs, scheduler, "AdamWScheduleFree", ["unet"])
        self.assertEqual(logs["lr/unet"], 0.5)

    def test_network_trainer_primary_lr_tag_is_overwritten(self):
        class NetworkTrainer:
            def generate_step_logs(
                self,
                args,
                current_loss,
                average_loss,
                scheduler,
                descriptions,
                optimizer=None,
            ):
                return {"loss/current": current_loss, "lr/unet": scheduler.get_last_lr()[0]}

        module = types.SimpleNamespace(NetworkTrainer=NetworkTrainer)
        _patch_network_trainer_module(module)
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.25}],
        )
        scheduler = types.SimpleNamespace(get_last_lr=lambda: [1.0], optimizer=optimizer)
        logs = NetworkTrainer().generate_step_logs(None, 0.4, 0.5, scheduler, None, optimizer)
        self.assertEqual(logs["lr/unet"], 0.25)

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

    def test_schedulefree_optimizer_gets_effective_noop_scheduler(self):
        module = types.SimpleNamespace(
            get_scheduler_fix=lambda args, optimizer, num_processes: "external-scheduler",
        )
        _patch_optimizer_module(module)
        optimizer = named_optimizer(
            "AdamWScheduleFree",
            param_groups=[{"lr": 1.0, "scheduled_lr": 0.125}],
        )

        scheduler = module.get_scheduler_fix(None, optimizer, 1)
        self.assertIsInstance(scheduler, EffectiveLrNoOpScheduler)
        self.assertEqual(scheduler.get_last_lr(), [0.125])

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
