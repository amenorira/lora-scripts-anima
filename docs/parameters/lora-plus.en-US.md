# LoRA+

> LoRA+ gives different learning rates to different parameters within a LoRA. It may change how quickly target features appear, but it is not a quality-enhancement option and does not guarantee a better final result. Training without LoRA+ remains a complete, standard LoRA workflow.

<!-- doc-anchor: overview -->
## Quick overview

A standard LoRA can be understood as two parts that work together. Ordinary training gives them the same learning rate. LoRA+ keeps the base learning rate for one group and gives the other group a higher rate.

For example, with a base learning rate of `1e-4` and a LoRA+ ratio of `2.0`:

- The base group continues to use `1e-4`.
- The higher-rate group uses `2e-4`.
- The base model, number of LoRA parameters, and exported file format do not change.

LoRA+ therefore changes how much may be learned after a given number of steps, not what the model is capable of learning. The dataset and captions determine which content is repeated during training. LoRA+ may make the intended feature appear sooner, but it may also make repeated backgrounds, poses, and compositions easier to memorize.

<!-- doc-anchor: effects -->
## How LoRA+ affects training

LoRA+ uses the same learning-rate mechanism for characters, styles, garments, and general concepts, but the results worth checking differ by training target:

| Training target | Possible change | Also examine |
| --- | --- | --- |
| Character LoRA | Face, hair, or identity features may stabilize earlier | Whether outfits remain replaceable and whether backgrounds or poses become tied to the character |
| Style LoRA | Color, line, and shape characteristics may appear earlier | Whether the style transfers to new characters, objects, and compositions |
| Garment or object LoRA | The target appearance may become clear in earlier checkpoints | Whether it combines with different characters, poses, and scenes |
| Trigger-based concept | The trigger may produce a clear response earlier | Whether the rest of the prompt retains its intended control over the result |

Image count alone does not determine the LoRA+ outcome. The effective number and diversity of independent images change the trajectory produced by the same ratio:

- A small character dataset can memorize identity, outfit, background, and pose together. LoRA+ may make all of them appear sooner.
- A larger dataset with varied viewpoints, poses, and backgrounds makes it easier to separate faster learning from better generalization.
- A large collection of near-duplicates carries risks similar to a small dataset.
- `repeats` increases how often an image is used; it does not add new viewpoints, poses, or compositions.

LoRA+ also interacts with the rest of the training configuration:

- **Base learning rate** sets the value before multiplication. A ratio of `2.0` produces a different effective rate from a base of `1e-4` than from a base of `2e-4`.
- **Training steps** determine how many updates occur. LoRA+ may move both the best checkpoint and the onset of overfitting earlier.
- **Rank** controls LoRA capacity, not learning speed directly. An underfit high-rank LoRA may need a different learning rate, more steps, or better captions rather than LoRA+.
- **Alpha** scales the LoRA weight update. A ratio that worked before an alpha change may no longer behave the same way.
- **Dataset and captions** determine which content is repeatedly reinforced. LoRA+ cannot replace missing data or correct an unsuitable trigger or inaccurate captions.

<!-- doc-anchor: effective-lr -->
## Effective learning rates

A LoRA+ ratio only has meaning together with its base learning rate. The trainer first determines the base rate for each trained component, then applies the LoRA+ ratio to that component's higher-rate parameter group:

| Component | Learning-rate lookup order | Fallback |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| Text encoder | `text_encoder_lr` | `learning_rate` |

The following examples show how the base learning rate and LoRA+ ratio combine to determine the effective rates:

| Configuration | Base group | Higher-rate group |
| --- | --- | --- |
| Base LR `1e-4`, LoRA+ disabled | `1e-4` | `1e-4` |
| Base LR `1e-4`, ratio `2.0` | `1e-4` | `2e-4` |
| Base LR `2e-4`, ratio `2.0` | `2e-4` | `4e-4` |

When `unet_lr` or `text_encoder_lr` is set, the corresponding component uses that rate in the calculation. For example, with `learning_rate=1e-4`, `unet_lr=8e-5`, and a UNet/DiT ratio of `2.0`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Example effective UNet LoRA+ learning rates">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

Raising the global learning rate accelerates every LoRA parameter. Raising the LoRA+ ratio accelerates only the higher-rate group. This distinction is the main practical purpose of LoRA+.

<!-- doc-anchor: ratio-guidance -->
## What the ratio means

The ratio is a learning-rate multiplier for the higher-rate group, not a quality level:

| Ratio | Effective meaning | What changes |
| --- | --- | --- |
| `1.0` | Both groups use the same rate | No differential LoRA+ learning-rate effect |
| `2.0` | The higher-rate group uses 2× the base rate | The trainer default and a relatively mild difference |
| `4.0` | The higher-rate group uses 4× the base rate | The resulting effective rate requires closer attention |
| `8.0`–`16.0` | The higher-rate group uses a substantially higher rate | More sensitive to the base rate, stopping point, and repeated data |

The LoRA+ paper uses `16` in its experimental settings, and the sd-scripts documentation records that value. Those experiments cover specific models and tasks and do not establish a ratio ranking for character, style, or concept LoRAs. This trainer's field default is `2.0`, which gives the higher-rate group twice the base group's learning rate.

<!-- doc-anchor: parameters -->
## Trainer parameters

“Enable LoRA+” is the master switch in this trainer. It controls whether the ratio settings below are written for sd-scripts; the toggle itself is not a training argument.

When the switch is off, ratio values retained in the UI are not included in the training configuration. Matching `loraplus_*` entries in advanced custom network arguments are also ignored so that the UI and backend validation use the same values.

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

The global ratio. UNet/DiT and text encoder groups use this value when no component-specific ratio is set. The UI default is `2.0`, and the minimum is `1.0`.

```toml
loraplus_lr_ratio = 2.0
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

Overrides the ratio for the main UNet only. The Anima training path retains the sd-scripts `unet` parameter name even though it refers to the main DiT network.

```toml
loraplus_unet_lr_ratio = 2.0
```

This setting has no effect when only the text encoder is trained.

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

Overrides the ratio for text-encoder LoRA parameters only.

```toml
loraplus_text_encoder_lr_ratio = 2.0
```

This setting has no effect when the text encoder is not trained, “Train UNet only” is enabled, or caching prevents text-encoder training. A higher text-encoder ratio may make the trigger produce a clear response sooner, but it may also make the model depend on that trigger earlier and reduce control from the rest of the prompt.

The ratio precedence is:

| Component | Ratio used |
| --- | --- |
| UNet/DiT | `loraplus_unet_lr_ratio`, falling back to `loraplus_lr_ratio` when empty |
| Text encoder | `loraplus_text_encoder_lr_ratio`, falling back to `loraplus_lr_ratio` when empty |

When the global ratio is empty, a component ratio can be used by itself to limit LoRA+ to that component. At least one ratio is required while LoRA+ is enabled. A component does not use LoRA+ when both its specific ratio and the global ratio are empty.

<!-- doc-anchor: good-cases -->
## Observable quantities changed by LoRA+

LoRA+ raises the effective learning rate of only the higher-rate parameter group, changing:

- The cumulative update magnitude of that group at the same step.
- The checkpoint at which a target feature first becomes visible.
- The checkpoint at which repeated background, pose, or composition starts to become fixed.
- The actual parameter-group learning-rate curves recorded in TensorBoard.

The best observed checkpoints from standard LoRA and LoRA+ can match or differ. The toggle itself contains no judgment about final quality.

<!-- doc-anchor: cautions -->
## Numerical range and limitations

The following data conditions cause a higher ratio to accumulate repeated evidence faster:

- The dataset is very small or many images share the same background, pose, and composition.
- The collection contains many video frames, duplicate crops, or near-identical images despite a large file count.
- The base learning rate is already high, making the multiplied effective rate excessive.
- Secondary characters, watermarks, effects, or undescribed elements recur throughout the dataset.
- The current run already shows rigid composition, background binding, or weaker prompt control.
- The optimizer manages learning rates internally, allowing the effective ratio to change during training.

LoRA+ does not change model capacity, add training data, or correct captions. It also does not calculate a stopping step. As the ratio increases, both target features and repeated evidence can appear in earlier checkpoints.

<!-- doc-anchor: testing -->
## What each comparison measures

The two comparisons answer different questions:

| Comparison | What it shows |
| --- | --- |
| Checkpoints at the same step | Whether LoRA+ changed learning speed |
| The best observed checkpoint from each configuration | Whether LoRA+ improved the best result actually obtained |

Differences can be attributed to the LoRA+ toggle or ratio only when the dataset, training seed, rank, alpha, base learning rates, optimizer, scheduler, total steps, generation seeds, and prompts remain fixed.

Observable results for each target include:

- **Character LoRA:** identity consistency, outfit replacement, and recognition in new backgrounds and poses.
- **Style LoRA:** transfer to subjects and compositions absent from the training set rather than simple reproduction of training images.
- **Garment or object LoRA:** combination with different characters, poses, and scenes.
- **Trigger-based concept:** a clear trigger response while other character, action, and environment terms remain effective.

When a higher ratio only makes a similar result appear earlier, the observed difference is learning speed. When background binding, repeated composition, or weaker prompt control also appears earlier, the observation includes the combined effects of ratio, base learning rate, repeated data, and stopping point.

Loss can help identify training anomalies and overall trends, but it cannot determine identity fidelity, style transfer, or prompt control on its own.

<!-- doc-anchor: mechanism -->
## Technical mechanism

Instead of changing the original model weights directly, a standard LoRA represents the weight update with two low-rank matrices. In sd-scripts terminology, `lora_down` first projects the input into a lower-dimensional space and `lora_up` projects it back to the original dimension:

<div class="doc-equation" role="group" aria-label="Standard LoRA weight update equation">
  <div class="doc-equation-expression"><span class="doc-math-var">ΔW</span> = <span class="doc-frac"><span><span class="doc-math-var">α</span></span><span><span class="doc-math-var">r</span></span></span> · <span class="doc-math-var">B</span> · <span class="doc-math-var">A</span></div>
  <p><span class="doc-math-var">A</span> is <code>lora_down</code>, <span class="doc-math-var">B</span> is <code>lora_up</code>, <span class="doc-math-var">r</span> is the rank, and <span class="doc-math-var">α</span> is alpha.</p>
</div>

In the current sd-scripts implementation, `lora_down` is initialized with random values and `lora_up` is initialized to zero. On the first backward pass, the gradient of `lora_down` is temporarily zero because `lora_up` is zero. After `lora_up` has been updated, `lora_down` begins to receive a nonzero gradient. The two matrices therefore have different update dynamics at the start of training.

With LoRA+ disabled, both parameter groups use the same base learning rate. LoRA+ retains the base rate for `lora_down` and raises the rate for `lora_up`:

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ learning-rate equations">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

The ratio changes the size of each update, not the point at which a parameter starts updating. At a ratio of `1.0`, both groups still use the same learning rate.

<!-- doc-anchor: optimizer-compatibility -->
## Optimizers and schedulers

| Optimizer | LoRA+ status | Notes |
| --- | --- | --- |
| AdamW, AdamW8bit, PagedAdamW8bit | Supported | Preserve separate learning rates for different parameter groups, making the ratio relatively easy to interpret. |
| Lion, Lion8bit, PagedLion8bit | Supported | Preserve separate parameter-group learning rates. |
| CAME | Supported | Preserves separate parameter-group learning rates. |
| AdamWScheduleFree | Supported | Preserves the groups, but its internal adjustments affect the effective rates during training. |
| Automagic3 | Conditional | The result of “base LR × LoRA+ ratio” must remain within `min_lr` and `max_lr`. Adaptive behavior can change the effective ratio during training. |
| AdaFactor | Manual-LR mode only | Both `relative_step` and `warmup_init` must be disabled. The default relative-step mode ignores parameter-group rates, so the UI disables and locks LoRA+. |
| Prodigy, ProdigyPlus | Unsupported | The current sd-scripts training path cannot reliably preserve separate learning rates for different parameter groups; both UI and backend reject this combination. |
| EmoSens | Unsupported | EmoSens updates every parameter with one global `emoPulse` and resets all parameter groups to that rate after each step, removing the LoRA+ ratio. |

Switching to an incompatible mode turns LoRA+ off and displays the reason. Backend validation also rejects incompatible combinations submitted through older presets or direct API requests.

A conventional scheduler applies the same proportional learning-rate curve to each parameter group, preserving the initial LoRA+ ratio. Warmup controls the overall learning-rate progression at the start of training and is not a LoRA+ ratio. For internally adaptive optimizers such as Schedule-Free and Automagic3, the training log records the effective rates used during training.

<!-- doc-anchor: support -->
## Supported network modules

The trainer exposes LoRA+ only for native network modules in which the current sd-scripts implementation defines a higher-rate parameter:

| Network module | Higher-rate parameter | Notes |
| --- | --- | --- |
| `networks.lora` | `lora_up` | Standard LoRA+ grouping. |
| `networks.lora_anima` | `lora_up` | Standard LoRA+ grouping for Anima. |
| `networks.loha` | `hada_w2_a` | The sd-scripts extension for LoHa. |
| `networks.lokr` | `lokr_w1` | The sd-scripts extension for LoKr. |

The toggle is hidden for `lycoris.kohya` so the trainer does not pass unverified parameters to that module. LoHa and LoKr support means that sd-scripts can assign a higher learning rate to the listed parameter. It does not mean that the standard LoRA+ paper reports equivalent experimental evidence for these decompositions.

<!-- doc-anchor: tensorboard -->
## TensorBoard

When LoRA+ is enabled, sd-scripts records the base and higher-rate groups separately. A standard SDXL LoRA records these names:

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

The Anima text encoder is numbered and records these names:

```text
lr/textencoder 1
lr/textencoder 1 plus
```

`plus` identifies the higher-rate parameter group. Block learning rates or other multi-group configurations can add more names and curves.

The trainer records the parameter-group learning rates currently used by the optimizer. For internally adaptive optimizers such as Automagic3 and Schedule-Free, the TensorBoard curves show the effective values. With conventional optimizers, the two curves can be used to confirm that the expected ratio is maintained.

<!-- doc-anchor: references -->
## References

- Hayou et al., [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354), presents the theoretical motivation and experiments for using different learning rates for the two LoRA matrices.
- The sd-scripts `train_network_advanced.md` documentation describes `loraplus_lr_ratio`, component-specific ratios, and optimizer restrictions.
- The sd-scripts `loha_lokr.md` documentation describes the higher-rate parameter mappings for LoHa and LoKr.
