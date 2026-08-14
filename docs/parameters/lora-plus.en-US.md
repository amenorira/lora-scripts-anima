# LoRA+

> LoRA+ assigns different learning rates to the two parameter groups inside a LoRA. It changes learning speed: target features may appear sooner — but so may memorized backgrounds, poses, and compositions. It is not a quality enhancement, and it does not guarantee a better final result. Training without LoRA+ remains a complete, standard LoRA workflow.

<!-- doc-anchor: overview -->
## Quick overview

A standard LoRA consists of two matrices that work together: one projects the input into a lower-dimensional space, and the other projects it back to the original dimension. Ordinary training gives both groups the same learning rate. LoRA+ keeps the base rate for one group and multiplies the other group's rate by a fixed ratio.

For example, with a base learning rate of `1e-4` and a ratio of `2.0`:

- The base group continues to use `1e-4`.
- The higher-rate group uses `2e-4`.
- The base model, the number of LoRA parameters, and the exported file format do not change.

So LoRA+ changes how quickly the model learns, not what it can learn. The dataset and captions determine which content the model sees repeatedly. LoRA+ may make the intended feature appear sooner, but it can also make repeated backgrounds, poses, and compositions easier to memorize.

<!-- doc-anchor: effects -->
## How LoRA+ affects different training targets

The learning-rate mechanism is the same for every target, but the observations worth checking differ:

| Training target | Possible change | Also check |
| --- | --- | --- |
| Character LoRA | Face, hair, or identity features may stabilize earlier | Whether outfits stay replaceable and whether backgrounds or poses become tied to the character |
| Style LoRA | Color, line, and shape characteristics may appear earlier | Whether the style transfers to new characters, objects, and compositions |
| Garment or object LoRA | The target appearance may become clear in earlier checkpoints | Whether it combines with different characters, poses, and scenes |
| Trigger-based concept | The trigger may respond clearly sooner | Whether the rest of the prompt still controls the result |

The number of images alone does not determine whether LoRA+ is appropriate. What matters more is how many effectively independent images the dataset has and how varied they are:

- A small character set can memorize identity, outfit, background, and pose together. LoRA+ may bring all of them out sooner.
- A larger set with varied views, poses, and backgrounds makes it easier to tell whether LoRA+ changed learning speed or final generalization.
- A large collection of near-duplicates carries risks similar to a small dataset.
- `repeats` increases how often each image is used; it does not add new views, poses, or compositions.

The rest of the training configuration also shapes the outcome:

- **Base learning rate** is the starting point that the ratio multiplies. The same `2.0` ratio means something very different at `1e-4` than at `2e-4`.
- **Training steps** determine how many updates happen. LoRA+ can move both the best checkpoint and the onset of overfitting earlier.
- **Rank** controls LoRA capacity, not learning speed. If a high-rank LoRA underfits, check learning rate, steps, and captions before reaching for LoRA+.
- **Alpha** scales the weight update. A ratio that worked before an alpha change may no longer be appropriate.
- **Dataset and captions** decide which content gets reinforced. LoRA+ cannot add missing data or fix a bad trigger or inaccurate captions.

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

The precedence is:

| Component | Ratio used |
| --- | --- |
| UNet/DiT | `loraplus_unet_lr_ratio`, falling back to `loraplus_lr_ratio` when empty |
| Text encoder | `loraplus_text_encoder_lr_ratio`, falling back to `loraplus_lr_ratio` when empty |

With an empty global ratio, setting a ratio on a single component limits LoRA+ to that component. LoRA+ requires at least one ratio while enabled. A component whose specific ratio and the global ratio are both empty does not use LoRA+.

<!-- doc-anchor: good-cases -->
## When LoRA+ is worth trying

Whether LoRA+ is worth using depends on your current training results. It is worth comparing when:

- Character identity, style, or the target concept remains clearly underfit within the intended step budget.
- Raising the global learning rate damages detail or causes instability, but only part of the LoRA needs faster updates.
- Training time or total steps are limited, and earlier usable checkpoints matter.
- A run without LoRA+ already exists as a comparison for learning speed and final quality.

When a standard LoRA already stabilizes within the intended budget, LoRA+ usually has little to add. Its availability doesn't mean every configuration benefits from it.

<!-- doc-anchor: cautions -->
## Risks and limitations

A higher ratio is more likely to accelerate overfitting when:

- The dataset is very small, or many images share the same background, pose, and composition.
- The collection has many files but consists of video frames, duplicate crops, or near-identical images.
- The base learning rate is already high, so the multiplied effective rate becomes excessive.
- Secondary characters, watermarks, effects, or undescribed elements recur throughout the data.
- The current run already shows rigid composition, background binding, or weaker prompt control.
- The optimizer manages learning rates internally, so the effective ratio changes during training.

LoRA+ cannot compensate for insufficient model capacity, missing data, or inaccurate captions, nor does it tell you when to stop. A higher ratio can move both the best checkpoint and overfitting earlier, so the previous stopping point may no longer be right.

<!-- doc-anchor: testing -->
## Evaluating the result

Compare from two angles:

| Comparison | What it shows |
| --- | --- |
| Checkpoints at the same step | Whether LoRA+ changed learning speed |
| The best checkpoint of each configuration | Whether LoRA+ improved the best result actually obtained |

A meaningful comparison holds the dataset, training seed, rank, alpha, base learning rates, optimizer, scheduler, and total steps constant, varying only the LoRA+ toggle or a single ratio. Previewing with the same generation seeds and prompts reduces random variation.

Useful observations by target:

- **Character LoRA:** identity consistency, outfit replacement, and recognition in new backgrounds and poses.
- **Style LoRA:** transfer to subjects and compositions absent from the training set, not just reproduction of the training images.
- **Garment or object LoRA:** combination with different characters, poses, and scenes.
- **Trigger-based concept:** a clear trigger response while the other character, action, and environment terms still work.

If a higher ratio only makes the best result appear earlier while quality stays similar, its main benefit is fewer steps to that result. If background binding, repeated composition, or weaker prompt control also appears earlier, evaluate the ratio, base rate, repeated data, and stopping point together.

Loss helps identify anomalies and trends, but it cannot measure identity fidelity, style transfer, or prompt control by itself.

<!-- doc-anchor: mechanism -->
## How it works

A standard LoRA does not change the original model weights directly. It represents the weight update with two low-rank matrices. In sd-scripts terminology, `lora_down` projects the input into a lower-dimensional space and `lora_up` projects it back to the original dimension:

<div class="doc-equation" role="group" aria-label="Standard LoRA weight update equation">
  <div class="doc-equation-expression"><span class="doc-math-var">ΔW</span> = <span class="doc-frac"><span><span class="doc-math-var">α</span></span><span><span class="doc-math-var">r</span></span></span> · <span class="doc-math-var">B</span> · <span class="doc-math-var">A</span></div>
  <p><span class="doc-math-var">A</span> is <code>lora_down</code>, <span class="doc-math-var">B</span> is <code>lora_up</code>, <span class="doc-math-var">r</span> is the rank, and <span class="doc-math-var">α</span> is alpha.</p>
</div>

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

The toggle is hidden for `lycoris.kohya` so the trainer never passes unverified parameters to that module. LoHa and LoKr support means sd-scripts can assign a higher rate to those parameters; the LoRA+ paper reports no experiments on these decompositions. Krea 2 (`networks.lora_krea2`, the musubi-tuner path) does not offer the LoRA+ toggle.

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

The trainer records the per-group rates the optimizer actually uses. For internally adaptive optimizers such as Automagic3 and Schedule-Free, read the live values from the curves. With conventional optimizers, compare the two curves to confirm the expected ratio.

<!-- doc-anchor: faq -->
## Frequently asked questions

**The result got worse or overfitting appeared earlier after enabling LoRA+. What should I do?**

Disable LoRA+ or lower the ratio back to `1.0` first and check whether the problem disappears. Then review the base learning rate, dataset repetition, and stopping point. The ratio only scales one parameter group's learning rate; it cannot determine final quality on its own.

**What ratio should I use?**

`2.0` is the trainer default and a relatively mild starting point. The paper's experiments use `16` (expressed as `2^4` in the paper), but that value comes from specific models and tasks and is not a universal recommendation for character, style, or concept LoRAs.

**How do I confirm that LoRA+ is actually active?**

With LoRA+ enabled, TensorBoard shows two curves per component, such as `lr/unet` and `lr/unet plus`. With a conventional optimizer, the ratio between the two curves should be close to the configured ratio.

**Why did the trainer disable LoRA+ automatically?**

When you switch to Prodigy, ProdigyPlus, or EmoSens, or when AdaFactor is in its default relative-step mode, the optimizer cannot reliably preserve per-group learning rates. The UI turns LoRA+ off and shows the reason.

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