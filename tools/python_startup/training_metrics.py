"""Read-only diagnostics for the main rank's training samples, excluding validation.

Loss uses fixed noise thirds and sample-weighted batch, rolling and epoch means.
Counts accumulate in 1000 bins since process start, including after a resume.
Both follow loss/current through the existing TensorBoard writer, including
accumulation microbatches. ANIMA_TRAIN_METRICS_* flags enable them independently.
"""
from __future__ import annotations

import builtins
from array import array
from contextlib import ExitStack, contextmanager
import functools
import inspect
import os
import sys


_FLAG = "_anima_training_metrics"
_IMPORT_FLAG = "_anima_training_metrics_import"
_WARNED = False
_BUCKETS = ("low", "mid", "high")
_TIMESTEP_BINS = 1000


def _warn(exc):
    global _WARNED
    if not _WARNED:
        print(f"warning: training diagnostics disabled / 训练诊断已停用: {exc}", file=sys.stderr)
        _WARNED = True


def _bucket_logs(totals, suffix=""):
    logs = {}
    for index, bucket in enumerate(_BUCKETS):
        total, count = totals[index], totals[index + 3]
        if count:
            logs[f"loss/timestep/{suffix}{bucket}"] = total / count
    return logs


class _BucketWindow:
    """LossRecorder's replace-by-batch-slot window, storing six doubles per slot."""

    def __init__(self):
        self.history = array("d")
        self.totals = [0.0] * 6

    def add(self, epoch, step, totals):
        offset = len(self.history) if epoch == 0 else step * 6
        missing = offset + 6 - len(self.history)
        if missing > 0:
            self.history.extend([0.0] * missing)
        for index, value in enumerate(totals):
            self.totals[index] += value - self.history[offset + index]
            self.history[offset + index] = value


class TrainingMetrics:
    """Current-batch, original rolling-window, and current-epoch bucket totals."""

    def __init__(self, grad_norm=True, *, grad_clipped=True, timestep_loss=True, timestep_count=True):
        self.grad_norm = grad_norm
        self.grad_clipped = grad_norm and grad_clipped
        self.timestep_loss = timestep_loss
        self.timestep_count = timestep_count
        self.enabled = True
        self.totals = None
        self.step_finished = False
        self.pending_norm = None
        self.in_training_batch = False
        self.batch_position = None
        self.loss_recorder = None
        self.epoch = None
        self.next_batch = 0
        self.average = _BucketWindow()
        self.epoch_totals = [0.0] * 6
        self.pending_timesteps = None
        self.timestep_counts = None
        self.distribution_dirty = False

    def observe_timesteps(self, timesteps, scale):
        if not self.timestep_count:
            return
        import torch

        # Convert directly to plot units; normalizing and scaling back can
        # round integer timesteps such as 251 down to the preceding bin.
        sampled = timesteps.detach().to(dtype=torch.float32).reshape(-1)
        self.pending_timesteps = sampled * (_TIMESTEP_BINS / scale)

    def observe_loss(self, loss, timesteps, scale):
        if not self.timestep_loss:
            return
        import torch

        with torch.no_grad():
            values = loss.detach().float().reshape(-1)
            sampled = timesteps.detach().to(device=values.device, dtype=torch.float32).reshape(-1)
            times = sampled / scale
            if values.numel() != times.numel():
                raise ValueError("per-sample loss and timestep sizes differ")
            boundaries = times.new_tensor([1 / 3, 2 / 3])
            indices = torch.bucketize(times, boundaries, right=True)
            stats = values.new_zeros(2, 3)
            stats[0].scatter_add_(0, indices, values)
            stats[1].scatter_add_(0, indices, torch.ones_like(values))
            self.totals = stats
            self.observe_timesteps(sampled, scale)
            self.batch_position = None

    def finish_step(self):
        self.step_finished = True

    def loss_logs(self, include_average=False):
        logs = {}
        totals = None
        if self.pending_timesteps is not None:
            import numpy as np
            import torch

            # Share one device-to-host transfer when both switches are on.
            # Count-only mode never computes or transfers loss bucket stats.
            if self.totals is not None:
                data = torch.cat((self.totals.reshape(-1), self.pending_timesteps)).cpu().numpy()
                totals = data[:6].tolist()
                sampled = data[6:]
            else:
                sampled = self.pending_timesteps.cpu().numpy()
            bins = np.clip(sampled.astype(np.int64), 0, _TIMESTEP_BINS - 1)
            counts = np.bincount(bins, minlength=_TIMESTEP_BINS)
            if self.timestep_counts is None:
                self.timestep_counts = counts
            else:
                self.timestep_counts += counts
            self.distribution_dirty = True
        elif self.totals is not None:
            totals = self.totals.cpu().reshape(-1).tolist()
        if totals is not None:
            epoch, step = self.batch_position or (self.epoch or 0, self.next_batch)
            if self.epoch != epoch:
                self.epoch = epoch
                self.epoch_totals = [0.0] * 6
            self.average.add(epoch, step, totals)
            for index, value in enumerate(totals):
                self.epoch_totals[index] += value
            self.next_batch = step + 1
            logs = _bucket_logs(totals)
            if include_average:
                logs.update(_bucket_logs(self.average.totals, "average/"))
        self.totals = None
        self.pending_timesteps = None
        self.batch_position = None
        return logs

    def epoch_logs(self, epoch_number):
        # No samples from an empty/skipped epoch must reuse the previous epoch.
        if not self.timestep_loss or self.epoch is None or epoch_number != self.epoch + 1:
            return {}
        return _bucket_logs(self.epoch_totals, "epoch/")

    def write_distribution(self, writer, step=None):
        if not self.distribution_dirty:
            return
        from tensorboard.compat.proto import summary_pb2, tensor_pb2, tensor_shape_pb2, types_pb2

        counts = self.timestep_counts.astype("<i8", copy=False)
        summary = summary_pb2.Summary(value=[summary_pb2.Summary.Value(
            tag="timestep/distribution",
            metadata=summary_pb2.SummaryMetadata(
                data_class=summary_pb2.DATA_CLASS_TENSOR,
                plugin_data=summary_pb2.SummaryMetadata.PluginData(
                    plugin_name="anima_timesteps", content=b"1",
                ),
            ),
            tensor=tensor_pb2.TensorProto(
                dtype=types_pb2.DT_INT64,
                tensor_shape=tensor_shape_pb2.TensorShapeProto(
                    dim=[tensor_shape_pb2.TensorShapeProto.Dim(size=_TIMESTEP_BINS)],
                ),
                tensor_content=counts.tobytes(),
            ),
        )])
        writer.file_writer.add_summary(summary, global_step=step)
        self.distribution_dirty = False

    def batch_logs(self, include_average=False):
        logs = self.loss_logs(include_average)
        if not self.step_finished:
            return logs
        self.step_finished = False
        if self.grad_norm:
            if self.grad_clipped:
                logs["train/grad_clipped"] = 0
            if self.pending_norm is not None:
                norm, threshold = self.pending_norm
                value = float(norm)
                logs["train/grad_norm"] = value
                if self.grad_clipped:
                    logs["train/grad_clipped"] = int(threshold > 0 and value > threshold)
        self.pending_norm = None
        return logs


def _observe(state, action):
    """A reporting failure must not interrupt or repeat a training operation."""
    if state.enabled:
        try:
            return action()
        except Exception as exc:
            state.enabled = False
            state.totals = None
            state.pending_timesteps = None
            state.pending_norm = None
            _warn(exc)
    return None


def _replace(stack, obj, name, replacement):
    # Preserve instance overrides and class descriptor lookup on restoration.
    had_attribute = name in vars(obj)
    previous = vars(obj).get(name)
    setattr(obj, name, replacement)

    def restore():
        if had_attribute:
            setattr(obj, name, previous)
        else:
            delattr(obj, name)

    stack.callback(restore)


def _attach_loss_recorder(stack, state, engine):
    module_name = "library.logging_util" if engine == "sd_scripts" else "musubi_tuner.utils.train_utils"
    module = sys.modules.get(module_name)
    recorder_class = getattr(module, "LossRecorder", None)
    if recorder_class is None:
        return
    original_add = recorder_class.add

    @functools.wraps(original_add)
    def add(recorder, *, epoch, step, loss):
        result = original_add(recorder, epoch=epoch, step=step, loss=loss)

        def observe_position():
            # Validation has its own recorders. Bind only the recorder that sees
            # a pending training batch, and never change its loss or state.
            if state.totals is not None and (state.loss_recorder is None or state.loss_recorder is recorder):
                state.loss_recorder = recorder
                state.batch_position = (epoch, step)

        _observe(state, observe_position)
        return result

    _replace(stack, recorder_class, "add", add)


def _unclipped_norm(accelerator, optimizer):
    import torch

    # Sharded gradients need engine-specific global reductions. Do not report
    # a misleading local norm or add collectives to training for diagnostics.
    kind = getattr(getattr(accelerator, "distributed_type", None), "name", "NO")
    if kind not in ("NO", "MULTI_GPU", "MULTI_CPU"):
        return None
    grads = [p.grad.detach() for group in optimizer.param_groups for p in group["params"] if p.grad is not None]
    if not grads:
        return None
    # Full-FP16 gradients may be finite while their *scaled* L2 norm exceeds
    # FP16's range. Accumulate the reductions in FP32 without copying whole
    # gradient buffers or editing them. Keep foreach's batched CUDA kernels.
    groups = {}
    for grad in grads:
        groups.setdefault((grad.device, grad.dtype), []).append(grad)
    norms = []
    for (_, dtype), group in groups.items():
        accumulation_dtype = torch.float32 if dtype in (torch.float16, torch.bfloat16) else None
        norms.extend(torch._foreach_norm(group, 2.0, dtype=accumulation_dtype))
    norm = torch.linalg.vector_norm(torch.stack([value.to(grads[0].device) for value in norms]), 2.0)
    # Called before AcceleratedOptimizer.step, so AMP gradients are still scaled.
    # Reading/dividing the scalar avoids changing GradScaler's state or gradients.
    scaler = getattr(optimizer, "scaler", None)
    if scaler is not None:
        norm = norm / scaler.get_scale()
    return norm.detach()


def _attach_gradients(stack, accelerator, state):
    original_clip = accelerator.clip_grad_norm_

    @functools.wraps(original_clip)
    def clip(parameters, max_norm, *args, **kwargs):
        norm = original_clip(parameters, max_norm, *args, **kwargs)
        if state.grad_norm and accelerator.sync_gradients and norm is not None:
            _observe(state, lambda: setattr(state, "pending_norm", (norm.detach(), max_norm)))
        return norm

    _replace(stack, accelerator, "clip_grad_norm_", clip)

    for optimizer in accelerator._optimizers:
        original_step = optimizer.step

        def make_step(opt, original):
            @functools.wraps(original)
            def step(*args, **kwargs):
                boundary = state.enabled and accelerator.sync_gradients
                if boundary and state.grad_norm and state.pending_norm is None:
                    norm = _observe(state, lambda: _unclipped_norm(accelerator, opt))
                    if norm is not None:
                        state.pending_norm = (norm, 0)
                result = original(*args, **kwargs)
                if boundary:
                    state.finish_step()
                return result
            return step

        _replace(stack, optimizer, "step", make_step(optimizer, original_step))


def _attach_accelerator(stack, accelerator, state):
    if state.grad_norm:
        _attach_gradients(stack, accelerator, state)

    for tracker in accelerator.trackers:
        if tracker.name != "tensorboard":
            continue
        original_log = tracker.log

        def make_log(original, tracker):
            @functools.wraps(original)
            def log(values, step=None, **kwargs):
                extra = None
                if state.enabled and "loss/current" in values:
                    extra = _observe(state, lambda: state.batch_logs("loss/average" in values))
                    if state.timestep_count:
                        # Write before the original log flushes the shared writer.
                        _observe(state, lambda: state.write_distribution(tracker.writer, step))
                elif state.enabled and ("loss/epoch_average" in values or "loss/epoch" in values):
                    extra = _observe(state, lambda: state.epoch_logs(step))
                if extra:
                    values = {**values, **extra}
                return original(values, step=step, **kwargs)
            return log

        _replace(stack, tracker, "log", make_log(original_log, tracker))


def _loss_mean_capture():
    """Capture musubi's weighted loss reduction only inside compute_loss."""
    import torch
    from torch.overrides import TorchFunctionMode

    class Capture(TorchFunctionMode):
        pair = None

        def __torch_function__(self, func, types, args=(), kwargs=None):
            result = func(*args, **(kwargs or {}))
            if func in (torch.mean, torch.Tensor.mean) and result.ndim == 0:
                self.pair = (result, args[0].detach())
            return result

    return Capture()


@contextmanager
def instrument_trainer(trainer, engine, grad_norm=True, *, grad_clipped=True, timestep_loss=True, timestep_count=True):
    """Install scoped instance hooks, including actual subclass loss overrides."""
    state = TrainingMetrics(grad_norm, grad_clipped=grad_clipped, timestep_loss=timestep_loss, timestep_count=timestep_count)
    with ExitStack() as stack:
        if not state.grad_norm and not state.timestep_loss and not state.timestep_count:
            yield state
            return
        if state.timestep_loss:
            _observe(state, lambda: _attach_loss_recorder(stack, state, engine))
        attached = False
        original_batch = trainer.process_batch
        batch_signature = inspect.signature(original_batch)

        @functools.wraps(original_batch)
        def process_batch(*args, **kwargs):
            nonlocal attached
            arguments = batch_signature.bind(*args, **kwargs).arguments
            accelerator = arguments["accelerator"]
            training = arguments.get("is_train", True)
            tracking = accelerator.is_main_process and any(t.name == "tensorboard" for t in accelerator.trackers)
            if training and tracking and not attached:
                _observe(state, lambda: _attach_accelerator(stack, accelerator, state))
                attached = True
            previous = state.in_training_batch
            state.in_training_batch = training and tracking and state.enabled
            try:
                return original_batch(*args, **kwargs)
            finally:
                state.in_training_batch = previous

        _replace(stack, trainer, "process_batch", process_batch)

        if (state.timestep_loss or state.timestep_count) and engine == "sd_scripts":
            original_loss = trainer.post_process_loss
            timestep_scale = 1.0 if any(cls.__name__ == "AnimaNetworkTrainer" for cls in type(trainer).__mro__) else 1000.0

            @functools.wraps(original_loss)
            def post_process_loss(loss, args, timesteps, noise_scheduler):
                result = original_loss(loss, args, timesteps, noise_scheduler)
                if state.in_training_batch:
                    if state.timestep_loss:
                        _observe(state, lambda: state.observe_loss(result, timesteps, timestep_scale))
                    else:
                        _observe(state, lambda: state.observe_timesteps(timesteps, timestep_scale))
                return result

            _replace(stack, trainer, "post_process_loss", post_process_loss)
        elif state.timestep_loss or state.timestep_count:
            original_loss = trainer.compute_loss

            @functools.wraps(original_loss)
            def compute_loss(*args, **kwargs):
                if not state.in_training_batch:
                    return original_loss(*args, **kwargs)
                timesteps = kwargs.get("timesteps", args[2] if len(args) > 2 else None)
                if not state.timestep_loss:
                    result = original_loss(*args, **kwargs)
                    _observe(state, lambda: state.observe_timesteps(timesteps, 1000.0))
                    return result
                capture = _observe(state, _loss_mean_capture)
                if capture is None:
                    return original_loss(*args, **kwargs)
                with capture:
                    result = original_loss(*args, **kwargs)

                def collect():
                    import torch

                    if capture.pair is None or capture.pair[0] is not result[0]:
                        raise ValueError("musubi loss no longer ends in the expected mean reduction")
                    values = capture.pair[1]
                    dimensions = tuple(range(1, values.ndim))
                    per_sample = values.mean(dim=dimensions, dtype=torch.float32) if dimensions else values
                    state.observe_loss(per_sample, timesteps, 1000.0)

                _observe(state, collect)
                return result

            _replace(stack, trainer, "compute_loss", compute_loss)

        yield state


def _patch_trainer(module, engine):
    cls = getattr(module, "NetworkTrainer", None)
    if cls is None or getattr(cls, _FLAG, False):
        return
    original_train = cls.train

    @functools.wraps(original_train)
    def train(self, *args, **kwargs):
        with instrument_trainer(
            self, engine,
            grad_norm=os.environ.get("ANIMA_TRAIN_METRICS_GRAD_NORM", "0") == "1",
            grad_clipped=os.environ.get("ANIMA_TRAIN_METRICS_GRAD_CLIPPED", "0") == "1",
            timestep_loss=os.environ.get("ANIMA_TRAIN_METRICS_TIMESTEP_LOSS", "0") == "1",
            timestep_count=os.environ.get("ANIMA_TRAIN_METRICS_TIMESTEP_COUNT", "0") == "1",
        ):
            return original_train(self, *args, **kwargs)

    cls.train = train
    setattr(cls, _FLAG, True)


def install_import_hook():
    """Lazy loading keeps torch and training engines out of Python startup."""
    if getattr(builtins, _IMPORT_FLAG, False):
        return
    original_import = builtins.__import__
    pending = {"train_network": "sd_scripts", "musubi_tuner.training.trainer_base": "musubi_tuner"}

    def patch_loaded():
        for name, engine in tuple(pending.items()):
            module = sys.modules.get(name)
            cls = getattr(module, "NetworkTrainer", None)
            if cls is not None and callable(getattr(cls, "train", None)):
                _patch_trainer(module, engine)
                del pending[name]

    @functools.wraps(original_import)
    def import_with_metrics(*args, **kwargs):
        imported = original_import(*args, **kwargs)
        if pending:
            try:
                patch_loaded()
            except Exception as exc:
                _warn(exc)
        return imported

    builtins.__import__ = import_with_metrics
    setattr(builtins, _IMPORT_FLAG, True)
    patch_loaded()
