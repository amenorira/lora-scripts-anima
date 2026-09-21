# LoRA+

> LoRA+ assigns different learning rates to the two parameter groups inside a LoRA. It changes learning speed: target features may appear sooner — but so may memorized backgrounds, poses, and compositions. It is not a quality enhancement, and it does not guarantee a better final result. Training without LoRA+ remains a complete, standard LoRA workflow.

<!-- doc-anchor: overview -->
## Quick overview

LoRA+ gives the two parameter groups in a LoRA different learning rates to adjust how quickly they learn relative to each other. In standard LoRA, `lora_down` keeps the base learning rate, while `lora_up` uses that rate multiplied by the ratio.

This may bring out target features in fewer steps without adding parameters. A ratio that is too high can also bring forward memorization of repeated backgrounds, clothing, or poses, so the best checkpoint may occur earlier.

The following example uses a base learning rate of `2e-5` to show the calculation, not to recommend a training configuration.

| Ratio | `lora_down` rate | `lora_up` rate |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

Raising the base learning rate affects both groups. Raising the LoRA+ ratio affects only the designated group. These are different adjustments.

<!-- doc-anchor: effects -->
## How LoRA+ affects different training targets

Characters, styles, clothing, and concepts use the same LoRA+ group mechanism; compare them with the same-step, best-checkpoint, and new-scenario checks in Evaluating the result.

<!-- doc-anchor: effective-lr -->
## Effective learning rates

A ratio is only meaningful in the context of its base learning rate. The trainer determines a base rate for each trained component first, then applies the ratio to that component's higher-rate group:

| Component | Preferred base rate | Used when empty |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| Text encoder | `text_encoder_lr` | `learning_rate` |

These examples show how the base rate and the ratio combine:

| Configuration | Base group | Higher-rate group |
| --- | --- | --- |
| Base LR `1e-4`, LoRA+ off | `1e-4` | `1e-4` |
| Base LR `1e-4`, ratio `2.0` | `1e-4` | `2e-4` |
| Base LR `2e-4`, ratio `2.0` | `2e-4` | `4e-4` |

When `unet_lr` or `text_encoder_lr` is set, the calculation uses that component's own rate. For example, with `learning_rate=1e-4`, `unet_lr=8e-5`, and a UNet/DiT ratio of `2.0`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Example effective UNet LoRA+ learning rates">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

Raising the global learning rate speeds up every LoRA parameter; raising the ratio speeds up only the higher-rate group. That distinction is the practical purpose of LoRA+.

<!-- doc-anchor: ratio-guidance -->
## Choosing a ratio

The ratio is a learning-rate multiplier for the higher-rate group. The number itself says nothing about quality:

| Ratio | What it means | Notes |
| --- | --- | --- |
| `1.0` | Both groups use the same rate | No LoRA+ effect |
| `2.0` | Higher-rate group gets 2× | The trainer default; a mild difference |
| `4.0` | Higher-rate group gets 4× | Check the resulting effective rate against the base |
| `8.0`–`16.0` | A much higher rate for the higher-rate group | More sensitive to base rate, stopping point, and repeated data |

The LoRA+ paper uses `16` (expressed as `2^4` in the paper) in its experiments, and the sd-scripts documentation repeats that value. That value comes from experiments on specific models and tasks; it is not a universal recommendation for character, style, or concept LoRAs. This trainer defaults to `2.0` for a milder starting difference.

<!-- doc-anchor: parameters -->
## Trainer parameters

"Enable LoRA+" is the master switch. It decides whether the ratio settings below are written to the training configuration; the toggle itself is not a training argument.

When the switch is off, ratio values kept in the UI are not written to the config, and matching `loraplus_*` entries in the advanced custom network arguments are ignored. The UI and backend validation therefore always use the same set of values.

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

The global ratio, used by UNet/DiT and the text encoder when no component-specific ratio is set. The UI default is `2.0`; the minimum is `1.0`. The UI steps by `0.5`; finer values can be set via custom `network_args`.

```toml
loraplus_lr_ratio = 2.0
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

Applies the ratio override only to the main UNet. The Anima training path keeps the sd-scripts `unet` parameter name even though it refers to the main DiT network.

```toml
loraplus_unet_lr_ratio = 2.0
```

This parameter has no effect when only the text encoder is trained. The value is still written to the training configuration, but no UNet/DiT parameters are trained, so it does not affect the run.

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

Overrides the ratio for text-encoder LoRA parameters only.

```toml
loraplus_text_encoder_lr_ratio = 2.0
```

This parameter has no effect when the text encoder is not trained, when "Train UNet only" is enabled, or when caching prevents text-encoder training. A higher text-encoder ratio can make the trigger respond clearly sooner, but it can also make the model depend on that trigger earlier and weaken control from the rest of the prompt.

Each component uses its own ratio when one is set. Otherwise, it inherits the global LoRA+ ratio. A component with neither ratio set does not use LoRA+.

| Component | Preferred setting | Fallback |
| --- | --- | --- |
| Backbone | Backbone LoRA+ ratio | Global LoRA+ ratio |
| Text encoder | Text encoder LoRA+ ratio | Global LoRA+ ratio |

<!-- doc-anchor: good-cases -->
## When LoRA+ is worth trying

Use LoRA+ as a one-variable comparison when a baseline still underlearns within the expected budget, or when the overall rate is unstable but only one LoRA group should be changed. An ordinary run is the baseline; without one, no ratio should be treated as mandatory.

<!-- doc-anchor: cautions -->
## Risks and limitations

With repeated data, a high base rate, or an internally dynamic optimizer, a high ratio can bring memorization of fixed content forward. LoRA+ does not add missing data, fix captions, or choose the stopping step; compare the saved stages of the actual run.

<!-- doc-anchor: testing -->
## Evaluating the result

Evaluate learning speed separately from final quality.

| Comparison | What it answers |
| --- | --- |
| Models saved at the same step | Whether the character, style, or concept is learned sooner |
| The best model from each run | Whether the best attainable result improves |
| New poses, backgrounds, and unseen subjects | Whether the learned features remain flexible |

When LoRA+ only brings the best result forward, its main benefit is fewer training steps. If the target and a fixed composition are memorized earlier together, review both the ratio and the stopping point.

<!-- doc-anchor: mechanism -->
## How it works

Standard LoRA represents a layer’s weight change using two smaller matrices. `lora_down` projects the input to rank dimensions, and `lora_up` projects it to the layer’s output dimension. The input and output dimensions do not have to match.

For a layer with 2048 input features, 8192 output features, and rank 32, the LoRA branch is:

```text
2048 input features → lora_down → 32 features → lora_up → 8192 output features
```

The weight change is `ΔW = (Alpha / rank) × B × A`, where A is `lora_down` and B is `lora_up`. The branch produces the original layer’s required output dimension; it does not necessarily return to the input dimension.

In the current sd-scripts implementation, `lora_down` is initialized with random values and `lora_up` starts at zero. On the first backward pass, `lora_down` receives a zero gradient because `lora_up` is still zero; once `lora_up` is updated, `lora_down` begins receiving a nonzero gradient. The two matrices therefore have different update dynamics early in training.

Standard LoRA training usually gives both parameter groups the same learning rate. LoRA+ keeps the base rate for `lora_down` and raises the rate for `lora_up`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ learning-rate equations">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

The ratio changes the size of each update, not the moment a parameter starts updating. At `1.0`, both groups still use the same rate.

<!-- doc-anchor: optimizer-compatibility -->
## Optimizers and schedulers

| Optimizer | LoRA+ status | Notes |
| --- | --- | --- |
| AdamW, AdamW8bit, PagedAdamW8bit | Supported | Preserve separate per-group learning rates, so the ratio is easy to interpret |
| Lion, Lion8bit, PagedLion8bit | Supported | Preserve separate per-group learning rates |
| CAME | Supported | Preserves separate per-group learning rates |
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

The trainer only provides the LoRA+ toggle for certain native network modules — those in which the current sd-scripts implementation defines LoRA+ parameter groups:

| Network module | Higher-rate parameter | Notes |
| --- | --- | --- |
| `networks.lora` | `lora_up` | Standard LoRA+ grouping |
| `networks.lora_anima` | `lora_up` | Standard LoRA+ grouping for Anima |
| `networks.loha` | `hada_w2_a` | The sd-scripts extension for LoHa |
| `networks.lokr` | `lokr_w1` | The sd-scripts extension for LoKr |
| `lycoris.kohya` (LoCon / algo `lora` only) | `lora_up` et al. | The LyCORIS adapter groups by the parameter name `lora_up`; the other LyCORIS algorithms (LoHa/LoKr, …) do not match that grouping, so the ratio has no effect |

With `lycoris.kohya`, the toggle appears only when the algorithm is LoCon (`lora`); other LyCORIS algorithms neither show it nor use the ratio. LoHa and LoKr support means sd-scripts can assign a higher rate to those parameters; the LoRA+ paper reports no experiments on these decompositions. Krea 2 (`networks.lora_krea2`, the musubi-tuner path) does not offer the LoRA+ toggle.

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

For ordinary optimizers, the base and plus learning-rate curves in TensorBoard help verify the ratio. With internally adaptive or Schedule-Free optimizers, the logged group rate may not fully describe the actual update magnitude. Consider the optimizer-specific metrics and generated samples as well.

<!-- doc-anchor: faq -->
## Frequently asked questions

**The result got worse or overfitting appeared earlier after enabling LoRA+. What should I do?**

Disable LoRA+ or lower the ratio back to `1.0` first and check whether the problem disappears. Then review the base learning rate, dataset repetition, and stopping point. The ratio only scales one parameter group's learning rate; it cannot determine final quality on its own.

**What ratio should I use?**

`2.0` is the trainer default and a relatively mild starting point. The paper's experiments use `16` (expressed as `2^4` in the paper), but that value comes from specific models and tasks and is not a universal recommendation for character, style, or concept LoRAs.

**How do I confirm that LoRA+ is actually active?**

With LoRA+ enabled, TensorBoard shows two curves per component, such as `lr/unet` and `lr/unet plus`. With a conventional optimizer, the ratio between the two curves should be close to the configured ratio.

**Why did the trainer disable LoRA+ automatically?**

See the Optimizers and schedulers compatibility table. The UI disables LoRA+ and shows the reason, and the backend rejects unsupported combinations.

**Does LoRA+ still help when only the text encoder is trained?**

It helps for the text encoder only: `loraplus_text_encoder_lr_ratio` applies, while `loraplus_unet_lr_ratio` has no UNet/DiT parameters being trained and therefore has no effect.

<!-- doc-anchor: references -->
## Evidence and references

Fact-checked on **2026-08-14**. Code links below are pinned to the reviewed revisions. The vendor sync of 2026-08-07 (commit `37a1cbb`) has been re-reviewed; the conclusions above are unchanged.

**Implementation facts:** The ratio parameters, component fallback order, initialization behavior, and TensorBoard group names reflect the actual implementation in this project's vendored sd-scripts fork (`networks/lora.py`, `networks/lora_anima.py`, `networks/network_base.py`).

**Paper and upstream evidence:** [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354) by Hayou et al. presents the theoretical motivation and experiments for using different learning rates for the two LoRA matrices. The paper expresses its recommended ratio as `2^4` (that is, `16`). The sd-scripts `train_network_advanced.md` repeats that value and documents `loraplus_lr_ratio`, component-specific ratios, and optimizer restrictions; `loha_lokr.md` documents the higher-rate parameter mappings for LoHa and LoKr. Note that the arXiv page may be updated by later revisions; the `16` ratio refers to the paper's original wording.

**Experience requiring local validation:** The suggestion that LoRA+ may help identity or style appear sooner, and the risk tendencies of higher ratios, are engineering observations that should be verified with a fixed-condition comparison.

References:

- [This project's sd-scripts fork: `train_network_advanced.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [This project's sd-scripts fork: `loha_lokr.md` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
