# Optimizer Selection and Parameter Guide

> For most Anima / SDXL LoRA training, start with **AdamW8bit** and build a baseline first. Once that baseline is stable, there is usually no need to switch optimizers.
>
> If your sources vary a lot in style and quality, try **CAME** as a comparison. If the log shows reproducible gradient spikes, or your LoRA trainable weights are FP16/BF16, try **StableAdamW**.

The optimizer affects convergence speed, VRAM use, and numerical stability, but it is usually not the deciding factor in character fidelity. When few-shot character training goes wrong, inspect the data, captions, repeats, learning rate, and stopping point first.

This guide distinguishes "what the papers and implementations actually say" from "engineering starting points for Anima." The paper results and library defaults for CAME, Lion, and Schedule-Free do not translate directly into optimal configurations for Anima LoRA. The official Anima model card recommends Anima-Base, training only the DiT blocks, rank 32, and starting around `2e-5`. This trainer uses `rank=32, alpha=32` as its engineering start; `alpha=32` in particular is a project choice that still needs validation on your dataset.

<!-- doc-anchor: quick-choice -->
## Quick choice

| Training situation | Suggested start | Why |
| --- | --- | --- |
| First time, or no clear stability problem | AdamW8bit | Well-understood settings and low state VRAM; easy to compare with common configs |
| Mixed DMM cards, art, screenshots, and effect images | Start with AdamW8bit, then compare CAME | CAME's internal clipping may steady the updates, but it will not identify low-quality images |
| Clear, reproducible loss or gradient spikes | Check the data and LR first, then compare StableAdamW | StableAdamW mainly steadies updates; it does not guarantee better image quality |
| LoRA trainable weights are FP16/BF16 | StableAdamW | `kahan_sum` helps most when parameter updates run at low precision |
| Not enough VRAM for optimizer state | AdamW8bit; if still tight, PagedAdamW8bit | Paging changes memory scheduling; host-device transfers may slow training |
| Want less learning-rate tuning | Prodigy | Requires a base LR of `1.0`; this project does not support LoRA+ with it |
| Want to compare matrix-orthogonalized updates | Muon | Keep the AdamW baseline LR and change only the optimizer first |

For few-shot character training, comparing **AdamW8bit, CAME, and StableAdamW** is a reasonable start. Change one major variable per comparison, or you cannot attribute the result.

<!-- doc-anchor: optimizer-type -->
## Available optimizers

| Optimizer | Primary purpose | Restrictions |
| --- | --- | --- |
| AdamW | Full-precision AdamW baseline | Uses more optimizer-state VRAM than the 8-bit builds |
| AdamW8bit | Everyday default | Small tensors keep FP32 state by design |
| PagedAdamW8bit | When the regular 8-bit optimizer still does not fit | Only difference is paging; transfers between CPU and GPU may slow training |
| StableAdamW | Gradient spikes, low-precision LoRA weights | Uses more state VRAM than AdamW8bit; does not prevent overfitting |
| Lion | Symbolic-momentum optimizer for comparison | Works with a different LR range; tune it separately |
| Lion8bit | Lion with less state VRAM | Needs its own LR sweep |
| PagedLion8bit | Lion8bit that also needs paging | Paging does not improve quality and may slow training |
| Prodigy | Optimizer-estimated update scale | Base LR must be `1.0`; not supported with LoRA+ here |
| ProdigyPlusScheduleFree | Testing internal schedules and combinations | External scheduler and warmup are ignored; benefits on short few-shot runs are uncertain |
| Automagic3 | Experimental adaptive scheme | Test only against a solid baseline |
| AdaFactor | Very tight optimizer memory | Relative-step mode takes over the LR and restricts LoRA+ |
| CAME | Comparison when source images mix and update scale varies | Uses three betas and internal RMS clipping |
| AdamWScheduleFree | Testing AdamW without an external scheduler | Supports internal warmup, but this project leaves `warmup_steps=0`; not a first choice for short runs |
| EmoSens | Experimental optimizer | Requires gradient accumulation of 1; LoRA+ not supported |
| Muon | Momentum orthogonalization for two-dimensional LoRA matrices | Uses PyTorch's native implementation; compare it with AdamW8bit under identical conditions |

Memory notes above refer only to optimizer state. Peak usage also depends on resolution, rank, batch size, cache, and preview generation.

<!-- doc-anchor: stable-comparison -->
## AdamW8bit, CAME, StableAdamW: how they differ

**AdamW8bit is the baseline.** It uses little state memory, is widely practiced, and makes it easy to isolate your learning rate, step count, and data issues. Use it unless you have a specific stability or memory concern.

**CAME uses factorized state with internal RMS clipping.** When card art, screenshots, and illustrations differ widely in quality and composition, compare it with AdamW8bit. CAME acts on parameter updates; it does not judge image quality. Companion characters, text, effects, and bad captions still have to be handled at data preparation time.

**StableAdamW caps unusually large parameter updates.** It supports the normal LR schedulers, warmup, `max_grad_norm`, and LoRA+, and this project keeps the Anima AdamW baseline with `lr=2e-5`, `betas=(0.9, 0.99)`, `eps=1e-8`, `weight_decay=0`; the SDXL UI baseline remains `1e-4`. It is not an 8-bit optimizer, so its state memory is usually larger than AdamW8bit.

When a baseline run is already stable and previews look fine, StableAdamW's added value is usually small. Its job is steadying updates, not unbreaking a dataset.

<!-- doc-anchor: parameters -->
## Parameter reference

<!-- doc-anchor: learning-rate -->
### Learning rate

When training Anima DiT blocks only, start from the engineering baselines below. The official Anima evidence covers rank 32 and roughly `2e-5`; the other numbers and `alpha=32` are ported heuristics, not measurements on Anima:

| Optimizer | Anima auto baseline | Source and meaning |
| --- | ---: | --- |
| AdamW / AdamW8bit / PagedAdamW8bit | `2e-5` | Official Anima rank-32 baseline; 8-bit and paged builds keep the same LR semantics |
| StableAdamW | `2e-5` | Same scale as AdamW first; isolate the stabilized updates |
| Muon (`match_rms_adamw`) | `2e-5` | Matches AdamW update RMS by matrix size; this is not an Anima-tuned optimum |
| CAME | `1.5e-5` | CAME's own guidance is roughly `0.5`–`0.9`× AdamW; this is a ported start, not an Anima-tuned optimum |
| Lion / Lion8bit / PagedLion8bit | `5e-6` | Lion's guidance is roughly `3`–`10`× smaller than AdamW |
| AdamWScheduleFree | `1e-4` | Schedule-Free guidance often `1`–`10`× higher than the base optimizer; treated as experimental on Anima |
| Prodigy / ProdigyPlus | `1.0` | D-adaptation scale; not comparable to `2e-5` |
| AdaFactor relative step | Controlled by the optimizer | With relative step off, Anima manual mode starts at `2e-5` |
| Automagic3 / EmoSens | `1e-4` / `0.1` | Internal dynamic-LR baseline values, not ordinary fixed LR |

The Lion `5e-6` only ports the paper's "roughly 3–10× smaller than AdamW" ratio. The paper also recommends scaling weight decay up by roughly 3–10×, which this project does not adopt, so this is not the complete official Lion recipe.

SDXL keeps its own generic baselines: `1e-4` for AdamW/StableAdamW, `1e-4` for CAME, `2e-5` for Lion, `3e-4` for AdamWScheduleFree. When you switch model type or optimizer, the UI only replaces recommended values you have not edited manually; imported and custom values stay as they are.

`network_alpha / network_dim` scales the LoRA branch. The upstream sd-scripts `1e-4` example assumes effectively `alpha=1` and explicitly says to lower or re-validate LR when raising it, so do not apply that example literally to this project's default `rank=32, alpha=32`.

When a character locks in, colors bleed, or prompt adherence drops too early, lower the learning rate or reduce training steps. When the model underlearns, confirm the trigger word and useful step count before nudging the LR up. Lion's usable LR range is different from AdamW's; test it on its own.

<!-- doc-anchor: scheduler-warmup -->
### LR scheduler and warmup

AdamW, AdamW8bit, StableAdamW, Lion, CAME, and Muon run under the external scheduler. New Anima configurations default to `constant`, matching the upstream Anima examples and removing one variable from short runs. `cosine_with_restarts` with the default `num_cycles=1` does not restart mid-training; only cycles greater than 1 do. Existing hand-made configs keep working; to test warmup, `constant_with_warmup` is the simple option, and keep it under `5%` of total optimizer steps first.

AdamWScheduleFree and ProdigyPlus manage their own schedule, so the UI forces the external scheduler to constant. Their internal warmup is separate from `lr_warmup_steps`.

<!-- doc-anchor: betas -->
### Momentum parameters (betas)

Keep the defaults unless you have a reason to change them:

- AdamW family: usually `0.9, 0.999`
- StableAdamW, Lion: usually `0.9, 0.99`
- CAME: three betas required

Higher betas smooth updates but respond slower to new gradients. In practice tune LR before betas.

<!-- doc-anchor: eps -->
### Numerical stabilizer (eps)

`eps` keeps denominators from magnifying small numbers. StableAdamW defaults to `1e-8`; PyTorch Muon defaults to `1e-7`. Unless samples show reproducible numerical issues, leave it.

<!-- doc-anchor: weight-decay -->
### Weight decay

For the optimizers covered here, this trainer defaults to AdamW/AdamW8bit/PagedAdamW8bit at `0.01`, and CAME, StableAdamW, and Muon at `0`. PyTorch Muon itself defaults to `0.1`; this trainer explicitly overrides it to `0` as a LoRA starting point, and the field remains editable.

Character LoRA capacity is limited; avoid aggressive weight decay without side-by-side evidence. Testing `weight_decay=0` on AdamW8bit means one parameter experiment with the same data, steps, and everything else.

StableAdamW's library defaults to `weight_decay=0.01`; this trainer explicitly writes `weight_decay=0` to override it. That is a deliberate choice, not a missing field.

<!-- doc-anchor: muon-options -->
### Muon options

Muon first accumulates gradient momentum, then approximately orthogonalizes updates for two-dimensional matrices. AdamW scales individual elements with second-moment statistics, while Muon focuses more on the direction of the whole matrix update. For LoRA, it processes `lora_down` and `lora_up` separately. This can change convergence speed and what directions are learned, but does not guarantee better final images than AdamW8bit.

Muon keeps one momentum state per parameter instead of the two states used by full-precision AdamW, but performs extra matrix multiplications on every step. Actual memory use and speed still depend on matrix sizes, rank, batch size, and the attention backend.

#### Update scale

- **Learning rate** (`learning_rate`, Anima default `2e-5`): Directly controls update size. Values that are too high can cause rapid overfitting, noisy loss, or unstable updates; values that are too low learn slowly. With the default scaling, an AdamW baseline is a useful starting point for comparison.
- **Learning-rate scaling** (`adjust_lr_fn`, default `match_rms_adamw`): `match_rms_adamw` can reuse the learning rate and weight decay from an AdamW recipe, making it suitable for isolating optimizer differences. `original` scales updates by matrix aspect ratio and usually needs separate learning-rate calibration; equal learning rates do not produce equal update scales across different matrix shapes.
- **Weight decay** (`weight_decay`, default `0`): Higher values shrink the LoRA factors further. This may reduce overfitting or may weaken character learning. PyTorch Muon defaults to `0.1`; the trainer explicitly passes the value shown in the UI.

#### Momentum

- **Momentum coefficient** (`momentum`, default `0.95`): Higher values produce smoother updates but respond more slowly to new gradients; lower values are more sensitive to the current batch.
- **Nesterov momentum** (`nesterov`, enabled by default): Controls how the current gradient and momentum history are combined before orthogonalization. Disabling it changes the optimization path rather than just performance.

#### Orthogonalization

- **Iteration count** (`ns_steps`, default `5`): More iterations improve the orthogonalization approximation and increase per-step compute. Fewer iterations reduce compute but change the update. The UI accepts values up to `99`.
- **Iteration coefficients** (`ns_coefficients`, default `3.4445, -4.775, 2.0315`): Define the polynomial used by the Newton-Schulz iteration. Other values can degrade the approximation or cause numerical problems and are mainly useful in controlled experiments.
- **Numerical stabilizer** (`eps`, default `1e-7`): Prevents division by very small values during normalization. It rarely affects normal training and is mainly relevant when investigating reproducible NaNs or abnormal amplification.

For a first comparison, change only AdamW8bit to Muon and keep the data, rank, alpha, scheduler, step count, and learning rate unchanged. Once the run is stable, test LR or weight decay separately. Changing the NS coefficients and iteration count together makes the result difficult to interpret; adjust one at a time.

<!-- doc-anchor: gradient-clipping -->
### Max gradient norm

`max_grad_norm=1` is the common start; `0` disables it. StableAdamW works with it normally.

Combining `percentile_clipping=95` with a smaller `max_grad_norm` can clip the same update twice. Without log evidence, keep just one gentler clip.

<!-- doc-anchor: percentile-clipping -->
### Percentile clipping

Applies only to AdamW8bit, PagedAdamW8bit, Lion8bit, and PagedLion8bit.

- `100`: off, and the default
- `99`: a gentle experimental comparison
- `95`: a stronger experimental comparison, only after confirming actual gradient outliers

`99` and `95` are engineering starting points without Anima LoRA validation. This feature follows recent gradient-norm work and does not judge image quality. If clipping is too aggressive, rare but genuine updates from unusual outfits, expressions, or compositions can be weakened too.

<!-- doc-anchor: min-8bit-size -->
### Minimum 8-bit tensor size

Default `4096`; tensors stay FP32 below this size.

In low-rank runs with suspected small-tensor issues, test `16384`: more of the adapter receives FP32 optimizer state for a small VRAM increase. This does not change the precision of the model parameters themselves.

<!-- doc-anchor: stableadamw-options -->
### StableAdamW-only options

`kahan_sum=True` reduces rounding error with compensated summation, mainly for cases where the LoRA trainable weights themselves are FP16/BF16. The project leaves LoRA trainable weights at FP32 under `mixed_precision=bf16`; only `full_bf16` converts them too. Without `full_bf16`, Kahan summation usually makes little difference.

`weight_decouple=True` runs the AdamW-style decoupled decay. With `weight_decay=0` this switch changes nothing; still, keep it on.

<!-- doc-anchor: came-clipping -->
### CAME's internal clipping

`came_clip_threshold` clips the RMS of CAME's internal updates, default `1.0`. It is distinct from the global `max_grad_norm`; keep the default and tune only if spikes recur under fixed conditions.

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free warmup

AdamWScheduleFree uses its internal `warmup_steps`, so the external `lr_warmup_steps` turns off. Schedule-Free upstream recommends warmup; this project leaves the internal `warmup_steps=0` because any larger fixed warmup competes with the short few-shot runs. `1e-4` is an experimental starting point without thorough Anima validation, not an official optimum.

<!-- doc-anchor: stochastic-rounding -->
### Stochastic rounding

Stochastic rounding reduces the drift from low-precision updates that consistently round the same direction. ProdigyPlus carries the library default; this trainer adds no separate switch. It is a numerical detail, not data augmentation.

<!-- doc-anchor: loraplus -->
### LoRA+

LoRA+ works with AdamW, 8-bit AdamW, StableAdamW, Lion, CAME, and AdamWScheduleFree. It is not available with Prodigy, ProdigyPlus, or EmoSens, and AdaFactor only offers it after turning off relative step mode.

After switching optimizers, reassess the LoRA+ ratio. The ratio scales the effective LR of part of the LoRA parameters and gives no independent visual benefit.

<!-- doc-anchor: scenarios -->
## By dataset type

<!-- doc-anchor: one-image -->
### A lone illustration

For Anima, start AdamW8bit at `1e-5`–`2e-5` and raise checkpoint cadence. SDXL follows its own separate baseline. The biggest risk here is imprinting a single pose and composition; StableAdamW can only level update spikes, not synthesize profiles, backs, or expressions.

<!-- doc-anchor: few-shot -->
### 2–5 images, few-shot

Run the AdamW8bit baseline first. Compare CAME at identical steps when the source images differ in quality, and add StableAdamW when the log spikes. Fancy internal schedules rarely have enough steps in short runs to show an effect.

<!-- doc-anchor: galgame -->
### Galgame expression sets

Compositions are usually rigid here, and AdamW8bit often suffices. Correct expression captions matter more than an optimizer swap, and the fixed background or standing pose should not train itself into the identity. If expressions are badly unbalanced, add one CAME comparison.

<!-- doc-anchor: dmm-mixed -->
### DMM cards, effects, companion characters mixed

Remove or correctly caption companion characters, text, watermarks, effects, and the different forms, then compare AdamW8bit and CAME. If the log still shows instability, add a StableAdamW comparison. No optimizer can learn which character is the subject.

<!-- doc-anchor: mixed-quality -->
### Mixed-quality inputs

Remove blur, compressed screenshots, duplicated crops, and consecutive Live2D frames first. Images you must keep, control through captions, grouping, and repeats. Comparing CAME is fine; with 8-bit optimizers test `percentile_clipping=99` first, hold off on `95`.

<!-- doc-anchor: outfits-forms -->
### Multiple outfits and forms

This scenario depends on accurate outfit/form tags and sane grouped sampling more than the optimizer. AdamW8bit, CAME, and StableAdamW all work; evaluate costume control, identity retention, and form mixing, not just how crisp one preview looks.

<!-- doc-anchor: style-lora -->
### Style LoRAs

Start with AdamW8bit there too. Generalization depends mostly on subject coverage and captions that separate content from style. StableAdamW can absorb a bad batch, but heavy clipping can also dilute rare stylistic traits.

<!-- doc-anchor: vram -->
### When memory is tight

Use AdamW8bit or Lion8bit first, and switch to paging only when there is confirmed memory pressure. When paging actually engages, the CPU–GPU state transfer can make the run slower. Keep `min_8bit_size` at `4096`
to avoid quantizing many tiny tensors just to save scraps of state memory.

<!-- doc-anchor: starting-configs -->
## Conservative starting configs

| Use | Optimizer and parameters | Other settings |
| --- | --- | --- |
| Anima general baseline | AdamW8bit, LR from the table above, `weight_decay=0.01` | constant scheduler, `max_grad_norm=1`, default rank/alpha, DiT only |
| Anima mixed-source comparison | CAME, LR from the table above, otherwise defaults | constant, `max_grad_norm=1`; validate with a fixed condition |
| Anima gradient-spike comparison | StableAdamW, LR from the table above, keep project stability defaults | Kahan on, constant, `max_grad_norm=1` |
| Anima Lion experiment | Lion or Lion8bit, LR from the table above | constant; not the full official Lion recipe |
| Gentle 8-bit clipping | AdamW8bit with baseline params, `percentile=99` | nothing else changes |

On overfitting, most often reduce steps, repeats, or LR; on underfitting, check trigger words and the effective step count; on logged spikes, locate the offending batch before trying clipping or StableAdamW.

<!-- doc-anchor: troubleshooting -->
## Troubleshooting by symptom

| Symptom | Check first | Optimizer action worth trying |
| --- | --- | --- |
| Loss plateaus but previews are poor | Data, captions, preview prompt, checkpoint timing | Usually not an optimizer switch |
| Isolated, reproducible loss or gradient spikes | The batch, its images, the LR | Compare StableAdamW, or test `percentile_clipping=99` alone |
| NaN / Inf appears | Stop immediately; check LR, precision settings, bad data, and resume points | Only after those are ruled out compare StableAdamW; do not mask a persistent problem with clipping |
| Optimizer state overflows memory | Confirm the peak is state, not resolution, batch, or preview | Use 8-bit first, paged only if still tight |
| Pose, background, or outfit memorized quickly | Steps, repeats, LR, data duplication | Reduce LR or shorten training; switching optimizers rarely fixes this |
| Character traits never quite acquire | Trigger word, captions, useful steps, rank, targets | After checking those, raise the LR a bit |

<!-- doc-anchor: ab-testing -->
## A/B

1. Fix the dataset, captions, the seed, the base model, VAE, rank/alpha, batch, and total steps.
2. Fix the preview prompt, sampler settings, and generation seed.
3. Anima comparisons use the matching engineering start from the LR table above. That compares the full default recipes; to isolate optimizer-alone differences, run an equal-LR experiment.
4. Compare checkpoints at the full logical steps, bundling the gradient norm, peak memory, and -step per config.
5. Judge on fidelity, costume control, pose/background binding, and prompt response, not just loss.

Always start each comparison from the same base model. Do not load state trained under one optimizer and then switch; momentum and state layouts are not interchangeable.

Prodigy and other optimizers on a different LR scale fall outside the single-variable comparison above. Tune each to a reasonable point first, then compare whole configurations, and phrase the conclusion as "this configuration suits this dataset," not the optimizer alone.

Changing the optimizer, LR, rank, and step count at the same time makes the result uninformative. Even if it improves, you cannot see which change caused it.

<!-- doc-anchor: limits -->
## What the optimizers will not do

- CAME acts on gradients and optimizer state only; it will not automatically downweight low-quality images.
- StableAdamW mainly steadies updates; a stable baseline run may show almost no quality difference, so evaluate it honestly.
- Vector-paged optimizers only change memory placement; there is no separate quality benefit, and real paging can slow the run.
- No optimizer by itself prevents overfitted samples' memorization; stopping point, repeat counts, and data variety matter more.
- Since optimizers run in different LR ranges, equal LR is not automatically an equal comparison.

<!-- doc-anchor: faq -->
## Frequently asked questions

**Why is the learning rate replaced after I switch model type or optimizer?**

The UI replaces a recommended value only when it has not been manually edited. Manually adjusted values, imported configurations, and custom values are preserved.

**Why is the Prodigy learning rate locked to `1.0`?**

Prodigy is a D-adaptation-style adaptive optimizer that uses the learning rate as a scaling baseline. The sd-scripts documentation recommends setting it near `1.0`, so the UI locks it and explains why.

**Why is StableAdamW's weight decay `0` in the generated configuration?**

The package default is `0.01`. This trainer deliberately writes `weight_decay=0` to align the starting point with the AdamW baseline. It is an intentional override, not a missing parameter.

**Why was LoRA+ turned off after I switched optimizer?**

Prodigy, ProdigyPlus, and EmoSens cannot reliably preserve per-group learning rates, and AdaFactor owns the learning rate in its default relative-step mode. The UI turns LoRA+ off and shows the reason; backend validation also rejects incompatible combinations submitted through older presets or the API.

**When training goes wrong, should I change the optimizer or inspect the data first?**

Inspect the dataset, captions, repeats, learning rate, and stopping point first. Optimizers mainly affect convergence speed, state memory, and numerical stability; they are usually not the primary factor in character fidelity.

<!-- doc-anchor: evidence -->
## Evidence and references

Evidence-check date: **2026-08-05**. The code and model card links below are fixed to the commits checked.

**Implementation facts:** This project loads `pytorch_optimizer.StableAdamW` through the exact sd-scripts class path. In the installed `pytorch-optimizer 3.10.0`, its constructor defaults are `betas=(0.9,0.99)`, `eps=1e-8`, `weight_decay=0.01`, `weight_decouple=True`, `kahan_sum=True`. This project deliberately overrides `weight_decay=0`.

**Model and upstream basis:** The Anima model card recommends Anima-Base, DiT-only training, and rank 32 starting near `2e-5`, and does not fix `alpha=32`. The sd-scripts Anima document marks `1e-4` as an `alpha=1` example and requires re-lowering or validating LR when alpha goes up.

**Paper basis:** CAME, Lion, Prodigy, Schedule-Free, and LoRA+ papers explain their algorithms and report their tasks. CAME's `0.5`–`0.9`× and Lion's `1/3`–`1/10` LR rules are relative to AdamW official tuning; results on language models, classification, or other diffusion tasks do not directly rank image quality for Anima character LoRA.

**Experience-based judgments, test yourself:** CAME may suit mixed-source data, StableAdamW may tolerate spike batches. These are community and engineering experience, and validated by fixed-condition A/B tests on the current dataset.

References:

- [Anima model card at a fixed commit](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [sd-scripts Anima training docs at a fixed commit](https://github.com/kohya-ss/sd-scripts/blob/37a1cbbc5725ed2a3575506e7bd2001c9908ac92/docs/anima_train_network.md)
- [CAME official implementation and notes at a fixed commit](https://github.com/yangluo7/CAME/tree/e77c5c022eaf71f1efb82a1433032cdcd5c52610)
- [Lion official implementation and notes at a fixed commit](https://github.com/google/automl/tree/6a54c8741e7c3265d4547c4f35f47a0391122dc5/lion)
- [Schedule-Free official implementation and notes at a fixed commit](https://github.com/facebookresearch/schedule_free/tree/70785b53e778d0e872c0bbb75ff4ee54ee10c291)
- [Transformers cosine restart scheduler implementation at a fixed commit](https://github.com/huggingface/transformers/blob/71c6f699ac9b3f8fc42a6a3e9dc59034c349a678/src/transformers/optimization.py)
- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms (Lion)](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low-Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [pytorch-optimizer implementation at a fixed commit](https://github.com/kozistr/pytorch_optimizer/tree/3d08fa02cb6617d4d12365ca0f7d643b72e8cbe8)
- [bitsandbytes optimizer implementation at a fixed commit](https://github.com/bitsandbytes-foundation/bitsandbytes/tree/a2b90e6eae31a958e6b4d85edf2cfb2b91e9ce29)
