"""Synchronous sampling wrapper with temporary adapters and state restoration."""
from __future__ import annotations

from contextlib import nullcontext
import functools
import logging
import random

import numpy as np
import torch

from .compat import PreviewCompatibilityError, sampling_due, sampling_signature
from .lora import LoRAManager
from . import anima, moss_image


logger = logging.getLogger(__name__)


def wrap_sampler(original, document):
    signature = sampling_signature(original)
    manager = LoRAManager(document["loras"], document["architecture"])

    @functools.wraps(original)
    def sample_images(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        values = bound.arguments
        if not sampling_due(values["args"], values["epoch"], values["steps"]):
            return original(*args, **kwargs)
        accelerator = values["accelerator"]
        dit = accelerator.unwrap_model(values["dit"])
        if not callable(getattr(dit, "switch_block_swap_for_training", None)):
            raise PreviewCompatibilityError("DiT block swap restoration interface changed / 模型换块恢复接口已改变")
        cpu_rng = torch.get_rng_state()
        cuda_rng = torch.cuda.get_rng_state_all() if torch.cuda.is_initialized() else None
        python_rng, numpy_rng = random.getstate(), np.random.get_state()
        entered = False
        loaded_te = False
        modes, placements = {}, []
        errors = []

        def restore(function, *arguments):
            try:
                function(*arguments)
            except Exception as exc:
                errors.append(exc)

        try:
            text_encoder = values["text_encoder"]
            if text_encoder is not None:
                text_encoder = accelerator.unwrap_model(text_encoder)
            te_needed = manager.needs_text_encoder
            if te_needed:
                if "sample_prompts_te_outputs" not in signature.parameters:
                    raise PreviewCompatibilityError("Sampler cannot bypass cached prompt embeddings / 采样接口无法刷新提示词编码")
                if text_encoder is None:
                    adapter = moss_image if document["architecture"] == "moss_image" else anima
                    text_encoder = adapter.load_text_encoder(values["args"], accelerator.device)
                    text_encoder.requires_grad_(False).eval()
                    loaded_te = True
                bound.arguments["text_encoder"] = text_encoder
                # External TE adapters must encode prompts again, never reuse
                # embeddings computed before these adapters were attached.
                bound.arguments["sample_prompts_te_outputs"] = None
            modules = [dit, values["vae"], text_encoder]
            modules = [accelerator.unwrap_model(module) for module in modules if module is not None]
            modes = {module: module.training for root in modules for module in root.modules()}
            # Buffers can be replaced by Module.to(), so preserve their slots
            # and identities as well as the original tensor devices/dtypes.
            placements = [(module, field, name, tensor, tensor.device, tensor.dtype)
                          for root in modules[1:] for module in root.modules()
                          for field in ("_parameters", "_buffers")
                          for name, tensor in getattr(module, field).items() if tensor is not None]
            if te_needed:
                text_encoder.to(accelerator.device).eval()
            compiled = any(hasattr(module, "_orig_mod") for module in modes)
            stance = getattr(torch.compiler, "set_stance", None)
            if compiled and stance is None:
                raise PreviewCompatibilityError("Compiled preview requires torch.compiler.set_stance / 编译预览缺少兼容接口")
            prepared = manager.prepare(dit, text_encoder if te_needed else None)
            logger.info("Preview external LoRAs / 预览外部 LoRA: %s", document["loras"])
            # Eager preview avoids stale compiled graphs retaining an old forward.
            # Compiled training resumes with its original graph and original forwards.
            with (stance("force_eager") if compiled else nullcontext()):
                with manager.activate(prepared, accelerator.device), torch.no_grad():
                    entered = True
                    return original(*bound.args, **bound.kwargs)
        finally:
            if entered:
                restore(dit.switch_block_swap_for_training)
            for module, training in modes.items():
                restore(setattr, module, "training", training)
            for module, field, name, tensor, device, dtype in placements:
                try:
                    if tensor.device != device or tensor.dtype != dtype:
                        tensor.data = tensor.data.to(device=device, dtype=dtype)
                    getattr(module, field)[name] = tensor
                except Exception as exc:
                    errors.append(exc)
            if loaded_te:
                # The trainer may have released its encoder to save RAM. Do
                # not retain it through the manager's target-module cache.
                manager.release_models()
            restore(torch.set_rng_state, cpu_rng)
            if cuda_rng is not None:
                restore(torch.cuda.set_rng_state_all, cuda_rng)
            restore(random.setstate, python_rng)
            restore(np.random.set_state, numpy_rng)
            if errors:
                raise RuntimeError("Preview state restoration failed; training cannot continue / "
                                   "预览状态恢复失败，训练已中止: " + "; ".join(map(str, errors))) from errors[0]

    sample_images._anima_preview_loras = True
    return sample_images
