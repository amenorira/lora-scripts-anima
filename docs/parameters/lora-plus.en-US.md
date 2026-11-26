<a name="guide-title"></a>
# LoRA+

> LoRA+ assigns different learning rates to the adapter's two low-rank parameter groups without changing parameter count or file size. It defaults to off, and uses a default ratio of `2.0` when enabled.

Supported across eligible networks on SDXL, Anima, and MOSS-Image plus native LoRA and LyCORIS LoCon on Krea 2; check [supported network modules](#support) and [optimizer compatibility](#optimizer-compatibility) before enabling.

<a name="overview"></a>
## Overview, when to use, and ratio guide

<div id="mechanism"></div>

Standard LoRA expresses each layer's weight update as `ΔW = (Alpha / Rank) × B × A`, initializing `lora_down` (`A`) randomly to project inputs down to Rank dimensions and `lora_up` (`B`) to zero to project back to the output size. Because `lora_up` starts at zero, `lora_down` receives zero gradient on the first step, giving the two factors asymmetric early update dynamics. LoRA+ keeps `lora_down` at the base learning rate and multiplies `lora_up` (or the mapped factor in native LoHa / LoKr) by `ratio`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ learning-rate equations">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

With a base learning rate of `2e-5` (raising the base rate scales both groups together, whereas raising `ratio` accelerates `lora_up` alone):

| Ratio | `lora_down` rate | `lora_up` rate |
| --- | --- | --- |
| `1.0` (equal-rate baseline) | `2e-5` | `2e-5` |
| `2.0` (default starting point) | `2e-5` | `4e-5` |
| `4.0` | `2e-5` | `8e-5` |

<div id="good-cases"></div>
<div id="ratio-guidance"></div>

- **When to enable**: Try LoRA+ when facial identity, outfit details, or brushwork converge slowly at a safe base learning rate (such as `2e-5–1e-4`), and raising the global learning rate degrades base-model structure or causes artifacts.
- **Recommended ratio (`2.0–4.0`)**: Compare the default `2.0` against an equal-rate (`1.0`) baseline with the same base learning rate and seed. Krea 2 also accepts positive ratios in `0.01–1.0` when you want `lora_up` below the base rate.
- **Avoid extreme ratios such as `16` at typical LoRA rates**: The paper and `sd-scripts` examples tested `16` on language models or tiny base learning rates (`~1e-5`). At standard image LoRA rates (`5e-5–1e-4`), `16×` pushes `lora_up` to `8e-4–1.6e-3`, frequently causing early color blowout, locked poses/backgrounds, or weaker response to non-trigger prompt tokens.

<a name="parameters"></a>
## Trainer parameters and effective learning rates

When **Enable LoRA+** is off, no ratios are exported. When on, the dedicated form fields take priority (for SDXL, Anima, and MOSS-Image, duplicate `loraplus_*` entries in **Custom network arguments** are stripped automatically; Krea 2 migrates legacy global ratios into the form field on import). Krea 2 exposes only the global ratio—when enabling LoRA+ there, set Rank and Alpha manually and turn off **Infer LoRA rank from existing weights**.

<a name="loraplus-lr-ratio"></a>
### `loraplus_lr_ratio`

Global ratio (default `2.0`), inherited whenever component-specific ratios are left blank.

| Model type | UI minimum | Step |
| --- | --- | --- |
| SDXL, Anima, MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<a name="loraplus-unet-lr-ratio"></a>
### `loraplus_unet_lr_ratio`

Overrides the UNet / DiT backbone ratio on the `sd-scripts` path, falling back to `loraplus_lr_ratio` when empty (Anima and MOSS-Image retain the `unet` parameter name for their DiT backbone). Inactive when training only the text encoder.

<a name="loraplus-text-encoder-lr-ratio"></a>
### `loraplus_text_encoder_lr_ratio`

Overrides the text-encoder LoRA ratio on the `sd-scripts` path, falling back to `loraplus_lr_ratio` when empty. Active only when the text encoder is trained—**Train UNet only** / **Train DiT only** and **Cache text encoder outputs** leave it inactive, and MOSS-Image and Krea 2 keep their text encoders frozen. Check both trigger strength and prompt flexibility after changing it.

<a name="effective-lr"></a>
### Ratio fallback and effective learning rate

The `sd-scripts` path resolves each component's base learning rate first (`unet_lr` / `text_encoder_lr`, falling back to `learning_rate`; Krea 2 uses `learning_rate` directly for the DiT) and then applies **component ratio → global ratio**:

| Component | Base learning-rate source | Ratio precedence |
| --- | --- | --- |
| UNet / DiT backbone | `unet_lr` (falls back to `learning_rate`) | `loraplus_unet_lr_ratio` → `loraplus_lr_ratio` |
| Text encoder | `text_encoder_lr` (falls back to `learning_rate`) | `loraplus_text_encoder_lr_ratio` → `loraplus_lr_ratio` |

Presets downloaded from the app use YAML, while generated `sd-scripts` runtime TOML combines active ratios into one `network_args` list:

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

For example, with `learning_rate=1e-4`, `unet_lr=8e-5`, and a backbone ratio of `2.0`, the backbone scales from its own `8e-5` base rate:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Example effective UNet LoRA+ learning rates">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<a name="optimizer-compatibility"></a>
## Optimizer compatibility and supported networks

Selecting an incompatible optimizer or adaptive mode automatically disables LoRA+ in the UI with an explanation, and backend validation rejects conflicting presets or API payloads:

| Optimizer | LoRA+ status | Notes |
| --- | --- | --- |
| AdamW, AdamW8bit, PagedAdamW8bit | Supported | Preserve independent per-group learning rates |
| Lion, Lion8bit, PagedLion8bit, CAME | Supported | Preserve independent per-group learning rates |
| StableAdamW, Muon, Adan, AdEMAMix, AdEMAMix8bit, SOAP | Supported | Preserve independent per-group learning rates |
| AdamWScheduleFree | Supported | Preserves parameter groups while internal scheduling adjusts effective step scale |
| Automagic3 / Automagic4 | Conditional | Every group's initial rate (including the scaled `plus` group) must lie within `min_lr`–`max_lr`; groups adapt independently during training |
| AdaFactor | Manual-LR mode only | Both `relative_step` and `warmup_init` must be off; default relative-step mode ignores per-group rates, so the UI locks LoRA+ off |
| Prodigy, ProdigyPlusScheduleFree | Unsupported | Per-group ratios are not preserved reliably; both UI and backend block this combination across all model types (including Krea 2) |
| EmoSens | Unsupported | Applies one global `emoPulse` and resets all parameter groups to the same rate every step |
| LoRA-Muon, LoRA-RITE | Unsupported | Paired-factor joint updates require intact low-rank factor pairs and cannot split `lora_down` and `lora_up` into separate groups |

Watch upper bounds with Automagic: a starting rate of `2e-5` with a ratio of `12` puts the `plus` group at `2.4e-4`, exceeding the default `max_lr` (`2e-4`)—lower the ratio or raise `max_lr` before launching. Conventional external schedulers and warmup scale all parameter groups by the same factor, keeping the configured ratio intact.

<a name="support"></a>
### Supported network modules

| Network module | Scaled parameter group | Scope and notes |
| --- | --- | --- |
| `networks.lora` | `lora_up` | Standard SDXL LoRA |
| `networks.lora_anima` | `lora_up` | Native Anima LoRA |
| `networks.lora_generic` | `lora_up` | Native MOSS-Image LoRA |
| `networks.lora_krea2` | `lora_up` | Native Krea 2 LoRA |
| `networks.loha` | `hada_w2_a` | `sd-scripts` LoHa group mapping |
| `networks.lokr` | `lokr_w1` | `sd-scripts` LoKr group mapping |
| `lycoris.kohya` (LoCon / `lora` only) | `lora_up` et al. | LyCORIS supports LoRA+ only in LoCon mode on Anima and Krea 2 |

<a name="testing"></a>
## Evaluation, TensorBoard checks, and troubleshooting

<div id="cautions"></div>
<div id="effects"></div>

Save checkpoints at shorter intervals when testing ratios above `2.0`, separating faster convergence from peak quality:

| Comparison | Question answered |
| --- | --- |
| Checkpoints saved at the same step | Did the character, style, or concept converge earlier? |
| Best checkpoint from each run | Did peak attainable image quality improve, or merely arrive sooner? |
| Novel poses, backgrounds, and unseen subjects | Did faster convergence lock in training compositions or weaken prompt control? |

<div id="faq"></div>

If overfitting appears earlier or colors look overcooked, inspect earlier checkpoints first, or step the ratio back toward `1.0–2.0` while checking base learning rate and dataset repeats.

<a name="tensorboard"></a>
### Verifying in TensorBoard

When TensorBoard logging is enabled, `plus` identifies the parameter group receiving the LoRA+ multiplier:

- **SDXL (backbone + text encoder)**: Logs `lr/unet`, `lr/unet plus`, `lr/textencoder`, and `lr/textencoder plus`.
- **Krea 2 / DiT-only runs**: Logs `lr/unet` and `lr/unet plus`.
- **Anima (with text encoder trained)**: Numbers text-encoder groups as `lr/textencoder 1` and `lr/textencoder 1 plus` (block-wise learning rates add further curves).

With standard optimizers, confirm that `plus / base` equals your configured ratio wherever the learning rate is nonzero; internally adaptive optimizers evolve each group's curve independently, so evaluate them alongside sample generations.

<div id="references"></div>

References: [LoRA+ paper (arXiv:2402.12354)](https://arxiv.org/abs/2402.12354) · [sd-scripts `train_network_advanced.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md) · [sd-scripts `loha_lokr.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
