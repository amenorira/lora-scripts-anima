"""Observe optimizer step sizes without changing updates or saved optimizer state.

The dashboard uses the scalar multiplying the optimizer's update direction. For
tensor-dependent step sizes, report a parameter-count-weighted mean. Gradient
preconditioning itself is left in the update direction, not turned into an LR.
"""
from __future__ import annotations

import math
import sys
from functools import wraps
from typing import Any


_TRACKER = "_anima_step_lr_tracker"


def _mean(entries: list[tuple[Any, int]]) -> float:
    # Reduce on-device first: never synchronise once per trainable tensor.
    tensors: dict[Any, list[tuple[Any, int]]] = {}
    total = 0.0
    weight = 0
    for value, count in entries:
        if count <= 0:
            continue
        device = getattr(value, "device", None)
        if device is None:
            total += value * count
        else:
            tensors.setdefault(device, []).append((value, count))
        weight += count
    if tensors:
        import torch

        for device, bucket in tensors.items():
            values = torch.stack([value.reshape(()) for value, _ in bucket])
            dtype = torch.float64 if values.dtype == torch.float64 else torch.float32
            values = values.to(dtype=dtype)
            counts = torch.tensor([count for _, count in bucket], dtype=dtype, device=device)
            total += float(torch.dot(values, counts))
    return total / weight if weight else 0.0


class StepLearningRates:
    def __init__(self, optimizer: Any):
        self.optimizer = optimizer
        self.name = type(optimizer).__name__.lower()
        self.rates: list[float] | None = None
        self.weights: list[int] = []
        self.pending: dict[int, list[tuple[Any, int]]] = {}
        self.in_step = False
        self.skipped = False
        self.failed = False
        self.warned = False
        self.parameter_steps: dict[int, int] = {}
        self.available = True
        try:
            self._install_readers()
        except Exception as exc:
            self.available = False
            self._error(exc)
        self.handles = (
            optimizer.register_step_pre_hook(self._before),
            optimizer.register_step_post_hook(self._after),
        )

    def _error(self, exc: Exception) -> None:
        self.failed = True
        self.rates = []
        if not self.warned:
            print(f"warning: effective LR unavailable / 本步有效学习率不可用: {exc}", file=sys.stderr)
            self.warned = True

    def _record(self, group: Any, value: Any, count: int) -> None:
        self.pending.setdefault(id(group), []).append((value, count))

    def _wrap(self, name: str, observe: Any) -> None:
        original = getattr(self.optimizer, name)

        @wraps(original)
        def wrapped(*args: Any, **kwargs: Any):
            result = original(*args, **kwargs)
            if self.in_step and not self.failed:
                try:
                    observe(result, *args, **kwargs)
                except Exception as exc:
                    self._error(exc)
            return result

        setattr(self.optimizer, name, wrapped)

    def _install_readers(self) -> None:
        optimizer = self.optimizer
        if self.name == "prodigyplusschedulefree":
            def dlr_read(value: Any, group: Any):
                if not group["use_schedulefree"]:
                    if group["use_adopt"] and group["k"] == 1:
                        value = 0.0  # ADOPT only initialises its second moment.
                    elif group["use_bias_correction"]:
                        value = optimizer.get_bias_correction(value, group["betas"][1], group["k"])[0]
                    # All active parameters in this group share this coefficient.
                    self.pending[id(group)] = [(value, self.group_weights[id(group)])]

            def update_read(_result: Any, y: Any, z: Any, update: Any, group: Any, dlr: Any):
                # effective_lr was computed by the real update, before d changes.
                value = dlr * group["effective_lr"] / group["lr"] if group["lr"] else 0.0
                self._record(group, value, y.numel())

            self._wrap("get_dlr", dlr_read)
            self._wrap("update_params", update_read)
        elif self.name == "adafactor":
            def adafactor_read(value: Any, group: Any, state: Any):
                position = self.positions.get(id(group), 0)
                sizes = self.active_sizes[id(group)]
                self._record(group, value, sizes[position])
                self.positions[id(group)] = position + 1

            self._wrap("_get_lr", adafactor_read)
        elif self.name == "stableadamw":
            # Both foreach and per-parameter paths expose the group before the
            # existing RMS computation. Reuse its result, without recomputing it.
            for method in ("_step_foreach", "_step_per_param"):
                original = getattr(optimizer, method)

                def with_group(group: Any, *args: Any, _original=original, **kwargs: Any):
                    self.current_group = group
                    return _original(group, *args, **kwargs)

                setattr(optimizer, method, with_group)

            def stable_read(rms: Any, grad: Any, exp_avg_sq: Any, **kwargs: Any):
                self._record(self.current_group, self.current_group["lr"] / rms, grad.numel())

            self._wrap("get_stable_adamw_rms", stable_read)

    def _before(self, optimizer: Any, args: Any, kwargs: Any):
        if not self.available:
            return
        try:
            # GradScaler calls fused optimizers even on overflow; their kernels
            # skip internally. Match non-fused AMP by retaining the last actual
            # measurement, including its parameter weights.
            found_inf = getattr(optimizer, "found_inf", None)
            self.skipped = found_inf is not None and float(found_inf) != 0.0
            if self.skipped:
                return
            self.failed = False
            self.in_step = True
            self.pending = {}
            self.positions: dict[int, int] = {}
            self.active_sizes = {
                id(group): [p.numel() for p in group["params"] if p.grad is not None]
                for group in optimizer.param_groups
            }
            self.group_weights = {key: sum(sizes) for key, sizes in self.active_sizes.items()}
            self.weights = [self.group_weights[id(group)] for group in optimizer.param_groups]
            self.before = []
            max_lr = max(group["lr"] for group in optimizer.param_groups) if self.name == "prodigy" else None
            for index, group in enumerate(optimizer.param_groups):
                value = group["lr"] if group["lr"] is not None else 0.0
                if self.name in {"automagic3", "automagic4"}:
                    entries = []
                    for parameter in group["params"]:
                        state = optimizer.state.get(parameter, {})
                        step = state.get("step", 0)
                        active = parameter.grad is not None or getattr(parameter, "_accum_grad", None) is not None
                        if optimizer.fused:
                            active = step > self.parameter_steps.get(id(parameter), 0)
                            self.parameter_steps[id(parameter)] = step
                        if active:
                            entries.append((state.get("lr", value), parameter.numel()))
                    # Fused Automagic has already cleared gradients in backward.
                    self.weights[index] = sum(count for _, count in entries)
                    value = _mean(entries)
                elif self.name == "prodigy":
                    value = group["d"] * max_lr if group["lr"] else 0.0
                    if group.get("use_bias_correction"):
                        beta1, beta2 = group["betas"]
                        step = group["k"] + 1
                        value *= math.sqrt(1 - beta2 ** step) / (1 - beta1 ** step)
                elif self.name.startswith("dadapt"):
                    value *= group["d"]
                    if group.get("use_bias_correction"):
                        beta1, beta2 = group["betas"]
                        step = group["k"] + 1
                        value *= math.sqrt(1 - beta2 ** step) / (1 - beta1 ** step)
                elif self.name == "muon" and type(optimizer).__module__.startswith("torch.optim"):
                    from torch.optim._muon import _adjust_lr
                    value = _mean([
                        (_adjust_lr(group["lr"], group["adjust_lr_fn"], p.shape), p.numel())
                        for p in group["params"] if p.grad is not None
                    ])
                elif self.name == "soap":
                    step = group.get("step", 0)
                    if not step:
                        value = 0.0  # First step only initialises the preconditioner.
                    elif group["correct_bias"]:
                        beta1, beta2 = group["betas"]
                        value *= math.sqrt(1 - beta2 ** step) / (1 - beta1 ** step)
                self.before.append(float(value))
            closure = kwargs.get("closure", args[1] if len(args) > 1 else None)
            if callable(closure):
                @wraps(closure)
                def observed_closure(*closure_args: Any, **closure_kwargs: Any):
                    result = closure(*closure_args, **closure_kwargs)
                    # Closures create gradients after the pre-hook runs.
                    self._before(optimizer, (), {})
                    return result

                if "closure" in kwargs:
                    return args, {**kwargs, "closure": observed_closure}
                return (args[0], observed_closure, *args[2:]), kwargs
        except Exception as exc:
            self._error(exc)

    def _after(self, optimizer: Any, args: Any, kwargs: Any) -> None:
        try:
            if self.failed or not self.available or self.skipped:
                return
            values = []
            for index, group in enumerate(optimizer.param_groups):
                entries = self.pending.get(id(group))
                value = self.before[index]
                if entries:
                    value = _mean(entries)
                    self.weights[index] = sum(count for _, count in entries)
                elif self.name == "emosens":
                    value = float(group["lr"])
                elif self.name == "adamwschedulefree":
                    step = group["k"]
                    weight = step ** group["r"] * group["lr_max"] ** group["weight_lr_power"]
                    ckp1 = weight / group["weight_sum"] if group["weight_sum"] else 0.0
                    value = group["scheduled_lr"] * (1 - group["betas"][0] * (1 - ckp1))
                elif self.name in {"prodigyplusschedulefree", "adafactor", "stableadamw"}:
                    value = 0.0  # No parameter update was observed in this group.
                if not math.isfinite(value):
                    raise ValueError(f"non-finite step LR: {value}")
                values.append(value if self.weights[index] else 0.0)
            self.rates = values
        except Exception as exc:
            self._error(exc)
        finally:
            self.in_step = False
            self.pending = {}


def install_learning_rate_tracking(optimizer: Any) -> None:
    """Attach once to the real optimizer, before scheduler/Accelerate wrapping."""
    if not hasattr(optimizer, _TRACKER):
        setattr(optimizer, _TRACKER, StepLearningRates(optimizer))


def step_learning_rates(optimizer: Any) -> list[float] | None:
    tracker = getattr(optimizer, _TRACKER, None)
    if tracker is None:
        return None
    # A configured multiplier is not a measurement before the first real step.
    return tracker.rates if tracker.rates is not None else []


def step_parameter_counts(optimizer: Any) -> list[int]:
    tracker = getattr(optimizer, _TRACKER, None)
    if tracker is not None and tracker.rates is not None:
        return tracker.weights
    return [sum(p.numel() for p in group["params"]) for group in optimizer.param_groups]
