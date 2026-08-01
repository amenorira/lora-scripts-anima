# Optimizer Mechanisms and Parameter Reference

An optimizer converts gradients into parameter updates. Implementations differ in how they track state, store that state, derive step size, apply clipping, and manage scheduling. Optimizers do not read image semantics and cannot identify a target character, incorrect captions, or missing viewpoints.

This guide describes the current implementation and its parameter relationships. When the optimizer changes, the UI may update the learning rate, `betas`, `weight_decay`, and scheduler. These linkages are configuration behavior; they do not rank algorithms or predict training results.

<!-- doc-anchor: quick-choice -->
## Mechanism quick reference

| Mechanism | Implementations | Observable effect |
| --- | --- | --- |
| First- and second-order state | AdamW, StableAdamW, Prodigy | Gradient history and squared-gradient history both affect update scale |
| Sign-direction update | Lion family | The update direction is the sign of a momentum/current-gradient mixture |
| Factored state | AdaFactor, CAME | Squared-gradient statistics for 2-D parameters use row and column factors |
| Low-bit state storage | AdamW8bit, Lion8bit | Quantizable optimizer state is stored in 8-bit form |
| Paged state | PagedAdamW8bit, PagedLion8bit | State pages transfer between CPU and GPU when paging is active |
| Internal scheduling | AdamWScheduleFree, ProdigyPlusScheduleFree | Parameter averaging and scheduling occur inside the optimizer |
| Project experimental state | Automagic3, EmoSens | Gradient-sign history or loss history adjusts the global update scale |

<!-- doc-anchor: optimizer-type -->
## Current optimizers

| Group | Optimizer | Update mechanism |
| --- | --- | --- |
| AdamW and state-storage variants | AdamW | Exponential moving averages of gradients and squared gradients, adaptive scaling, decoupled weight decay |
| AdamW and state-storage variants | AdamW8bit | AdamW updates with quantizable state stored in 8-bit form |
| AdamW and state-storage variants | PagedAdamW8bit | 8-bit AdamW state with state paging |
| AdamW and state-storage variants | `pytorch_optimizer.StableAdamW` | AdamW-style state, update RMS clipping, and Kahan summation |
| Sign updates | Lion | Sign-direction updates and one momentum state |
| Sign updates | Lion8bit | Lion updates with quantizable momentum state stored in 8-bit form |
| Sign updates | PagedLion8bit | 8-bit Lion state with state paging |
| Factorized states | AdaFactor | Factorized squared-gradient statistics and optional relative step |
| Factorized states | CAME | Factorized state, residual-confidence estimation, and internal RMS clipping |
| Step-size estimation and internal scheduling | Prodigy | D-adaptation step-size estimation |
| Step-size estimation and internal scheduling | ProdigyPlusScheduleFree | D-adaptation and a Schedule-Free parameter sequence |
| Step-size estimation and internal scheduling | AdamWScheduleFree | AdamW-style state and a Schedule-Free parameter sequence |
| Project experimental implementations | Automagic3 | Gradient-sign history, parameter-group learning-rate adaptation, and internal clipping |
| Project experimental implementations | EmoSens | Moving average of loss, global learning-rate multiplier, and stop signal |

The 8-bit and paged descriptions refer only to optimizer state. Peak training VRAM also includes model weights, activations, gradients, caches, and sampling.

<!-- doc-anchor: stable-comparison -->
## AdamW8bit, CAME, and StableAdamW

| Implementation | State and update | Additional behavior |
| --- | --- | --- |
| AdamW8bit | First- and second-order AdamW state; quantizable state stored in 8-bit form | bitsandbytes applies `percentile_clipping` to recent gradient norms |
| CAME | Factored second-order state, first-order normalized-update state, residual-square confidence state | Confidence scaling and internal update RMS clipping |
| StableAdamW | Full AdamW-style first- and second-order state | Update RMS clipping; Kahan summation compensates low-precision parameter accumulation |

All three process numerical updates only. Image quality, identity, outfit tags, and repeated composition are not classified by the optimizer.

<!-- doc-anchor: parameters -->
## Parameter reference

<!-- doc-anchor: learning-rate -->
### Learning rate

Learning rate controls the overall scale of each parameter update. AdamW, Lion, CAME, and StableAdamW use it as an external step size. AdaFactor derives a step from training progress when `relative_step=true`. Prodigy-family optimizers combine the input learning rate with a scale estimated through D-adaptation. Automagic3 and EmoSens also generate dynamic multipliers internally.

The project currently uses the automatic values below. The UI writes them only when the corresponding linkage conditions apply; manual and imported values continue to follow the existing source rules:

| Training configuration | Selection | Automatic learning rate |
| --- | --- | ---: |
| Anima | AdamW / AdamW8bit / PagedAdamW8bit / StableAdamW | `2e-5` |
| Anima | Lion / Lion8bit / PagedLion8bit | `5e-6` |
| Anima | CAME | `1.5e-5` |
| Anima | AdamWScheduleFree | `1e-4` |
| Anima | AdaFactor with `relative_step=false` | `2e-5` |
| Anima | EmoSens | `0.1` |
| General sd-scripts | Prodigy / ProdigyPlusScheduleFree | `1.0` |
| General sd-scripts | Automagic3 | `1e-4` |
| SDXL | CAME / StableAdamW | `1e-4` |
| SDXL | Lion family | `2e-5` |
| SDXL | AdamWScheduleFree | `3e-4` |

`network_alpha / network_dim` scales the LoRA branch, so the same optimizer learning rate does not represent the same LoRA-branch scale for every alpha/dim combination.

<!-- doc-anchor: scheduler-warmup -->
### External scheduler and warmup

AdamW, 8-bit/Paged AdamW, StableAdamW, Lion, CAME, and manual-step AdaFactor use the external scheduler, which also handles `lr_warmup_steps`. `cosine_with_restarts` produces multiple cycles in one run only when `num_cycles` is greater than 1; `num_cycles=1` does not restart mid-run.

AdamWScheduleFree and ProdigyPlusScheduleFree manage parameter averaging and scheduling inside the optimizer. The external scheduler is therefore fixed to `constant`, and `lr_warmup_steps` does not participate in training. AdaFactor also derives its step internally when `relative_step=true`, so the external scheduler does not participate.

<!-- doc-anchor: betas -->
### Exponential moving-average decay coefficients (betas)

Larger values retain a larger proportion of historical state and give the current observation a smaller share of this state update.

| Optimizer mechanism | Count | Meaning |
| --- | ---: | --- |
| AdamW, 8-bit/Paged AdamW, StableAdamW, EmoSens | 2 | `β1` controls the gradient moving average; `β2` controls the squared-gradient moving average |
| Lion family | 2 | `β1` controls the historical-momentum/current-gradient mix used for the current sign direction; `β2` controls the momentum state stored for later steps |
| CAME | 3 | `β1` controls the first-order normalized-update state; `β2` controls squared-gradient statistics; `β3` controls residual-square statistics between the normalized update and first-order state and contributes to confidence scaling |
| Prodigy | 2 | `β1` and `β2` control first- and second-order states; D-adaptation's additional decay is separate from this input |
| AdamWScheduleFree, ProdigyPlusScheduleFree | 2 | `β1` participates in combining current and averaged parameter sequences; `β2` controls squared-gradient statistics |

The UI resolves the corresponding explanation and validates the count for the selected optimizer.

<!-- doc-anchor: eps -->
### Numerical stability term (eps)

`eps` is added to adaptive-scaling denominators or related statistics to limit numerical amplification as a denominator approaches zero. It affects a numerical lower bound, not image content or regularization strength. AdaFactor uses a separate two-value `eps` input.

<!-- doc-anchor: weight-decay -->
### Weight decay

Weight decay shrinks parameters during updates. AdamW-style decoupled decay is applied outside the gradient update; coupled decay enters gradient-related computation. `weight_decay=0` applies no decay.

The CAME UI field `came_weight_decouple` maps to the actual argument `weight_decouple`, which selects the decoupled form. The UI field `came_fixed_decay` maps to CAME's actual `fixed_decay` argument and participates only in that branch. StableAdamW also uses `weight_decouple` to select the same decay form.

<!-- doc-anchor: gradient-clipping -->
### Maximum gradient norm

`max_grad_norm` scales gradients by the global gradient norm before the optimizer update; `0` disables this global clipping. CAME, AdaFactor, StableAdamW, and bitsandbytes can also clip internal updates or statistics. When several clipping mechanisms are active, they operate at different points in the computation.

<!-- doc-anchor: percentile-clipping -->
### Percentile clipping

`percentile_clipping` is consumed only by AdamW8bit, PagedAdamW8bit, Lion8bit, and PagedLion8bit. bitsandbytes uses the recent gradient-norm distribution to limit the current norm; `100` means that this percentile clipping is off. Lower thresholds scale more gradients near the upper end of that recent distribution.

<!-- doc-anchor: min-8bit-size -->
### Minimum 8-bit tensor size

`min_8bit_size` is the element-count threshold for bitsandbytes state quantization. Tensors smaller than the threshold retain FP32 optimizer state. Increasing the threshold leaves more small tensors in FP32 state and increases the corresponding state memory; it does not change model-weight dtype.

<!-- doc-anchor: stableadamw-options -->
### StableAdamW options

`kahan_sum=true` keeps a compensation term for parameter updates, reducing rounding loss when small updates accumulate into FP16/BF16 trainable parameters. With only `mixed_precision=bf16`, sd-scripts can keep trainable LoRA parameters in FP32; `full_bf16` changes the trainable-parameter dtype, so the scope of Kahan compensation depends on the actual dtype.

`weight_decouple=true` applies AdamW-style decoupled weight decay. With `weight_decay=0`, the decay branch does not change parameters.

<!-- doc-anchor: came-clipping -->
### CAME internal clipping

`came_clip_threshold` clips the RMS of CAME's normalized update. It is applied during CAME's internal update construction and is separate from pre-update global `max_grad_norm`.

`came_fixed_decay` is shown and emitted only for CAME when `came_weight_decouple=true`. It is the UI field; generated CAME optimizer arguments use the actual name `fixed_decay`. Enabling fixed decay makes the decay amount independent of the current learning-rate scale.

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free internal warmup

`schedulefree_warmup_steps` is an AdamWScheduleFree constructor argument that changes early internal step sizes. It is not passed to ProdigyPlusScheduleFree and is separate from external `lr_warmup_steps`.

<!-- doc-anchor: stochastic-rounding -->
### Stochastic rounding

ProdigyPlusScheduleFree stochastic rounding selects adjacent representable values with probabilities based on the discarded fraction when writing low-precision values. It reduces persistent directional rounding bias and does not alter samples or captions.

<!-- doc-anchor: loraplus -->
### LoRA+

LoRA+ assigns different effective learning rates to LoRA matrix components. AdamW, 8-bit/Paged AdamW, StableAdamW, Lion, CAME, and AdamWScheduleFree accept LoRA+ arguments. Prodigy, ProdigyPlusScheduleFree, and EmoSens do not; AdaFactor accepts them when `relative_step=false`.

<!-- doc-anchor: scenarios -->
## Dataset cases and capability boundaries

<!-- doc-anchor: one-image -->
### One image

Every optimizer repeatedly receives the evidence contained in the same image. Changing state statistics does not create missing viewpoints, expressions, or compositions; steps, repeats, and learning rate determine how strongly that evidence accumulates.

<!-- doc-anchor: few-shot -->
### Few-shot images

With few samples, a single batch contributes a larger share of total updates. Clipping can change the magnitude of an outlier numerical update, but it cannot determine whether that batch contains a valid rare feature or erroneous data.

<!-- doc-anchor: galgame -->
### Galgame sprites

Repeated poses, backgrounds, and crops enter the gradient as repeated evidence. The optimizer processes the numerical history and does not separate identity from shared composition.

<!-- doc-anchor: dmm-mixed -->
### DMM cards and mixed sources

Cards, captures, sprites, and effects can produce different gradient scales. CAME confidence state, StableAdamW update RMS clipping, and bitsandbytes percentile clipping act at different locations, but none reads the source category.

<!-- doc-anchor: mixed-quality -->
### Uneven quality

Blur, compression, duplicate crops, and consecutive frames all change the training signal. The optimizer does not automatically reduce their sampling weight; grouping, captions, and repeats determine how often and under which conditions they enter training.

<!-- doc-anchor: outfits-forms -->
### Multiple outfits or forms

Outfit and form binding comes from sample co-occurrence and caption conditions. The optimizer changes the update trajectory but does not create missing label boundaries.

<!-- doc-anchor: style-lora -->
### Style LoRA

Subject coverage and content/style captions determine whether style and subject signals are separated. Internal clipping affects both abnormal updates and numerically large updates from rare style features.

<!-- doc-anchor: vram -->
### Optimizer-state VRAM

8-bit state reduces the storage width of quantizable state. Paged variants move state pages to CPU when GPU memory pressure activates paging, adding CPU/GPU transfers. AdaFactor and CAME reduce corresponding second-order state through factorization.

<!-- doc-anchor: starting-configs -->
## Automatic linkages and hard relationships

| Condition | Configuration result | Reason |
| --- | --- | --- |
| AdamWScheduleFree / ProdigyPlusScheduleFree | External scheduler is `constant`, external warmup is `0` | Scheduling is managed inside the optimizer |
| AdaFactor with `relative_step=true` | External scheduler does not participate; LoRA+ is not emitted | AdaFactor generates the step internally |
| Prodigy / ProdigyPlusScheduleFree | Automatic base learning-rate value is `1.0` | The input learning rate participates in D-adaptation scale calculation |
| CAME with UI field `came_weight_decouple=false` | `came_fixed_decay` is hidden and omitted | The actual `fixed_decay` argument belongs only to the decoupled branch |
| 8-bit/Paged bitsandbytes optimizer | `percentile_clipping` and `min_8bit_size` are visible | Both are consumed by the bitsandbytes state implementation |
| Internal-scheduler optimizer | External scheduler controls reflect hard configuration only | External scheduler does not update parameters |

<!-- doc-anchor: troubleshooting -->
## Symptoms and observable measurements

| Symptom | Measurements that distinguish causes | Optimizer mechanisms |
| --- | --- | --- |
| Isolated gradient spike | Corresponding batch, gradient norm, and pre/post-clipping norm | Global clipping, percentile clipping, update RMS clipping |
| NaN / Inf | First step, parameter dtype, VAE output, learning rate, and resume state | `eps` and internal stability terms cover their own denominators; they do not repair invalid inputs |
| GPU out of memory | Separate parameter, activation, gradient, optimizer-state, and cache use | 8-bit state, factored state, paged state |
| Stable loss but unsuitable previews | Multiple fixed-prompt checkpoints, captions, and sample co-occurrence | Optimizer handles gradients; loss is not a complete generation objective |
| Fast memorization | Effective steps, repeats, learning rate, and duplicate samples | State history and step size determine update accumulation |

<!-- doc-anchor: ab-testing -->
## Conditions for attributable comparisons

Differences can be attributed to optimizer-related variables only when the dataset, captions, base model, random seed, rank/alpha, batch size, gradient accumulation, total optimizer steps, and preview conditions remain fixed. Changing the optimizer and learning rate together measures the difference between the complete configurations.

Optimizer state structures are not interchangeable. Resuming a state saved by another optimizer changes initial momentum, second-order statistics, and step-size state at the same time. D-adaptation optimizers also introduce an independent historical scale.

<!-- doc-anchor: limits -->
## Scope

- Optimizers do not identify image quality, character identity, outfit category, watermarks, or companion characters.
- Clipping operates on numerical magnitude and cannot tell whether a large update is bad data or a valid rare feature.
- Paged variants change state memory placement and do not provide an independent image-quality objective.
- Internal schedulers change parameter sequences and step-size history; external schedulers do not participate in those implementations.
- Training loss is an aggregate value, not the same as identity retention, style generalization, or prompt response.

<!-- doc-anchor: evidence -->
## Implementation evidence and references

Fact-checked on **2026-07-31**. Project behavior follows the field metadata, adapter, and pinned upstream implementations in this repository.

The trainer loads `pytorch_optimizer.StableAdamW` through sd-scripts' full-class-path mechanism. The installed `pytorch-optimizer 3.10.0` constructor includes `betas=(0.9,0.99)`, `eps=1e-8`, `weight_decay=0.01`, `weight_decouple=true`, and `kahan_sum=true`; generated configuration values override constructor values according to the UI state.

References:

- [Anima model card (pinned revision)](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [sd-scripts Anima training guide (pinned revision)](https://github.com/kohya-ss/sd-scripts/blob/37a1cbbc5725ed2a3575506e7bd2001c9908ac92/docs/anima_train_network.md)
- [CAME implementation (pinned revision)](https://github.com/yangluo7/CAME/tree/e77c5c022eaf71f1efb82a1433032cdcd5c52610)
- [Lion implementation (pinned revision)](https://github.com/google/automl/tree/6a54c8741e7c3265d4547c4f35f47a0391122dc5/lion)
- [Schedule-Free implementation (pinned revision)](https://github.com/facebookresearch/schedule_free/tree/70785b53e778d0e872c0bbb75ff4ee54ee10c291)
- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [pytorch-optimizer implementation (pinned revision)](https://github.com/kozistr/pytorch_optimizer/tree/3d08fa02cb6617d4d12365ca0f7d643b72e8cbe8)
- [bitsandbytes implementation (pinned revision)](https://github.com/bitsandbytes-foundation/bitsandbytes/tree/a2b90e6eae31a958e6b4d85edf2cfb2b91e9ce29)
