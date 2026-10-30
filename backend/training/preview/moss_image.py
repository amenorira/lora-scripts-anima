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


def sample_latents(options, dit, prompt_embeds, prompt_mask, negative_embeds, negative_mask,
                   height, width, steps, guidance_scale, flow_shift, uncond_skip_layers,
                   seed, device, show_progress=True):
    import torch
    from .kernels import cpu_generator, run_solver

    device = torch.device(device)
    enabled, compute_dtype = torch.is_autocast_enabled(device.type), torch.get_autocast_dtype(device.type)
    generator = cpu_generator(seed)
    initial = torch.randn((1, dit.latent_channels, height // 16, width // 16), generator=generator, dtype=torch.float32).to(device)
    positive, positive_mask = prompt_embeds.to(device=device, dtype=dit.dtype), prompt_mask.to(device)
    do_cfg = guidance_scale != 1 and negative_embeds is not None
    if do_cfg:
        negative, neg_mask = negative_embeds.to(device=device, dtype=dit.dtype), negative_mask.to(device)

    def predict(x, time, embedding, mask, **kwargs):
        # Keep the upstream offloader's cyclic prefetch; per-pass preparation
        # would synchronize transfers and empty the CUDA allocator cache.
        with torch.autocast(device_type=device.type, enabled=enabled, dtype=compute_dtype):
            # The native sd-scripts MOSS model consumes 0..1000, unlike the
            # normalized 0..1 model wrapper used by native ComfyUI.
            timestep = torch.full((x.shape[0],), time * 1000, device=device, dtype=torch.float32)
            return dit(x.to(dit.dtype), timestep, embedding, mask, **kwargs).float()

    def velocity(x, time):
        prediction = predict(x, time, positive, positive_mask)
        if do_cfg:
            uncond = predict(x, time, negative, neg_mask, skip_layers=uncond_skip_layers)
            prediction = uncond + guidance_scale * (prediction - uncond)
        return prediction

    return run_solver(velocity, initial, options=options, steps=steps, flow_shift=float(flow_shift), architecture="moss_image",
                      generator=generator, seed=seed, width=width, height=height, show_progress=show_progress)
