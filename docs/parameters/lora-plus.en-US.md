# LoRA+

> LoRA+ sets different learning rates for the adapter's two parameter groups while keeping the parameter count unchanged. It is off by default; when enabled, the default ratio is `2.0`.

It supports eligible networks for SDXL, Anima, and MOSS-Image, plus native LoRA and LyCORIS LoCon for Krea 2. See Supported network modules for grouping and the optimizer table for compatibility.

<!-- doc-anchor: overview -->
## Quick overview

In standard LoRA, `lora_down` keeps the base learning rate, while `lora_up` uses that rate multiplied by the ratio.

At `1.0`, both groups use the same learning rate. Krea 2 also accepts positive ratios below `1`, which give `lora_up` a lower learning rate than the base.

For a base learning rate of `2e-5`:

| Ratio | `lora_down` rate | `lora_up` rate |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

Raising the base learning rate affects both groups. Raising the LoRA+ ratio affects only the designated group.

<!-- doc-anchor: good-cases -->
## When LoRA+ is worth trying

After establishing a baseline without LoRA+, keep the base learning rate and other settings fixed and compare ratios `1` and `2`. Record results at matching steps and the step of each run's best result.

<!-- doc-anchor: ratio-guidance -->
## Choosing a ratio

Compare the default ratio `2.0` with the equal-rate baseline `1.0`. Keep the base learning rate fixed when testing other ratios, and calculate the scaled rate as in the example above.

The paper and sd-scripts documentation use `16` in their experiments; this trainer defaults to `2.0`. Compare those ratios together with their respective base learning rates.

<!-- doc-anchor: parameters -->
## Trainer parameters

With Enable LoRA+ off, no ratios are exported. With it on, the dedicated ratio fields supply the values. For SDXL, Anima, and MOSS-Image, matching `loraplus_*` entries in custom network arguments are removed so the form values take priority. Krea 2 imports a legacy global ratio from additional arguments into the form field.

The examples below show exported training TOML. Ratios belong in `network_args`; combine multiple ratios in a single list. Krea 2 provides only the global ratio. To use LoRA+ there, configure rank and Alpha manually and turn off dimension inference from weights.

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

The global ratio defaults to `2.0`. UNet/DiT and text-encoder components inherit it when their own ratio is empty.

| Training profile | UI minimum | Step |
| --- | --- | --- |
| SDXL, Anima, MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

Overrides the UNet/DiT ratio. Defaults to empty, which inherits the global ratio. Anima and MOSS-Image retain the `unet` parameter name for their DiT backbone. This field belongs to the sd-scripts path.

Has no effect when training only the text encoder.

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

Overrides the text-encoder LoRA ratio. Defaults to empty, which inherits the global ratio.

Applies only when the text encoder is trained. UNet-only training and text-encoder output caching make it inactive. MOSS-Image and Krea 2 keep the text encoder frozen. After changing it, check trigger response and control from the rest of the prompt.

The fallback order is component ratio → global ratio → LoRA+ disabled for that component:

| Component | Preferred setting | Fallback |
| --- | --- | --- |
| Backbone | Backbone LoRA+ ratio | Global LoRA+ ratio |
| Text encoder | Text encoder LoRA+ ratio | Global LoRA+ ratio |

Example sd-scripts export with multiple ratios:

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

<!-- doc-anchor: effective-lr -->
## Effective learning rates

The sd-scripts path first determines each component's base learning rate, then applies the ratio to its designated parameter group:

| Component | Preferred base rate | Used when empty |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| Text encoder | `text_encoder_lr` | `learning_rate` |

Krea 2 uses `learning_rate` as the DiT base learning rate.

When `unet_lr` or `text_encoder_lr` is set, the calculation uses that component's own rate. For example, with `learning_rate=1e-4`, `unet_lr=8e-5`, and a UNet/DiT ratio of `2.0`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Example effective UNet LoRA+ learning rates">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## Risks and limitations

Save more frequently when comparing higher ratios. Check whether the best result occurs earlier and whether later checkpoints show fixed poses, backgrounds, or weaker prompt control.

<span id="effects"></span>

<!-- doc-anchor: testing -->
## Evaluating the result

Evaluate learning speed separately from final quality.

| Comparison | What it answers |
| --- | --- |
| Models saved at the same step | Whether the character, style, or concept is learned sooner |
| The best model from each run | Whether the best attainable result improves |
| New poses, backgrounds, and unseen subjects | Whether the learned features remain flexible |

When LoRA+ only brings the best result forward, its main benefit is fewer training steps. If the target and a fixed composition are memorized earlier together, review both the ratio and the stopping point.

<!-- doc-anchor: optimizer-compatibility -->
## Optimizers and schedulers

| Optimizer | LoRA+ status | Notes |
| --- | --- | --- |
| AdamW, AdamW8bit, PagedAdamW8bit | Supported | Preserve separate per-group learning rates |
| Lion, Lion8bit, PagedLion8bit | Supported | Preserve separate per-group learning rates |
| CAME | Supported | Preserves separate per-group learning rates |
| StableAdamW, Muon, Adan, AdEMAMix, AdEMAMix8bit, SOAP | Supported | Preserve separate per-group learning rates |
| AdamWScheduleFree | Supported | Keeps the groups, but internal adjustments change the effective rates during training |
| Automagic3 | Conditional | Both initial group rates must lie within `min_lr` and `max_lr`. Each group adapts independently, so the initial ratio is not fixed during training |
| AdaFactor | Manual-LR mode only | Both `relative_step` and `warmup_init` must be off. The default relative-step mode ignores per-group rates, so the UI disables and locks LoRA+ |
| Prodigy, ProdigyPlus | Unsupported | The current sd-scripts path cannot reliably preserve separate per-group rates; both UI and backend reject the combination |
| EmoSens | Unsupported | Updates every parameter with one global `emoPulse` and resets all groups to that rate each step, which removes the ratio |
| LoRA-Muon | Not supported | The current joint-update implementation requires complete LoRA factor pairs |
| LoRA-RITE | Not supported | Its current factor-pair handling is incompatible with LoRA+ parameter groups |

Switching to an incompatible mode turns LoRA+ off and shows the reason. Backend validation also rejects incompatible combinations from older presets or direct API calls.

This trainer's conventional external schedulers apply the same multiplier to each group, preserving the initial ratio. Warmup changes the early learning rate without changing grouping. Internally adaptive optimizers also change step size; distinguish logged group rates from actual update scales.

<!-- doc-anchor: support -->
## Supported network modules

The following network modules provide the LoRA+ toggle:

| Network module | Parameter receiving the ratio | Notes |
| --- | --- | --- |
| `networks.lora` | `lora_up` | Standard LoRA+ grouping |
| `networks.lora_anima` | `lora_up` | Standard LoRA+ grouping for Anima |
| `networks.lora_generic` | `lora_up` | Standard LoRA+ grouping for MOSS |
| `networks.lora_krea2` | `lora_up` | Native LoRA grouping for Krea 2 |
| `networks.loha` | `hada_w2_a` | The sd-scripts extension for LoHa |
| `networks.lokr` | `lokr_w1` | The sd-scripts extension for LoKr |
| `lycoris.kohya` (LoCon / algo `lora` only) | `lora_up` et al. | LoCon for Anima and Krea 2 groups by the parameter name `lora_up` |

The sd-scripts native LoHa and LoKr modules use their own group mappings. LyCORIS LoRA+ supports LoCon (`lora`) only.

<!-- doc-anchor: tensorboard -->
## TensorBoard

With LoRA+ enabled and both backbone and text encoder trained, standard SDXL LoRA records these group names:

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Krea 2 trains only the DiT and records `lr/unet` and `lr/unet plus` with LoRA+ enabled.

Anima numbers its text-encoder groups. Training that component records:

```text
lr/textencoder 1
lr/textencoder 1 plus
```

`plus` marks the group receiving the ratio. Block learning rates or other multi-group configurations add more names and curves. See the FAQ below for ratio checks.

<!-- doc-anchor: mechanism -->
## How it works

Standard LoRA represents a layer’s weight change using two smaller matrices. `lora_down` projects the input to rank dimensions, and `lora_up` projects it to the layer’s output dimension.

For a layer with 2048 input features, 8192 output features, and rank 32, the LoRA branch is:

```text
2048 input features → lora_down → 32 features → lora_up → 8192 output features
```

The weight change is `ΔW = (Alpha / rank) × B × A`, where A is `lora_down` and B is `lora_up`.

In the current sd-scripts implementation, `lora_down` is initialized with random values and `lora_up` starts at zero. On the first backward pass, `lora_down` receives a zero gradient because `lora_up` is still zero; once `lora_up` is updated, `lora_down` begins receiving a nonzero gradient. The two matrices therefore have different update dynamics early in training.

Without LoRA+, both groups use the same learning rate. With it enabled, `lora_down` keeps the base rate and `lora_up` multiplies it by the chosen ratio:

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ learning-rate equations">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

<!-- doc-anchor: faq -->
## Frequently asked questions

**The result got worse or overfitting appeared earlier after enabling LoRA+. What should I do?**

Disable LoRA+ or lower the ratio to `1.0`, then check the base learning rate, repeated data, and stopping point.

**How do I confirm that LoRA+ is actually active?**

When TensorBoard logging is enabled, inspect the base and plus curves for components being trained, such as `lr/unet` and `lr/unet plus`. With a conventional optimizer and both groups active, their ratio should match the configured ratio wherever the learning rate is nonzero. Adaptive group rates change with each group's state; inspect each curve alongside dedicated metrics and generated results.

<!-- doc-anchor: references -->
## Evidence and references

The sd-scripts configuration path is defined in `backend/training/config/adapter.py`; Krea 2 ratios and network restrictions are in `krea2_network.py` and `krea2_optimizers.py`. Optimizer compatibility is in `optimizer_contracts.py`. Grouping, initialization, and log names are implemented in the vendored `networks/lora.py`, `lora_anima.py`, and `network_base.py`. The links below point to fixed revisions:

- [This project's sd-scripts fork: `train_network_advanced.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [This project's sd-scripts fork: `loha_lokr.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
