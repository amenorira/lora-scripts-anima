"""MOSS module aliases, including LoRAs targeting fused QKV projections."""


def fused_targets(name):
    if name.endswith(".proj.qkv"):
        return [name[:-3] + projection for projection in ("q", "k", "v")]
    return []


def load_text_encoder(args, device):
    import torch
    from library.moss_image_utils import load_text_encoder as load

    return load(args.text_encoder, dtype=torch.bfloat16, device="cpu",
                disable_mmap=getattr(args, "disable_mmap_load_safetensors", False),
                convrot_int8=getattr(args, "convrot_int8_text_encoder", False),
                convrot_int8_bwd=getattr(args, "convrot_int8_bwd", "bf16"), calc_device=device)
