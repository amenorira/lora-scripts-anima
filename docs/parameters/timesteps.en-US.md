# Timesteps

> During training, the trainer adds a random amount of noise to each image before the model sees it. The timestep describes how noisy that particular input is, and it controls whether training spends more time on fine detail, global structure, or the range between them.

This guide covers the flow-matching timestep controls used by **Anima** and **Krea 2**. SDXL follows a different diffusion training path, so its timestep range controls are covered separately at the end.

<!-- doc-anchor: quick-start -->
## Baseline configuration

When no baseline run is available, the defaults for the selected training profile can serve as the reference configuration. Timestep controls are advanced tuning tools; dataset quality, captions, learning rate, and stopping time usually have a more direct effect on training problems.

The Anima LoRA default baseline is:

```toml
timestep_sampling = "sigmoid"
sigmoid_scale = 1.0
weighting_scheme = "uniform"
```

Krea 2 defaults to `shift`, `sigmoid_scale=1.0`, `discrete_flow_shift=2.5`, and `weighting_scheme=none`, and that set is a fine baseline too.

Both defaults cover a range of noise levels rather than focusing on detail or structure alone, which makes them reasonable starting points for character, style, and general concept LoRAs.

> **Configuration note:** timestep settings are not a quality switch. Changing several timestep controls without a baseline makes the result hard to attribute. Run the defaults first; they give you a reference for later comparisons.

<!-- doc-anchor: terminology -->
## Types of steps

The trainer uses the word “step” for three unrelated things:

| Name | What it means | Typical parameter |
| --- | --- | --- |
| Training steps | How many times the LoRA parameters have been updated | `max_train_steps` |
| Training timestep | How much noise was added to the current image | `timestep_sampling` |
| Generation steps | How many denoising calculations are used to generate an image | `sample_steps` |

For example, “training step 500” means the LoRA has received 500 optimizer updates. It has no halfway relationship with noise timestep `t≈500`. Images within the same optimizer update may also receive different noise timesteps.

<!-- doc-anchor: visualizer -->
## Distribution preview

<div data-doc-widget="timestep-preview"></div>

The preview contains three main elements:

1. **Blue bars:** taller bars mean the corresponding noise range is sampled more often.
2. **Orange curve:** loss measures the error between the model's prediction and its training target. The curve shows any extra weight applied to that error after a timestep has been sampled.
3. **Low, mid, and high percentages:** these summarize whether the current setup leans toward detail, the middle of the path, or global structure.

The 32 blue bars are histogram bins, not the trainer's complete set of timesteps. Bar height is normalized against the tallest bin, so the chart does not offer a literal probability axis.

The orange curve uses a logarithmic display scale. It is not the loss reported in the training log, and its height cannot be compared directly with the blue bars. A flat line means no timestep receives extra explicit weighting; it does not mean the observed loss stays constant.

<div class="doc-equation doc-equation-compact" role="group" aria-label="Approximate influence of a noise region on training">
  <div class="doc-equation-kicker">Simplified relationship, not an exact prediction</div>
  <div class="doc-equation-expression">training influence ≈ sampling frequency × loss weight × current error</div>
  <p>The current error changes with the image, caption, and stage of training. The preview therefore shows allocation, not a guaranteed amount of learning.</p>
</div>

The preview runs 32,768 deterministic local simulations; identical settings produce an identical chart. Rounding can make the three percentages total `99.9%` or `100.1%`. Opening or refreshing the preview never starts training or edits the TOML configuration.

<!-- doc-anchor: dataset-guidance -->
## Dataset size and timestep selection

A small dataset gives the model fewer poses, views, backgrounds, and compositions to learn from. Timestep tuning cannot create those missing examples; it only changes the noise levels at which the existing images are used.

Small or repetitive datasets usually benefit from a stable mid-noise emphasis. Broader endpoint coverage becomes safer when the dataset is both larger and genuinely varied.

The following values are experimental starting points, not fixed recipes:

| Training case | Empirical starting point | Main consideration |
| --- | --- | --- |
| 5–12 character images | `sigmoid`, `sigmoid_scale=0.8–1.0`, `uniform` | Learn the identity shared across images while reducing pose and background memorization |
| 15–40 character images | `sigmoid`, `sigmoid_scale=1.0–1.2`, `uniform` | Balance identity, detail, and overall structure |
| 40–100 varied character images | `sigmoid`, `sigmoid_scale=1.1–1.4`, `uniform` | Broaden endpoint coverage when views and compositions are truly varied |
| 15–30 style images | `sigmoid`, `sigmoid_scale=0.8–1.0`, `uniform` | Reduce the risk of absorbing a recurring subject or composition as part of the style |
| 60–200 varied style images | `sigmoid`, `sigmoid_scale=1.1–1.4`, `uniform` | Cover linework, shape language, and composition with enough supporting data |
| Object or structural concept | `sigmoid`, `sigmoid_scale=1.0–1.2`, `uniform` | Provide a balanced baseline before adding high-noise emphasis for a weak silhouette |

These counts refer to **effectively independent images**. Consecutive video frames, multiple crops of one source, and near-duplicate card art do not provide the same diversity as distinct images.

Ten images repeated twenty times and one hundred distinct images repeated twice can produce a similar number of exposures. The first dataset still contains only ten images' worth of views and compositions. Repeats add optimization opportunities; they do not add visual information.

<div class="doc-equation doc-equation-compact" role="group" aria-label="Approximate optimizer updates per epoch">
  <div class="doc-equation-kicker">Rough single-GPU estimate</div>
  <div class="doc-equation-expression doc-equation-expression-small">updates per epoch ≈ <span class="doc-frac"><span>image count × repeats</span><span>batch size × gradient accumulation</span></span></div>
  <p>This helps estimate training length. It does not change the theoretical timestep distribution.</p>
</div>

<!-- doc-anchor: scenarios -->
## Reference settings by training objective

### Few-shot characters

Few-shot character datasets have a higher risk of binding a face to a fixed pose, background, or composition. `sigmoid 0.8–1.0 + uniform` works as a baseline; `sigma_sqrt` and strong high-noise shifts are left out of the default starting configuration because they can increase memorization and composition binding.

If the identity never appears, trigger words, captions, learning rate, and training duration also need review. Timestep tuning alone does not correct those underlying issues.

### Larger character datasets and high fidelity

A character that stays recognizable in new poses and camera angles cannot be learned from low noise alone. Low noise supports facial and clothing detail, mid noise balances identity and shape, and high noise influences how the model builds the overall character from weak visual information.

When the dataset truly contains varied poses, views, and compositions, `sigmoid_scale` can be tested gradually from `1.0` toward `1.1–1.4`. Keeping the default run as a comparison makes the effect of broader coverage easier to evaluate.

### Few-shot styles

Color, line quality, and brushwork are especially visible in the low and mid noise regions; proportion, shape design, lighting layout, and composition also involve high noise.

One primary risk in a small style dataset is learning a recurring subject or composition as part of the style. A mid-noise emphasis works as an empirical starting point, while subject and composition diversity remain important conditions.

### Larger, high-fidelity style datasets

High-fidelity style training does not mean pushing the whole distribution into low noise. Low and mid noise support linework, palette, and material treatment, and high noise also contributes to shape language, lighting, and composition.

With roughly 60 or more genuinely varied images, test `sigmoid_scale=1.1–1.4` in small increments. If linework and color are already right but the overall shape language is still weak, run a separate experiment with a mild high-noise shift. `sigma_sqrt` is not a general “stronger style” option.

Style quality involves more than similarity to the training images. Transfer of the same visual language to subjects and compositions absent from the dataset is also part of the evaluation.

### Objects, garments, and structural concepts

Distinctive clothing, props, and mechanical forms often need mid- and high-noise training to establish their overall silhouette. If local texture is correct but the structure is unstable, and the dataset contains enough views, test `sigmoid_scale=1.2–1.4` or a mild `shift>1`.

Front views alone cannot teach the back of an object. Missing views still require more data.

<!-- doc-anchor: diagnosis -->
## Interpreting training results

| What you see | Timestep change worth testing | Also inspect |
| --- | --- | --- |
| Identity works only in familiar poses | Raise `sigmoid_scale` moderately | View diversity, captions, and overfitting |
| Fine details remain missing | Raise `sigmoid_scale` slightly to broaden both endpoints | Whether the source images actually contain clear detail |
| The same pose or background keeps returning | Reduce high-noise shift and return to the sigmoid baseline | Duplicate data and background captions |
| Silhouette or body structure is unstable | With sufficient data, test a mild `shift>1` | Full-body and multi-view coverage |
| Texture is overly sharp, dirty, or repetitive | Disable `sigma_sqrt` or return to uniform weighting | Learning rate, total steps, and inference LoRA weight |
| The style has the right colors but weak shape language | Broaden sigmoid or test a separate mild high-noise shift | Subject and composition diversity |
| The style overrides prompt composition | Reduce high-noise shift | Overall training strength |

The same symptom can have several causes. Timestep distribution is one diagnostic tool; it does not replace inspection of the dataset, captions, learning rate, and fixed-prompt samples.

<!-- doc-anchor: flow-matching -->
## How timesteps work

This section describes the underlying flow-matching path. The formulas are not required for using the defaults; return here when you need to tune the related parameters.

Before training, the VAE compresses an image into a latent, the image representation processed by the model. Let <var>x</var> be the image latent, <var>ε</var> random noise, and <var>t</var> a normalized timestep. The noisy input is:

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

Training code also uses <var>σ</var>, written as `sigma` in parameter names, for the noise mixing ratio. In the flow-matching paths covered here it runs in the same direction as <var>t</var>: values near `0` are clean, values near `1` are close to pure noise. The UI presents this range as approximately `0–1000` timesteps.

<!-- doc-anchor: defaults -->
## Profile defaults

| Training profile | Default sampling | Default distribution parameters | Default loss weighting |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`, `discrete_flow_shift=2.5` | `none` |

In the current implementations, `uniform` and `none` both mean that no extra per-timestep loss weighting is applied. Krea 2 uses `none` for compatibility with its backend and older configurations. After importing an old preset, rely on the values shown in the form and distribution preview.

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

Sigmoid sampling takes a standard normal random value and maps it into the `0–1` range:

<div class="doc-equation" role="group" aria-label="Sigmoid timestep sampling equation">
  <div class="doc-equation-kicker">Sigmoid sampling</div>
  <div class="doc-equation-expression"><var>z</var> ∼ N(0, 1)<br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(<var>s</var> · <var>z</var><span class="doc-math-close">)</span></div>
  <p><var>s</var> is <code>sigmoid_scale</code>. Its default value is 1.0.</p>
</div>

With `sigmoid_scale=1.0`, the distribution is symmetric and clearly concentrated around mid noise. In the default 1024×1024 preview, the low, mid, and high regions are roughly 21%, 57%, and 21%; exact values vary slightly with settings and histogram boundaries.

### `uniform`

`uniform` samples evenly across the full timestep range. Compared with the default sigmoid distribution, it gives both the low- and high-noise endpoints substantially more training time.

Even coverage is not automatically better. With a small or repetitive dataset, the extra endpoint training can also strengthen memorized backgrounds, fixed poses, and image artifacts.

### `shift`

`shift` first creates a sigmoid distribution, then uses `discrete_flow_shift` to move the whole distribution toward low or high noise. It applies when a baseline result is available and controlled comparisons show the overall direction needs adjustment.

### `sigma`

`sigma` selects entries from the training scheduler's discrete noise table, and `discrete_flow_shift` changes that table.

When `weighting_scheme` is `logit_normal` or `mode`, it also changes where samples are drawn. With `sigma_sqrt` or `cosmap`, sampling keeps the ordinary density and only the loss weight changes afterward.

### `flux_shift` and `krea2_shift`

These modes derive their shift from the current latent grid size; higher resolutions can move the resulting distribution further toward high noise, and they do not use the fixed `discrete_flow_shift` value.

When buckets are enabled, images with similar resolutions and aspect ratios are grouped together. Each bucket uses its own latent dimensions, so a preview at one reference resolution cannot represent every bucket in the dataset.

### `logsnr`

SNR is the ratio of signal strength to noise strength, and LogSNR is its logarithmic form. Higher LogSNR means a stronger image signal and less noise.

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

The name `weighting_scheme` is slightly misleading because some choices change loss weight, while others change sampling only when `timestep_sampling=sigma`.

| Option | Changes sampling? | Changes loss weight? |
| --- | --- | --- |
| `uniform` / `none` | No | No |
| `sigma_sqrt` | No | Yes, strongly emphasizes low noise |
| `cosmap` | No | Yes, smoothly emphasizes mid noise |
| `logit_normal` | Only with `sigma` sampling | No |
| `mode` | Only with `sigma` sampling | No |

### `uniform` / `none`

No extra per-timestep loss weight is applied, so the orange line stays flat, which provides a straightforward comparison baseline.

### `sigma_sqrt`

<div class="doc-equation" role="group" aria-label="Sigma sqrt loss weighting equation">
  <div class="doc-equation-kicker">Low-noise weighting</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>1</span><span><var>σ</var><sup>2</sup></span></span></div>
  <p>The weight rises rapidly as <var>σ</var> approaches 0.</p>
</div>

This can make low-noise samples dominate the update. On small datasets, it may amplify memorized detail, over-sharpening, and unstable gradients; the trainer's default profiles do not use this weighting.

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
- With the current sigma scheduler's index direction, positive values usually move the resulting sigma toward low noise; negative values usually move it toward high noise.
- Smaller `logit_std` values concentrate samples. Larger values spread them toward the endpoints.

The scheduler shift also affects the final mapping, so use the preview to confirm the direction and strength. With `sigmoid + logit_normal`, logit-normal changes neither sampling nor loss weight.

<!-- doc-anchor: mode -->
### `mode` and `mode_scale`

`mode` changes sampling only when `timestep_sampling=sigma`. It does not add loss weighting.

- `mode_scale=0`: close to uniform density.
- Larger values: more samples gather around mid noise.
- Default `1.29`: already has a clear mid-noise emphasis.

<!-- doc-anchor: compatibility -->
## Parameter activation matrix

| Parameter | sigmoid | uniform | shift | sigma | flux/krea shift | logsnr |
| --- | --- | --- | --- | --- | --- | --- |
| `sigmoid_scale` | Used | Ignored | Used | Ignored | Used | Ignored |
| `discrete_flow_shift` | Ignored | Ignored | Used | Used | Ignored | Ignored |
| `logit_mean/std` | Ignored | Ignored | Ignored | `logit_normal` density only | Ignored | Used directly |
| `mode_scale` | Ignored | Ignored | Ignored | `mode` density only | Ignored | Ignored |
| `sigma_sqrt/cosmap` weight | Used | Used | Used | Used | Used | Used |

“Ignored” means the training code does not read that value. Leaving it in a configuration does not create a hidden effect. The form hides most inactive fields, and the preview warns about ignored combinations.

<!-- doc-anchor: sdxl-range -->
## SDXL `min_timestep` and `max_timestep`

SDXL does not use the Anima/Krea 2 flow-matching sampling options described above. The trainer provides two separate range controls for SDXL:

- `min_timestep`: the lowest allowed noise timestep; blank uses `0`.
- `max_timestep`: the highest allowed noise timestep; blank uses `1000`.
- Raising `min_timestep` removes the cleanest low-noise samples.
- Lowering `max_timestep` removes the noisiest samples.

These parameters crop the allowed range. They are not equivalents of `sigmoid_scale` or flow shift. The default configuration keeps the full range; range limits apply to experiments that exclude a specific noise endpoint.

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
## Controlled comparison methodology

1. **Baseline:** one run uses the defaults for the selected profile.
2. **Fixed controls:** the dataset, random seed, Rank, Alpha, learning rate, and total training steps remain unchanged.
3. **Single change:** each run changes one parameter, such as `sigmoid_scale` from `1.0` to `1.25`.
4. **Matched comparison:** checkpoints use the same training step, prompts, generation seeds, resolution, and inference LoRA weight.
5. **Evaluation criteria:** fidelity, background leakage, composition rigidity, prompt adherence, and performance on subjects or compositions absent from the dataset.

Training loss is supporting evidence rather than a complete evaluation. Whether a timestep configuration is better should be decided by controlled samples and the requirements of your actual use case.
