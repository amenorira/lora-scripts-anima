# Optimizer Selection and Parameter Guide

> For most Anima and SDXL LoRA training, **AdamW8bit** is the recommended baseline. If baseline training is stable, changing the optimizer is usually unnecessary.
>
> **CAME** may be compared when the dataset contains sources of substantially different quality. **StableAdamW** may be compared when the logs show reproducible gradient spikes or when trainable LoRA parameters use FP16/BF16.

Optimizer choice affects convergence, optimizer-state memory, and numerical stability. Dataset quality, captions, repeats, learning rate, and stopping point usually have a greater effect on character fidelity, especially with very small datasets.

<!-- doc-anchor: quick-choice -->
## Quick selection

| Training condition | Suggested baseline | Rationale |
| --- | --- | --- |
| First run, with no known stability issue | AdamW8bit | Established parameter behavior, low state memory, and easy comparison with common configurations |
| Sprites, card art, captures, and effects in one set | AdamW8bit baseline, followed by a CAME comparison | CAME's internal clipping may improve update stability but does not assess image quality |
| Reproducible loss or gradient spikes | Check the data and LR first, then compare StableAdamW | StableAdamW addresses update stability but does not guarantee higher image quality |
| Trainable LoRA weights stored in FP16/BF16 | StableAdamW | Kahan summation is primarily relevant to low-precision parameter updates |
| Optimizer-state memory is the main constraint | AdamW8bit; use PagedAdamW8bit only if paging is needed | Paged variants address memory pressure; CPU/GPU transfers may reduce training speed when paging occurs |
| Reduced absolute learning-rate tuning | Prodigy | The trainer requires a base LR of `1.0` |

For few-shot character training, comparisons may focus on **AdamW8bit, CAME, and StableAdamW**. Only one major variable should be changed at a time; otherwise, differences cannot be attributed to the optimizer.

<!-- doc-anchor: optimizer-type -->
## Available optimizers

| Optimizer | Primary use | Limitations and notes |
| --- | --- | --- |
| AdamW | A full-precision AdamW reference | Higher optimizer-state memory than the 8-bit version |
| AdamW8bit | The general default | Small tensors remain in FP32 state by default; that is intentional |
| PagedAdamW8bit | When ordinary 8-bit state still does not fit | Paging does not add a quality objective and may reduce speed when CPU/GPU transfers occur |
| StableAdamW | Spiky updates or low-precision trainable weights | State memory is usually higher than AdamW8bit; it does not prevent overfitting |
| Lion | Comparison with sign-based momentum | Requires an independent learning-rate search |
| Lion8bit | Lion with smaller optimizer state | Requires an independent learning-rate adjustment |
| PagedLion8bit | Lion8bit when paging is also needed | Same optimization method; paging may reduce training speed |
| Prodigy | Optimizer-estimated update scale | Base LR must be `1.0`; LoRA+ is not supported here |
| ProdigyPlusScheduleFree | Comparison of its internal schedule and combined features | External scheduler/warmup are disabled; benefits in short runs are uncertain |
| Automagic3 | Project-specific experimental adaptive optimizer | Recommended only when a clear baseline is available |
| AdaFactor | Reducing optimizer-state memory | Relative-step mode owns the LR and restricts LoRA+ |
| CAME | Comparison on batches with uneven update scales | Uses three betas and internal RMS clipping; it does not assess image quality |
| AdamWScheduleFree | AdamW without an external schedule | Uses internal warmup and is not a primary choice for short few-shot runs |
| EmoSens | Project-specific emotion-driven optimizer | Gradient accumulation must be 1; LoRA+ is unsupported |

The memory descriptions refer only to optimizer state. Actual peak VRAM also depends on resolution, rank, batch size, caching, and preview generation.

<!-- doc-anchor: stable-comparison -->
## AdamW8bit, CAME, and StableAdamW

**AdamW8bit is the baseline.** It has relatively low state memory, extensive practical use, and straightforward troubleshooting. It is generally preferred when no specific stability or memory issue is present.

**CAME uses factored state and internal RMS clipping.** It may be compared with AdamW8bit for datasets that mix sprites, cards, and captures with different update characteristics. CAME operates on parameter updates; it does not identify image quality, the target character, or unwanted effects.

**StableAdamW is designed to limit unusually large updates.** It supports the standard scheduler, warmup, `max_grad_norm`, and LoRA+. The recommended starting point is `lr=1e-4`, `betas=(0.9, 0.99)`, `eps=1e-8`, and `weight_decay=0`. It is not an 8-bit optimizer, so its state memory is generally higher than AdamW8bit.

If baseline curves and previews are already stable, the additional benefit of StableAdamW may be limited. Its primary purpose is update stability.

<!-- doc-anchor: parameters -->
## Parameter reference

<!-- doc-anchor: learning-rate -->
### Learning rate

Recommended starting points:

- AdamW, AdamW8bit, StableAdamW: `1e-4`
- CAME: the UI suggests `2e-4`; `1e-4` is a useful conservative comparison for tiny datasets
- Prodigy and ProdigyPlus: `1.0`

Lower the LR when composition becomes rigid too early, colors bleed, or prompt response declines. When learning is insufficient, verify triggers and effective step count before increasing it. Lion requires a separate LR search because its useful range differs from AdamW.

<!-- doc-anchor: scheduler-warmup -->
### Scheduler and warmup

AdamW, AdamW8bit, StableAdamW, Lion, and CAME use the external sd-scripts scheduler. Existing cosine recipes still apply. Few-shot runs are short, so begin with no warmup or no more than roughly 5% of total steps.

AdamWScheduleFree and ProdigyPlusScheduleFree own their schedules. The trainer locks the external scheduler to constant for them. Their internal warmup is not the same setting as `lr_warmup_steps`.

<!-- doc-anchor: betas -->
### Betas

Retain the defaults unless a controlled test provides a reason to change them:

- AdamW family: commonly `0.9, 0.999`
- StableAdamW and Lion: commonly `0.9, 0.99`
- CAME: three beta values

Higher betas tend to smooth updates while reacting more slowly to new gradients. In normal LoRA tuning, LR is a much more useful first adjustment.

<!-- doc-anchor: eps -->
### Epsilon

`eps` prevents a tiny denominator from producing an oversized update. StableAdamW defaults to `1e-8`. It is a numerical safeguard rather than an image-quality control and should remain at default unless a reproducible numerical issue is present.

<!-- doc-anchor: weight-decay -->
### Weight decay

For the optimizers emphasized in this guide, the trainer provides the following starting points: `0.01` for AdamW, AdamW8bit, and PagedAdamW8bit; `0` for CAME and StableAdamW. These defaults establish reproducible baselines; they do not show that `0.01` is always better than `0`.

Character LoRAs have limited capacity, so large weight decay should not be introduced without a controlled comparison. Testing `weight_decay=0` with AdamW8bit is reasonable, but it should be treated as a separate parameter experiment with the dataset, run length, and other settings held constant.

The StableAdamW package defaults to `weight_decay=0.01`. The generated TOML deliberately includes `weight_decay=0` to override that default.

<!-- doc-anchor: gradient-clipping -->
### Maximum gradient norm

`max_grad_norm=1` is a sensible baseline; `0` disables global norm clipping. StableAdamW works normally with this control.

Avoid a very low norm limit together with `percentile_clipping=95`. Both controls can cut the same update, and normal learning may be clipped twice.

<!-- doc-anchor: percentile-clipping -->
### Percentile clipping

This setting is available only for AdamW8bit, PagedAdamW8bit, Lion8bit, and PagedLion8bit.

- `100`: off, and the default
- `99`: a mild experimental comparison value
- `95`: a stronger experimental comparison value, considered only after confirming outlier gradients

The values `99` and `95` are engineering starting points, not Anima LoRA optima established by published tests. bitsandbytes uses recent gradient norms; it does not inspect images. Strong clipping can suppress a rare outfit or expression just as easily as a genuinely bad batch.

<!-- doc-anchor: min-8bit-size -->
### Minimum 8-bit tensor size

The default is `4096`. Tensors smaller than this keep FP32 optimizer state.

For a low-rank LoRA, `16384` is a reasonable diagnostic if small-tensor numerical behavior is a concern. More tensors remain in FP32 state, using a little more VRAM. This setting does not change the precision of the model weights themselves.

<!-- doc-anchor: stableadamw-options -->
### StableAdamW options

`kahan_sum=True` uses compensated summation to retain small low-precision updates. It matters most when the trainable LoRA weights themselves are FP16 or BF16. In this project, selecting `mixed_precision=bf16` alone leaves trainable LoRA parameters in FP32; enabling `full_bf16` also casts those parameters to BF16. Kahan summation therefore usually has little effect unless `full_bf16` is enabled.

`weight_decouple=True` applies AdamW-style decoupled decay. It does not change the result while `weight_decay=0` and should normally remain enabled.

<!-- doc-anchor: came-clipping -->
### CAME's internal clipping

`came_clip_threshold` applies to the RMS of CAME's own update and defaults to `1.0`. It is separate from global `max_grad_norm`. Keep it at default first. Change it only when the same setup repeatedly shows the same instability.

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free warmup

AdamWScheduleFree consumes its own `warmup_steps`, while external `lr_warmup_steps` is disabled. A long internal warmup can take up most of a short character run.

<!-- doc-anchor: stochastic-rounding -->
### Stochastic rounding

Stochastic rounding reduces the long-term bias caused by repeatedly rounding low-precision updates in the same direction. ProdigyPlus keeps its package default; the trainer does not expose another switch. This is numerical handling, not data augmentation.

<!-- doc-anchor: loraplus -->
### LoRA+

AdamW, 8-bit AdamW, StableAdamW, Lion, CAME, and AdamWScheduleFree can use LoRA+. Prodigy, ProdigyPlus, and EmoSens cannot. AdaFactor requires relative step to be disabled first.

Re-test the LoRA+ ratio after changing optimizer or base LR. The ratio changes the effective LR of part of the LoRA; it is not an independent quality boost.

<!-- doc-anchor: scenarios -->
## Common dataset cases

<!-- doc-anchor: one-image -->
### One sprite or character image

Use AdamW8bit around `5e-5` to `1e-4`, with frequent checkpoints. The main risks are memorized pose and framing. StableAdamW may reduce update spikes, but it cannot supply missing side views, back views, or expressions.

<!-- doc-anchor: few-shot -->
### Two to five character images

Begin with an AdamW8bit baseline. If source or image quality differs noticeably, compare CAME at the same step budget. StableAdamW is relevant when the logs show update spikes. Complex internal schedules may have insufficient steps to show a benefit in very short runs.

<!-- doc-anchor: galgame -->
### Galgame sprites and expressions

AdamW8bit is generally sufficient. Accurate expression tags and removal of repeated background information are more important than optimizer choice. If expression groups are strongly imbalanced, CAME may be included as a comparison rather than treated as an automatic upgrade.

<!-- doc-anchor: dmm-mixed -->
### DMM cards, effects, and companion characters

Companion characters, text, watermarks, effects, and alternate forms should first be labeled or removed. AdamW8bit and CAME may then be compared. StableAdamW may be added if the training log remains unstable. Optimizers cannot identify which character is the training target.

<!-- doc-anchor: mixed-quality -->
### Uneven image quality

Blurred captures, heavy compression, duplicate crops, and near-identical Live2D frames should be addressed before optimizer tuning. Images that must remain can be controlled through captions, grouping, and repeats. CAME may be compared; for 8-bit optimizers, test `percentile_clipping=99` before `95`.

<!-- doc-anchor: outfits-forms -->
### Multiple outfits or forms

Optimizer choice is secondary to accurate outfit/form tags and balanced sampling. AdamW8bit, CAME, and StableAdamW are all applicable. Evaluation should cover outfit control, identity retention, and color leakage across several prompts rather than a single preview.

<!-- doc-anchor: style-lora -->
### Style LoRA

AdamW8bit is the recommended baseline. Subject coverage and captions that separate content from style generally have greater impact. StableAdamW can reduce the effect of an abnormal batch, while aggressive clipping may also suppress rare style features.

<!-- doc-anchor: vram -->
### Tight VRAM

Use AdamW8bit or Lion8bit first. A Paged version is appropriate only when memory pressure makes paging useful. Once paging is active, optimizer-state transfers between CPU and GPU may reduce training speed. Keep `min_8bit_size=4096` unless measured results justify quantizing more small tensors.

<!-- doc-anchor: starting-configs -->
## Conservative starting configurations

| Purpose | Optimizer settings | Rest of the run |
| --- | --- | --- |
| General baseline | AdamW8bit, `lr=1e-4`, `weight_decay=0.01` | cosine, `max_grad_norm=1` |
| Mixed-source comparison | CAME at `lr=1e-4`, then compare the UI default `2e-4`; leave its other settings alone | cosine, `max_grad_norm=1` |
| Spike-handling comparison | StableAdamW, `lr=1e-4`, `betas=(0.9,0.99)`, `eps=1e-8`, `weight_decay=0` | Kahan on, cosine, `max_grad_norm=1` |
| Mild 8-bit clipping test | Keep the AdamW8bit baseline and add `percentile_clipping=99` | Keep all other settings unchanged |

For overfitting, first reduce steps, repeats, or LR. For underfitting, verify triggers and effective steps. For update spikes, identify the corresponding batch before adding more clipping.

<!-- doc-anchor: troubleshooting -->
## Troubleshooting by symptom

| Symptom | Check first | Optimizer adjustment to consider |
| --- | --- | --- |
| Stable loss but poor previews | Dataset, captions, preview prompt, and checkpoint timing | Changing optimizer is usually not the first step |
| Isolated, reproducible loss or gradient spikes | Corresponding batch, outlier images, and LR | Compare StableAdamW, or test `percentile_clipping=99` separately |
| NaN or Inf | Stop the run; inspect LR, precision settings, corrupt data, and resume state | Compare StableAdamW only after correcting configuration or data issues; do not use clipping to hide a persistent error |
| Optimizer state causes OOM | Confirm that state memory, rather than resolution, batch size, or preview generation, is responsible | Use 8-bit first; use a Paged variant only if needed |
| Pose, background, or outfit is memorized quickly | Steps, repeats, LR, and duplicate data | Lower LR or shorten the run; changing optimizer usually does not solve this |
| Character features remain weak | Trigger, captions, effective steps, rank, and training target | Raise LR gradually only after verifying those items |

<!-- doc-anchor: ab-testing -->
## Controlled comparison method

1. Fix the dataset, captions, seed, base model, rank/alpha, batch size, and total steps.
2. Fix preview prompts, sampler settings, and generation seeds.
3. AdamW8bit, CAME, and StableAdamW can first be compared at the same `lr=1e-4`, changing only the optimizer and its required arguments.
4. Compare checkpoints at matching steps. Record gradient norm, peak VRAM, and training time as well as previews.
5. Include identity, outfit control, pose/background leakage, and prompt response in addition to loss.

Start each comparison from the same base model. Do not resume a saved optimizer state and then switch optimizer, because their momentum and state structures are not equivalent.

Optimizers such as Prodigy require a different LR scale and cannot be included in that single-variable comparison. Tune each to a reasonable configuration first, then compare complete training recipes. The result should be described as a better recipe for the dataset, not as an isolated optimizer effect.

Changing the optimizer, LR, rank, and run length together prevents attribution. Even if the result improves, the effective change cannot be identified.

<!-- doc-anchor: limits -->
## Scope and limitations

- CAME operates on gradients and optimizer state; it does not automatically reduce the weight of low-quality images.
- StableAdamW primarily improves update stability. If the baseline is already stable, image-quality differences may be small.
- Paged optimizers change memory management and do not provide an independent image-quality benefit; active paging may reduce training speed.
- Optimizer choice alone cannot prevent one-image overfitting. Repeats, run length, and dataset diversity are more important.
- Optimizer families have different useful LR ranges, so a shared LR does not necessarily produce a fair comparison.

<!-- doc-anchor: evidence -->
## Evidence and references

**Implementation facts:** The trainer loads `pytorch_optimizer.StableAdamW` through sd-scripts' full-class-path mechanism. In the installed `pytorch-optimizer 3.10.0`, constructor defaults include `betas=(0.9,0.99)`, `eps=1e-8`, `weight_decay=0.01`, `weight_decouple=True`, and `kahan_sum=True`. This trainer deliberately overrides weight decay to `0`.

**Published evidence:** The CAME, Lion, Prodigy, Schedule-Free, and LoRA+ papers explain the algorithms and report results on their respective tasks. Language-model and classification results do not establish an image-quality ranking for Anima character LoRA training.

**Experience requiring local validation:** CAME may be suitable for mixed-source image sets, and StableAdamW may tolerate spiky batches more effectively. These are community and engineering observations that should be verified with a fixed-condition comparison on the target dataset.

References:

- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms (Lion)](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [pytorch-optimizer documentation](https://pytorch-optimizers.readthedocs.io/)
- [bitsandbytes optimizer documentation](https://huggingface.co/docs/bitsandbytes/optimizers)
