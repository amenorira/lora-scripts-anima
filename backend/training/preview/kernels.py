"""Scoped replacement of the two latent generators, leaving upstream I/O intact."""
from contextlib import contextmanager, ExitStack, nullcontext
import functools
import json
import logging
import sys
import threading

import torch
from tqdm.auto import tqdm

from .compat import KERNELS, PreviewCompatibilityError, kernel_signature
from .config import custom_sampling
from .schedules import build_sigmas, solver_sigmas
from .solvers import sample


logger = logging.getLogger(__name__)
_LOCK = threading.RLock()


@contextmanager
def override_kernel(original, architecture, options, *, context=None):
    custom = custom_sampling(options)
    if not custom and context is None:
        yield
        return
    namespace = original.__globals__
    name = KERNELS[architecture][0]
    with _LOCK:
        kernel = namespace.get(name)
        if not callable(kernel) or getattr(kernel, "_anima_preview_kernel", False):
            raise PreviewCompatibilityError(f"Cannot install preview {name} / 无法挂载预览去噪函数")
        signature = kernel_signature(kernel, architecture)
        early = context is not None and architecture == "anima"
        inference = namespace.get("_sample_image_inference")
        if early and not callable(inference):
            raise PreviewCompatibilityError("Sampler image inference function changed / 单张预览接口已改变")
        from . import anima, moss_image

        adapter = moss_image if architecture == "moss_image" else anima
        active = None
        denoised = False

        @functools.wraps(inference)
        def image_inference(*args, **kwargs):
            nonlocal active, denoised
            if active is not None:
                raise PreviewCompatibilityError("Nested preview image inference / 单张预览重复进入")
            with ExitStack() as stack:
                active = stack
                denoised = False
                try:
                    # Anima's DiT llm_adapter runs before do_sample. Cover it
                    # too, then close this scope as soon as latents are ready.
                    stack.enter_context(context())
                    return inference(*args, **kwargs)
                finally:
                    active = None

        @functools.wraps(kernel)
        def replacement(*args, **kwargs):
            nonlocal denoised
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            if early and (active is None or denoised):
                raise PreviewCompatibilityError("Denoiser called outside image inference / 去噪调用已脱离单张预览上下文")
            try:
                # MOSS needs no DiT patches while encoding prompts. Allocate
                # only once its latent generator is actually entered.
                with context() if context is not None and not early else nullcontext():
                    if custom:
                        return adapter.sample_latents(options, **bound.arguments)
                    return kernel(*args, **kwargs)
            finally:
                # Upstream's next phase cleans memory and moves the VAE in.
                if early and active is not None:
                    denoised = True
                    active.__exit__(*sys.exc_info())

        replacement._anima_preview_kernel = True
        namespace[name] = replacement
        if early:
            namespace["_sample_image_inference"] = image_inference
        try:
            yield
        finally:
            namespace[name] = kernel
            if early:
                namespace["_sample_image_inference"] = inference


def run_solver(velocity, initial, *, options, steps, flow_shift, architecture, generator,
               seed, width, height, show_progress=True):
    sigmas = solver_sigmas(build_sigmas(options["scheduler"], steps, flow_shift, architecture), options["sampler"], flow_shift)
    metadata = {**options, "architecture": architecture, "seed": generator.initial_seed(), "width": width, "height": height,
                "flow_shift": flow_shift, "requested_steps": steps, "effective_steps": len(sigmas) - 1,
                "sigmas": sigmas.tolist(), "solver_version": 1}
    logger.info("Preview sampling / 预览采样: %s", json.dumps(metadata, ensure_ascii=False))
    calls = 0

    def counted(x, sigma):
        nonlocal calls
        calls += 1
        return velocity(x, sigma)

    with tqdm(total=len(sigmas) - 1, desc="Sampling", disable=not show_progress) as bar:
        def progress(current, total):
            bar.update(current - bar.n)
        # Keep integration and noise accumulation outside the trainer's autocast.
        with torch.autocast(device_type=initial.device.type, enabled=False):
            result = sample(counted, initial, sigmas, options["sampler"], generator, progress)
    logger.info("Preview finished / 预览采样完成: steps=%s, model evaluations=%s", len(sigmas) - 1, calls)
    return result


def cpu_generator(seed):
    generator = torch.Generator(device="cpu")
    if seed is None or seed == -1:
        generator.seed()
    else:
        generator.manual_seed(int(seed))
    return generator
