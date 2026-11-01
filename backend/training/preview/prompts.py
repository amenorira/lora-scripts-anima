"""Encode external-TE preview prompts before allocating denoising branches."""
from __future__ import annotations

import gc
import logging

import torch

from .compat import PreviewCompatibilityError
from . import anima, moss_image


logger = logging.getLogger(__name__)


def prompt_texts(original, values, architecture):
    sampling = original.__globals__.get("sampling")
    load = getattr(sampling, "load_prompts", None)
    if not callable(load):
        raise PreviewCompatibilityError("Sampler prompt loader changed / 预览提示词加载接口已改变")
    replacement = values.get("prompt_replacement")
    texts = {}
    accelerator = values["accelerator"]
    prompts = load(values["args"].sample_prompts)
    prompts = prompts[getattr(accelerator, "process_index", 0)::getattr(accelerator, "num_processes", 1)]
    for prompt in prompts:
        positive, negative = prompt.get("prompt", ""), prompt.get("negative_prompt", "")
        if replacement is not None:
            positive = positive.replace(*replacement)
            if negative:
                negative = negative.replace(*replacement)
        texts[positive] = None
        scale = prompt.get("scale", 7.5 if architecture == "anima" else 3.0)
        if negative is not None and (scale > 1 if architecture == "anima" else scale != 1):
            texts[negative] = None
    return tuple(texts)


def encode_prompts(texts, values, encoder):
    tokenize, encoding = values["tokenize_strategy"], values["text_encoding_strategy"]
    result = {}
    with torch.no_grad(), values["accelerator"].autocast():
        for text in texts:
            outputs = encoding.encode_tokens(tokenize, [encoder], tokenize.tokenize(text))
            result[text] = [value.detach().cpu() if isinstance(value, torch.Tensor) else value for value in outputs]
    return result


def encode_with_adapters(manager, texts, values, encoder, architecture):
    """Keep temporary model references out of the denoising frame.

    Only a caller-owned encoder needs device restoration. A frozen encoder can
    encode once on CPU when training weights leave insufficient CUDA memory.
    """
    temporary = encoder is None
    device = values["accelerator"].device
    devices = (device, torch.device("cpu")) if temporary and device.type == "cuda" else (device,)
    for target in devices:
        try:
            if temporary:
                adapter = moss_image if architecture == "moss_image" else anima
                encoder = adapter.load_text_encoder(values["args"], target).requires_grad_(False)
                if target.type == "cuda":
                    size = sum(t.numel() * t.element_size() for t in (*encoder.parameters(), *encoder.buffers()))
                    available = (torch.cuda.mem_get_info(target)[0] + torch.cuda.memory_reserved(target)
                                 - torch.cuda.memory_allocated(target))
                    if size > available:
                        target = torch.device("cpu")
                        logger.info("Preview text encoder uses CPU: insufficient free CUDA memory / 预览文本编码改用 CPU，显存不足")
            encoder.to(target).eval()
            with manager.activate(manager.prepare(None, encoder), target, models=(encoder,)):
                return encode_prompts(texts, values, encoder)
        except torch.cuda.OutOfMemoryError:
            if not temporary or target.type != "cuda":
                raise
            logger.info("Retry preview text encoding on CPU / 显存不足，在 CPU 重试预览文本编码")
        finally:
            if temporary:
                manager.release_text_encoder()
                encoder = None
                # ConvRot installs bound forwards on its own child modules.
                # Those cycles must release weights before denoising/retry.
                gc.collect()
            else:
                encoder.to("cpu")
