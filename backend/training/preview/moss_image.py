"""MOSS module aliases, including LoRAs targeting fused QKV projections."""

from contextlib import contextmanager


def text_encoder_swap_active(encoder):
    return getattr(encoder, "_moss_text_encoder_block_swap_handles", None) is not None


def _enable_preview_text_encoder_swap(encoder, blocks, device, *, temporary=False):
    from library import moss_image_utils as utils
    from library.custom_offloading_utils import LoRAStreamOffloader, attach_forward_streaming_hooks

    layers = list(encoder.layers)
    if not 0 < blocks <= len(layers):
        raise ValueError(f"text_encoder_blocks_to_swap must be between 1 and {len(layers)}, got {blocks}")
    # Upstream enable_text_encoder_block_swap publishes its lifecycle handles
    # only after preparation. Keep them here to roll back an initialization OOM,
    # including preparation of only part of the offloader's CPU masters.
    # Temporary encoders are discarded on failure. Avoid retaining their full
    # original CPU storage while the offloader creates flat CPU masters.
    saved = [] if temporary else [(module, field, name, tensor, tensor.detach(), tensor.requires_grad)
             for module in encoder.modules() for field in ("_parameters", "_buffers")
             for name, tensor in getattr(module, field).items() if tensor is not None]
    offloader, handles = None, []
    try:
        encoder.requires_grad_(False)
        for name, module in encoder.named_children():
            if name != "layers":
                module.to(device)
        offloader = LoRAStreamOffloader("moss-te", layers, len(layers), blocks,
                                       supports_backward=False, device=device, ring_size=2, use_pinned_memory=False)
        handles = attach_forward_streaming_hooks(offloader, layers)
        setattr(encoder, utils.TEXT_ENCODER_BLOCK_SWAP_HANDLES_ATTR, handles)
        setattr(encoder, utils.TEXT_ENCODER_BLOCK_SWAP_OFFLOADER_ATTR, offloader)
        setattr(encoder, utils.TEXT_ENCODER_DEVICE_ATTR, device)
        offloader.prepare_block_devices_before_forward(layers)
    except BaseException:
        try:
            for handle in handles:
                handle.remove()
            if offloader is not None:
                # release_device_buffers requires every streamed master to exist;
                # initialization may have failed before creating the next one.
                offloader.copier.sync()
        finally:
            for name in (utils.TEXT_ENCODER_BLOCK_SWAP_HANDLES_ATTR, utils.TEXT_ENCODER_BLOCK_SWAP_OFFLOADER_ATTR,
                         utils.TEXT_ENCODER_DEVICE_ATTR):
                if hasattr(encoder, name):
                    delattr(encoder, name)
            # prepare may fail while a streamed parameter is an empty temporary
            # placeholder. Reinstall the original storage, including buffer slots.
            for module, field, name, tensor, data, requires_grad in saved:
                tensor.data = data
                tensor.requires_grad_(requires_grad)
                getattr(module, field)[name] = tensor
        raise


@contextmanager
def text_encoder_for_preview(encoder, args, device, *, temporary=False):
    """Keep live streaming hooks intact and release preview-owned swaps."""
    if text_encoder_swap_active(encoder):
        # Its parameters may point into the offloader's ring. Moving individual
        # tensors, or the whole model, would disconnect them from that ring.
        encoder.eval()
        try:
            yield
        except BaseException:
            # A failed layer can interrupt the cyclic prefetch before the next
            # pass wraps around. Reset using the original offloader and masters.
            encoder._moss_text_encoder_block_swap_offloader.prepare_block_devices_before_forward(list(encoder.layers))
            raise
        return
    blocks = getattr(args, "text_encoder_blocks_to_swap", None) or 0
    if blocks > 0 and device.type == "cuda":
        from library.moss_image_utils import disable_text_encoder_block_swap

        try:
            _enable_preview_text_encoder_swap(encoder, blocks, device, temporary=temporary)
            encoder.eval()
            yield
        finally:
            disable_text_encoder_block_swap(encoder)
    else:
        try:
            encoder.to(device).eval()
            yield
        finally:
            encoder.to("cpu")


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
