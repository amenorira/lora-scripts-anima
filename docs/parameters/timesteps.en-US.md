# Flow-matching Training Timesteps

> A timestep controls how much noise is mixed into a training image and how learning opportunities are distributed across low-noise detail, mid-noise features, and high-noise structure. It is not the number of optimizer updates already completed, nor the number of sampling steps used for generation.

This guide primarily covers the flow-matching timestep controls used by **Anima** and **Krea 2** in this trainer. SDXL follows a different diffusion training path; its timestep range controls are covered separately near the end.

<!-- doc-anchor: quick-start -->
## A practical starting point

If you cannot yet diagnose which noise region needs more attention, keep the defaults for the selected training profile. A common Anima LoRA baseline is:

```toml
timestep_sampling = "sigmoid"
sigmoid_scale = 1.0
weighting_scheme = "uniform"
```

This emphasizes the middle of the noise path while retaining some low- and high-noise coverage. It is a sensible first baseline for characters, styles, and ordinary concepts.

Timestep controls are advanced tuning tools. Dataset curation, captions, learning rate, and stopping time usually matter more. Train a default baseline first, then change one timestep parameter while keeping prompts, random seeds, inference settings, and checkpoint steps (saved training snapshots) fixed.

<!-- doc-anchor: terminology -->
## Three different kinds of “steps”

| Name | Meaning | Typical parameter |
| --- | --- | --- |
| Training steps | How many times the optimizer updates LoRA parameters | `max_train_steps` |
| Training timestep | The noise level assigned to the current training sample | `timestep_sampling` |
| Generation steps | Numerical solver steps used to travel from noise to an image | `sample_steps` |

Optimizer step 500 and noise timestep `t≈500` do not mean that the same process is halfway complete. Within one optimizer update, different images may also receive different noise timesteps.

<!-- doc-anchor: flow-matching -->
## What a timestep does during training

Let `x` be the VAE latent (the image representation processed by the model), `ε` be random noise, and `t∈[0,1]` be the normalized timestep. The Anima and Krea 2 training input can be understood as:

```text
x_t = (1 - t) * x + t * ε
```

- `t≈0`: the input is still close to the image latent, the low-noise region.
- `t≈0.5`: image and noise are strongly mixed, the mid-noise region.
- `t≈1`: the input is close to pure noise, the high-noise region.

The current Anima implementation trains the model to predict the flow direction `ε-x`. Inference reverses the journey: it starts at high noise and follows the learned direction toward a clean image.

### What each region tends to teach

| Region | Input state | Training effects that often become visible |
| --- | --- | --- |
| Low noise | Most image information remains | Lines, texture, color, facial details, garment details |
| Mid noise | Image and noise are strongly mixed | A balance of identity, style, shape, and detail |
| High noise | Little image information remains | Semantics, silhouette, pose, composition, global structure |

This is an intuition aid, not a strict partition of model capabilities. Detail, identity, and composition span many timesteps, and every region is still affected by the dataset, captions, and base model.

Training code also commonly uses `sigma` for the noise mixing ratio. In the flow-matching paths covered here, it can be read in the same direction as `t`: values near `0` are clean and values near `1` are close to pure noise. The UI displays this range as approximately `0–1000` for readability.

<!-- doc-anchor: visualizer -->
## Read the current distribution

<div data-doc-widget="timestep-preview"></div>

The **blue bars** show how often a timestep is sampled. Taller bars mean that training encounters that noise region more often. The 32 bars are histogram bins covering the full range; the trainer does not have only 32 timesteps. Bar height is normalized to the tallest bin and is not a direct probability axis.

The **orange curve** shows the additional per-timestep loss weight after a sample has been drawn. Loss is the error between the model prediction and its training target, which the trainer uses to update LoRA. The curve uses a logarithmic display scale, is not the observed training loss, and cannot be compared directly with the blue bar height. A flat orange line means equal explicit weighting across timesteps, not a fixed loss value.

The effective contribution of a region can be approximated as:

```text
sampling probability * loss weight * error produced by the current batch
```

The final term changes with images, captions, and training progress. The chart therefore describes sampling opportunities and explicit weighting, not an exact prediction of learned capacity.

The preview uses 32,768 deterministic simulations, so identical settings produce a stable chart. Rounded low/mid/high percentages can total `99.9%` or `100.1%`. The preview never starts training or modifies the TOML training configuration.

<!-- doc-anchor: defaults -->
## Profile defaults

| Training profile | Default sampling | Default distribution parameters | Default loss weighting |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`, `discrete_flow_shift=2.5` | `none` |

`uniform` and `none` both mean no extra per-timestep loss weighting in the current implementations. `none` also serves compatibility with older configurations and training backends. After importing an old preset, trust the values shown in the form and distribution preview.

<!-- doc-anchor: sampling -->
## `timestep_sampling`: where samples come from

This parameter primarily shapes the blue histogram: it chooses which parts of the noise path are sampled most often.

| Option | Behavior | Availability |
| --- | --- | --- |
| `sigmoid` | Applies sigmoid to a scaled normal value, usually emphasizing mid noise | Anima, Krea 2 |
| `uniform` | Samples uniformly across the full range | Anima, Krea 2 |
| `shift` | Applies a fixed flow shift to a sigmoid distribution | Anima, Krea 2 |
| `sigma` | Samples from scheduler sigmas; some weighting schemes can change density | Anima, Krea 2 |
| `flux_shift` | Computes a FLUX-style shift from the current resolution | Anima |
| `krea2_shift` | Computes a Krea 2 shift from the current resolution | Krea 2 |
| `logsnr` | Creates timesteps from a LogSNR distribution | Krea 2 |

### `sigmoid`

```text
z ~ Normal(0, 1)
t = sigmoid(sigmoid_scale * z)
```

With `sigmoid_scale=1.0`, the distribution is symmetric and concentrated near the middle. In a typical 1024×1024 preview, roughly 21% falls in the low-noise region, 57% in the middle, and 21% in the high-noise region. Exact displayed values depend on histogram boundaries and settings.

### `uniform`

`uniform` samples directly across the full range. Compared with the default sigmoid distribution, it substantially increases both endpoint regions. It is not automatically better because it looks more even: with a small or repetitive dataset, the endpoints can also learn image-specific detail and dataset-wide composition bias more aggressively.

### `shift`

`shift` starts from a sigmoid distribution and applies a fixed displacement. Use it after controlled comparisons show that the model needs more high- or low-noise training, rather than making a large change from the words “structure” or “detail” alone.

### `sigma`

`sigma` selects noise levels from the discrete training scheduler. `discrete_flow_shift` changes that noise schedule. When `weighting_scheme` is `logit_normal` or `mode`, it also changes sampling density.

With `sigma_sqrt` or `cosmap`, sigma sampling still uses the ordinary density; those options change the loss after sampling.

### `flux_shift` and `krea2_shift`

These modes derive the shift from the current latent token count, meaning the size of the compressed image-feature grid. Higher resolutions can produce a distribution with more high-noise emphasis. They do not read the fixed `discrete_flow_shift` value.

With buckets enabled, images of similar resolution and aspect ratio are grouped for training, and every bucket uses its own latent dimensions. A preview at the reference resolution cannot represent every bucket in the dataset.

### `logsnr`

SNR is the ratio of signal strength to noise strength; LogSNR is its logarithmic representation. Higher LogSNR means more signal and less noise. Krea 2 `logsnr` first draws LogSNR from a normal distribution defined by `logit_mean` and `logit_std`, then converts it to a timestep:

```text
logSNR ~ Normal(logit_mean, logit_std)
t = sigmoid(-logSNR / 2)
```

It shares parameter names with `sigma + logit_normal`, but the transformation path is different. Use the distribution preview instead of inferring the final direction from parameter signs alone.

<!-- doc-anchor: sigmoid-scale -->
## `sigmoid_scale`: how far the distribution spreads

`sigmoid_scale` is used by `sigmoid`, `shift`, `flux_shift`, and `krea2_shift`.

- Near `0`: samples collapse toward `t≈0.5`.
- `1.0`: mid-noise emphasis with meaningful endpoint coverage.
- `1.2–1.5`: both low- and high-noise coverage increase.
- Very large values: the distribution may become overly concentrated near both endpoints.

Increasing the value is not a general quality switch. It can increase opportunities for detail and structure, but also makes backgrounds, fixed compositions, compression artifacts, and caption mistakes easier to learn.

<!-- doc-anchor: flow-shift -->
## `discrete_flow_shift`: move the distribution to one side

```text
shifted_t = shift * t / (1 + (shift - 1) * t)
```

- `1.0`: no displacement.
- Greater than `1.0`: moves the distribution toward high noise.
- Less than `1.0`: moves it toward low noise.

It is applied directly by `shift` and through the scheduler by `sigma`. `sigmoid`, `uniform`, `flux_shift`, `krea2_shift`, and `logsnr` ignore this fixed value.

<!-- doc-anchor: weighting -->
## `weighting_scheme`: how much a sampled point counts

The name can be misleading. Some options alter loss weight, while others alter sampling density only when `timestep_sampling=sigma`.

| Option | Changes sampling density | Changes loss weight |
| --- | --- | --- |
| `uniform` / `none` | No | No |
| `sigma_sqrt` | No | Yes, emphasizes low noise with `1/sigma²` |
| `cosmap` | No | Yes, smoothly emphasizes mid noise |
| `logit_normal` | Only with `sigma` sampling | No |
| `mode` | Only with `sigma` sampling | No |

### `uniform` / `none`

No additional per-timestep weighting is applied. The orange curve remains flat. This is the easiest behavior to reason about and the best baseline for most experiments.

### `sigma_sqrt`

```text
weight = 1 / sigma²
```

This strongly increases the contribution of low-noise samples. Weight grows rapidly near the clean endpoint, which can amplify memorized detail, over-sharpening, and unstable gradients in small datasets. It is not recommended as a beginner default.

### `cosmap`

```text
weight = 2 / [pi * (1 - 2sigma + 2sigma²)]
```

This smoothly reduces the relative contribution of both endpoints and emphasizes the middle. It changes only the orange loss curve, not the blue sampling histogram.

<!-- doc-anchor: logit-normal -->
### `logit_normal`, `logit_mean`, and `logit_std`

These parameters change sampling density only with `timestep_sampling=sigma`.

- `logit_mean=0` gives a roughly symmetric density.
- Under the sigma scheduler's index direction, positive values usually move the resulting sigma toward low noise and negative values toward high noise.
- Smaller `logit_std` concentrates samples; larger values spread them toward the endpoints.

Scheduler shift also participates in the final mapping, so use the preview to confirm direction and magnitude. With `sigmoid + logit_normal`, logit-normal neither changes sampling nor adds loss weighting.

<!-- doc-anchor: mode -->
### `mode` and `mode_scale`

`mode` changes density only with `timestep_sampling=sigma` and adds no loss weighting.

- `mode_scale=0` is close to uniform density.
- Larger values concentrate more samples in the middle.
- The default `1.29` already has a clear mid-noise emphasis.

<!-- doc-anchor: compatibility -->
## Parameter activation matrix

| Parameter | sigmoid | uniform | shift | sigma | flux/krea shift | logsnr |
| --- | --- | --- | --- | --- | --- | --- |
| `sigmoid_scale` | Used | Ignored | Used | Ignored | Used | Ignored |
| `discrete_flow_shift` | Ignored | Ignored | Used | Used | Ignored | Ignored |
| `logit_mean/std` | Ignored | Ignored | Ignored | `logit_normal` density only | Ignored | Used directly |
| `mode_scale` | Ignored | Ignored | Ignored | `mode` density only | Ignored | Ignored |
| `sigma_sqrt/cosmap` loss | Used | Used | Used | Used | Used | Used |

“Ignored” means that the training code does not consume the parameter; leaving a value in the configuration does not create a hidden effect. The form hides most irrelevant fields, and the preview warns about ignored combinations.

<!-- doc-anchor: dataset-guidance -->
## How dataset size relates to timesteps

Dataset size controls the evidence available for generalization. Timestep settings decide at which noise difficulty that evidence is practiced. Smaller and more repetitive datasets should usually keep a stable mid-noise emphasis; large and genuinely diverse datasets can support broader endpoint coverage.

The following ranges are experimental starting points, not rules:

| Training case | Suggested baseline | Main concern |
| --- | --- | --- |
| 5–12 character images | `sigmoid`, scale `0.8–1.0`, `uniform` | Reduce endpoint overfitting and extract shared identity first |
| 15–40 character images | `sigmoid`, scale `1.0–1.2`, `uniform` | Balance identity, structure, and detail |
| 40–100 diverse character images | `sigmoid`, scale `1.1–1.4`, `uniform` | Broader coverage becomes safer with real diversity |
| 15–30 style images | `sigmoid`, scale `0.8–1.0`, `uniform` | Avoid binding subject and composition into the style |
| 60–200 diverse style images | `sigmoid`, scale `1.1–1.4`, `uniform` | Learn brushwork, shape language, and composition together |
| Object or structural concept | `sigmoid`, scale `1.0–1.2`, `uniform` | Stay balanced, then add high-noise coverage if silhouette is weak |

Counts refer to **effectively independent images**. Consecutive video frames, crops of one image, and highly similar card art do not provide equivalent diversity.

Ten images repeated twenty times and one hundred distinct images repeated twice may create similar exposure counts, but the former does not gain new views, poses, or backgrounds. Repeats can supply optimizer updates; they cannot create new visual evidence.

For a rough single-GPU estimate:

```text
samples per epoch = image count * repeats
optimizer updates per epoch ≈ samples / batch size / gradient accumulation
```

<!-- doc-anchor: scenarios -->
## Characters, styles, and concepts

### Few-shot characters

Few-shot character sets easily bind identity to a fixed pose, background, or composition. Start with `sigmoid 0.8–1.0 + uniform`, and avoid `sigma_sqrt` or a strong high-noise shift. If identity does not appear, inspect trigger words, captions, learning rate, and training duration before changing the timestep distribution.

### Larger character sets and fidelity

A character that remains recognizable under new poses and camera angles cannot be learned from low noise alone. Low noise supports facial and garment detail, mid noise supports stable identity, and high noise helps construct the overall character from noise. With genuinely varied data, test `sigmoid_scale=1.1–1.4` gradually while retaining the default run as a baseline.

### Few-shot and high-fidelity styles

Color, brushwork, and line quality appear strongly in low and mid noise. Proportion, shape design, lighting layout, and compositional language also involve high noise. With few style images, avoid teaching a fixed subject and composition as “the style.” Broaden coverage or test a mild high-noise shift only when subject matter is sufficiently varied.

High-fidelity style training should not simply push everything toward low noise. Low and mid noise help reproduce linework, palette, and material treatment; high noise also participates in shape language, lighting layout, and composition. With roughly 60 or more genuinely varied images, test `sigmoid_scale=1.1–1.4` progressively. If only the global shape language remains weak, test a mild high-noise shift as a separate experiment. `sigma_sqrt` is not a general-purpose “more style fidelity” switch.

Looking similar to the training images is not the same as style generalization. A transferable style LoRA should preserve its visual language on subjects and compositions absent from the dataset.

### Objects and structural concepts

Special garments, props, and mechanical forms often need mid- and high-noise training to establish semantics and silhouette. If local texture is correct but global structure is unstable, and the dataset contains enough views, test `sigmoid_scale=1.2–1.4` or a mild `shift>1`. Timestep tuning cannot infer the back of an object from front views alone.

<!-- doc-anchor: diagnosis -->
## Diagnose before adjusting

| Symptom | Timestep direction to test | Also inspect |
| --- | --- | --- |
| Identity works only with familiar poses | Raise `sigmoid_scale` moderately | View diversity, captions, overfitting |
| Fine details remain absent | Add a little endpoint coverage | Whether the source actually contains clear detail |
| The same pose or background repeats | Reduce high-noise shift and return to the sigmoid baseline | Dataset repetition and background captions |
| Silhouette and body structure are unstable | With sufficient data, test a mild `shift>1` | Full-body and multi-view coverage |
| Over-sharpening, dirty texture, image repetition | Avoid `sigma_sqrt` | Learning rate, total steps, inference LoRA weight |
| Style has color but lacks shape language | Broaden sigmoid or test mild high-noise shift | Subject and composition diversity |
| Style overrides prompt composition | Reduce high-noise shift | Overall training strength |

The same symptom can have several causes. The timestep chart explains allocation of training opportunities; it does not replace inspection of data, learning rate, and fixed-prompt samples.

<!-- doc-anchor: sdxl-range -->
## SDXL `min_timestep` and `max_timestep`

SDXL does not use the Anima/Krea 2 flow-matching options described above. The trainer exposes separate SDXL timestep range controls:

- `min_timestep`: lowest allowed noise timestep; blank uses `0`.
- `max_timestep`: highest allowed noise timestep; blank uses `1000`.
- Raising `min_timestep` excludes the cleanest low-noise samples.
- Lowering `max_timestep` excludes the noisiest samples.

These parameters crop the allowed range; they are not equivalents of `sigmoid_scale` or flow shift. Keep the full range unless you have a specific experimental goal.

`min_snr_gamma`, `v_parameterization`, and `zero_terminal_snr` are also related to SDXL noise training, but they concern loss reweighting, prediction targets, and scheduler behavior rather than the flow-matching distribution covered here.

<!-- doc-anchor: common-mistakes -->
## Common mistakes

1. `sigmoid + logit_normal` does not use logit-normal density; that density is active only with `sigma`.
2. `discrete_flow_shift` is not applied to every sampling mode.
3. High noise does not automatically mean higher quality, and low noise does not guarantee better detail.
4. Timestep tuning cannot create views, structures, or drawing rules absent from the dataset.
5. `sample_flow_shift` is an inference preview parameter, not the training timestep distribution.
6. `seed` changes the random sequence used by real training but not the long-run theoretical distribution. The document preview uses a fixed simulation seed, so changing the training Seed does not make the chart fluctuate.
7. Batch size and GPU count do not change the theoretical distribution, though short-run histogram variance changes.
8. Timestep settings do not alter the exported LoRA format or require an identically named inference sampler.

<!-- doc-anchor: testing -->
## A reliable comparison method

1. Train a baseline with the current profile defaults.
2. Keep the dataset, Seed, Rank, Alpha, learning rate, and total steps fixed.
3. Change only one parameter, such as `sigmoid_scale` from `1.0` to `1.25`.
4. Compare checkpoints at identical training steps with the same prompts, generation seed, resolution, and inference LoRA weight.
5. Evaluate fidelity, background leakage, composition rigidity, prompt adherence, and generalization to unseen cases.

Loss is supporting evidence only. The better timestep configuration is the one that produces better controlled samples for the intended use case.
