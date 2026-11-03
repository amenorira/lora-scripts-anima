"""Synchronous sampling wrapper with temporary adapters and state restoration."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import functools
import logging
from pathlib import Path
import random
import sys

import numpy as np
import torch

from .compat import PreviewCompatibilityError, sampling_due, sampling_signature
from .lora import LoRAManager, preserve_training_adapters
from .config import sampling_options
from .kernels import override_kernel
from .prompts import encode_with_adapters, prompt_texts
from . import moss_image


logger = logging.getLogger(__name__)


def _release_cuda_cache(device):
    if torch.device(device).type != "cuda":
        return
    failed = sys.exc_info()[0] is not None
    try:
        # Native allocator cache flushing is process-wide, including when a
        # device context is selected. Reserve this fallback for failed/late
        # releases instead of repeating upstream's successful-path cleanup.
        torch.cuda.empty_cache()
    except Exception:
        if not failed:
            raise
        logger.warning("Preview CUDA cleanup failed / 预览 CUDA 缓存清理失败", exc_info=True)


def _log_cuda_memory(device, phase):
    if torch.device(device).type == "cuda" and logger.isEnabledFor(logging.DEBUG):
        try:
            logger.debug("Preview CUDA memory / 预览显存: phase=%s allocated=%s reserved=%s",
                         phase, torch.cuda.memory_allocated(device), torch.cuda.memory_reserved(device))
        except Exception:
            logger.debug("Preview CUDA memory unavailable / 无法读取预览显存", exc_info=True)


def wrap_sampler(original, document):
    signature = sampling_signature(original)
    manager = LoRAManager(document["loras"], document["architecture"])
    options = sampling_options(document.get("sampler"), document.get("scheduler"))
    prompt_cache_key, prompt_cache = None, None

    @functools.wraps(original)
    def sample_images(*args, **kwargs):
        nonlocal prompt_cache_key, prompt_cache
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        values = bound.arguments
        if not sampling_due(values["args"], values["epoch"], values["steps"]):
            return original(*args, **kwargs)
        prompt_file = getattr(values["args"], "sample_prompts", None)
        if prompt_file is not None and not Path(prompt_file).is_file():
            # Preserve upstream log-and-skip before reading external weights.
            if "sample_prompts_te_outputs" in signature.parameters:
                bound.arguments["sample_prompts_te_outputs"] = None
            return original(*bound.args, **bound.kwargs)
        accelerator = values["accelerator"]
        dit = accelerator.unwrap_model(values["dit"])
        if not callable(getattr(dit, "switch_block_swap_for_training", None)):
            raise PreviewCompatibilityError("DiT block swap restoration interface changed / 模型换块恢复接口已改变")
        cpu_rng = torch.get_rng_state()
        cuda_rng = torch.cuda.get_rng_state_all() if torch.cuda.is_initialized() else None
        python_rng, numpy_rng = random.getstate(), np.random.get_state()
        entered = False
        completed = False
        external_attempted = False
        late_cuda_release = False
        modes, placements = {}, []
        errors = []
        swapped_text_encoder = None
        encoding_attempted = False

        def restore(function, *arguments):
            try:
                function(*arguments)
            except Exception as exc:
                errors.append(exc)

        try:
            text_encoder = values["text_encoder"]
            if text_encoder is not None:
                text_encoder = accelerator.unwrap_model(text_encoder)
                if document["architecture"] == "moss_image" and moss_image.text_encoder_swap_active(text_encoder):
                    swapped_text_encoder = text_encoder
            te_needed = manager.needs_text_encoder
            if te_needed:
                if "sample_prompts_te_outputs" not in signature.parameters:
                    raise PreviewCompatibilityError("Sampler cannot bypass cached prompt embeddings / 采样接口无法刷新提示词编码")
                texts = prompt_texts(original, values, document["architecture"])
                # A missing encoder is the trainer's frozen/cache-outputs path.
                # Live training encoders must be encoded again at every preview.
                frozen = text_encoder is None
                key = (texts, getattr(values["args"], "qwen3" if document["architecture"] == "anima" else "text_encoder", None),
                       id(values["tokenize_strategy"]), id(values["text_encoding_strategy"]))
                if not texts:
                    bound.arguments["sample_prompts_te_outputs"] = {}
                    te_needed = False
                elif frozen and key == prompt_cache_key:
                    bound.arguments["sample_prompts_te_outputs"] = prompt_cache
                    te_needed = False
                bound.arguments["text_encoder"] = None
            modules = [dit, values["vae"], text_encoder]
            modules = [accelerator.unwrap_model(module) for module in modules if module is not None]
            modes = {module: module.training for root in modules for module in root.modules()}
            # Buffers can be replaced by Module.to(), so preserve their slots
            # and identities as well as the original tensor devices/dtypes.
            placements = [(module, field, name, tensor, tensor.device, tensor.dtype)
                          for root in modules[1:]
                          if not (document["architecture"] == "moss_image" and moss_image.text_encoder_swap_active(root))
                          for module in root.modules()
                          for field in ("_parameters", "_buffers")
                          for name, tensor in getattr(module, field).items() if tensor is not None]
            compiled = any(hasattr(module, "_orig_mod") for module in modes)
            stance = getattr(torch.compiler, "set_stance", None)
            if compiled and stance is None:
                raise PreviewCompatibilityError("Compiled preview requires torch.compiler.set_stance / 编译预览缺少兼容接口")
            logger.info("Preview external LoRAs / 预览外部 LoRA: %s", document["loras"])
            # Eager preview avoids stale compiled graphs retaining an old forward.
            # Compiled training resumes with its original graph and original forwards.
            with (
                stance("force_eager") if compiled else nullcontext(),
                torch.no_grad(),
                preserve_training_adapters(modules) as owners,
            ):
                if te_needed:
                    external_attempted = True
                    encoding_attempted = True
                    encoded = encode_with_adapters(manager, texts, values, text_encoder, document["architecture"])
                    bound.arguments["sample_prompts_te_outputs"] = encoded
                    if frozen:
                        prompt_cache_key, prompt_cache = key, encoded
                prepared = manager.prepare(dit)

                @contextmanager
                def denoising_adapters():
                    nonlocal external_attempted
                    external_attempted = True
                    try:
                        _log_cuda_memory(accelerator.device, "before_adapters")
                        with manager.activate(prepared, accelerator.device, owners=owners):
                            _log_cuda_memory(accelerator.device, "adapters_loaded")
                            yield
                    finally:
                        _log_cuda_memory(accelerator.device, "adapters_released")

                with override_kernel(original, document["architecture"], options,
                                     context=denoising_adapters if prepared else None):
                    entered = True
                    result = original(*bound.args, **bound.kwargs)
                completed = True
                return result
        finally:
            # The upstream sampler restores block swapping on normal return.
            if entered and not completed:
                restore(dit.switch_block_swap_for_training)
            if swapped_text_encoder is not None and not completed and not encoding_attempted:
                restore(swapped_text_encoder._moss_text_encoder_block_swap_offloader.prepare_block_devices_before_forward,
                        list(swapped_text_encoder.layers))
            for module, training in modes.items():
                restore(setattr, module, "training", training)
            for module, field, name, tensor, device, dtype in placements:
                try:
                    if tensor.device != device or tensor.dtype != dtype:
                        released_cuda = tensor.device.type == "cuda"
                        tensor.data = tensor.data.to(device=device, dtype=dtype)
                        late_cuda_release |= released_cuda
                    slots = getattr(module, field)
                    if slots.get(name) is not tensor:
                        late_cuda_release |= isinstance(slots.get(name), torch.Tensor) and slots[name].device.type == "cuda"
                    # Do not keep a local reference to the replaced CUDA buffer
                    # alive until the fallback cache flush below.
                    slots[name] = tensor
                except Exception as exc:
                    errors.append(exc)
            restore(torch.set_rng_state, cpu_rng)
            if cuda_rng is not None:
                restore(torch.cuda.set_rng_state_all, cuda_rng)
            restore(random.setstate, python_rng)
            restore(np.random.set_state, numpy_rng)
            try:
                if errors:
                    raise RuntimeError("Preview state restoration failed; training cannot continue / "
                                       "预览状态恢复失败，训练已中止: " + "; ".join(map(str, errors))) from errors[0]
            finally:
                if external_attempted and (not completed or errors or late_cuda_release or sys.exc_info()[0] is not None):
                    # Normal success uses upstream's VAE/final cleanup. Only
                    # recover failures or CUDA storage released after it.
                    _release_cuda_cache(accelerator.device)

    sample_images._anima_preview_loras = True
    return sample_images
