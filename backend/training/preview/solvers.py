"""FP32 preview solvers over a model-independent velocity callback.

ER-SDE follows the VP ER-SDE-Solver-3 and 200-point integration of ComfyUI
b5a432157de6; log-space ratios avoid overflowing phi at the pure-noise boundary.
https://github.com/Comfy-Org/ComfyUI/blob/b5a432157de6b8884f81104cd02926adf4d597e4/comfy/k_diffusion/sampling.py
https://github.com/QinpengCui/ER-SDE-Solver
"""
import math

import torch

from .config import SAMPLERS
from .schedules import validate_sigmas


def _log_phi(level):
    return level.log() + torch.logaddexp(level.pow(.3), level.new_tensor(math.log(10)))


@torch.no_grad()
def sample(velocity, initial, sigmas, sampler, generator, progress=lambda *_: None):
    if sampler not in SAMPLERS:
        raise ValueError(f"Unknown preview sampler: {sampler}")
    validate_sigmas(sigmas)
    if sampler != "er_sde":
        from backend.regularization.sampling import sample as common_sample

        return common_sample(velocity, initial, sigmas, sampler, generator, progress)
    x = initial.float()
    previous_denoised = previous_slope = None
    levels = (sigmas.double() / (1 - sigmas.double())).float()
    points = torch.arange(200, dtype=torch.float32)
    for index in range(len(sigmas) - 1):
        current, following = float(sigmas[index]), float(sigmas[index + 1])
        progress(index, len(sigmas) - 1)
        v = velocity(x, current).float()
        if not torch.isfinite(v).all():
            raise FloatingPointError("Non-finite preview prediction / 预览模型输出含非有限值")
        denoised = x - current * v
        if following == 0:
            x = denoised
        else:
            start, end = levels[index], levels[index + 1]
            if not torch.isfinite(start):
                raise ValueError("ER-SDE needs a finite initial log-SNR / ER-SDE 起点需要有限信噪比")
            log_end = _log_phi(end)
            ratio = (_log_phi(end) - _log_phi(start)).exp()
            alpha_start, alpha_end = sigmas[index] / start, sigmas[index + 1] / end
            x = float(alpha_end / alpha_start * ratio) * x + float(alpha_end * (1 - ratio)) * denoised
            if index >= 1:
                dt = end - start
                step = -dt / 200
                positions = end + points * step
                kernel = (log_end - _log_phi(positions)).exp()
                slope = (denoised - previous_denoised) / float(start - levels[index - 1])
                x = x + float(alpha_end * (dt + kernel.sum() * step)) * slope
                if index >= 2:
                    curvature = (slope - previous_slope) / float((start - levels[index - 2]) / 2)
                    coefficient = dt.square() / 2 + (kernel * (positions - start)).sum() * step
                    x = x + float(alpha_end * coefficient) * curvature
                previous_slope = slope
            variance = (end.square() - start.square() * ratio.square()).clamp_min(0)
            noise = torch.randn(x.shape, generator=generator, dtype=torch.float32, device="cpu").to(x.device)
            x = x + float(alpha_end * variance.sqrt()) * noise
        if not torch.isfinite(x).all():
            raise FloatingPointError("Non-finite preview result / 预览采样结果含非有限值")
        previous_denoised = denoised
    progress(len(sigmas) - 1, len(sigmas) - 1)
    return x
