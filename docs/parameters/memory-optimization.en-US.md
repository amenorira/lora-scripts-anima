# VRAM and speed

Choose settings for the stage that runs out of memory: loading, caching, training, or previews. Measurements use the bundled upstream revision; sources are linked in each section. Compare runs with matching resolution, batch, rank, attention backend, and quantization.

<!-- doc-anchor: overview -->
## Choose settings for the bottleneck

| Situation | Check first | Main cost |
| --- | --- | --- |
| Training runs out of VRAM | Batch, resolution, checkpointing, caches | More recomputation or lower throughput; resolution affects training content |
| Frozen weights occupy too much VRAM | Block swap; ConvRot INT8 for MOSS | More system RAM, transfers, or quantization error |
| Text caching runs out of VRAM | MOSS text encoder layer swap, INT8 | Slower caching with layer swap; changed model numerics with quantization |
| VAE encoding or preview decoding runs out of VRAM | Anima 2D VAE, VAE batch, preview dimensions | Different encoding throughput or preview size |
| Training fits with spare VRAM | Gradually skip checkpointing more final blocks | More VRAM, less recomputation |

Complete caching, several training steps, and a preview before changing settings one at a time. Leave roughly 1–2 GB for larger buckets and previews. LoRA optimizer states are often smaller than base weights and activations; see the [optimizer guide](optimizers.en-US.md#optimizer-type).

<!-- doc-anchor: partial-checkpointing -->
## Final blocks to skip checkpointing

With checkpointing enabled, `gradient_checkpointing_skip_blocks=N` retains activations for the final N main blocks, saving their backward recomputation. Larger N uses more VRAM and usually reduces step time. `0` checkpoints all main blocks. Anima accepts `0–28`, MOSS `0–42`; MOSS text embedder blocks remain checkpointed.

Start at `0`, then increase by a few blocks while comparing steady-state step time and peak VRAM. Under the configurations below, upstream found this a useful way to spend spare VRAM compared with increasing the batch size. With [H2D-only swap](#h2d-only), either the skipped count or the swapped count must fit within the ring slots.

### Anima: upstream measurements

About 1 MP images, batch 1, LoRA dim 16, bf16, Flash Attention, cached latents and text outputs. Peaks are training-time `nvidia-smi` readings. Both GPUs use the same training settings.

| Skipped blocks | PRO 6000 Blackwell VRAM | Step time | RTX 4090 VRAM | Step time |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 s | 6.7 GB | 0.73 s |
| 7 | 9.4 GB | 0.75 s | 9.6 GB | 0.68 s |
| 14 | 12.9 GB | 0.73 s | 13.0 GB | 0.63 s |
| 21 | 16.4 GB | 0.59 s | 16.5 GB | 0.56 s |
| 28 | 19.9 GB | 0.53 s | 20.0 GB | 0.52 s |

In this RTX 4090 run, moving from `0` to `28` reduced step time by about 29% and added about 13.3 GB. This trainer's default rank and attention backend can differ from the benchmark.

Source: [upstream Anima guide, pinned revision](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md#71-vram-usage-optimization--vram使用量の最適化).

### MOSS-Image: upstream measurements

RTX PRO 6000 Blackwell, about 1 MP images, batch 1, LoRA dim 16, Flash Attention, cached latents and text outputs. The INT8 configuration also enables `compile`; its times follow compilation and autotune warm-up. Quantization and compilation change together in this comparison.

| Skipped blocks | bf16 VRAM | Step time | ConvRot INT8 + compile VRAM | Step time |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 s | 10.0 GB | 0.84 s |
| 11 | 23.4 GB | 1.21 s | 15.4 GB | 0.79 s |
| 21 | 33.6 GB | 1.13 s | 21.9 GB | 0.74 s |
| 32 | 44.9 GB | 1.02 s | 29.1 GB | 0.70 s |
| 42 | 55.0 GB | 0.93 s | 35.5 GB | 0.64 s |

Upstream's description of startup peaks conflicts with this table. Published readings are preserved here; use the separate [stage measurements](#memory-phases) for startup.

RTX 4090, matching image / batch / rank / attention settings, ConvRot INT8 text encoder:

| DiT configuration | Skipped blocks | Peak VRAM | Step time |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 s |
| bf16 | 5 | 17.6 GB | 1.83 s |
| bf16 | 10 | 22.5 GB | 1.77 s |
| INT8 + compile | 0 | 10.0 GB | 1.00 s |
| INT8 + compile | 7 | 13.0 GB | 0.98 s |
| INT8 + compile | 14 | 17.5 GB | 0.94 s |
| INT8 + compile | 21 | 22.0 GB | 0.90 s |

Source: [upstream MOSS measurements and conditions, pinned revision](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化).

<!-- doc-anchor: checkpointing -->
## Gradient checkpointing

`gradient_checkpointing` reduces intermediate activations retained for backward, at the cost of recomputation. It mainly affects training. Loading or text-caching memory pressure needs settings for those stages. Enable it first when training VRAM is tight, then adjust batch and resolution.

H2D-only swap for Anima / MOSS requires checkpointing. With spare VRAM, use the [partial-checkpointing measurements](#partial-checkpointing) to reduce recomputation gradually. CPU and Unsloth options are covered under [activation offload](#activation-offload).

<!-- doc-anchor: block-swap -->
## Block swap: keep fewer weights resident

`blocks_to_swap` keeps some main-block weights on the CPU and transfers them to the GPU when needed. More swapped blocks reduce resident weight memory and increase system RAM and transfer costs. Anima supports up to `26`, MOSS up to `40`. Krea 2 has its own model and UI limits.

For Anima / MOSS, block swap is mutually exclusive with CPU and Unsloth activation offload. Start with checkpointing enabled, increase the swapped count gradually, and check free system RAM. Disable `compile_fullgraph` when swapping; compilation may also provide a smaller speed benefit.

Compare [H2D-only swap](#h2d-only) as a further option. MOSS VRAM and RAM readings are in the [stage measurements](#memory-phases).

<!-- doc-anchor: h2d-only -->
## H2D-only, ring buffers, and pinned memory

For Anima / MOSS frozen-base CUDA training, `block_swap_h2d_only` removes GPU-to-CPU weight transfers. It requires `blocks_to_swap>0` and gradient checkpointing. Ring buffers consume additional VRAM: `block_swap_ring_size=2` overlaps transfers and computation; `1` uses less VRAM but removes that overlap.

At the same swapped count, H2D-only can use more VRAM than classic swap. For similar memory usage, increase the swapped count or reduce the ring slots within the UI limits. With partial checkpointing, **skipped blocks ≤ ring slots, or swapped blocks ≤ ring slots** must hold.

`use_pinned_memory_for_block_swap` page-locks the CPU weight copies. Transfers may improve, but Windows shared GPU memory and system RAM pressure increase. It only affects H2D-only; when disabled, upstream still uses a small pinned staging pool.

Upstream MOSS, RTX 3090, PCIe Gen3 x4, bf16, 1024², batch 1, 36 swapped blocks:

| Swap mode | VRAM | Step time |
| --- | --- | --- |
| Classic | Not listed separately | 11.7 s |
| H2D-only + pinned memory | About 7 GB | 9.4 s |

PCIe bandwidth and power limits affect speed.

Source: [upstream block-swap guide, pinned revision](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md).

<!-- doc-anchor: activation-offload -->
## Activation offload

CPU offload (`cpu_offload_checkpointing`) and asynchronous Unsloth offload (`unsloth_offload_checkpointing`) move checkpoint activations to system RAM. They trade VRAM for RAM and transfers, and can help when activations remain the bottleneck after enabling checkpointing.

For Anima / MOSS, the two modes are mutually exclusive and cannot be combined with `blocks_to_swap>0`. Compare a swap configuration against an activation-offload configuration using peak VRAM, RAM, and steady-state step time. Krea 2's `gradient_checkpointing_cpu_offload` belongs to a separate engine and follows that profile's UI constraints.

One upstream MOSS INT8 run used `8.2 GB` during training with Unsloth offload, versus `9.1 GB` without it. See the [stage measurements](#memory-phases) for all conditions.

<!-- doc-anchor: caching -->
## Latent and text-output caches

`cache_latents` reuses VAE encodings; `cache_text_encoder_outputs` reuses text encodings. Caching allows the corresponding encoders to be released from the GPU during training. Disk caches also support reuse across runs and reduce resident cache RAM, at the cost of storage and reads.

Initially building caches still runs the VAE or text encoder. For MOSS text caching, consider [text encoder layer swap](#text-encoder-swap).

Latent caching conflicts with random cropping. Text caching requires freezing the relevant encoder and restricts dynamic caption processing such as tag shuffling, tag-level dropout, and token warm-up; follow the selected profile's UI hints. Rebuild affected caches after changing images, encoder weights, captions, or relevant preprocessing.

<!-- doc-anchor: text-encoder-swap -->
## MOSS text encoder layer swap

`text_encoder_blocks_to_swap` streams Qwen3.5-9B layers from the CPU while building text caches. The range is `0–32`: `0` disables streaming and `32` streams every layer. It lowers caching peaks at the cost of PCIe transfers and more RAM, and requires a frozen encoder. This trainer keeps the MOSS text encoder frozen.

Upstream text-caching measurements for one roughly 2000-token prompt:

| Text encoder | Streamed layers | Peak GPU allocation (PyTorch) |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

These exclude full driver usage. Upstream also measured the standalone text-caching tool without layer swap using driver peaks:

| Text encoder | GPU peak (nvidia-smi) |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

The two tables use different conditions and accounting. For MOSS, `text_encoder_batch_size` sets how many captions each caching batch handles. The encoder still processes them one at a time, so this setting mainly changes the loop granularity.

Source: [upstream MOSS caching measurements](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化).

<!-- doc-anchor: quantization -->
## MOSS ConvRot INT8

`convrot_int8` quantizes frozen base Linear weights in the main DiT blocks to reduce weight memory while the LoRA branch remains trainable. `convrot_int8_text_encoder` quantizes the frozen text encoder, reducing upstream model size from about `15.9 GB` to `7.4 GB`. Pre-quantized ConvRot files are detected automatically; bf16 files can be quantized at load time.

Fused INT8 kernels require Triton compatible with the installed torch. Without it, a temporary bf16 dequantization fallback retains weight-memory savings but may be slower. Keep `convrot_int8_bwd=bf16` initially: `int8` also quantizes input gradients, and upstream found no clear step-time gain with checkpointing.

Quantization changes base-model numerics, so compare loss and saved checkpoints. MOSS uses ConvRot INT8 and does not support FP8. Other profiles' FP8 or GGUF options follow their own backend. Merging base LoRAs before MOSS ConvRot INT8 has restrictions enforced by the UI.

See [stage measurements](#memory-phases) for memory and [partial checkpointing](#partial-checkpointing) for the combined INT8 + compile timings.

<!-- doc-anchor: memory-phases -->
## Startup, training, and system RAM

Upstream MOSS on Windows, RTX PRO 6000 Blackwell, 1024², batch 1, LoRA dim 16, AdamW, gradient checkpointing, and disk latent cache. This table trains only the DiT and caches text outputs. Startup includes text caching; swap rows use classic swap.

| DiT / text encoder | Additional setting | Startup GPU peak | Training GPU peak | CPU RAM peak |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | None | 15.3 GB | 13.2 GB | 17.2 GB |
| INT8 / INT8 | None | 9.1 GB | 9.1 GB | 9.9 GB |
| INT8 / INT8 | Swap 20 blocks | 7.9 GB | 6.9 GB | 14.0 GB |
| INT8 / INT8 | Swap 36 blocks | 7.9 GB | 5.2 GB | 15.6 GB |
| INT8 / INT8 | Unsloth activation offload | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / INT8 | Swap 20 blocks | 9.0 GB | 9.0 GB | 18.5 GB |

Upstream also measured training the text encoder. This trainer's MOSS UI keeps it frozen; the next rows show the effect of that additional training scope.

| DiT / text encoder | Training scope | Startup GPU peak | Training GPU peak | CPU RAM peak |
| --- | --- | --- | --- | --- |
| INT8 / INT8 | DiT + text encoder LoRA, no text cache | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + text encoder LoRA, no text cache | 32.4 GB | 32.4 GB | 16.1 GB |

GPU peaks are `nvidia-smi` readings including the CUDA context; CPU RAM is process working set. Windows commit charge can exceed working set, reaching about `38 GB` in upstream bf16 runs. Check available system memory and the page file.

An 8 GB GPU may fail during startup even if training only needs about 5.2 GB. Upstream's 8 GB procedure uses separate caching tools and text encoder layer swap; this UI's cache switches do not automatically split the stages into separate processes. Check preview-generation peaks too.

`lowram` keeps more models on the GPU to save system RAM. It can increase VRAM use.

Source: [upstream MOSS stage measurements](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値).

<!-- doc-anchor: vae -->
## VAE encoding and decoding

Anima's `qwen_image_vae_2d` uses an equivalent 2D path for single images with the same VAE weights. Upstream VAE encoding on an RTX 3090, ten 1024² images:

| VAE path | GPU peak | Encoding time |
| --- | --- | --- |
| 3D | About 4.4 GB | 7.7 s |
| 2D | About 1.4 GB | 4.5 s |

Upstream's standalone MOSS latent-caching tool used about `3.2 GB` of GPU memory with the FP32 VAE and 1024² images. This is a different VAE from the Anima comparison.

Lower `vae_batch_size` first for VAE memory pressure. `vae_chunk_size` controls Anima spatial chunking; full-resolution activations and attention often dominate the 2D peak, limiting the savings from chunking. `vae_disable_cache` affects internal temporal caches of the 3D VAE and has no effect on the 2D path.

SDXL's `no_half_vae` uses FP32 for the VAE, which can help precision problems but increases memory. MOSS uses the FLUX.2 VAE; Krea 2 has its own VAE caching and tiling controls. Lower preview dimensions when decoding previews runs out of memory.

Sources: [Anima VAE options](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md), [MOSS caching measurements](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値).

<!-- doc-anchor: batch-resolution -->
## Batch, resolution, and gradient accumulation

`train_batch_size` controls the number of images processed together. Larger values usually increase activation VRAM. Start at `1` when tight, then use `gradient_accumulation_steps` to obtain the desired effective samples per update: approximately batch × accumulation × GPU count for full batches.

Accumulation combines gradients from several small batches without retaining all their image activations at once. At fixed epochs it also changes the number of optimizer updates. Compare time per sample, update count, and training results together.

`resolution` and actual buckets determine image-token and activation sizes. Larger images usually require more VRAM. The largest bucket, longest caption, and additional trainable components can all raise peaks.

<!-- doc-anchor: precision-attention -->
## Precision and attention backends

`mixed_precision` changes part of the computation precision. `full_bf16` also casts model and trainable parameters to BF16, which may save more memory with lower parameter precision. Check optimizer support and establish a baseline with profile defaults before changing it.

The memory and speed of SDPA, Flash Attention, and xformers depend on hardware, dependencies, and input length. Upstream memory tables use Flash Attention; this trainer's default `torch` / SDPA can differ.

`split_attn` processes attention per sample and may reduce padding for variable-length captions. Anima / MOSS enable it automatically with xformers. The gain depends on batch and caption lengths; batch 1 usually has less padding to remove.

<!-- doc-anchor: compile -->
## Compilation and VRAM

Anima / MOSS `compile` compiles individual DiT blocks. Wait for compilation and autotuning to settle before comparing timings. Upstream MOSS INT8 + compile retained about `0.6 GB` per skipped block, versus roughly `1 GB` in its bf16 run; see [partial checkpointing](#partial-checkpointing) for all conditions.

Compilation may also increase peaks or cache memory. Block swap limits the layers that can be compiled; disable `compile_fullgraph` while swapping. Krea 2's compilation path is separate, so measure it with that profile's settings.
