"""Flow-matching samplers implemented for this trainer.

Anima predicts velocity v, with x(t)=(1-t)*x0+t*noise. A denoised
estimate is x0=x-t*v. All stochastic draws use the supplied CPU generator.
ER-SDE uses the third-order VP Taylor solution of Cui et al., WACV 2025,
https://arxiv.org/abs/2309.06169, in noise-to-signal coordinates t/(1-t).
This module has no dependency on Studio, Forge, k-diffusion or torchsde.
"""
import math

import numpy as np
import torch


def flux2_mu(width, height, steps):
    # Empirical shift from Black Forest Labs' FLUX.2 schedule. Anima's
    # 8x VAE and 2x patching give one image token per 16x16 pixels.
    # https://github.com/black-forest-labs/flux2/blob/main/src/flux2/sampling.py
    tokens = width * height / 256
    long = 0.00016927 * tokens + 0.45666666
    if tokens > 4300:
        return long
    short = 8.73809524e-05 * tokens + 1.89833333
    return short + (long - short) * (steps - 10) / 190


def schedule(name, steps, width, height, flow_shift=3):
    """Schedules for the 1000-point discrete flow model, using ComfyUI names.

    normal includes the minimum model timestep; sgm_uniform omits that
    endpoint. beta selects unique discrete timesteps, so its actual step
    count can be smaller than requested. Existing simple/linear/flux2
    schedules retain their previous values for saved jobs.
    """
    def shifted(times):
        return flow_shift * times / (1 + (flow_shift - 1) * times)

    minimum = shifted(.001)
    if name == "simple":
        times = torch.tensor([(1000 - int(i * 1000 / steps)) / 1000 for i in range(steps)] + [0.], dtype=torch.float64)
    elif name in ("linear", "flux2"):
        times = torch.linspace(1, 0, steps + 1, dtype=torch.float64)
    elif name in ("normal", "sgm_uniform"):
        count = steps + (name == "sgm_uniform")
        times = torch.linspace(1, minimum, count, dtype=torch.float64)
        if name == "sgm_uniform":
            times = times[:-1]
        return torch.cat((shifted(times), times.new_zeros(1)))
    elif name == "beta":
        from scipy.special import betaincinv

        # Beta(0.6, 0.6) timestep allocation, arXiv:2407.12173.
        quantiles = 1 - np.arange(steps, dtype=np.float64) / steps
        indices = np.rint(betaincinv(.6, .6, quantiles) * 999).astype(np.int64)
        indices = indices[np.r_[True, np.diff(indices) != 0]]
        times = torch.from_numpy((indices + 1) / 1000.)
        return torch.cat((shifted(times), times.new_zeros(1)))
    elif name in ("karras", "exponential"):
        ramp = torch.linspace(0, 1, steps, dtype=torch.float64)
        # Karras et al., arXiv:2206.00364, rho=7. Boundaries already include
        # the model's flow shift; do not shift these noise levels twice.
        values = (1 + ramp * (minimum ** (1 / 7) - 1)) ** 7 if name == "karras" else torch.exp(ramp * math.log(minimum))
        return torch.cat((values, values.new_zeros(1)))
    else:
        raise ValueError(f"Unknown schedule: {name}")
    shift = math.exp(flux2_mu(width, height, steps)) if name == "flux2" else flow_shift
    return shift * times / (1 + (shift - 1) * times)


def sampling_sigmas(sigmas, sampler, flow_shift=3):
    """Keep the SDE solver's log-SNR finite at the pure-noise boundary."""
    if sampler == "dpmpp_2m_sde" and len(sigmas) > 1 and sigmas[0] >= 1 - 1e-12:
        sigmas = sigmas.clone()
        time = 1 - 1e-4
        boundary = flow_shift * time / (1 + (flow_shift - 1) * time)
        # A custom schedule can start closer to one than the model's offset.
        sigmas[0] = max(boundary, (1 + float(sigmas[1])) / 2)
    return sigmas


def normal_like(x, generator):
    return torch.randn(x.shape, generator=generator, device="cpu", dtype=torch.float32).to(x.device)


def ancestral_step(x, denoised, current, following, noise):
    if following == 0:
        return denoised
    # Euler ancestral adapted to a rectified flow's signal coefficient 1-t.
    # Mathematical comparison: ComfyUI sample_euler_ancestral_RF, eta=1.
    down = following * following / current
    signal_ratio = (1 - following) / (1 - down)
    variance = max(0., following**2 - (down * signal_ratio)**2)
    intermediate = (down / current) * x + (1 - down / current) * denoised
    return signal_ratio * intermediate + math.sqrt(variance) * noise


def _log_phi(value):
    power = value**0.3
    # phi(s)=s*(exp(s**0.3)+10); evaluate in log space to avoid overflow.
    return math.log(value) + float(np.logaddexp(power, math.log(10)))


_QUADRATURE_NODES, _QUADRATURE_WEIGHTS = np.polynomial.legendre.leggauss(64)


def er_coefficients(current, following):
    """Integrals in the ER-SDE variation-of-constants solution, not an Euler proxy."""
    ratio = math.exp(_log_phi(following) - _log_phi(current))
    center, radius = (current + following) / 2, (current - following) / 2
    points = center + radius * _QUADRATURE_NODES
    kernel = np.array([math.exp(_log_phi(following) - _log_phi(float(p))) for p in points])
    integral = radius * float(np.dot(_QUADRATURE_WEIGHTS, kernel))
    first = following - current + integral
    second = (following - current)**2 / 2 + radius * float(np.dot(_QUADRATURE_WEIGHTS, kernel * (points - current)))
    return ratio, first, second


@torch.inference_mode()
def sample(velocity, initial, sigmas, sampler, generator, progress=lambda *_: None):
    x = initial.float()
    history = []
    old_denoised = None
    old_h = None
    for index in range(len(sigmas) - 1):
        current, following = float(sigmas[index]), float(sigmas[index + 1])
        progress(index, len(sigmas) - 1)
        v = velocity(x, current).float()
        if not torch.isfinite(v).all():
            raise FloatingPointError("Non-finite model prediction / 模型输出含非有限值")
        denoised = x - current * v
        if sampler == "euler":
            x = x + (following - current) * v
        elif sampler == "heun":
            predicted = x + (following - current) * v
            if following:
                next_v = velocity(predicted, following).float()
                x = x + .5 * (following - current) * (v + next_v)
            else:
                x = predicted
        elif sampler == "euler_a":
            x = ancestral_step(x, denoised, current, following, normal_like(x, generator) if following else 0.)
        elif sampler == "dpmpp_2m":
            # DPM-Solver++ multistep data prediction, arXiv:2211.01095.
            if not following:
                x = denoised
            else:
                h = math.log(current / following)
                estimate = denoised if old_denoised is None else denoised + .5 * h / old_h * (denoised - old_denoised)
                x = following / current * x - math.expm1(-h) * estimate
                old_h = h
            old_denoised = denoised
        elif sampler == "dpmpp_2m_sde":
            if not following:
                x = denoised
            else:
                # Flow parameterization: alpha=1-t, lambda=log(alpha/t).
                # eta=1, midpoint correction. Disjoint SDE intervals use
                # independent normal increments from the per-image RNG.
                h = math.log((1 - following) / following) - math.log((1 - current) / current)
                weight = -math.expm1(-2 * h)
                x = following / current * math.exp(-h) * x + (1 - following) * weight * denoised
                if old_denoised is not None:
                    x = x + .5 * (1 - following) * weight * h / old_h * (denoised - old_denoised)
                x = x + following * math.sqrt(weight) * normal_like(x, generator)
                old_h = h
            old_denoised = denoised
        elif sampler == "er_sde":
            if following == 0:
                x = denoised
            elif current == 1:
                # Pure noise has zero signal, so t/(1-t) is singular. Use the
                # well-defined flow ODE boundary step, then enter VP coordinates.
                x = x + (following - current) * v
            else:
                signal, next_signal = 1 - current, 1 - following
                noise_level, next_level = current / signal, following / next_signal
                ratio, first, second = er_coefficients(noise_level, next_level)
                value = ratio * (x / signal) + (1 - ratio) * denoised
                if history:
                    old_level, old_denoised, old_slope = history[-1]
                    slope = (denoised - old_denoised) / (noise_level - old_level)
                    value = value + first * slope
                    if len(history) > 1 and old_slope is not None:
                        acceleration = 2 * (slope - old_slope) / (noise_level - history[-2][0])
                        value = value + second * acceleration
                else:
                    slope = None
                variance = max(0., next_level**2 - noise_level**2 * ratio**2)
                x = next_signal * (value + math.sqrt(variance) * normal_like(x, generator))
                history.append((noise_level, denoised, slope))
                history = history[-2:]
        else:
            raise ValueError(f"Unknown sampler: {sampler}")
        if not torch.isfinite(x).all():
            raise FloatingPointError("Non-finite sampling result / 采样结果含非有限值")
    progress(len(sigmas) - 1, len(sigmas) - 1)
    return x
