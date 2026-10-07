# LoRA+

> LoRA+ raises the learning rate of a selected parameter group to speed up learning without adding parameters. It is off by default. Start comparisons at the default ratio of `2.0`, and check whether the best checkpoint occurs earlier.

<!-- doc-anchor: overview -->
## Quick overview

LoRA+ gives the two parameter groups in a LoRA different learning rates to adjust how quickly they learn relative to each other. In standard LoRA, `lora_down` keeps the base learning rate, while `lora_up` uses that rate multiplied by the ratio.

Higher ratios widen the gap between the two learning rates; `1.0` gives both groups the same rate. Excessive ratios can bring forward memorization of repeated backgrounds, clothing, or poses.

For a base learning rate of `2e-5`:

| Ratio | `lora_down` rate | `lora_up` rate |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

Raising the base learning rate affects both groups. Raising the LoRA+ ratio affects only the designated group. These are different adjustments.

<!-- doc-anchor: good-cases -->
## When LoRA+ is worth trying

Test LoRA+ when a baseline run is stable but learns target features slowly. If loss already spikes, lower the base learning rate before comparing ratios.

<!-- doc-anchor: effects -->
## How LoRA+ affects different training targets

Characters, styles, clothing, and concepts use the same grouping. Check how soon target features appear and how well they work in new poses and backgrounds. If fixed compositions appear earlier too, lower the ratio or stop sooner.

<!-- doc-anchor: ratio-guidance -->
## Choosing a ratio

Start at `2.0`. Compare `4.0` if learning remains slow; lower the ratio if overfitting appears earlier.

| Ratio | What it means | Notes |
| --- | --- | --- |
| `1.0` | Both groups use the same rate | No LoRA+ effect |
| `2.0` | Higher-rate group gets 2× | The trainer default; a mild difference |
| `4.0` | Higher-rate group gets 4× | Check the resulting effective rate against the base |
| `8.0`–`16.0` | A much higher rate for the higher-rate group | More sensitive to base rate, stopping point, and repeated data |

The ratio of `16` in the paper and sd-scripts documentation comes from specific experiments. This trainer uses `2.0` as a milder starting point.

<!-- doc-anchor: parameters -->
## Trainer parameters

"Enable LoRA+" is the master switch. It decides whether the ratio settings below are written to the training configuration; the toggle itself is not a training argument.

With the switch off, no ratios are exported. With it on, only the dedicated ratio fields are used. Matching `loraplus_*` entries in custom network arguments are removed and cannot override those fields.

The examples below show exported training TOML. Ratios belong in `network_args`; combine multiple ratios in a single list. In the UI, use the dedicated ratio fields.

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

The global ratio, inherited by components without their own ratio. Defaults to `2.0`, with a UI minimum of `1.0` and a step of `0.5`.

```toml
network_args = ["loraplus_lr_ratio=2.0"]
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

Overrides the UNet/DiT ratio. Defaults to empty, which inherits the global ratio. Anima retains the `unet` parameter name for its DiT backbone.

```toml
network_args = ["loraplus_unet_lr_ratio=2.0"]
```

Has no effect when training only the text encoder.

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

Overrides the text-encoder LoRA ratio. Defaults to empty, which inherits the global ratio.

```toml
network_args = ["loraplus_text_encoder_lr_ratio=2.0"]
```

Applies only when the text encoder is trained. UNet-only training and text-encoder output caching make it inactive. After changing it, check trigger response and control from the rest of the prompt.

A component with neither ratio set does not use LoRA+.

| Component | Preferred setting | Fallback |
| --- | --- | --- |
| Backbone | Backbone LoRA+ ratio | Global LoRA+ ratio |
| Text encoder | Text encoder LoRA+ ratio | Global LoRA+ ratio |

<!-- doc-anchor: effective-lr -->
## Effective learning rates

A ratio is only meaningful in the context of its base learning rate. The trainer determines a base rate for each trained component first, then applies the ratio to that component's higher-rate group:

| Component | Preferred base rate | Used when empty |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| Text encoder | `text_encoder_lr` | `learning_rate` |

When `unet_lr` or `text_encoder_lr` is set, the calculation uses that component's own rate. For example, with `learning_rate=1e-4`, `unet_lr=8e-5`, and a UNet/DiT ratio of `2.0`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Example effective UNet LoRA+ learning rates">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## Risks and limitations

Combining a high base rate with a high ratio amplifies updates and increases the risk of early memorization. Save more frequently when testing higher ratios so earlier checkpoints remain available for comparison.

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
| AdamW, AdamW8bit, PagedAdamW8bit | Supported | Preserve separate per-group learning rates, so the ratio is easy to interpret |
| Lion, Lion8bit, PagedLion8bit | Supported | Preserve separate per-group learning rates |
| CAME | Supported | Preserves separate per-group learning rates |
| StableAdamW, Muon, Adan, AdEMAMix, AdEMAMix8bit, SOAP | Supported | Preserve separate per-group learning rates |
| AdamWScheduleFree | Supported | Keeps the groups, but internal adjustments change the effective rates during training |
| Automagic3 | Conditional | "Base LR × ratio" must stay within `min_lr` and `max_lr`; adaptive behavior can change the effective ratio |
| AdaFactor | Manual-LR mode only | Both `relative_step` and `warmup_init` must be off. The default relative-step mode ignores per-group rates, so the UI disables and locks LoRA+ |
| Prodigy, ProdigyPlus | Unsupported | The current sd-scripts path cannot reliably preserve separate per-group rates; both UI and backend reject the combination |
| EmoSens | Unsupported | Updates every parameter with one global `emoPulse` and resets all groups to that rate each step, which removes the ratio |
| LoRA-Muon | Not supported | The current joint-update implementation requires complete LoRA factor pairs |
| LoRA-RITE | Not supported | Its current factor-pair handling is incompatible with LoRA+ parameter groups |

Switching to an incompatible mode turns LoRA+ off and shows the reason. Backend validation also rejects incompatible combinations from older presets or direct API calls.

With a conventional scheduler, groups normally change by the same proportion and the initial ratio survives. Warmup shapes the overall rate at the start of training; it is not a ratio. For internally adaptive optimizers such as Schedule-Free and Automagic3, rely on the curves recorded during training.

<!-- doc-anchor: support -->
## Supported network modules

The following network modules provide the LoRA+ toggle:

| Network module | Higher-rate parameter | Notes |
| --- | --- | --- |
| `networks.lora` | `lora_up` | Standard LoRA+ grouping |
| `networks.lora_anima` | `lora_up` | Standard LoRA+ grouping for Anima |
| `networks.loha` | `hada_w2_a` | The sd-scripts extension for LoHa |
| `networks.lokr` | `lokr_w1` | The sd-scripts extension for LoKr |
| `lycoris.kohya` (LoCon / algo `lora` only) | `lora_up` et al. | The LyCORIS adapter groups by the parameter name `lora_up`; the other LyCORIS algorithms (LoHa/LoKr, …) do not match that grouping, so the ratio has no effect |

Native LoHa and LoKr use their own group mappings. LyCORIS supports LoCon (`lora`) only. Krea 2 (`networks.lora_krea2`, the musubi-tuner path) does not offer LoRA+.

<!-- doc-anchor: tensorboard -->
## TensorBoard

With LoRA+ enabled, sd-scripts records the base and higher-rate groups separately. A standard SDXL LoRA commonly produces:

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

The Anima text encoder is numbered and commonly produces:

```text
lr/textencoder 1
lr/textencoder 1 plus
```

`plus` marks the higher-rate group. Block learning rates or other multi-group configurations add more names and curves.

For ordinary optimizers, compare the two curves to verify the ratio. Adaptive and Schedule-Free optimizers also scale updates internally; check their dedicated metrics and generated samples.

<!-- doc-anchor: mechanism -->
## How it works

Standard LoRA represents a layer’s weight change using two smaller matrices. `lora_down` projects the input to rank dimensions, and `lora_up` projects it to the layer’s output dimension.

For a layer with 2048 input features, 8192 output features, and rank 32, the LoRA branch is:

```text
2048 input features → lora_down → 32 features → lora_up → 8192 output features
```

The weight change is `ΔW = (Alpha / rank) × B × A`, where A is `lora_down` and B is `lora_up`.

In the current sd-scripts implementation, `lora_down` is initialized with random values and `lora_up` starts at zero. On the first backward pass, `lora_down` receives a zero gradient because `lora_up` is still zero; once `lora_up` is updated, `lora_down` begins receiving a nonzero gradient. The two matrices therefore have different update dynamics early in training.

Standard LoRA training usually gives both parameter groups the same learning rate. LoRA+ keeps the base rate for `lora_down` and raises the rate for `lora_up`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ learning-rate equations">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

The ratio changes the size of each update, not the moment a parameter starts updating. At `1.0`, both groups still use the same rate.

<!-- doc-anchor: faq -->
## Frequently asked questions

**The result got worse or overfitting appeared earlier after enabling LoRA+. What should I do?**

Disable LoRA+ or lower the ratio to `1.0`, then check the base learning rate, repeated data, and stopping point.

**How do I confirm that LoRA+ is actually active?**

With LoRA+ enabled, TensorBoard shows two curves per component, such as `lr/unet` and `lr/unet plus`. With a conventional optimizer, the ratio between the two curves should be close to the configured ratio.

**Why did the trainer disable LoRA+ automatically?**

See the Optimizers and schedulers compatibility table. The UI disables LoRA+ and shows the reason, and the backend rejects unsupported combinations.

**Does LoRA+ still help when only the text encoder is trained?**

It applies to the text encoder only. The text-encoder ratio takes priority; an empty field inherits the global ratio.

<!-- doc-anchor: references -->
## Evidence and references

Configuration handling and compatibility are defined in `backend/training/adapter.py` and `optimizer_contracts.py`. Grouping, initialization, and log names are implemented in the vendored `networks/lora.py`, `lora_anima.py`, and `network_base.py`. The pinned links below provide implementation references:

- [This project's sd-scripts fork: `train_network_advanced.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [This project's sd-scripts fork: `loha_lokr.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
