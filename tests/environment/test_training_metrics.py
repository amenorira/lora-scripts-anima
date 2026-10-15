"""Prove diagnostics preserve training and use the existing TensorBoard stream."""
from contextlib import nullcontext
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import torch

from tools.python_startup.training_metrics import TrainingMetrics, instrument_trainer, _unclipped_norm
from backend.training.metrics_config import training_metrics_environment


ROOT = Path(__file__).resolve().parents[2]


class BucketTests(unittest.TestCase):
    def test_boundaries_sample_weighting_and_empty_buckets(self):
        state = TrainingMetrics()
        loss = torch.tensor([2., 4., 6., 8.], requires_grad=True)
        state.observe_loss(loss, torch.tensor([0., 1/3, 2/3, 1.]), 1)
        self.assertFalse(state.totals.requires_grad)
        self.assertIsNone(state.totals.grad_fn)
        logs = state.batch_logs()
        self.assertEqual([logs[f"timestep/count/{k}"] for k in ("low", "mid", "high")], [1, 1, 2])
        self.assertEqual([logs[f"loss/timestep/{k}"] for k in ("low", "mid", "high")], [2, 4, 7])
        self.assertNotIn("train/grad_norm", logs)
        self.assertEqual(state.batch_logs(), {})
        state.observe_loss(torch.tensor([10.]), torch.tensor([900.]), 1000)
        next_batch = state.batch_logs()
        self.assertEqual(next_batch["timestep/count/high"], 1)
        self.assertEqual(next_batch["loss/timestep/high"], 10)
        self.assertEqual(next_batch["timestep/count/low"], 0)
        self.assertNotIn("loss/timestep/low", next_batch)

    def test_each_loss_point_uses_only_its_current_batch(self):
        state = TrainingMetrics()
        # A batch without a loss/current record must not leak into a later one.
        state.observe_loss(torch.tensor([999.]), torch.tensor([.1]), 1)
        state.observe_loss(torch.tensor([5.]), torch.tensor([.9]), 1)
        logs = state.batch_logs()
        self.assertEqual(logs["timestep/count/low"], 0)
        self.assertNotIn("loss/timestep/low", logs)
        self.assertEqual(logs["loss/timestep/high"], 5)

    def test_average_window_and_epoch_totals_weight_actual_samples(self):
        state = TrainingMetrics()

        def record(epoch, step, losses, times):
            state.observe_loss(torch.tensor(losses), torch.tensor(times), 1)
            state.batch_position = (epoch, step)
            return state.batch_logs(include_average=True)

        record(0, 0, [2., 10., 14.], [.1, .5, .5])
        logs = record(0, 1, [8., 20., 40.], [.5, .9, .9])
        self.assertEqual(logs["loss/timestep/average/low"], 2)
        self.assertAlmostEqual(logs["loss/timestep/average/mid"], 32 / 3)
        self.assertEqual(logs["loss/timestep/average/high"], 30)
        self.assertEqual(logs["timestep/count/average/mid"], 3)
        first_epoch = state.epoch_logs(1)
        self.assertAlmostEqual(first_epoch["loss/timestep/epoch/mid"], 32 / 3)
        self.assertEqual(first_epoch["timestep/count/epoch/high"], 2)

        # Like the original LossRecorder, epoch 2 replaces batch slot 0 while
        # retaining the preceding epoch's slot 1 until it too gets replaced.
        logs = record(1, 0, [100.], [.5])
        self.assertEqual(logs["loss/timestep/average/mid"], 54)
        self.assertEqual(logs["loss/timestep/average/high"], 30)
        self.assertNotIn("loss/timestep/average/low", logs)
        partial_epoch = state.epoch_logs(2)
        self.assertEqual(partial_epoch["loss/timestep/epoch/mid"], 100)
        self.assertEqual(partial_epoch["timestep/count/epoch/high"], 0)
        self.assertNotIn("loss/timestep/epoch/high", partial_epoch)
        self.assertEqual(state.epoch_logs(3), {})  # No stale values for an empty epoch.

        logs = record(1, 1, [4., 6., 8.], [.1, .1, .1])
        self.assertEqual(logs["loss/timestep/average/low"], 6)
        self.assertEqual(logs["loss/timestep/average/mid"], 100)
        self.assertNotIn("loss/timestep/average/high", logs)
        self.assertEqual(state.epoch_logs(2)["timestep/count/epoch/low"], 3)
        self.assertEqual(len(state.average.history), 12)

    def test_resumed_average_ignores_unobserved_batch_slots(self):
        state = TrainingMetrics()
        state.observe_loss(torch.tensor([7.]), torch.tensor([.9]), 1)
        state.batch_position = (5, 2)
        logs = state.batch_logs(include_average=True)
        self.assertEqual(logs["loss/timestep/average/high"], 7)
        self.assertEqual(logs["timestep/count/average/high"], 1)
        self.assertEqual(state.epoch_logs(6)["loss/timestep/epoch/high"], 7)
        self.assertNotIn("loss/timestep/epoch/low", state.epoch_logs(6))


class FakeTracker:
    name = "tensorboard"

    def __init__(self, directory=None):
        self.records = []
        if directory:
            from torch.utils.tensorboard import SummaryWriter
            self.writer = SummaryWriter(directory)
        else:
            self.writer = None

    def log(self, values, step=None, **kwargs):
        self.records.append((step, dict(values)))
        if self.writer:
            for key, value in values.items():
                self.writer.add_scalar(key, value, step)
            self.writer.flush()


class FakeOptimizer:
    def __init__(self, optimizer, accelerator):
        self.optimizer = optimizer
        self.param_groups = optimizer.param_groups
        self.accelerator = accelerator
        self.scaler = None
        self.skipped = False

    def step(self):
        if self.accelerator.sync_gradients and not self.skipped:
            self.optimizer.step()

    def zero_grad(self):
        if self.accelerator.sync_gradients:
            self.optimizer.zero_grad(set_to_none=True)


class FakeAccelerator:
    def __init__(self, parameter, tracker=None, main=True):
        self.trackers = [tracker or FakeTracker()]
        self.is_main_process = main
        self.sync_gradients = True
        self.distributed_type = SimpleNamespace(name="NO")
        self._optimizers = [FakeOptimizer(torch.optim.AdamW([parameter], lr=.01), self)]
        self.clip_calls = 0
        self.ended = False

    def clip_grad_norm_(self, parameters, max_norm):
        self.clip_calls += 1
        return torch.nn.utils.clip_grad_norm_(parameters, max_norm)

    def end_training(self):
        self.ended = True
        if self.trackers[0].writer:
            self.trackers[0].writer.close()


class SdTrainer:
    def process_batch(self, loss, timesteps, accelerator, args=None, is_train=True):
        return self.post_process_loss(loss, args, timesteps, None).mean()

    def post_process_loss(self, loss, args, timesteps, noise_scheduler):
        return loss * 2  # Stand-in for the final weighted per-sample objective.


class AnimaNetworkTrainer(SdTrainer):
    def post_process_loss(self, loss, args, timesteps, noise_scheduler):
        return loss * 3  # Subclass overrides must also be observed.


class MusubiTrainer:
    def process_batch(self, loss, timesteps, accelerator):
        return self.compute_loss(None, loss, timesteps, None, None, None, 0)[0]

    def compute_loss(self, args, output, timesteps, noise_scheduler, dit_dtype, network_dtype, global_step):
        loss = output * torch.tensor([2., 3., 4.]).reshape(3, 1)
        return loss.mean(), {"untouched": 123}


class TrainingLoopTests(unittest.TestCase):
    def run_loop(self, engine, instrument=True, clipping=1, main=True, grad_norm=True, directory=None,
                 grad_clipped=True, timestep_loss=True, timestep_count=True):
        parameter = torch.nn.Parameter(torch.tensor([1., 2.]))
        tracker = FakeTracker(directory)
        accelerator = FakeAccelerator(parameter, tracker, main)
        trainer = MusubiTrainer() if engine == "musubi_tuner" else AnimaNetworkTrainer()
        original_attrs = dict(vars(trainer))
        losses, gradients = [], []
        context = instrument_trainer(
            trainer, engine, grad_norm=grad_norm, grad_clipped=grad_clipped,
            timestep_loss=timestep_loss, timestep_count=timestep_count,
        ) if instrument else nullcontext()
        with context:
            for micro in range(6):  # Every batch logs; every second batch updates.
                accelerator.sync_gradients = micro % 2 == 1
                if engine == "musubi_tuner":
                    inputs = parameter.square().expand(3, 2)
                    times = torch.tensor([100., 500., 900.])
                else:
                    inputs = parameter.square().sum().expand(3)
                    times = torch.tensor([.1, .5, .9])
                loss = trainer.process_batch(inputs, times, accelerator)
                losses.append(loss.detach().clone())
                (loss / 2).backward()
                if accelerator.sync_gradients and clipping:
                    accelerator.clip_grad_norm_([parameter], clipping)
                gradients.append(parameter.grad.clone())
                optimizer = accelerator._optimizers[0]
                optimizer.step()
                optimizer.zero_grad()
                tracker.log({"loss/current": float(loss.detach()),
                             "loss/average": sum(float(v) for v in losses) / len(losses),
                             "lr/unet": .01}, step=(micro + 1) // 2)
                # A validation pass has different noise/loss and must not count.
                if engine == "sd_scripts":
                    trainer.process_batch(torch.ones(1) * 999, torch.tensor([.9]), accelerator, is_train=False)
                    tracker.log({"loss/validation": 999}, step=100)
            epoch_tag = "loss/epoch_average" if engine == "sd_scripts" else "loss/epoch"
            tracker.log({epoch_tag: sum(float(v) for v in losses) / len(losses)}, step=1)
            accelerator.end_training()
        self.assertEqual(vars(trainer), original_attrs)
        self.assertNotIn("step", vars(accelerator._optimizers[0]))
        self.assertNotIn("log", vars(tracker))
        return parameter.detach(), losses, gradients, tracker, accelerator

    def test_both_engines_preserve_loss_gradients_and_adamw_updates(self):
        for engine in ("sd_scripts", "musubi_tuner"):
            for clipping in (0, 1):
                with self.subTest(engine=engine, clipping=clipping):
                    before = self.run_loop(engine, instrument=False, clipping=clipping)
                    after = self.run_loop(engine, clipping=clipping)
                    for reference, observed in zip((before[0], *before[1], *before[2]), (after[0], *after[1], *after[2])):
                        torch.testing.assert_close(reference, observed, rtol=0, atol=0)
                    gradient_logs = [(s, v) for s, v in after[3].records if "train/grad_norm" in v]
                    self.assertEqual([s for s, _ in gradient_logs], [1, 2, 3])
                    self.assertEqual([v["train/grad_clipped"] for _, v in gradient_logs], [int(bool(clipping))] * 3)
                    buckets = [(s, v) for s, v in after[3].records if "timestep/count/low" in v]
                    current = [(s, v) for s, v in after[3].records if "loss/current" in v]
                    self.assertEqual([s for s, _ in buckets], [0, 1, 1, 2, 2, 3])
                    self.assertEqual(buckets, current)
                    self.assertEqual([v["timestep/count/low"] for _, v in buckets], [1] * 6)
                    for _, values in buckets:
                        self.assertAlmostEqual(
                            sum(values[f"loss/timestep/{k}"] for k in ("low", "mid", "high")) / 3,
                            values["loss/current"], places=5,
                        )
                        self.assertAlmostEqual(
                            sum(values[f"loss/timestep/average/{k}"] for k in ("low", "mid", "high")) / 3,
                            values["loss/average"], places=5,
                        )
                    self.assertTrue(all(v["loss/timestep/high"] < 100 for _, v in buckets))
                    self.assertEqual(after[4].clip_calls, before[4].clip_calls)

    def test_existing_event_file_contains_all_tags(self):
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

        with tempfile.TemporaryDirectory() as directory:
            self.run_loop("sd_scripts", directory=directory)
            self.assertEqual(len(list(Path(directory).glob("events.out.tfevents.*"))), 1)
            events = EventAccumulator(directory).Reload()
            for tag in ("loss/current", "lr/unet", "train/grad_norm", "train/grad_clipped",
                        "loss/timestep/low", "loss/timestep/mid", "loss/timestep/high",
                        "timestep/count/low", "timestep/count/mid", "timestep/count/high"):
                self.assertIn(tag, events.Tags()["scalars"])
            for bucket in ("low", "mid", "high"):
                self.assertEqual([v.step for v in events.Scalars(f"loss/timestep/average/{bucket}")],
                                 [v.step for v in events.Scalars("loss/average")])
                self.assertEqual([v.step for v in events.Scalars(f"loss/timestep/epoch/{bucket}")], [1])
                self.assertEqual(events.Scalars(f"timestep/count/epoch/{bucket}")[0].value, 6)
            self.assertEqual([v.step for v in events.Scalars("loss/timestep/low")], [0, 1, 1, 2, 2, 3])
            self.assertEqual([v.step for v in events.Scalars("loss/timestep/low")],
                             [v.step for v in events.Scalars("loss/current")])

    def test_empty_buckets_and_epoch_logs_do_not_reuse_another_batch(self):
        trainer = AnimaNetworkTrainer()
        accelerator = FakeAccelerator(torch.nn.Parameter(torch.ones(1)))
        tracker = accelerator.trackers[0]
        with instrument_trainer(trainer, "sd_scripts"):
            for step, timestep, value in ((0, .1, 2.), (0, .9, 4.), (1, .5, 6.)):
                loss = trainer.process_batch(torch.tensor([value]), torch.tensor([timestep]), accelerator)
                # Epoch and validation logs must neither acquire nor drain the
                # batch's pending buckets, even at an identical global_step.
                tracker.log({"loss/epoch_average": 99}, step=step)
                tracker.log({"loss/validation": 99}, step=step)
                tracker.log({"loss/current": loss.item()}, step=step)
            records_before_end = list(tracker.records)
            accelerator.end_training()
            self.assertEqual(tracker.records, records_before_end)
        current = [(step, values) for step, values in tracker.records if "loss/current" in values]
        self.assertEqual([step for step, _ in current], [0, 0, 1])
        for (_, values), bucket, expected in zip(current, ("low", "high", "mid"), (6., 12., 18.)):
            for key in ("low", "mid", "high"):
                self.assertEqual(values[f"timestep/count/{key}"], int(key == bucket))
                self.assertEqual(f"loss/timestep/{key}" in values, key == bucket)
            self.assertEqual(values[f"loss/timestep/{bucket}"], expected)
        for _, values in tracker.records:
            if "loss/current" not in values:
                self.assertNotIn("loss/timestep/low", values)
                self.assertNotIn("timestep/count/low", values)
        last_epoch = [v for _, v in tracker.records if "loss/epoch_average" in v][-1]
        self.assertEqual(last_epoch["loss/timestep/epoch/low"], 6)
        self.assertEqual(last_epoch["loss/timestep/epoch/high"], 12)
        self.assertNotIn("loss/timestep/epoch/mid", last_epoch)

    def test_disabled_gradient_metrics_and_non_main_rank(self):
        disabled = self.run_loop("sd_scripts", grad_norm=False)
        self.assertFalse(any("train/grad_norm" in v or "train/grad_clipped" in v for _, v in disabled[3].records))
        self.assertTrue(any("loss/timestep/low" in v for _, v in disabled[3].records))
        non_main = self.run_loop("sd_scripts", main=False)
        self.assertFalse(any("train/grad_norm" in v or "loss/timestep/low" in v for _, v in non_main[3].records))

    def test_all_switch_combinations_enforce_parent_dependencies(self):
        import itertools

        for engine in ("sd_scripts", "musubi_tuner"):
            baseline = self.run_loop(engine, instrument=False)
            for grad, clipped, loss, count in itertools.product((False, True), repeat=4):
                with self.subTest(engine=engine, grad=grad, clipped=clipped, loss=loss, count=count):
                    observed = self.run_loop(engine, grad_norm=grad, grad_clipped=clipped,
                                             timestep_loss=loss, timestep_count=count)
                    records = [v for _, v in observed[3].records]
                    keys = set().union(*(v.keys() for v in records))
                    self.assertEqual("train/grad_norm" in keys, grad)
                    self.assertEqual("train/grad_clipped" in keys, grad and clipped)
                    for suffix in ("low", "average/low", "epoch/low"):
                        self.assertEqual(f"loss/timestep/{suffix}" in keys, loss)
                        self.assertEqual(f"timestep/count/{suffix}" in keys, loss and count)
                    torch.testing.assert_close(baseline[0], observed[0], rtol=0, atol=0)

    def test_disabled_parents_skip_collection_and_installation(self):
        with patch.object(TrainingMetrics, "observe_loss") as collect, patch(
            "tools.python_startup.training_metrics._unclipped_norm"
        ) as norm, patch("tools.python_startup.training_metrics._loss_mean_capture") as capture:
            self.run_loop("musubi_tuner", grad_norm=False, grad_clipped=True,
                          timestep_loss=False, timestep_count=True, clipping=0)
            collect.assert_not_called()
            norm.assert_not_called()
            capture.assert_not_called()
        with patch.object(TrainingMetrics, "observe_loss") as collect, patch(
            "tools.python_startup.training_metrics._loss_mean_capture"
        ) as capture:
            self.run_loop("musubi_tuner", grad_norm=True, timestep_loss=False)
            collect.assert_not_called()
            capture.assert_not_called()

    def test_scaled_unclipped_norm_is_read_only(self):
        parameter = torch.nn.Parameter(torch.tensor([3., 4.]))
        accelerator = FakeAccelerator(parameter)
        optimizer = accelerator._optimizers[0]
        optimizer.scaler = SimpleNamespace(get_scale=lambda: 8)
        # Simulate GradScaler skipping the optimizer update after overflow.
        optimizer.skipped = True
        trainer = AnimaNetworkTrainer()
        with instrument_trainer(trainer, "sd_scripts"):
            loss = trainer.process_batch(parameter.square(), torch.tensor([.1, .9]), accelerator)
            (loss * 8).backward()
            expected_gradient = parameter.grad.clone()
            optimizer.step()
            torch.testing.assert_close(parameter.grad, expected_gradient, rtol=0, atol=0)
            torch.testing.assert_close(parameter.detach(), torch.tensor([3., 4.]), rtol=0, atol=0)
            accelerator.trackers[0].log({"loss/current": 1}, step=1)
        self.assertEqual(accelerator.trackers[0].records[0][1]["train/grad_norm"], 15)

    def test_scaled_half_precision_norm_does_not_overflow(self):
        parameter = torch.nn.Parameter(torch.ones(4, dtype=torch.float16))
        parameter.grad = torch.full_like(parameter, 40000)
        accelerator = FakeAccelerator(parameter)
        optimizer = accelerator._optimizers[0]
        optimizer.scaler = SimpleNamespace(get_scale=lambda: 65536)
        gradient_before = parameter.grad.clone()
        self.assertTrue(torch.isinf(torch.nn.utils.get_total_norm([parameter.grad])))
        norm = _unclipped_norm(accelerator, optimizer)
        self.assertTrue(torch.isfinite(norm))
        self.assertEqual(norm.item(), 1.220703125)
        torch.testing.assert_close(parameter.grad, gradient_before, rtol=0, atol=0)

    def test_mixed_gradient_dtypes_and_unknown_sharding(self):
        parameters = [torch.nn.Parameter(torch.ones(1, dtype=dtype)) for dtype in
                      (torch.float16, torch.bfloat16, torch.float32, torch.float64)]
        for parameter, value in zip(parameters, (3, 4, 0, 12)):
            parameter.grad = torch.full_like(parameter, value)
        accelerator = FakeAccelerator(parameters[0])
        optimizer = accelerator._optimizers[0]
        optimizer.param_groups = [{"params": parameters}]
        self.assertEqual(_unclipped_norm(accelerator, optimizer).item(), 13)
        accelerator.distributed_type = SimpleNamespace(name="FSDP")
        self.assertIsNone(_unclipped_norm(accelerator, optimizer))

    def test_reporting_failure_does_not_repeat_or_abort_training(self):
        baseline = self.run_loop("sd_scripts", instrument=False)
        with patch.object(TrainingMetrics, "observe_loss", side_effect=RuntimeError("diagnostic failed")):
            observed = self.run_loop("sd_scripts")
        torch.testing.assert_close(baseline[0], observed[0], rtol=0, atol=0)
        self.assertTrue(observed[4].ended)


class StartupTests(unittest.TestCase):
    def test_real_ppsf_and_emosens_preserve_updates_and_optimizer_state(self):
        # EmoSens installs a global backward hook: keep this proof isolated.
        # Use real AcceleratedOptimizer wrappers, including PPSF's no-clip path.
        script = r'''
import copy
from contextlib import nullcontext
import torch
from accelerate import Accelerator
from prodigyplus import ProdigyPlusScheduleFree
from vendor.emo_optimizer.emosens import EmoSens
from tests.environment.test_training_metrics import AnimaNetworkTrainer, MusubiTrainer, FakeTracker
from tools.python_startup.training_metrics import instrument_trainer

def equal(a, b):
    if isinstance(a, torch.Tensor):
        torch.testing.assert_close(a, b, rtol=0, atol=0)
    elif isinstance(a, dict):
        assert a.keys() == b.keys()
        for key in a:
            equal(a[key], b[key])
    elif isinstance(a, (list, tuple)):
        assert len(a) == len(b)
        for x, y in zip(a, b):
            equal(x, y)
    else:
        assert a == b, (a, b)

def run(kind, engine, dtype, enabled, clipping):
    torch.manual_seed(41)
    accelerator = Accelerator(cpu=True)
    model = torch.nn.Linear(2, 1, bias=False, dtype=dtype)
    with torch.no_grad():
        model.weight.copy_(torch.tensor([[1., 2.]], dtype=dtype))
    if kind == 'emosens':
        raw = EmoSens(model.parameters(), lr=.1, notify=False)
    else:
        raw = ProdigyPlusScheduleFree(model.parameters(), eps=None if kind == 'ppsf_atan2' else 1e-8)
        raw.train()
    model, optimizer = accelerator.prepare(model, raw)
    tracker = FakeTracker()
    accelerator.trackers = [tracker]
    trainer = AnimaNetworkTrainer() if engine == 'sd_scripts' else MusubiTrainer()
    history = []
    context = instrument_trainer(trainer, engine) if enabled else nullcontext()
    with context:
        for step in range(4):
            inputs = model.weight.square().sum().expand(3) if engine == 'sd_scripts' else model.weight.square().expand(3, 2)
            times = torch.tensor([.1, .5, .9]) if engine == 'sd_scripts' else torch.tensor([100., 500., 900.])
            loss = trainer.process_batch(inputs, times, accelerator)
            accelerator.backward(loss)
            gradient = model.weight.grad.detach().clone()
            expected_norm = float(gradient.float().norm())
            if clipping:
                expected_norm = float(accelerator.clip_grad_norm_(model.parameters(), clipping))
            optimizer.step()
            tracker.log({'loss/current': float(loss.detach()), 'loss/average': float(loss.detach())}, step=step)
            if enabled:
                values = tracker.records[-1][1]
                assert abs(values['train/grad_norm'] - expected_norm) < 1e-5
                assert values['train/grad_clipped'] == int(bool(clipping) and expected_norm > clipping)
                assert all(values[f'timestep/count/{bucket}'] == 1 for bucket in ('low', 'mid', 'high'))
            if kind == 'emosens':
                assert raw._manual_loss == loss.item()
            history.append((loss.detach().clone(), gradient, model.weight.detach().clone(), copy.deepcopy(raw.state_dict())))
            optimizer.zero_grad(set_to_none=True)
    return history

cases = 0
for kind, clipping in (('ppsf', 0), ('ppsf_atan2', 0), ('emosens', 0), ('emosens', 1)):
    for engine in ('sd_scripts', 'musubi_tuner'):
        for dtype in (torch.float32, torch.bfloat16):
            equal(run(kind, engine, dtype, False, clipping), run(kind, engine, dtype, True, clipping))
            cases += 1
print('OPTIMIZER_METRICS_OK', cases)
'''
        result = subprocess.run(
            [sys.executable, "-c", script], cwd=ROOT, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OPTIMIZER_METRICS_OK 16", result.stdout)

    def test_real_trainers_accelerate_and_existing_writer(self):
        from backend.training.supervisor import _build_train_env

        # Real engine loss code and real Accelerate, with tiny CPU model outputs;
        # no checkpoints, datasets, CUDA allocations, or model downloads needed.
        script = r'''
import sys
from pathlib import Path
from types import SimpleNamespace
import torch
from accelerate import Accelerator
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
from tools.python_startup.training_metrics import instrument_trainer

profile, directory = sys.argv[1:]
if profile == "krea2":
    from musubi_tuner.training.trainer_base import NetworkTrainer
    from musubi_tuner.krea2_train_network import Krea2NetworkTrainer
    from musubi_tuner.utils.train_utils import LossRecorder
    trainer = Krea2NetworkTrainer()
    engine = "musubi_tuner"
elif profile == "anima":
    from train_network import NetworkTrainer
    from anima_train_network import AnimaNetworkTrainer
    trainer = AnimaNetworkTrainer()
    engine = "sd_scripts"
else:
    from train_network import NetworkTrainer
    from sdxl_train_network import SdxlNetworkTrainer
    trainer = SdxlNetworkTrainer()
    engine = "sd_scripts"
if engine == "sd_scripts":
    from library.logging_util import LossRecorder
assert getattr(NetworkTrainer, "_anima_training_metrics", False)

accelerator = Accelerator(cpu=True, gradient_accumulation_steps=2,
                          log_with="tensorboard", project_dir=directory)
model = torch.nn.Linear(2, 1, bias=False)
with torch.no_grad():
    model.weight.copy_(torch.tensor([[1., 2.]]))
reference = torch.nn.Parameter(model.weight.detach().clone())
reference_optimizer = torch.optim.AdamW([reference], lr=.01)
model, optimizer = accelerator.prepare(model, torch.optim.AdamW(model.parameters(), lr=.01))
accelerator.init_trackers("network_train")
inputs = torch.tensor([[1., 2.], [3., 4.], [5., 6.]])
times = torch.tensor([100., 500., 900.])
config = SimpleNamespace(loss_type="l2", masked_loss=False, min_snr_gamma=None,
                         scale_v_pred_loss_like_noise_pred=False, v_pred_like_loss=None,
                         debiased_estimation_loss=False, weighting_scheme="none")
if profile == "krea2":
    trainer.get_noisy_model_input_and_timesteps = lambda *a: (None, times)
    trainer.call_dit = lambda *a: SimpleNamespace(pred=model(inputs).reshape(3, 1, 1, 1, 1),
                                                 target=torch.zeros(3, 1, 1, 1, 1))
    expected_values = (inputs @ reference.T).square().reshape(3)
    def batch_loss():
        return trainer.process_batch(config, accelerator, None, model, {"timesteps": None},
                                     None, None, None, torch.float32, torch.float32, None, 0)[0]
else:
    actual_times = times / 1000 if profile == "anima" else times
    trainer.shift_scale_latents = lambda args, latents: latents
    trainer.get_noise_pred_and_target = lambda *a, **k: (
        model(inputs).reshape(3, 1, 1, 1), torch.zeros(3, 1, 1, 1), actual_times, None)
    batch = {"latents": torch.ones(3, 1, 1, 1), "loss_weights": torch.tensor([1., 2., 3.]),
             "text_encoder_outputs_list": [torch.ones(3, 1), torch.zeros(3)]}
    strategy = SimpleNamespace(drop_cached_text_encoder_outputs=lambda *a, **k: list(a))
    expected_values = (inputs @ reference.T).square().reshape(3) * batch["loss_weights"]
    def batch_loss():
        return trainer.process_batch(batch, [], None, model, None, None, torch.float32,
                                     torch.float32, accelerator, config, strategy, None,
                                     train_text_encoder=False)

expected_loss = expected_values.mean()
expected_loss.backward()
expected_gradient = reference.grad.clone()
expected_norm = float(torch.nn.utils.clip_grad_norm_([reference], 1.))
reference_optimizer.step()

recorder = LossRecorder()
validation_recorder = LossRecorder()
original_recorder_add = LossRecorder.add
with instrument_trainer(trainer, engine) as metrics:
    for micro in range(2):
        with accelerator.accumulate(model):
            loss = batch_loss()
            torch.testing.assert_close(loss.detach(), expected_loss.detach(), rtol=0, atol=0)
            accelerator.backward(loss)
            if accelerator.sync_gradients:
                torch.testing.assert_close(model.weight.grad, expected_gradient, rtol=0, atol=0)
                accelerator.clip_grad_norm_(model.parameters(), 1.)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
        # Exercise each core's existing logging path and actual event writer.
        recorder.add(epoch=0, step=micro, loss=float(loss.detach()))
        assert metrics.loss_recorder is recorder
        assert metrics.batch_position == (0, micro)
        validation_recorder.add(epoch=10, step=999, loss=999.)
        assert metrics.batch_position == (0, micro)
        logs = {"loss/current": float(loss.detach()), "loss/average": recorder.moving_average, "lr/unet": .01}
        if engine == "sd_scripts":
            trainer.step_logging(accelerator, logs, (micro + 1) // 2, 1)
        else:
            accelerator.log(logs, step=(micro + 1) // 2)
    epoch_tag = "loss/epoch_average" if engine == "sd_scripts" else "loss/epoch"
    if engine == "sd_scripts":
        trainer.epoch_logging(accelerator, {epoch_tag: float(expected_loss.detach())}, 1, 1)
    else:
        accelerator.log({epoch_tag: float(expected_loss.detach())}, step=1)
    accelerator.end_training()
assert LossRecorder.add is original_recorder_add

torch.testing.assert_close(model.weight.detach(), reference.detach(), rtol=0, atol=0)
events_path = Path(directory) / "log"
assert len(list(events_path.rglob("events.out.tfevents.*"))) == 1
events = EventAccumulator(str(events_path)).Reload()
assert events.Scalars("train/grad_norm")[0].step == 1
assert abs(events.Scalars("train/grad_norm")[0].value - expected_norm) < 1e-3
assert len(events.Scalars(epoch_tag)) == 1
for bucket, expected in zip(("low", "mid", "high"), expected_values.detach().tolist()):
    scalars = events.Scalars(f"loss/timestep/{bucket}")
    assert [scalar.step for scalar in scalars] == [0, 1]
    assert [scalar.step for scalar in scalars] == [scalar.step for scalar in events.Scalars("loss/current")]
    assert [scalar.value for scalar in events.Scalars(f"timestep/count/{bucket}")] == [1, 1]
    for scalar in scalars:
        assert abs(scalar.value - expected) < 1e-5, (bucket, scalar.value, expected)
    average = events.Scalars(f"loss/timestep/average/{bucket}")
    assert [scalar.step for scalar in average] == [0, 1]
    assert [scalar.step for scalar in average] == [scalar.step for scalar in events.Scalars("loss/average")]
    for scalar in average:
        assert abs(scalar.value - expected) < 1e-5
    assert [scalar.value for scalar in events.Scalars(f"timestep/count/average/{bucket}")] == [1, 2]
    epoch_loss = events.Scalars(f"loss/timestep/epoch/{bucket}")
    assert len(epoch_loss) == 1 and epoch_loss[0].step == 1
    assert abs(epoch_loss[0].value - expected) < 1e-5
    assert events.Scalars(f"timestep/count/epoch/{bucket}")[0].value == 2
print("REAL_TRAINER_OK", profile)
'''
        for profile in ("anima", "sdxl", "krea2"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                engine = "musubi_tuner" if profile == "krea2" else "sd_scripts"
                env = _build_train_env(directory, "metrics-real", engine_id=engine)
                env.update(training_metrics_environment(dict.fromkeys(
                    ("log_grad_norm", "log_grad_clipped", "log_timestep_loss", "log_timestep_count"), True
                )))
                if engine == "sd_scripts":
                    env["PYTHONPATH"] += os.pathsep + str(ROOT / "vendor" / "sd-scripts")
                result = subprocess.run(
                    [sys.executable, "-c", script, profile, directory], cwd=ROOT, env=env,
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("REAL_TRAINER_OK", result.stdout)

    def test_startup_is_lazy_and_environment_is_configurable(self):
        from backend.training.supervisor import _build_train_env

        with tempfile.TemporaryDirectory() as directory:
            for engine in ("sd_scripts", "musubi_tuner"):
                env = _build_train_env(directory, "metrics-test", engine_id=engine)
                self.assertEqual(env["ANIMA_TRAIN_METRICS"], "0")
                result = subprocess.run(
                    [sys.executable, "-c", "import sys; assert 'tools.python_startup.training_metrics' not in sys.modules; assert 'torch' not in sys.modules"],
                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                env.update(training_metrics_environment({"log_grad_norm": True}))
                result = subprocess.run(
                    [sys.executable, "-c", "import sys; assert 'tools.python_startup.training_metrics' in sys.modules; assert 'torch' not in sys.modules"],
                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            with patch.dict(os.environ, {"ANIMA_TRAIN_METRICS": "1", "ANIMA_TRAIN_METRICS_GRAD_NORM": "1"}):
                env = _build_train_env(directory, "metrics-test")
            self.assertEqual(env["ANIMA_TRAIN_METRICS"], "0")
            self.assertEqual(env["ANIMA_TRAIN_METRICS_GRAD_NORM"], "0")


if __name__ == "__main__":
    unittest.main()
