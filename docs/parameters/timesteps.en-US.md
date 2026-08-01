# Timesteps

> During training, the trainer adds a random amount of noise to each image before the model sees it. The timestep describes how noisy that particular input is. It affects whether training spends more time on fine detail, global structure, or the range between them.

This guide focuses on the flow-matching timestep controls used by **Anima** and **Krea 2**. SDXL uses a different diffusion training path, so its timestep range controls are covered separately near the end.

<!-- doc-anchor: quick-start -->
## Current default configuration

The Anima LoRA default configuration is:

```toml
timestep_sampling = "sigmoid"
sigmoid_scale = 1.0
weighting_scheme = "uniform"
```

Krea 2 defaults to `shift`, `sigmoid_scale=1.0`, `discrete_flow_shift=2.5`, and `weighting_scheme=none`.

Both configurations cover multiple noise regions instead of concentrating only on the detail or structure endpoint. Timestep parameters change sampling frequency or loss weight; they do not represent a quality ranking. Changing several controls at once produces their combined effect.

<!-- doc-anchor: terminology -->
## Types of steps

The trainer uses the word “step” for three unrelated things:

| Name | What it means | Typical parameter |
| --- | --- | --- |
| Training steps | How many times the LoRA parameters have been updated | `max_train_steps` |
| Training timestep | How much noise was added to the current image | `timestep_sampling` |
| Generation steps | How many denoising calculations are used to generate an image | `sample_steps` |

For example, “training step 500” means that the LoRA has received 500 optimizer updates. It has no halfway relationship with noise timestep `t≈500`. Images in the same optimizer update may also receive different noise timesteps.

<!-- doc-anchor: visualizer -->
## Distribution preview

<div data-doc-widget="timestep-preview"></div>

The preview contains three main elements:

1. **Blue bars:** taller bars mean that the corresponding noise range is sampled more often.
2. **Orange curve:** loss is the error between the model's prediction and its training target. The curve shows how much extra weight is applied after a timestep is sampled.
3. **Low, mid, and high percentages:** these summarize whether the current setup leans toward detail, the middle of the path, or global structure.

The 32 blue bars are histogram bins, not the trainer's complete set of timesteps. Their heights are normalized against the tallest bin, so the chart does not provide a literal probability axis.

The orange curve uses a logarithmic display scale. It is not the loss reported in the training log, and its height is not directly comparable with the blue bars. A flat line means that no timestep receives extra weighting; it does not mean that the observed loss remains constant.

<div class="doc-equation doc-equation-compact" role="group" aria-label="Approximate influence of a noise region on training">
  <div class="doc-equation-kicker">Simplified relationship, not an exact prediction</div>
  <div class="doc-equation-expression">training influence ≈ sampling frequency × loss weight × current error</div>
  <p>The current error changes with the image, caption, and stage of training. The preview therefore shows allocation, not a guaranteed amount of learning.</p>
</div>

The preview runs 32,768 deterministic local simulations. Identical settings produce an identical chart. Rounding can make the three percentages total `99.9%` or `100.1%`. Opening or refreshing the preview never starts training or edits the TOML configuration.

<!-- doc-anchor: dataset-guidance -->
## Dataset size and sampling coverage

A small dataset gives the model fewer poses, views, backgrounds, and compositions to learn from. Timestep tuning cannot create those missing examples; it only changes the noise levels at which the existing images are used.

With few or repetitive images, each image contributes a larger share of total updates. Increasing endpoint coverage gives image detail, fixed poses, backgrounds, and compositions more endpoint samples; the distribution cannot classify which content belongs to the target.

| Dataset property | Effect on timestep results |
| --- | --- |
| Few effectively independent images | Each image has a larger share of repeated exposure in every noise region |
| Varied views and compositions | Endpoint samples cover more independent structure and detail evidence |
| Many consecutive frames or duplicate crops | File count rises with little change in independent structure evidence |
| Higher repeats | Images are sampled more often; the theoretical timestep distribution is unchanged |
| Batch or gradient-accumulation changes | Theoretical distribution is unchanged; short-run sampling variance changes |

These counts refer to **effectively independent images**. Consecutive video frames, multiple crops of one source, and near-duplicate card art do not provide the same diversity as distinct images.

Ten images repeated twenty times and one hundred distinct images repeated twice can produce a similar number of training samples. The first dataset still contains only ten images' worth of views and compositions. Repeats add optimization opportunities; they do not add visual information.

<div class="doc-equation doc-equation-compact" role="group" aria-label="Approximate optimizer updates per epoch">
  <div class="doc-equation-kicker">Rough single-GPU estimate</div>
  <div class="doc-equation-expression doc-equation-expression-small">updates per epoch ≈ <span class="doc-frac"><span>image count × repeats</span><span>batch size × gradient accumulation</span></span></div>
  <p>This helps estimate training length. It does not change the theoretical timestep distribution.</p>
</div>

<!-- doc-anchor: scenarios -->
## Signal ranges by training objective

### Few-shot characters

Few-shot character datasets accumulate face, pose, background, and composition as shared evidence. `sigma_sqrt` amplifies low-noise loss weight, while a shift toward high noise increases structure-end sampling. Neither separates identity from repeated composition.

### Larger character datasets and high fidelity

A character that stays recognizable in new poses and camera angles cannot be learned from low noise alone. Low noise supports facial and clothing detail, mid noise balances identity and shape, and high noise influences how the model builds the overall character from weak visual information.

Increasing `sigmoid_scale` raises sampling at both low- and high-noise endpoints. The variety of views, poses, and compositions in the dataset determines how much independent structure evidence those additional samples cover.

### Few-shot styles

Color, line quality, and brushwork are especially visible in low and mid noise. Proportion, shape design, lighting layout, and composition also involve high noise.

In a small style dataset, recurring subjects and compositions enter the gradient together with color, line, and brushwork. Timestep controls only change how often those combined signals appear in each noise region.

### Larger, high-fidelity style datasets

High-fidelity style training does not require concentrating the entire distribution at low noise. Low and mid noise support linework, palette, and material treatment, while high noise also contributes to shape language, lighting, and composition.

Increasing `sigmoid_scale` adds low-noise samples associated with line and material signals and high-noise samples associated with shape and composition signals. A shift toward high noise only moves the full distribution, while `sigma_sqrt` only amplifies low-noise loss weight. Neither is a style-strength level.

Style quality includes more than similarity to the training images. Transfer of the same visual language to subjects and compositions absent from the dataset is also part of the evaluation.

### Objects, garments, and structural concepts

Local texture in clothing, props, and mechanical forms produces gradients across low and mid noise, while global silhouette also produces gradients across mid and high noise. Changing timestep distribution cannot create back-view structure evidence from front views alone.

<!-- doc-anchor: diagnosis -->
## Training symptoms and parameter effects

| What you see | Related timestep mechanism | Other variables in the result |
| --- | --- | --- |
| Identity works only in familiar poses | `sigmoid_scale` controls endpoint coverage; shift controls the overall noise direction | View variety, captions, effective steps |
| Fine details remain missing | Low-noise sampling and low-noise loss weighting affect visible-detail updates | Source detail, VAE representation, training strength |
| The same pose or background keeps returning | High-noise coverage processes global structure and repeated composition together | Duplicate data, background captions, repeats |
| Silhouette or body structure is unstable | High-noise sampling affects updates that build global structure from weak image signal | Full-body and multi-view coverage |
| Texture is overly sharp or dirty | `sigma_sqrt` rapidly amplifies loss weight near zero sigma | Learning rate, total steps, image artifacts |
| Style has color but weak shape language | Low and high noise cover material-side and structure-side signals | Subject and composition variety |
| Style overrides prompt composition | High-noise structure signals accumulate with repeated composition | Overall training strength and data co-occurrence |

The same symptom can have several causes. Timestep distribution is one diagnostic tool; it does not replace inspection of the dataset, captions, learning rate, and fixed-prompt samples.

<!-- doc-anchor: flow-matching -->
## How timesteps work

You do not need the formulas to use the default settings. They are included to show how the related parameters change the flow-matching distribution.

Before training, the VAE compresses an image into a latent, the image representation processed by the model. Let <var>x</var> be the image latent, <var>ε</var> be random noise, and <var>t</var> be a normalized timestep. The noisy input is:

<div class="doc-equation" role="group" aria-label="Flow-matching noisy input equation">
  <div class="doc-equation-kicker">Input after adding noise</div>
  <div class="doc-equation-expression"><var>x</var><sub>t</sub> = (1 − <var>t</var><span class="doc-math-close">)</span> · <var>x</var> + <var>t</var> · <var>ε</var></div>
  <p>Smaller <var>t</var> stays closer to the image. Larger <var>t</var> moves closer to pure noise.</p>
</div>

| Timestep region | What the model sees | Effects that often become visible |
| --- | --- | --- |
| Low noise, `t≈0` | Most image information remains | Linework, texture, color, facial features, and clothing detail |
| Mid noise, `t≈0.5` | Image and noise are strongly mixed | Balance among identity, style, shape, and detail |
| High noise, `t≈1` | The input is close to pure noise | Subject semantics, silhouette, pose, composition, and global structure |

This table is an intuition aid, not a strict division of model capabilities. Identity, detail, and composition span many timesteps, and the outcome still depends on the dataset, captions, and base model.

The current Anima and Krea 2 implementations train the model to predict the direction from data toward noise:

<div class="doc-equation doc-equation-compact" role="group" aria-label="Flow-matching training target">
  <div class="doc-equation-kicker">Prediction target</div>
  <div class="doc-equation-expression"><var>v</var> = <var>ε</var> − <var>x</var></div>
  <p>Generation follows the learned path in reverse, starting from high noise and moving toward a clean image.</p>
</div>

Training code also uses <var>σ</var>, written as `sigma` in parameter names, for the noise mixing ratio. In the flow-matching paths covered here, it points in the same direction as <var>t</var>: values near `0` are clean, and values near `1` are close to pure noise. The UI presents this range as approximately `0–1000` timesteps.

<!-- doc-anchor: defaults -->
## Profile defaults

| Training profile | Default sampling | Default distribution parameters | Default loss weighting |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`, `discrete_flow_shift=2.5` | `none` |

In the current implementations, `uniform` and `none` both mean that no extra per-timestep loss weighting is applied. Krea 2 uses `none` to remain compatible with its backend and older configurations. After importing an old preset, rely on the values shown in the form and distribution preview.

<!-- doc-anchor: sampling -->
## `timestep_sampling`: which timesteps appear most often

`timestep_sampling` determines the basic shape of the blue histogram: which noise levels are sampled most often.

| Option | Sampling behavior | Available for |
| --- | --- | --- |
| `sigmoid` | Emphasizes mid noise while retaining both endpoints | Anima, Krea 2 |
| `uniform` | Samples evenly across the full range | Anima, Krea 2 |
| `shift` | Builds a sigmoid distribution, then moves it toward one side | Anima, Krea 2 |
| `sigma` | Samples from the training scheduler's discrete noise table | Anima, Krea 2 |
| `flux_shift` | Computes a FLUX-style shift from the current resolution | Anima |
| `krea2_shift` | Computes a Krea 2 shift from the current resolution | Krea 2 |
| `logsnr` | Converts a LogSNR distribution into timesteps | Krea 2 |

### `sigmoid`

Sigmoid sampling starts with a standard normal random value and maps it into the `0–1` range:

<div class="doc-equation" role="group" aria-label="Sigmoid timestep sampling equation">
  <div class="doc-equation-kicker">Sigmoid sampling</div>
  <div class="doc-equation-expression"><var>z</var> ∼ N(0, 1)<br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(<var>s</var> · <var>z</var><span class="doc-math-close">)</span></div>
  <p><var>s</var> is <code>sigmoid_scale</code>. Its default value is 1.0.</p>
</div>

With `sigmoid_scale=1.0`, the distribution is symmetric and clearly concentrated around mid noise. In the default 1024×1024 preview, the low, mid, and high regions are roughly 21%, 57%, and 21%. Exact values vary slightly with settings and histogram boundaries.

### `uniform`

`uniform` samples evenly across the full timestep range. Compared with the default sigmoid distribution, it gives both the low- and high-noise endpoints substantially more training time.

Even coverage is not automatically better. With a small or repetitive dataset, the extra endpoint training can also strengthen memorized backgrounds, fixed poses, and image artifacts.

### `shift`

`shift` first creates a sigmoid distribution, then uses `discrete_flow_shift` to move the whole distribution toward low or high noise.

### `sigma`

`sigma` selects entries from the training scheduler's discrete noise table. `discrete_flow_shift` changes that table.

When `weighting_scheme` is `logit_normal` or `mode`, it also changes where samples are drawn. With `sigma_sqrt` or `cosmap`, sampling keeps the ordinary density and only the loss weight changes afterward.

### `flux_shift` and `krea2_shift`

These modes derive their shift from the current latent grid size. Resolution changes alter the computed shift and resulting distribution. They do not use the fixed `discrete_flow_shift` value.

When buckets are enabled, images with similar resolutions and aspect ratios are grouped together. Each bucket uses its own latent dimensions, so a preview at one reference resolution cannot represent every bucket in the dataset.

### `logsnr`

SNR is the ratio of signal strength to noise strength. LogSNR is its logarithmic form. Higher LogSNR means a stronger image signal and less noise.

Krea 2 `logsnr` draws a LogSNR value from the distribution defined by `logit_mean` and `logit_std`, then converts it into a timestep:

<div class="doc-equation" role="group" aria-label="LogSNR timestep conversion equation">
  <div class="doc-equation-kicker">Krea 2 logsnr sampling</div>
  <div class="doc-equation-expression">LogSNR ∼ N(<var>μ</var>, <var>σ</var><span class="doc-math-close">)</span><br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(−LogSNR / 2)</div>
  <p><var>μ</var> is <code>logit_mean</code>; <var>σ</var> is <code>logit_std</code>.</p>
</div>

This mode shares parameter names with `sigma + logit_normal`, but the conversion path is different. Parameter signs do not fully describe the final direction; the distribution preview shows the converted result directly.

<!-- doc-anchor: sigmoid-scale -->
## `sigmoid_scale`: how far the distribution spreads

`sigmoid_scale` is active with `sigmoid`, `shift`, `flux_shift`, and `krea2_shift`.

- Near `0`: samples collapse around `t≈0.5`.
- `1.0`: mid-noise emphasis with meaningful low- and high-noise coverage.
- `1.2–1.5`: both endpoints receive more samples.
- Very large values: samples can become overly concentrated near the two endpoints.

Raising `sigmoid_scale` is not a general quality improvement. It can help with detail and global structure, but it can also strengthen recurring backgrounds, fixed compositions, compression artifacts, and caption errors.

<!-- doc-anchor: flow-shift -->
## `discrete_flow_shift`: moving the whole distribution

Let <var>s</var> be the shift value. The transform is:

<div class="doc-equation" role="group" aria-label="Discrete flow shift equation">
  <div class="doc-equation-kicker">Fixed flow shift</div>
  <div class="doc-equation-expression"><var>t</var><sub>shifted</sub> = <span class="doc-frac"><span><var>s</var> · <var>t</var></span><span>1 + (<var>s</var> − 1) · <var>t</var></span></span></div>
  <p><var>s</var> is <code>discrete_flow_shift</code>.</p>
</div>

- `1.0`: no movement.
- Greater than `1.0`: moves the distribution toward high noise.
- Less than `1.0`: moves the distribution toward low noise.

This value is applied directly by `shift` and through the scheduler by `sigma`. `sigmoid`, `uniform`, `flux_shift`, `krea2_shift`, and `logsnr` ignore the fixed value.

<!-- doc-anchor: weighting -->
## Sampling frequency and loss weight are separate controls

A timestep affects training in two separate stages:

1. **Where the sample comes from.** Sampling controls shape the blue histogram.
2. **How much that sample counts.** Actual loss weighting shapes the orange curve.

The name `weighting_scheme` can be misleading because some choices change loss weight, while others change sampling only when `timestep_sampling=sigma`.

| Option | Changes sampling? | Changes loss weight? |
| --- | --- | --- |
| `uniform` / `none` | No | No |
| `sigma_sqrt` | No | Yes, strongly emphasizes low noise |
| `cosmap` | No | Yes, smoothly emphasizes mid noise |
| `logit_normal` | Only with `sigma` sampling | No |
| `mode` | Only with `sigma` sampling | No |

### `uniform` / `none`

No extra per-timestep loss weight is applied, so the orange line stays flat. This configuration provides a straightforward comparison baseline.

### `sigma_sqrt`

<div class="doc-equation" role="group" aria-label="Sigma sqrt loss weighting equation">
  <div class="doc-equation-kicker">Low-noise weighting</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>1</span><span><var>σ</var><sup>2</sup></span></span></div>
  <p>The weight rises rapidly as <var>σ</var> approaches 0.</p>
</div>

This can make low-noise samples dominate the update. On small datasets, it may amplify memorized detail, over-sharpening, and unstable gradients. None of the trainer's default profiles uses this weighting.

### `cosmap`

<div class="doc-equation" role="group" aria-label="Cosmap loss weighting equation">
  <div class="doc-equation-kicker">Mid-noise weighting</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>2</span><span><var>π</var> · (1 − 2 · <var>σ</var> + 2 · <var>σ</var><sup>2</sup><span class="doc-math-close">)</span></span></span></div>
  <p>This reduces the relative influence of both endpoints and smoothly emphasizes the middle.</p>
</div>

`cosmap` changes only the orange loss-weight curve, not the blue sampling histogram.

<!-- doc-anchor: logit-normal -->
### `logit_normal`, `logit_mean`, and `logit_std`

These controls change sampling only when `timestep_sampling=sigma`.

- `logit_mean=0`: the density is roughly symmetric.
- With the current sigma scheduler's index direction, positive values move the resulting sigma toward low noise; negative values move it toward high noise.
- Smaller `logit_std` values concentrate samples. Larger values spread them toward the endpoints.

The scheduler's shift also affects the final mapping, so use the preview to confirm the direction and strength. With `sigmoid + logit_normal`, logit-normal changes neither sampling nor loss weight.

<!-- doc-anchor: mode -->
### `mode` and `mode_scale`

`mode` changes sampling only when `timestep_sampling=sigma`. It does not add loss weighting.

- `mode_scale=0`: close to uniform density.
- Larger values: more samples gather around mid noise.
- Default `1.29`: already has a clear mid-noise emphasis.

<!-- doc-anchor: compatibility -->
## Parameter activation matrix

| Parameter | sigmoid | uniform | shift | sigma | `flux_shift` / `krea2_shift` | logsnr |
| --- | --- | --- | --- | --- | --- | --- |
| `sigmoid_scale` | Used | Ignored | Used | Ignored | Used | Ignored |
| `discrete_flow_shift` | Ignored | Ignored | Used | Used | Ignored | Ignored |
| `logit_mean/std` | Ignored | Ignored | Ignored | `logit_normal` density only | Ignored | Used directly |
| `mode_scale` | Ignored | Ignored | Ignored | `mode` density only | Ignored | Ignored |
| `sigma_sqrt/cosmap` weight | Used | Used | Used | Used | Used | Used |

“Ignored” means that the training code does not read that value. Leaving it in a configuration does not create a hidden effect. The form hides most inactive fields, and the preview warns about ignored combinations.

<!-- doc-anchor: sdxl-range -->
## SDXL `min_timestep` and `max_timestep`

SDXL does not use the Anima/Krea 2 flow-matching sampling options described above. The trainer provides two separate range controls for SDXL:

- `min_timestep`: the lowest allowed noise timestep; blank uses `0`.
- `max_timestep`: the highest allowed noise timestep; blank uses `1000`.
- Raising `min_timestep` removes the cleanest low-noise samples.
- Lowering `max_timestep` removes the noisiest samples.

These parameters crop the allowed range. They are not equivalents of `sigmoid_scale` or flow shift. The default configuration retains the full range; non-default values exclude the corresponding noise endpoints.

`min_snr_gamma`, `v_parameterization`, and `zero_terminal_snr` are also related to SDXL noise training, but they control loss reweighting, the prediction target, and scheduler behavior rather than the flow-matching distribution covered here.

<!-- doc-anchor: common-mistakes -->
## Common misconceptions

1. `sigmoid + logit_normal` does not enable logit-normal sampling; it is active only with `sigma`.
2. `discrete_flow_shift` is not used by every sampling mode.
3. High noise does not automatically mean higher quality, and low noise does not guarantee better detail.
4. Timestep tuning cannot create views, structures, or drawing rules missing from the dataset.
5. `sample_flow_shift` is a generation-preview control, not a training timestep setting.
6. The training `seed` changes the random sequence of sampled timesteps, but not the long-run theoretical distribution. The document preview uses a fixed simulation seed, so changing the training seed does not change the chart.
7. Batch size and GPU count do not change the theoretical distribution, although they affect short-run sampling variance.
8. Timestep settings do not change the exported LoRA format or require an identically named sampler during inference.

<!-- doc-anchor: testing -->
## Conditions for attributable comparisons

Differences can be attributed to one timestep parameter only when the dataset, random seed, rank, alpha, learning rate, total training steps, checkpoint step, prompts, generation seeds, resolution, and inference LoRA weight remain fixed.

Training loss is the aggregate error for the current objective and does not fully represent identity fidelity, style transfer, background leakage, composition binding, or prompt response. When multiple timestep parameters change, the result expresses their combined distribution and weighting changes.
