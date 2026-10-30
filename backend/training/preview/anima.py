"""Anima shares its canonical DiT module paths with the ComfyUI LoRA layout."""


def fused_targets(name):
    return []


def load_text_encoder(args, device):
    import torch
    from library.anima_utils import load_qwen3_text_encoder

    return load_qwen3_text_encoder(args.qwen3, dtype=torch.bfloat16, device="cpu")[0]


def sample_latents(options, height, width, seed, dit, crossattn_emb, steps, dtype, device,
                   guidance_scale=1., flow_shift=3., neg_crossattn_emb=None):
    import torch
    from .kernels import cpu_generator, run_solver

    device = torch.device(device)
    enabled, compute_dtype = torch.is_autocast_enabled(device.type), torch.get_autocast_dtype(device.type)
    generator = cpu_generator(seed)
    initial = torch.randn((1, 16, 1, height // 8, width // 8), generator=generator, dtype=torch.float32).to(device)
    padding = torch.zeros((1, 1, height // 8, width // 8), device=device, dtype=dtype)

    def predict(x, time, embedding):
        # Upstream prepares once per prompt; its forward-only offloader wraps
        # around for subsequent passes, including CFG and Heun corrections.
        with torch.autocast(device_type=device.type, enabled=enabled, dtype=compute_dtype):
            t = torch.tensor([time], device=device, dtype=dtype)
            return dit(x.to(dtype), t, embedding, padding_mask=padding).float()

    def velocity(x, time):
        positive = predict(x, time, crossattn_emb)
        if guidance_scale > 1 and neg_crossattn_emb is not None:
            negative = predict(x, time, neg_crossattn_emb)
            return negative + guidance_scale * (positive - negative)
        return positive

    return run_solver(velocity, initial, options=options, steps=steps, flow_shift=float(flow_shift), architecture="anima",
                      generator=generator, seed=seed, width=width, height=height).to(dtype)
