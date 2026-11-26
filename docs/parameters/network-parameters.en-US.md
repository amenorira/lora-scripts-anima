<a name="guide-title"></a>
# Network parameters

Network parameters control the adapter's matrix factorization, target layer scope, and saved weight size. New configurations default to dropout `0`, with Rank / Alpha defaults set by model type:

| Model type | Default Rank / Alpha |
| --- | --- |
| Anima, SDXL, Krea 2 | `32 / 32` |
| MOSS-Image | `16 / 1` |

After changing the algorithm, Rank, factorization settings, or target scope, open [Matrix structure and file size](matrix-preview.en-US.md) to verify trainable parameter counts, effective scale, and estimated `.safetensors` file size.

<a name="algorithms"></a>
## LoRA, LoHa, and LoKr

| Algorithm | Weight-update representation | Practical trade-offs and selection |
| --- | --- | --- |
| Standard LoRA / LoCon | Product of two low-rank matrices `B × A` | Broadest inference compatibility (ComfyUI, WebUI, Diffusers); supports [LoRA+](lora-plus.en-US.md) and paired-factor optimizers (`LoRA-Muon`, `LoRA-RITE`). Recommended default starting point |
| LoHa | Elementwise (Hadamard) product of two low-rank pairs | Higher effective rank ceiling per Rank, at **roughly 2× the trainable parameters** of standard LoRA at the same Rank (halve Rank to match file size); suited to multi-concept or dense style experiments |
| LoKr | Kronecker product `W1 ⊗ W2`, where factors can be low-rank | Shaped jointly by `lokr_factor` and Rank (Rank `8–16` is a common starting point); balances compact files with high-rank capacity when the target inference loader supports LyCORIS |

Available network modules by model type:

- **Anima, SDXL**: Native `sd-scripts` modules (`networks.lora_anima` / `networks.lora`, `networks.loha`, `networks.lokr`) or `lycoris.kohya` (LoCon, LoHa, LoKr).
- **MOSS-Image**: Linear-only native modules (`networks.lora_generic`, `networks.loha`, `networks.lokr`). All three support rank/module dropout, [LoRA+](lora-plus.en-US.md), regex-based per-layer Rank/learning-rate overrides (`network_reg_dims` / `network_reg_lrs`), and optional [DiT text projection and refiner blocks](#moss-text-embedder); the Qwen text encoder stays frozen.
- **Krea 2**: Native LoRA (`networks.lora_krea2`) or LyCORIS (LoCon, LoHa, LoKr) across up to 264 DiT Linear layers; see [Krea 2 target filtering](#krea-targets).

When comparing algorithms, match total trainable parameters in the [structure preview](matrix-preview.en-US.md) first, then evaluate checkpoints with identical prompts and seeds ([comparison workflow](timesteps.en-US.md#comparison-method)).

<a name="dimension"></a>
## Rank (network dimension)

`network_dim` (Rank) sets the intermediate dimension of low-rank factors. It defaults to `32` for Anima, SDXL, and Krea 2, and `16` for MOSS-Image.

| Scenario or training symptom | Typical standard LoRA Rank | Guidance |
| --- | --- | --- |
| Single character, facial identity, or simple prop | `16–32` (`8–16` for LoKr) | Captures facial features, hair, and one outfit cleanly while keeping file size and overfitting risk low |
| Multiple outfits, complex art style, or larger datasets | `32–64` (`16–32` for LoHa) | Provides extra capacity for varied textures, lighting, and brushwork |
| Rank too low (`4–8` on detailed subjects) | Raise to `16–32` | Fine facial traits, costume ornaments, or stroke textures stay soft and underfit even after loss levels off |
| Rank too high (`64–128+` on 15–30 image datasets) | Lower to `16–32` | Inflates file and optimizer-state size while memorizing poses, backgrounds, and dataset noise faster |

<a name="alpha"></a>
## Alpha and rsLoRA

Standard LoRA scales the low-rank matrix product by `Alpha / Rank` during both training and inference, without changing parameter count or file size:

```text
ΔW = (Alpha / Rank) × B × A
```

With Rank and learning rate held fixed, lowering Alpha scales down the per-step update magnitude and backward gradients while letting larger internal weights represent the same `ΔW` (originally introduced in Kohya scripts to reduce low-precision FP16 / BF16 rounding of tiny weights to zero). Raising Alpha increases effective update strength.

<a name="alpha-choice"></a>
### Practical values and shortcuts

Keep the defaults for initial runs (`32 / 32` on Anima, SDXL, and Krea 2; `16 / 1` on MOSS-Image). When following an existing recipe, copy Rank, Alpha, and learning rate together. For standard LoRA at Rank `32`:

| Shortcut | Alpha | `Alpha / Rank` scale | Typical use |
| --- | --- | --- | --- |
| `= dim` | `32` | `1.0` | Unscaled baseline suited to most initial runs |
| `½ dim` | `16` | `0.5` | Gentle first step to soften early updates and smooth convergence |
| `1` | `1` | `1/32` (`0.03125`) | Strong downscaling used by MOSS-Image defaults and Alpha-1 recipes |

Each shortcut writes Alpha once; changing Rank afterward does not update Alpha automatically. Some native modules treat `Alpha = 0` as equal to Rank (scale `1.0`).

<a name="alpha-lr"></a>
### Coordinating with learning rate

Adaptive optimizers such as AdamW normalize updates by first and second gradient moments, so effective update speed does not scale linearly with `Alpha / Rank`—do not multiply the learning rate by 32× simply because Alpha changed from `32` to `1`. Keep other settings fixed, compare checkpoints across epochs with matching seeds, and raise the learning rate modestly only if convergence becomes clearly sluggish, or lower it if early checkpoints blow out colors or lock poses.

<a name="rslora"></a>
### rsLoRA (rank-stabilized scaling)

Enabling `rs_lora` replaces the denominator `Rank` with `√Rank` (`ΔW = (Alpha / √Rank) × B × A`) so update strength does not decay at high ranks.

Toggling `rs_lora` shifts effective scaling sharply: at Rank `32`, leaving `Alpha = 32` jumps the multiplier from `1.0` to **`√32 ≈ 5.66`**, and `Alpha = 1` jumps from `0.03125` to **`≈ 0.177`**. Always lower Alpha (for example to `1` or `4–8`) or reduce the learning rate when turning `rs_lora` on to avoid early gradient blowups or rapid overfitting. Inspect LoHa and LoKr scales in the [structure preview](matrix-preview.en-US.md), and see [Full matrices and both-factor decomposition](#full-matrix) for full-factor LoKr rules.

References: [Kohya parameter guide](https://github.com/bmaltais/kohya_ss/wiki/LoRA-training-parameters#network-alpha) · [LoRA §4.1](https://arxiv.org/html/2106.09685v2#S4.SS1) · [rsLoRA](https://arxiv.org/html/2312.03732v1)

<a name="lokr-factor"></a>
## LoKr factor

LoKr represents weight updates via the Kronecker product `ΔW = scale × (W1 ⊗ W2)`. The UI field `lokr_factor` (passed as `factor`) controls how layer dimensions are split between `W1` and `W2`, including in full-matrix mode; `Rank` (`dim`) sets the intermediate rank when factors are decomposed further.

The default `-1` chooses a near-balanced factor split automatically. On a single `2048×2048` Linear layer with full factors and balanced splitting:

| `lokr_factor` | `W1` shape | `W2` shape | Parameters in that layer |
| --- | --- | --- | --- |
| `4` | `4×4` | `512×512` | `262,160` |
| `8` | `8×8` | `256×256` | `65,600` |

Here, raising `lokr_factor` from `4` to `8` cuts parameter count fourfold. Because layers vary in shape, check total adapter size in the [structure preview](matrix-preview.en-US.md) after any change.

<a name="full-matrix"></a>
## Full matrices and both-factor decomposition

LyCORIS LoKr defaults to `full_matrix=false` and `decompose_both=false`. Turning `full_matrix` on stores both `W1` and `W2` directly as dense matrices and ignores `decompose_both`. Even with `full_matrix` off, any factor whose `Rank ≥ max(dim1, dim2) / 2` (shown as the **W2 full-storage threshold** in the structure preview) automatically switches to direct matrix storage.

| Setting combination | `W1` storage | `W2` storage |
| --- | --- | --- |
| `full_matrix` off, `decompose_both` off | Direct matrix | Low-rank below threshold; direct matrix at or above threshold |
| `full_matrix` off, `decompose_both` on | Low-rank when eligible | Low-rank below threshold; direct matrix at or above threshold |
| `full_matrix` on | Direct matrix | Direct matrix |

Once both `W1` and `W2` are stored directly, raising Rank stops adding parameters to those factors, while LyCORIS LoKr scaling still depends on `rs_lora`:

| Both factors stored as full matrices | Internal Alpha | Resulting module `scale` |
| --- | --- | --- |
| `rs_lora=false` | Set to `dim` | `1` |
| `rs_lora=true` | Set to `dim` | `√dim` |

<div id="preview"></div>

Use [Matrix structure and file size](matrix-preview.en-US.md) to inspect **Layers storing full W2** and per-layer `scale` after changing decomposition options.

<a name="unbalanced"></a>
## Unbalanced factorization

`unbalanced_factorization` defaults to off. Enabling it swaps how the split output dimensions are assigned between `W1` and `W2`, changing both factor aspect ratios. Adjust it only when testing specific compression ratios or matrix shapes, and verify both parameter count and scale in the [structure preview](matrix-preview.en-US.md).

<a name="dora-bypass"></a>
## DoRA (weight decomposition) and bypass mode

LyCORIS exposes `dora_wd` (DoRA weight decomposition) and `bypass_mode` (bypass forward pass) to control how adapter updates are applied:

- **DoRA (`dora_wd`)**: Decomposes updated weights into direction and a trainable per-output-channel magnitude (norm) by reconstructing `W + ΔW` before normalizing direction. Enabling DoRA requires **`bypass_mode` off**, and ordinary feature `dropout` is inactive on this weight-reconstruction path.
- **Bypass mode (`bypass_mode`)**: Computes adapter output on a separate branch `W(x) + ΔW(x)` without merging into base weights—required when quantized base weights cannot be reconstructed directly during forward passes.
- **Quantization and algorithm constraints**:
  - **Anima (LyCORIS)**: Linear and Conv LoCon, LoHa, and LoKr all support DoRA when `bypass_mode` is off.
  - **Krea 2 (LyCORIS)**: Enabling `DiT FP8 dynamic quantization` (`fp8_base`) or `ConvRot INT8` (`convrot_int8`) forces `bypass_mode=true`. To use DoRA on Krea 2, turn off both quantizations and `bypass_mode`, and keep ordinary `dropout = 0` on LyCORIS LoCon (positive ordinary dropout enables bypass mode).

<a name="dropout"></a>
## Network and caption dropout

Dropout randomly masks features, low-rank channels, adapter branches, or text conditioning during forward passes (default `0`; saved weight files keep all parameters). If poses or backgrounds lock in, test earlier checkpoints before tuning dropout; when adding regularization, start around **`0.05–0.1`** (`> 0.2` often slows convergence or softens subject detail).

| Dropout type and key | What is masked | Purpose and caveats |
| --- | --- | --- |
| Feature dropout `network_dropout` | Intermediate adapter activations | Reduces reliance on fixed local feature combinations |
| Rank dropout `rank_dropout` | Subset of low-rank channels | Spreads representation across channels |
| Module dropout `module_dropout` | Entire layer adapter branch | Masked layers output the unmodified base model activation for that step |
| Full-caption dropout `caption_dropout_rate` | Entire prompt (SDXL) | Mixes unconditional steps into training; `keep_tokens` does not prevent full-caption drops |
| Tag dropout `caption_tag_dropout_rate` | Individual comma-separated tags | Decouples trigger words from background/outfit tags; leading tags set by `keep_tokens` stay protected |

**Interaction with text-encoder caching**: Setting `caption_tag_dropout_rate > 0` (or `caption_dropout_rate > 0` on SDXL) requires re-encoding randomized captions every step, so the UI **automatically disables and locks `Cache text encoder outputs`**, keeping the text encoder in VRAM and increasing step time.

In Anima and SDXL LyCORIS LoKr, active dropout types also depend on the forward path (Krea 2's LyCORIS LoKr UI exposes `module_dropout` only):

| LyCORIS LoKr forward path | Ordinary feature `dropout` | `rank_dropout` | `module_dropout` |
| --- | --- | --- | --- |
| Bypass output (`bypass_mode=true`) | Active (masks branch output) | Inactive | Active |
| Weight reconstruction (`bypass_mode=false`) | Inactive | Active (masks output channels of `ΔW`) | Active |

<a name="krea-targets"></a>
## Krea 2: default targets and filtering

Krea 2 defaults to Rank / Alpha `32 / 32` across all 264 DiT Linear layers (main-block attention, MLPs, the text-fusion transformer, and projection MLPs). Text fusion runs inside the DiT while the Qwen text encoder remains frozen and cached; modulation and RMSNorm tensors are outside Linear LoRA scope.

Native LoRA and LyCORIS (LoCon, LoKr, LoHa) share the same target-layer selector:

- **All Linear (264 layers)**: Covers main blocks plus input/output, timestep, and text-fusion projections.
- **Main Attention (140 layers)**: Targets backbone attention projections only for the smallest adapter footprint.
- **Main Attention + MLP (224 layers)**: Covers core backbone blocks while omitting peripheral and text-fusion projections.
- **Custom regex**: One full-match regex per line against original Linear layer names, with **exclusions taking priority over inclusions**. For example, including `blocks\.[0-9]+\.attn\..*` selects main attention, while including `.*` and excluding `txtfusion\..*` drops text fusion. An empty match fails validation before launch.

| Krea 2 network mode | Dropout and LoRA+ support |
| --- | --- |
| Native LoRA | `rank_dropout`, `module_dropout`, and [LoRA+](lora-plus.en-US.md) |
| LyCORIS LoCon | Ordinary `dropout`, `rank_dropout`, `module_dropout`, and [LoRA+](lora-plus.en-US.md); [DoRA](#dora-bypass) requires ordinary `dropout = 0` |
| LyCORIS LoHa | `rank_dropout` and `module_dropout` |
| LyCORIS LoKr | `module_dropout` only on the current path |

Export portable presets via `training.yaml` (runtime target presets are generated automatically). Under **All Linear (264 layers)**, legacy native LoRA configurations still accept `exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']` in **Custom network arguments** (`include_patterns` only restores excluded layers); new runs should use the target selector directly and avoid passing native arguments into LyCORIS. See the [Krea 2 upstream target guide](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー).

<a name="moss-text-embedder"></a>
## MOSS text projection and refiner blocks

In MOSS-Image, `train_text_embedder` defaults to off. Enabling it adds **11 adapter modules** across the DiT text input projection and two text refiner blocks using the selected LoRA / LoHa / LoKr algorithm (expanding target layers from `252` to `263`, or `71.0 MiB → 74.4 MiB` for standard LoRA at Rank 16 in `bf16`). Because the Qwen text encoder itself remains frozen, text-encoder output caching stays available.

These 11 modules inherit the backbone learning rate by default. To assign a separate rate such as `5e-5`, add `network_reg_lrs=.*text_embedder.*=5e-5` in **Custom network arguments** (inactive with `EmoSens`, which enforces one global rate across all parameters). On Anima, see **Train LLM adapter blocks** (`train_llm_adapter`) and the [AdaLN modulation guide](adaln.en-US.md) for adapting conditioning layers without unfreezing Qwen3.
