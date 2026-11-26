<a name="guide-title"></a>
# VRAM Optimization and Speed Benchmarks

<a name="quick-guide"></a>
## Choosing settings by GPU VRAM tier

Enable memory controls in order—**lossless caching → quantization + compile → block swap when VRAM is still tight** (all tiers below assume **Gradient checkpointing**, **Save image latents to disk**, **Cache text encoder outputs**, an 8-bit optimizer such as **`AdamW8bit`**, and `batch_size = 1` with gradient accumulation):

| GPU VRAM tier | Anima (~2B–2.9B) | MOSS-Image / Krea 2 (large DiTs) | Key trade-off |
| --- | --- | --- | --- |
| **16–24 GB+** | `bf16` with `DiT block swap count = 0`; raise [Final blocks to skip checkpointing](#anima-partial-checkpointing) (`14–28`) to use spare VRAM | Enable **ConvRot INT8** (or Krea 2 **DiT FP8 dynamic quantization**) with `torch.compile`. When training **MOSS-Image** on a 24 GB GPU, you can skip gradient checkpointing for the last `7–14` blocks. | Trades spare VRAM for **15%–45%** faster steps |
| **10–12 GB** | Runs comfortably in `bf16` with full gradient checkpointing (~**`6.7 GB`** peak at 1024px) | Enable **ConvRot INT8** (or Krea 2 **DiT FP8 dynamic quantization**) + `compile` (~**`9.1–10.0 GB`** MOSS training peak at 1024px); on MOSS, avoid startup text-caching OOMs by enabling text-encoder `ConvRot INT8` or setting [Text encoder block swap count](#moss-text-encoder-swap) to `28–32` | Balances low VRAM and high throughput without startup spikes |
| **6–8 GB** | If 1024px is tight, swap `8–16` [DiT blocks](#block-swap) + `H2D-only` | Enable **ConvRot INT8** (or Krea 2 **DiT FP8 dynamic quantization**): on **MOSS-Image**, set [DiT block swap count](#block-swap) to `20–36` (`5.2 GB` measured training VRAM at `36` blocks); on **Krea 2**, set `16–26` (max `26`, with **Turbo DiT** preview acceleration off). Both can enable `H2D-only` + pinned memory when gradient checkpointing is on (**16–32 GB+** system RAM) | Trades PCIe transfer time and system RAM so 6–8 GB cards fit |

<a name="block-swap"></a>
## DiT block swap and compatibility rules

**DiT block swap count** (`blocks_to_swap`) keeps the chosen number of DiT Transformer blocks in system RAM and streams them into GPU VRAM one by one during forward and backward passes. Numerical precision is unchanged, at the cost of higher CPU RAM usage (**16–32 GB+** recommended) and per-step PCIe transfer latency.

- **Maximum swappable blocks by model type**:
  - **Anima**: Up to `total_blocks - 2` (**`26`** on 28-block Anima-Preview, **`38`** on 40-block Anima-2.9B).
  - **Krea 2**: Up to **`26`** blocks; when the swap count is above `0` and gradient checkpointing is enabled, `H2D-only` and pinned memory are supported. Disable **Turbo DiT** preview acceleration when using block swap.
  - **MOSS-Image**: Up to **`40`** blocks; see [MOSS-Image DiT block swap count](#moss-block-swap) below for measured VRAM and CPU RAM.
- **H2D-only and pinned memory**: Enabling `H2D-only` frees GPU block copies directly after backward passes instead of copying unchanged weights back to CPU (D2H); paired with pinned memory, it cuts swap overhead by roughly 20% on bandwidth-limited PCIe links.
- **Mutual-exclusion rules**:
  - Incompatible with **Gradient-checkpoint CPU offload** and **Unsloth asynchronous activation offload**.
  - When **`H2D-only`** is combined with **Final blocks to skip checkpointing**, at least one of the two counts must stay `≤ block_swap_ring_size` (default `2`)—keep skipped checkpoint blocks at `0` whenever swapping many blocks.
  - Per-block `torch.compile` with block swap requires `compile_fullgraph = false`.

<a name="anima"></a>
## Anima

<a name="anima-partial-checkpointing"></a>
### Final blocks to skip checkpointing

When spare VRAM is available and heavy block swapping is off, skipping gradient checkpointing on the final N backbone blocks retains their forward activations to avoid backward recomputation (up to `28` on Anima-Preview, `40` on Anima-2.9B).

Conditions: ~1 MP (`1024×1024`) images, `batch_size = 1`, LoRA Rank `16`, `bf16`, Flash Attention; gradient checkpointing, latent caching, and text caching enabled. VRAM shows training-phase `nvidia-smi` peak:

| Skipped blocks | PRO 6000 Blackwell VRAM | s/step | RTX 4090 VRAM | s/step |
| --- | --- | --- | --- | --- |
| `0` | `6.5 GB` | `0.85` | `6.7 GB` | `0.73` |
| `7` | `9.4 GB` | `0.75` | `9.6 GB` | `0.68` |
| `14` | `12.9 GB` | `0.73` | `13.0 GB` | `0.63` |
| `21` | `16.4 GB` | `0.59` | `16.5 GB` | `0.56` |
| `28` | `19.9 GB` | `0.53` | `20.0 GB` | `0.52` |

Source: [sd-scripts `anima_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<a name="moss"></a>
## MOSS-Image

<a name="moss-partial-checkpointing"></a>
### Final blocks to skip checkpointing

Conditions: ~1 MP images, `batch_size = 1`, LoRA Rank `16`, Flash Attention; gradient checkpointing, latent caching, and text caching enabled (`ConvRot INT8 + compile` timings measured after warm-up; VRAM is training-phase `nvidia-smi` peak including CUDA context).

<a name="moss-skip-pro6000"></a>
#### RTX PRO 6000 Blackwell

(Startup text-encoder caching in `bf16` peaks around `15.6 GB`.)

| Skipped blocks | `bf16` VRAM | s/step | `ConvRot INT8 + compile` VRAM | s/step |
| --- | --- | --- | --- | --- |
| `0` | `13.5 GB` | `1.29` | `10.0 GB` | `0.84` |
| `11` | `23.4 GB` | `1.21` | `15.4 GB` | `0.79` |
| `21` | `33.6 GB` | `1.13` | `21.9 GB` | `0.74` |
| `32` | `44.9 GB` | `1.02` | `29.1 GB` | `0.70` |
| `42` | `55.0 GB` | `0.93` | `35.5 GB` | `0.64` |

<a name="moss-skip-4090"></a>
#### RTX 4090 (with ConvRot INT8 text encoder)

| DiT configuration | Skipped blocks | Peak VRAM | s/step |
| --- | --- | --- | --- |
| `bf16` | `0` | `14.3 GB` | `1.88` |
| `bf16` | `5` | `17.6 GB` | `1.83` |
| `bf16` | `10` | `22.5 GB` | `1.77` |
| `ConvRot INT8 + compile` | `0` | `10.0 GB` | `1.00` |
| `ConvRot INT8 + compile` | `7` | `13.0 GB` | `0.98` |
| `ConvRot INT8 + compile` | `14` | `17.5 GB` | `0.94` |
| `ConvRot INT8 + compile` | `21` | `22.0 GB` | `0.90` |

Note: Enabling `ConvRot INT8` without `compile` primarily lowers VRAM at nearly identical step times (`1.41 s/step` vs. `1.45 s/step` in `bf16` on PRO 6000); pair it with `torch.compile` for both memory savings and speedups. Source: [sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<a name="moss-block-swap"></a>
### DiT block swap count

Conditions: RTX PRO 6000 Blackwell, Windows, `1024×1024`, `batch_size = 1`, LoRA Rank `16`, AdamW; gradient checkpointing, disk latent caching, and text caching enabled (classic swap mode; VRAM is `nvidia-smi` peak including CUDA context, Startup VRAM includes initial text caching, and CPU RAM is peak process working set; see [compatibility rules](#block-swap) above):

| DiT / text encoder precision | Memory configuration | Startup VRAM | Training VRAM | CPU RAM |
| --- | --- | --- | --- | --- |
| `bf16` / `bf16` | No swap | `15.3 GB` | `13.2 GB` | `17.2 GB` |
| `ConvRot INT8` / `ConvRot INT8` | No swap | `9.1 GB` | `9.1 GB` | `9.9 GB` |
| `ConvRot INT8` / `ConvRot INT8` | Unsloth async offload | `8.2 GB` | `8.2 GB` | `11.2 GB` |
| `bf16` / `ConvRot INT8` | Swap `20` blocks | `9.0 GB` | `9.0 GB` | `18.5 GB` |
| `ConvRot INT8` / `ConvRot INT8` | Swap `20` blocks | `7.9 GB` | `6.9 GB` | `14.0 GB` |
| `ConvRot INT8` / `ConvRot INT8` | Swap `36` blocks | `7.9 GB` | `5.2 GB` | `15.6 GB` |

<a name="moss-swap-h2d"></a>
#### 36 swapped blocks: classic vs. H2D-only step time

Conditions: RTX 3090, PCIe Gen3 x4, `bf16`, `1024×1024`, `batch_size = 1` (`—` indicates VRAM was not reported upstream):

| Swap mode | VRAM | s/step |
| --- | --- | --- |
| Classic swap | — | `≈ 11.7` |
| `H2D-only` + pinned memory | `≈ 7 GB` | `≈ 9.4` |

Sources: [sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md) · [`block_swap.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<a name="moss-text-encoder-swap"></a>
### Text encoder block swap count

When MOSS-Image encodes dataset captions into disk cache at startup with `0` swapped text-encoder blocks, loading the full Qwen text encoder reaches an `nvidia-smi` peak (including CUDA context) of **`15.5 GB`** in `bf16` or **`8.3 GB`** with `ConvRot INT8`. On 8–12 GB GPUs, this initial caching pass can run out of VRAM even when DiT training itself fits.

Raising **Text encoder block swap count** streams Qwen layers one by one during that one-time startup caching pass, before unloading the text encoder prior to DiT training (streamed rows below report peak PyTorch GPU tensor allocations on a ~2000-token caption):

| Text encoder precision | Swapped blocks | Measurement basis | Peak VRAM |
| --- | --- | --- | --- |
| `bf16` | `0` (no swap) | `nvidia-smi` total GPU peak | `15.5 GB` |
| `ConvRot INT8` | `0` (no swap) | `nvidia-smi` total GPU peak | `8.3 GB` |
| `bf16` | `28` | PyTorch GPU tensor allocation peak | `5.1 GB` |
| `bf16` | `32` | PyTorch GPU tensor allocation peak | `3.5 GB` |
| `ConvRot INT8` | `32` | PyTorch GPU tensor allocation peak | `2.2 GB` |

Streaming only slows initial caption caching (on RTX PRO 6000, PCIe 5.0, `bf16`: `0.1–0.3 s/caption` at `0` blocks vs. `≈ 0.7 s/caption` at `28` blocks) and has zero impact once cached embeddings are reused from disk. Source: [sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
