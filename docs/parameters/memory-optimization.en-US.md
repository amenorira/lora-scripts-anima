# Measured VRAM and speed

<!-- doc-anchor: anima -->
## Anima

<!-- doc-anchor: anima-partial-checkpointing -->
### Final blocks without checkpointing

About 1 MP images, batch 1, LoRA rank 16, bf16, Flash Attention; gradient checkpointing, latent caching, and text caching enabled. VRAM is the training-time nvidia-smi peak.

| Skipped blocks | PRO 6000 Blackwell VRAM | s/step | RTX 4090 VRAM | s/step |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 | 6.7 GB | 0.73 |
| 7 | 9.4 GB | 0.75 | 9.6 GB | 0.68 |
| 14 | 12.9 GB | 0.73 | 13.0 GB | 0.63 |
| 21 | 16.4 GB | 0.59 | 16.5 GB | 0.56 |
| 28 | 19.9 GB | 0.53 | 20.0 GB | 0.52 |

Source: [sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<!-- doc-anchor: moss -->
## MOSS-Image

<!-- doc-anchor: moss-partial-checkpointing -->
### Final blocks without checkpointing

#### RTX PRO 6000 Blackwell

About 1 MP images, batch 1, LoRA rank 16, Flash Attention; gradient checkpointing, latent caching, and text caching enabled. INT8 + compile timings follow warm-up.

VRAM is the training-phase nvidia-smi peak, including the CUDA context. Startup peaks at about 15.6 GB when caching with the bf16 text encoder.

| Skipped blocks | bf16 VRAM | s/step | ConvRot INT8 + compile VRAM | s/step |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 | 10.0 GB | 0.84 |
| 11 | 23.4 GB | 1.21 | 15.4 GB | 0.79 |
| 21 | 33.6 GB | 1.13 | 21.9 GB | 0.74 |
| 32 | 44.9 GB | 1.02 | 29.1 GB | 0.70 |
| 42 | 55.0 GB | 0.93 | 35.5 GB | 0.64 |

#### RTX 4090

Same image, batch, rank, attention settings, and VRAM measurement method. The text encoder uses ConvRot INT8.

| DiT configuration | Skipped blocks | Peak VRAM | s/step |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 |
| bf16 | 5 | 17.6 GB | 1.83 |
| bf16 | 10 | 22.5 GB | 1.77 |
| ConvRot INT8 + compile | 0 | 10.0 GB | 1.00 |
| ConvRot INT8 + compile | 7 | 13.0 GB | 0.98 |
| ConvRot INT8 + compile | 14 | 17.5 GB | 0.94 |
| ConvRot INT8 + compile | 21 | 22.0 GB | 0.90 |

#### Training speed: bf16 vs ConvRot INT8

RTX PRO 6000 Blackwell, 1024×1024, batch 1, gradient checkpointing. Compile status, skipped blocks, and VRAM were not reported for this comparison.

| DiT configuration | s/step |
| --- | --- |
| bf16 | 1.45 |
| ConvRot INT8 | 1.41 |

Source: [sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<!-- doc-anchor: moss-block-swap -->
### Blocks to swap

RTX PRO 6000 Blackwell, Windows, 1024×1024, batch 1, LoRA rank 16, AdamW; gradient checkpointing and disk latent caching. Swap rows use classic swap.

| DiT / text encoder | Configuration | Startup VRAM | Training VRAM | CPU RAM |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | DiT only, text cache | 15.3 GB | 13.2 GB | 17.2 GB |
| ConvRot INT8 / ConvRot INT8 | DiT only, text cache | 9.1 GB | 9.1 GB | 9.9 GB |
| ConvRot INT8 / ConvRot INT8 | DiT only, text cache, swap 20 | 7.9 GB | 6.9 GB | 14.0 GB |
| ConvRot INT8 / ConvRot INT8 | DiT only, text cache, swap 36 | 7.9 GB | 5.2 GB | 15.6 GB |
| ConvRot INT8 / ConvRot INT8 | DiT only, text cache, Unsloth offload | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / ConvRot INT8 | DiT only, text cache, swap 20 | 9.0 GB | 9.0 GB | 18.5 GB |
| ConvRot INT8 / ConvRot INT8 | DiT + text encoder LoRA, no text cache | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + text encoder LoRA, no text cache | 32.4 GB | 32.4 GB | 16.1 GB |

VRAM is the nvidia-smi peak, including the CUDA context; when text caching is enabled, startup includes that process. CPU RAM is peak process working set. The last two rows train the text encoder, which this trainer does not currently support.

Source: [sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

#### 36 swapped blocks: classic vs H2D-only

RTX 3090, PCIe Gen3 x4, bf16, 1024×1024, batch 1.

| Mode | VRAM | s/step |
| --- | --- | --- |
| Classic swap | — | ≈ 11.7 |
| H2D-only + pinned memory | ≈ 7 GB | ≈ 9.4 |

—: not reported upstream.

Source: [sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<!-- doc-anchor: moss-text-encoder-swap -->
### Text encoder layers to stream

#### Caching VRAM

One caption of about 2000 tokens. Peak GPU allocations by PyTorch.

| Text encoder | Streamed layers | Peak GPU allocation |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

#### Standalone text-caching tool: no layer swap

Peak VRAM measured with nvidia-smi.

| Text encoder | Peak VRAM |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

#### Layer-streaming time

RTX PRO 6000, PCIe 5.0, bf16. Caption length was not reported for this comparison.

| Streamed layers | s/caption |
| --- | --- |
| 0 | 0.1–0.3 |
| 28 | ≈ 0.7 |

Source: [sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
