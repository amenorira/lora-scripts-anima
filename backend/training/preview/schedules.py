"""Model-aware flow schedules. Comfy names follow reference b5a432157de6.

https://github.com/Comfy-Org/ComfyUI/blob/b5a432157de6b8884f81104cd02926adf4d597e4/comfy/samplers.py
The native MOSS grid retains training-grid snapping, separate from sgm_uniform.
"""
import math

import numpy as np
import torch

from .config import SCHEDULERS


def build_sigmas(name, steps, flow_shift, architecture):
    if name not in SCHEDULERS:
        raise ValueError(f"Unknown preview schedule: {name}")
    if isinstance(steps, bool) or not isinstance(steps, int) or steps < 1:
        raise ValueError("Preview steps must be a positive integer / 预览步数必须为正整数")
    if not math.isfinite(float(flow_shift)) or flow_shift <= 0:
        raise ValueError("Preview flow shift must be finite and positive / 预览偏移必须为有限正数")
    if architecture not in ("anima", "moss_image"):
        raise ValueError(f"Unknown preview architecture: {architecture}")
    if name == "native":
        if architecture == "moss_image":
            from library.moss_image_train_utils import get_sampling_sigmas

            values = get_sampling_sigmas(steps, flow_shift)
        else:
            # Form the grid in float64: at small shifts float32 cancellation
            # can otherwise turn the pure-noise endpoint into sigma > 1.
            times = torch.linspace(1, 0, steps + 1, dtype=torch.float64)
            values = flow_shift * times / (1 + (flow_shift - 1) * times)
    elif name == "beta57":
        from scipy.special import betaincinv

        # RES4LYF beta57 is Beta(alpha=0.5, beta=0.7), on the same flow grid.
        indices = np.rint(betaincinv(.5, .7, 1 - np.arange(steps) / steps) * 999).astype(np.int64)
        times = torch.from_numpy((indices + 1) / 1000.)
        values = torch.cat((flow_shift * times / (1 + (flow_shift - 1) * times), times.new_zeros(1)))
    else:
        # Reuse the project's pure mathematical schedules, with no model loader
        # or generation worker dependency and no change to saved regularization jobs.
        from backend.regularization.sampling import schedule

        values = schedule(name, steps, 0, 0, flow_shift)
    values = torch.unique_consecutive(values.detach().to(device="cpu", dtype=torch.float32))
    validate_sigmas(values)
    return values


def validate_sigmas(values):
    if (values.ndim != 1 or len(values) < 2 or not torch.isfinite(values).all()
            or values[0] > 1 or values[-1] != 0 or not torch.all(values[:-1] > values[1:])):
        raise ValueError("Invalid preview sigma schedule / 预览噪声时间表必须从 (0,1] 严格下降至 0")


def solver_sigmas(values, sampler, flow_shift):
    if sampler == "er_sde" and values[0] >= 1:
        # VP log-SNR is singular at t=1. Match ComfyUI's percent offset, while
        # retaining strict order even when float32 rounds very large shifts.
        values = values.clone()
        time = 1 - 1e-4
        boundary = flow_shift * time / (1 + (flow_shift - 1) * time)
        values[0] = max(boundary, (1 + float(values[1])) / 2)
        if values[0] >= 1:
            values[0] = torch.nextafter(values.new_tensor(1.), values.new_tensor(0.))
        # At large shifts there may be no representable float32 value between
        # the first two levels after offsetting. Keep the effective grid unique.
        values = torch.unique_consecutive(values)
        validate_sigmas(values)
    return values
