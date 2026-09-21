# Timesteps

During training, the model learns to process images at different noise levels. A timestep describes the noise level of a particular input. At high noise levels, little image information remains, so the model must establish more of the overall image. At low noise levels, more of the image is visible, and the task places greater emphasis on local refinement.

The following table provides a useful way to think about these ranges:

| Noise range | Typical emphasis | What to inspect in generated images |
| --- | --- | --- |
| High | Global structure, pose, composition, and silhouette | Body proportions, poses, and overall layout |
| Medium | Connecting the overall image with local features | Consistency of identity, shape, and major features |
| Low | Texture, linework, edges, and facial details | Hair strands, fabric texture, brushwork, and small accessories |

These are overlapping tendencies, not separate capabilities. Identity, color, and structure depend on multiple timesteps. Sampling a range more often does not guarantee a corresponding improvement.

Timestep sampling controls how often each noise level appears. Loss weighting controls how much a sampled prediction error contributes to the training loss. Both can change the emphasis of training, but at different stages.

<!-- doc-anchor: quick-start -->
## Baseline configuration

When no baseline run is available, the defaults for the selected training profile can serve as the reference configuration. Timestep controls are advanced tuning tools; dataset quality, captions, learning rate, and when to stop training usually have a more direct effect on training problems.

The Anima LoRA default baseline is:

```toml
timestep_sampling = "sigmoid"
sigmoid_scale = 1.0
weighting_scheme = "uniform"
```

Krea 2 defaults to `shift`, `sigmoid_scale=1.0`, `discrete_flow_shift=2.5`, and `weighting_scheme=none`, and that set is a fine baseline too.

Both defaults cover a range of noise levels rather than focusing on detail or structure alone, which makes them reasonable starting points for character, style, and general concept LoRAs. All of these parameters live in the timestep/sampling section of the training form.

> **Configuration note:** timestep settings are not a quality switch. Changing several timestep controls without a baseline makes the result hard to attribute. Run the defaults first; they give you a reference for later comparisons.

<!-- doc-anchor: terminology -->
## Types of steps

The trainer uses the word “step” for three unrelated things:

| Name | What it means | Typical parameter |
| --- | --- | --- |
| Training steps | How many times the LoRA parameters have been updated | `max_train_steps` |
| Training timestep | How much noise was added to the current image | `timestep_sampling` |
| Generation steps | How many denoising calculations are used to generate an image | `sample_steps` |

For example, “training step 500” means the LoRA has received 500 optimizer updates. Noise timestep `t≈500` instead means the current sample is mixed with roughly half noise; the similar numbers are a coincidence. Images within the same optimizer update may also receive different noise timesteps.

<!-- doc-anchor: visualizer -->
## Distribution preview

![Timestep distribution preview in the ComfyUI theme](../images/timestep-preview.en-US.png)

This is a static illustration of an example configuration. Open **View timestep distribution** under the training timestep sampling field to inspect your own settings and switch between the base and overall training distributions. The sidebar shows sampling settings, base and current median timesteps, and loss weighting. Hover the curve to read values at a particular position.

The preview shows how training samples and loss weights are distributed. It does not predict image quality.

| Preview element | How to read it |
| --- | --- |
| Sampling curve | Over intervals of equal width, more area under the curve means that noise range is sampled more often |
| High-, medium-, and low-noise shares | Help compare opportunities for global reconstruction and local refinement |
| Loss-weight curve | Shows the multiplier applied to a sample’s prediction error after it is sampled |
| Reference resolution | Determines resolution-dependent shifts; it does not represent every bucket in the dataset |

High noise tends to emphasize global structure and low noise local refinement, but these are not separate capabilities. Sampling, loss weights, and gradients all affect learning, so curve height is not a measure of parameter-update size. When a discrete noise table is used, a continuous curve is only a visualization of its approximate distribution.

The horizontal axis follows the physical denoising order of image generation: left is maximum noise `t≈1000` (pure noise, structure & composition stage), while right is clean `t≈0` (low noise, fine detail stage).

The vertical axis displays the exact probability density <var>f</var>(<var>t</var>), while the weight polyline uses a logarithmic display scale. Uniform weighting applies the same loss weight to every timestep; it does not mean the observed loss stays constant.

<div class="doc-equation doc-equation-compact" role="group" aria-label="Approximate influence of a noise region on training">
  <div class="doc-equation-kicker">Simplified relationship, not an exact prediction</div>
  <div class="doc-equation-expression">training influence ≈ sampling frequency × loss weight × current error</div>
  <p>The current error changes with the image, caption, and stage of training. The preview therefore shows allocation, not a guaranteed amount of learning.</p>
</div>

The preview curve is not a random simulation: it is computed directly from the active sampling algorithm and shift formulas, and looks the same on every refresh. Rounding can make the three percentages total `99.9%` or `100.1%`. Opening or refreshing the preview never starts training or edits the TOML configuration.

<!-- doc-anchor: dataset-guidance -->
<!-- doc-anchor: scenarios -->
<!-- doc-anchor: diagnosis -->
## Adjusting from training results

Timestep tuning is most useful once a reference run is available. Without one, use the defaults for the current training profile. First identify what is missing, then check whether the training images actually contain that information.

| Observation | Check first | Direction to test |
| --- | --- | --- |
| Weak silhouette or body proportions | Full-body coverage and relevant views | Moderately increase high-noise sampling and compare with the original distribution |
| Missing texture, linework, or accessories | Whether the source and training resolution preserve those details | Moderately increase low-noise sampling while also checking learning rate and training duration |
| Both global and local features are weak | General underfitting or an unsuitable training scope | Keep the distribution fixed while checking learning rate, duration, and scope |
| Repeated pose or background | Duplicate data and signs of overfitting | Check data and stopping point rather than immediately blaming a noise range |
| A style changes colors but not shapes | Variety of subjects and compositions | Once coverage is adequate, compare a distribution with more emphasis on global structure |

These are experimental directions, not diagnostic rules. Both characters and styles depend on several noise ranges: character training is not limited to facial detail, and style training is not limited to texture or brushwork.

Change one timestep setting at a time. Keep the dataset, training budget, prompts, generation seeds, resolution, and LoRA inference weight fixed. Compare several generated samples rather than judging by one preview or a lower training loss.

<!-- doc-anchor: flow-matching -->
## How timesteps work

This section describes the underlying flow-matching path. The formulas are not required for using the defaults; return here when you need to tune the related parameters.

Before training, the VAE encodes each image into a latent — the representation the model actually operates on. Let <var>x</var> be the image latent, <var>ε</var> random noise, and <var>t</var> a normalized timestep. The noisy input is:

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

Training code also uses <var>σ</var> for the noise mixing ratio — this is the sigma in weight names such as `sigma_sqrt` and `cosmap`. In the flow-matching paths covered here <var>σ</var> moves in the same direction as <var>t</var>: values near `0` are clean, values near `1` are close to pure noise. The UI presents this range as approximately `0–1000` timesteps.

<!-- doc-anchor: defaults -->
## Profile defaults

| Training profile | Default sampling | Default distribution parameters | Default loss weighting |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`, `discrete_flow_shift=2.5` | `none` |

In the current implementations, `uniform` and `none` both mean that no extra per-timestep loss weighting is applied. Krea 2 uses `none` for compatibility with its backend and older configurations. After importing an old preset, rely on the values shown in the form and distribution preview.

<!-- doc-anchor: sampling -->
## `timestep_sampling`: which timesteps appear most often

`timestep_sampling` determines the basic shape of the blue sampling-density curve: which noise levels are sampled most often.

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

With `sigmoid_scale=1.0`, the distribution is symmetric and clearly concentrated around mid noise. In the default 1024×1024 preview, the low, mid, and high regions are roughly 21%, 57%, and 21%; exact values vary slightly with settings and the region boundaries.

### `uniform`

`uniform` samples evenly across the full timestep range. Compared with the default sigmoid distribution, it gives both the low- and high-noise endpoints substantially more training time.

Even coverage is not automatically better. With a small or repetitive dataset, the extra endpoint training can also strengthen memorized backgrounds, fixed poses, and image artifacts.

### `shift`

`shift` first creates a sigmoid distribution, then uses `discrete_flow_shift` to move the whole distribution toward low or high noise. Use `shift` after you have a baseline and test images confirm the distribution should lean toward one end.

### `sigma`

`sigma` selects entries from the training scheduler's discrete noise table, and `discrete_flow_shift` changes that table.

When `weighting_scheme` is `logit_normal` or `mode`, it also changes where samples are drawn. With `sigma_sqrt` or `cosmap`, sampling keeps the ordinary density and only the loss weight changes afterward.

### `flux_shift` and `krea2_shift`

These modes derive their shift from the current latent grid size, so higher resolutions can push the resulting distribution further toward high noise. They ignore the fixed `discrete_flow_shift` value.

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

`sigmoid_scale` controls how widely timesteps are spread. With no timestep shift, smaller values concentrate sampling around medium noise levels. Higher values make both low- and high-noise timesteps more common.

| Adjustment | Distribution change | What it means for training |
| --- | --- | --- |
| Decrease | More samples fall near medium noise | Fewer samples at the extremes and more emphasis on the middle of the denoising task |
| Increase | Both low- and high-noise samples become more common | More opportunities to train local refinement and global reconstruction |

This table describes sigmoid sampling without an additional shift. When a fixed, resolution-dependent, or subset shift is applied, use the preview to check the resulting noise proportions.

Increasing this setting does not selectively strengthen detail or composition. To move training toward one end of the noise range, adjust the timestep shift rather than only widening the distribution.

<!-- doc-anchor: flow-shift -->
## `discrete_flow_shift`: moving the whole distribution

A timestep shift moves sampling toward higher or lower noise levels. It changes which timesteps are sampled, not the loss weight of each sample.

| `discrete_flow_shift` | Direction | Training emphasis to compare |
| --- | --- | --- |
| Above 1 | More high-noise samples | Global structure, pose, and composition |
| 1 | No fixed shift | The base distribution |
| Between 0 and 1 | More low-noise samples | Texture, linework, and local details |

Let <var>s</var> be the shift value. The transform is:

<div class="doc-equation" role="group" aria-label="Discrete flow shift equation">
  <div class="doc-equation-kicker">Fixed flow shift</div>
  <div class="doc-equation-expression"><var>t</var><sub>shifted</sub> = <span class="doc-frac"><span><var>s</var> · <var>t</var></span><span>1 + (<var>s</var> − 1) · <var>t</var></span></span></div>
  <p><var>s</var> is <code>discrete_flow_shift</code>.</p>
</div>

The fixed shift is used only by the `shift` and `sigma` paths. `flux_shift` and `krea2_shift` compute their own resolution-dependent shifts instead of reading this value.

<!-- doc-anchor: subset-offsets -->
## Per-subset timestep offsets

`subset_timestep_offsets` moves the timestep distribution separately for each training subset, so one run can treat close-up face crops and full-body shots differently. It currently works for **Anima** training only; Krea 2 and SDXL do not support it.

A subset is a subfolder whose name starts with a number followed by an underscore (for example `10_face` and `3_full_body`); the leading number is the repeat count. In the UI and API, the setting is a mapping from subset name to offset, not one global value. A minimal setup takes three steps:

1. Create the subset folders (names starting with a number and an underscore) and organize images into them by content.
2. Enter each subset folder name and its offset value in the UI's subset-offset mapping.
3. Use the distribution preview to confirm the distribution changes as expected.

The mapping looks like this:

```json
{"10_face": -0.25, "3_full_body": 0.20}
```

When training starts, the backend writes a separate `dataset.toml`; the field itself is not part of the main training configuration:

```toml
[[datasets.subsets]]
image_dir = ".../10_face"
[datasets.subsets.custom_attributes]
timestep_sampling = { offset = -0.25 }
```

During training, the offset is carried with each image into the batch. Images from `10_face` use `-0.25`, while images from `3_full_body` use `0.20`; in a mixed batch, each image keeps its own subset's offset. Regularization data does not receive these offsets.

### Where the offset is applied

The offset is added to the normal random sample first. The result is then scaled by `sigmoid_scale` and passed through `sigmoid`; with `shift` or `flux_shift`, an additional overall remapping follows:

```text
timestep = sigmoid( sigmoid_scale × (random sample + offset) )
```

In other words, before the sigmoid mapping, the distribution shifts as a whole by `offset × sigmoid_scale`.

Subset offsets use a different convention: negative values favor low noise, positive values favor high noise, and 0 leaves the subset unchanged. For example, close-ups and full-body images can use different offsets, but image type alone does not establish which offset will work best.

Shifting redistributes training opportunities. More low-noise training cannot supply detail that is missing from the source images, and more high-noise training cannot reveal the true unseen structure of a target for which the dataset lacks views.

With `timestep_sampling=sigma`, `weighting_scheme=logit_normal` or `mode` also changes the sampled distribution, but it changes the base distribution shared by every subset, not the offset of a single subset. The `sigma` path never reads `subset_timestep_offsets`; weighting options that change the base distribution cannot substitute for a true per-subset offset.

### Supported modes and recommended range

Subset offsets are supported by `sigmoid`, `shift`, and `flux_shift`. `uniform` and `sigma` do not read this value; if the value is passed through the API anyway, training still runs and the offset simply has no effect.

Start with values in the `-0.5` to `+0.5` range. Larger absolute values push the whole distribution toward one end; with `shift` or `flux_shift`, positive offsets can starve the low-noise side quickly. A small negative offset is a reasonable starting point for close-up and texture-heavy subsets, while full-body or structure-heavy subsets can be tested with a small positive value. These are experiment starting points, not fixed recipes.

The UI preview can show the base distribution (all offsets zero), the overall training distribution, and an individual subset. Keep the default run as a control and adjust one subset offset at a time. Offsets affect training sampling only; validation stays unbiased so validation loss remains comparable.

<!-- doc-anchor: weighting -->
## Sampling frequency and loss weight are separate controls

Sampling answers “How often is this noise level used?” Loss weighting answers “How much does its prediction error count once it is sampled?” Sampling low-noise inputs more often and assigning them larger loss weights can both increase attention to that part of the task, but they are different controls.

| Scheme | What changes | Meaning |
| --- | --- | --- |
| `uniform` / `none` | No additional loss weighting | Every timestep uses the same loss weight; sampling frequency still comes from the sampling method |
| `sigma_sqrt` | Larger weights at low noise | Emphasizes low-noise tasks, with rapidly increasing weights near zero noise that require attention to update stability |
| `cosmap` | Relatively larger weights at medium noise | Gives the endpoints less relative weight without changing sampling frequency |
| `logit_normal` | Sampling frequency in the `sigma` path | Does not add loss weights or enable logit-normal sampling in other paths |
| `mode` | Sampling frequency in the `sigma` path | Does not add loss weights; `mode_scale` controls the distribution |

Larger loss weights do not guarantee better identity or style fidelity. In particular, `sigma_sqrt` is a weighting rule, not a detail-enhancement switch.

### Exact weights for `sigma_sqrt` and `cosmap`

<div class="doc-equation" role="group" aria-label="Sigma sqrt loss weighting equation">
  <div class="doc-equation-kicker">Low-noise weighting</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>1</span><span><var>σ</var><sup>2</sup></span></span></div>
  <p>The weight rises rapidly as <var>σ</var> approaches 0.</p>
</div>

<div class="doc-equation" role="group" aria-label="Cosmap loss weighting equation">
  <div class="doc-equation-kicker">Mid-noise weighting</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>2</span><span><var>π</var> · (1 − 2 · <var>σ</var> + 2 · <var>σ</var><sup>2</sup><span class="doc-math-close">)</span></span></span></div>
  <p>This reduces the relative influence of both endpoints and smoothly emphasizes the middle.</p>
</div>

<!-- doc-anchor: logit-normal -->
### `logit_normal`, `logit_mean`, and `logit_std`

These controls change sampling only when `timestep_sampling=sigma`.

- `logit_mean=0`: the density is roughly symmetric.
- Positive values usually shift the sampled timesteps toward low noise; negative values toward high noise.
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
| `subset_timestep_offsets` | Used | Ignored | Used | Ignored | Only `flux_shift` | Ignored |
| `sigma_sqrt/cosmap` weight | Used | Used | Used | Used | Used | Used |

“Ignored” means the training code does not read that value. Leaving it in a configuration is harmless — it is simply not read. The form hides or annotates inactive fields, and the preview warns about ignored combinations.

<!-- doc-anchor: sdxl-range -->
## SDXL `min_timestep` and `max_timestep`

SDXL does not use the Anima/Krea 2 flow-matching sampling options described above. The trainer provides two separate range controls for SDXL:

- `min_timestep`: the lowest allowed noise timestep; blank uses `0`.
- `max_timestep`: the highest allowed noise timestep; blank uses `1000`.
- Raising `min_timestep` removes the cleanest low-noise samples.
- Lowering `max_timestep` removes the noisiest samples.

These parameters crop the allowed range. They are not equivalents of `sigmoid_scale` or `discrete_flow_shift`. The default configuration keeps the full range; range limits are meant for experiments that deliberately exclude one end of the noise range.

`min_snr_gamma`, `v_parameterization`, and `zero_terminal_snr` are also related to SDXL noise training, but they control loss reweighting, the prediction target, and scheduler behavior rather than the flow-matching distribution covered here.

<!-- doc-anchor: common-mistakes -->
## Common misconceptions

1. `sigmoid + logit_normal` does not enable logit-normal sampling; it is active only with `sigma`.
2. `discrete_flow_shift` is not used by every sampling mode.
3. High noise does not automatically mean higher quality, and low noise does not guarantee better detail.
4. Timestep tuning cannot create views, structures, or drawing rules missing from the dataset.
5. `sample_flow_shift` is a generation-preview control, not a training timestep setting.
6. The training `seed` changes the random sequence of sampled timesteps, but not the long-run theoretical distribution. The document preview evaluates the analytical PDF deterministically without random simulation, so changing the training seed does not change the chart.
7. Batch size and GPU count do not change the theoretical distribution, although they affect short-run sampling variance.
8. Timestep settings do not change the exported LoRA format or require an identically named sampler during inference.
9. `subset_timestep_offsets` only works with `sigmoid`, `shift`, and `flux_shift`; it has no effect with `uniform` or `sigma`.
10. Subset offsets are applied per image according to its subset, not once for the whole batch using the last subset value.

<!-- doc-anchor: testing -->
## Controlled comparison methodology

1. **Baseline:** one run uses the defaults for the selected profile.
2. **Fixed controls:** the dataset, random seed, rank, alpha, learning rate, and total training steps remain unchanged.
3. **Single change:** each run changes one parameter, such as `sigmoid_scale` from `1.0` to `1.25`.
4. **Matched comparison:** checkpoints use the same training step, prompts, generation seeds, resolution, and inference LoRA weight.
5. **Evaluation criteria:** fidelity, background leakage, composition rigidity, prompt adherence, and performance on subjects or compositions absent from the dataset.

Training loss is a supporting signal, not a sufficient evaluation on its own. Whether a timestep configuration is better should be decided by controlled samples and the requirements of your actual use case.

<!-- doc-anchor: evidence -->
## Evidence and references

Fact-checked on **2026-08-29**. Code links below are pinned to the reviewed revisions.

**Implementation facts:** The formulas and parameter activation behavior in this guide reflect the training code and configuration wiring actually used in this project:

- The sd-scripts fork's `library/flux_train_utils.py`: `sigmoid`, `shift`, and `flux_shift` sampling, the `sigma_sqrt` and `cosmap` weighting formulas, and the `discrete_flow_shift` transform.
- The Anima trainer's `anima_train_network.py`: reads per-sample subset offsets from batch `custom_attributes` and applies them only during training.
- The backend's `backend/training/sd_dataset_config.py` and `backend/server/routes/training.py`: validates subset offsets, writes the separate `dataset.toml`, and passes it to the trainer through `--dataset_config`.
- `library/anima_train_utils.py`: Anima's sampling and loss-weighting dispatch.
- The musubi-tuner fork's `src/musubi_tuner/training/trainer_base.py`: Krea 2's `krea2_shift` and `logsnr` sampling implementations.
- The musubi-tuner fork's `src/musubi_tuner/training/timesteps.py`: the shared density and loss-weighting formulas.
- The frontend distribution preview is implemented in `frontend/js/training-core.js` as a deterministic analytical PDF sampled at 120 points, with a separate loss-weight curve when applicable.

**Model and upstream evidence:** The Anima and Krea 2 training paths use flow-matching noise and the training target `v = ε − x`. The `sigmoid` sampling scheme and the `discrete_flow_shift` transform come from [Scaling Rectified Flow Transformers for High-Resolution Image Synthesis (SD3)](https://arxiv.org/abs/2403.03206). The empirical starting points for dataset sizes in this guide are this trainer's own suggestions; the `1.1–1.4` range for style training matches the official Anima example style LoRA, which uses `sigmoid_scale=1.3`.

**Experience requiring local validation:** The exact `sigmoid_scale` values suggested for different dataset sizes, the tendencies described for few-shot characters and styles, and the intuitive division of low noise as detail and high noise as structure should be verified with a fixed-condition comparison on the target dataset.

References:

- [This project's sd-scripts fork: `library/flux_train_utils.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/library/flux_train_utils.py)
- [This project's Anima trainer: `anima_train_network.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/anima_train_network.py)
- [This project's dataset configuration adapter: `backend/training/sd_dataset_config.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/backend/training/sd_dataset_config.py)
- [This project's sd-scripts fork: `library/anima_train_utils.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/sd-scripts/library/anima_train_utils.py)
- [This project's musubi-tuner fork: `src/musubi_tuner/training/timesteps.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/musubi-tuner/src/musubi_tuner/training/timesteps.py)
- [This project's musubi-tuner fork: `src/musubi_tuner/training/trainer_base.py` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/vendor/musubi-tuner/src/musubi_tuner/training/trainer_base.py)
- [This project's frontend: `frontend/js/training-core.js` (pinned revision)](https://github.com/amenorira/lora-scripts-anima/blob/11d0f7a348721b8688240dada0e172980b20a3b7/frontend/js/training-core.js)
- [Official Anima model card (pinned revision)](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [Official Anima example style LoRA: Greg Rutkowski Style - Anima (Civitai, published by Circlestone Labs, the Anima model authors)](https://civitai.com/models/2536147/greg-rutkowski-style-anima)
- [Scaling Rectified Flow Transformers for High-Resolution Image Synthesis](https://arxiv.org/abs/2403.03206)
- [Flow Matching for Generative Modeling](https://arxiv.org/abs/2210.02747)
