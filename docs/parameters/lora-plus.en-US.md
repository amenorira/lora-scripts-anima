# LoRA+

> LoRA+ assigns different learning rates to LoRA parameter groups during training. It is not an optimizer or scheduler, and it does not change the exported LoRA format or inference behavior.

<!-- doc-anchor: overview -->
## Overview

A standard LoRA update is the product of two low-rank matrices:

```text
delta W = scale * lora_up * lora_down
```

`lora_down` is commonly initialized with small random values while `lora_up` starts at zero. Early in training, `lora_up` therefore receives the useful update first and the effective gradient for `lora_down` is initially weak. Standard LoRA uses one learning rate for both matrices. LoRA+ raises only the `lora_up` rate:

```text
lora_down LR = base LR
lora_up LR   = base LR * LoRA+ ratio
```

With a base rate of `1e-4` and a ratio of `2`, the regular group uses `1e-4` and the `plus` group uses `2e-4`.

<!-- doc-anchor: effects -->
## Training effects

- **Faster startup:** `lora_up` can leave its zero initialization sooner.
- **Targeted acceleration:** the base rate for the other LoRA parameters remains unchanged.
- **More learning within a fixed budget:** useful features may appear in fewer steps.
- **Faster overfitting:** backgrounds, watermarks, effects, and incorrect captions can also be learned sooner.
- **Separate LR telemetry:** TensorBoard receives regular and `plus` learning-rate series.

LoRA+ adds no inference VRAM or compute cost and does not change how the `.safetensors` file is loaded.

<!-- doc-anchor: good-cases -->
## When it can help

LoRA+ is most worth testing when:

1. You use a conventional optimizer such as AdamW or AdamW8bit.
2. The current run underfits, but raising the global learning rate is unstable.
3. You train a medium or high rank such as `16`, `32`, or `64` with a limited step budget.
4. The dataset and captions are clean and consistent.
5. You want useful character, outfit, or style features to appear earlier.

For few-shot character LoRAs, identity details may form sooner. Repeated backgrounds and compositions can also be memorized sooner, so dataset quality matters more, not less.

<!-- doc-anchor: cautions -->
## When to be cautious

- Very small or highly duplicated datasets that already overfit easily.
- A high base learning rate that becomes excessive after multiplication.
- Captions or images containing repeated unwanted details.
- Low-rank runs or configurations that already converge within the intended budget.
- Prodigy or DAdapt optimizers. The sd-scripts documentation states that they cannot be combined with LoRA+; this trainer blocks Prodigy and ProdigyPlus while LoRA+ is enabled.

ScheduleFree and other internally scheduled optimizers can generally hold different parameter-group rates, but their internal dynamics interact with the ratio. AdamW ratios should not be copied blindly.

<!-- doc-anchor: parameters -->
## sd-scripts parameters

The UI toggle is local to this trainer and is never sent to sd-scripts. Only these native `network_args` are emitted.

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

Global LoRA+ ratio and the default for both UNet/DiT and text encoder groups.

```text
loraplus_lr_ratio=2.0
```

A component-specific value overrides the global value for that component. Leave the global field empty and set only a component field to enable LoRA+ for one component.

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

Ratio for the main UNet. The same sd-scripts parameter name is used for the main DiT in Anima training.

```text
loraplus_unet_lr_ratio=2.0
```

For a first character-LoRA experiment, applying `2.0` only to UNet/DiT is the conservative starting point.

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

Ratio for text-encoder LoRA parameters.

```text
loraplus_text_encoder_lr_ratio=2.0
```

The text encoder can bind a trigger word faster, but it can also lose prompt generalization faster. Start conservatively.

<!-- doc-anchor: support -->
## Supported network modules

The trainer exposes LoRA+ only for modules that implement it in sd-scripts:

| Network module | Higher-rate parameter group |
| --- | --- |
| `networks.lora` | `lora_up` |
| `networks.lora_anima` | `lora_up` |
| `networks.loha` | second LoHa parameter pair |
| `networks.lokr` | LoKr scale parameter group |

The switch is hidden for `lycoris.kohya` so the trainer does not pass unverified parameters to that module.

<!-- doc-anchor: testing -->
## Suggested experiment

Keep the dataset, seed, rank, alpha, base LR, and total steps fixed:

1. Run a baseline without LoRA+.
2. Test only `loraplus_unet_lr_ratio=2.0`.
3. If the run still clearly underfits, test `4.0`.
4. Try `8.0` or `16.0` only after confirming that the base LR is conservative.

Compare samples at the same steps. Watch identity formation, background leakage, rigid composition, and prompt generalization. Loss alone cannot determine whether LoRA+ is better.

<!-- doc-anchor: tensorboard -->
## TensorBoard

sd-scripts records the regular and higher-rate groups separately:

```text
lr/unet
lr/unet plus
```

Text-encoder training can also produce:

```text
lr/textencoder
lr/textencoder plus
```

The trainer's true-LR reporting layer reads the actual parameter-group rates, so both regular and `plus` TensorBoard series reflect the values used by the optimizer.
