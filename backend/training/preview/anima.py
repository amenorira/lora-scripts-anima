"""Anima shares its canonical DiT module paths with the ComfyUI LoRA layout."""


def fused_targets(name):
    return []


def load_text_encoder(args, device):
    import torch
    from library.anima_utils import load_qwen3_text_encoder

    return load_qwen3_text_encoder(args.qwen3, dtype=torch.bfloat16, device="cpu")[0]
