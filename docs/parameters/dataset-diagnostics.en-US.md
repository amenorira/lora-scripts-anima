<a name="guide-title"></a>
# Dataset Diagnostics

Supports **SDXL**, **Anima**, and **MOSS-Image** (`musubi-tuner` / Krea 2 does not write `loss.jsonl`).

Every training step draws a random noise timestep per sample, and raw loss varies severalfold across noise levels. Building on the per-sample residual analysis in Kohya `sd-scripts` (see upstream [`loss.jsonl` and residual analysis](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#analyzing-the-loss-log--loss-%E3%83%AD%E3%82%B0%E3%81%AE%E5%88%86%E6%9E%90)), Dataset Diagnostics compares each sample against **peers in the same timestep bin**:

| Core metric | Meaning | How to read it |
| --- | --- | --- |
| **Residual** | Relative deviation of sample loss from its timestep bin mean | `0%` is the dataset average; positive is harder to fit, negative is easier |
| **Per-epoch slope** | Rate of residual change per epoch vs. same-epoch peer baseline after `≥ 3` comparable epochs | Negative means the gap to the average is closing; near `0%` means flat/stalled; positive means the residual is rising (gap widening) |

Residual is a relative metric within the same run (the dataset weighted mean is always `0%`). Consider a 40-image character dataset mixing 30 plain-background portraits with 10 complex scene illustrations:

| Sample group | Early mean loss (dataset mean `0.178`) | Epoch 8 mean loss (dataset mean `0.143`) | What changed |
| --- | --- | --- | --- |
| Plain-background portraits (30) | `0.15` (`-15.5%` residual) | `0.12` (`-15.8%` residual) | Loss dropped ~20%; relative residual stayed put |
| Complex scene illustrations (10) | `0.26` (`+46.5%` residual) | `0.21` (`+47.4%` residual) | Also dropped ~20%, yet residual stays high with slope near `0%` |

> Residual and slope measure relative standing within the same run; judge overall model quality and overfitting from checkpoint sample previews.

<a name="rules"></a>
## Image Statuses and Match Rules

Dataset Diagnostics evaluates the rules below in priority order using **Min samples** (default `≥ 3` comparable samples), `±20%` residual cutoffs, and an adaptive **drop slope threshold** (listed in UI display order):

| Status | Match condition | First step |
| --- | --- | --- |
| `NaN / Inf` | Any non-finite loss recorded | Check isolated files for corruption or broken color profiles; if widespread, inspect learning rate and mixed precision immediately |
| `High (not dropping)` | Residual `≥ +20%`, with `< 3` comparable epochs or slope `> drop slope threshold` | Once any single image reaches 3 comparable epochs, the overview bucket switches to this name; images still under 3 comparable epochs keep the **High residual** detail badge, while sloped ones split into **High (slow)** (`< 0`) or **High (not dropping)** (`≥ 0`). Check source, crop, and caption below |
| `High (dropping)` | Residual `≥ +20%` and slope `≤ drop slope threshold` | Complex pose, perspective, or outfit that the model is steadily learning; keep and monitor in later epochs |
| `Near mean` | `-20% < residual < +20%` | Progressing in line with the dataset average; no action needed |
| `Low residual` | Residual `≤ -20%` | Common on simple compositions, styles close to the base model, or near-duplicates; green UI indicators only mean easier to fit—if widespread, check previews for overfitting |
| `Pending` | Fewer than **Min samples** finite or comparable same-bin samples (**Few samples / Few noise peers** in details) | Wait for more epochs to accumulate samples, or temporarily lower **Min samples** in the header |

Note: `NaN / Inf` and `Pending` take classification precedence before residual thresholds; the drop slope threshold scales automatically between `-2.0%` and `-0.4% / epoch` based on each image's comparable epoch span (see [Same-epoch peer slope](#slope) below).

<a name="diagnosis"></a>
## Interpreting High and Low Residuals

### 4 Common High-Residual Cases

Open a high-residual image and check **slope, timestep curve (high noise left / low noise right), crop percentage, and caption** together:

| Case & example | Panel signature | Cause & action |
| --- | --- | --- |
| **Missing or conflicting tags**<br>The character wears prominent red glasses with a second person beside them, yet its `.txt` caption only says `1girl, solo`; or a detailed scene lacks background tags | Residual sits noticeably high (e.g., `+30%` to `+60%`) with slope stalled or rising after 3 comparable epochs; **left/mid bands** (high-noise layout and mid-noise structure) sit above the dataset curve | The text conditioning contradicts the image, forcing the model to fit conflicting supervision signals. Open the detail modal and click **Open in Tag Editor** to add missing tags or fix conflicts |
| **Blurry source, compression noise, or watermarks**<br>Upscaled low-res image, heavy JPEG artifacts, screentone moiré, or large corner text/watermarks | High residual that refuses to drop; **right bands** (low-noise detail stage, `t` near `0`) spike clearly while high-noise bands stay near the mean | Low timesteps reconstruct high-frequency texture; random noise and compression artifacts have no learnable pattern, keeping loss elevated. Replace with a clean high-res source, crop out watermarks, or remove degraded images |
| **Subject cut off by bucket crop**<br>A tall full-body shot lands in a near-square bucket with `boots, standing` tagged, while the lower body was cropped out | High `Source → Bucket` crop percentage on the left of the detail modal, or an entire size group sits high under **Bucket size** in the right-hand group breakdown (may show a **Crop diff** badge) | Tagged objects were cropped out of frame, creating an image-caption mismatch. Relax bucket aspect ratio limits or reduce bucket resolution steps, pre-crop manually, or remove tags for cropped-out parts |
| **Complex composition / rare view**<br>Dramatic low-angle perspective, ornate armor/outfit, or intricately lit illustration making up a small share of the dataset | Residual `+20%` to `+40%`; often shows `High (dropping)` once 3 comparable epochs are reached and flattens as the whole dataset improves; source image is sharp, cleanly framed, and accurately tagged | The scene carries higher intrinsic detail than the dataset average, or that framing appears infrequently. **Keep the image**; if you want the model to master these compositions more thoroughly, add similar images or raise the subset's `num_repeats` |

### 3 Common Low-Residual Cases

| Case & example | Panel signature | Cause & action |
| --- | --- | --- |
| **Simple / plain-background shot**<br>White-background turnaround sheet, broad solid sky, or close-up portrait with heavy background blur | Only a few minimal shots sit at low residual while most images cluster near `0%` | Large smooth regions lack high-frequency detail, making denoising easy across all noise levels. Normal behavior; no action needed |
| **Near-duplicates or excessive repeats**<br>6 burst shots of the same pose, 5 expression variants sharing a nearly identical base image, or one subset with much higher `num_repeats` | Residuals sink quickly to `-30%` to `-50%`, pushing normal images upward relative to the mean | The model rapidly memorizes the fixed pixels, leading to stiff outputs that break on new poses. Trim duplicate images or lower the subset's `num_repeats`, and check sample previews for generalization |
| **Close to base model prior**<br>Style LoRA trained on an anime base with many standard portraits that already match the base style | A large share of images sit low while checkpoint previews show minimal style shift | The base model already denoises these images with low error, so the LoRA barely updates its weights. Add training samples with stronger, clearer target style cues |

### What to Watch Across Training Stages

| Stage | Data behavior | What to focus on |
| --- | --- | --- |
| **Early** (`< 3` comparable epochs, or `< 5` samples per image) | High variance from random timesteps and noise; slopes not yet computed | Scan only for extreme outliers (corrupt files, blank captions, `NaN / Inf`); avoid culling images broadly |
| **Mid** (`3–10` epochs) | Slopes stabilize and best separate `High (dropping)` from `High (not dropping)` | Focus on persistently high, non-dropping images to fix bad tags, crop mismatches, and low-quality files |
| **Late** (long runs, e.g., `15+` epochs) | Global loss plateaus and most slopes approach `0%` | Watch for near-mean images sinking sharply into low residual; check previews to decide whether to stop early or pick an earlier checkpoint |

### Practical Caveats

- **Mid-run caption or image edits do not affect live cached runs**: When text encoder outputs (default for Anima / MOSS-Image) or latents are cached, editing `.txt` files or images on disk will not change the active run; deleting images mid-run without caching can also break data loading. Note or fix issues as you inspect, then restart or re-cache cleanly.
- **Augmentation and masked loss increase per-step variance**: `caption_dropout_rate`, `shuffle_caption`, `random_crop`, and `color_aug` add step-to-step noise—raise **Min samples** to `5` or `10` and wait for more epochs before judging. With `masked_loss`, images whose mask coverage differs sharply can show systematically shifted residuals.
- **2D scatter plot can show fewer dots than status counts**: In 2D mode, only images with both `≥ Min samples` and a computed slope are plotted; `NaN / Inf`, few-sample, and `< 3`-epoch images remain visible under **Images**.

<a name="workflow"></a>
## Panel Areas and Linked Controls

| Panel area | What it shows and how to use it |
| --- | --- |
| **Header · Views & scope** | Switch between **Overview** and **Images** on the left; configure **Min samples** (`1 / 3 / 5 / 10`), **Dataset** scope, and **Run** segment on the right. Defaults to **Training only** when regularization images exist so they do not skew the baseline (switchable to **Regularization only / All datasets**). Reusing an output folder appends a new segment to `loss.jsonl` — pick **All N runs combined** when resuming from saved state, or keep **Latest (ID)** when retraining from scratch |
| **Overview top · Verdict banner** | Summarizes current status (`NaN / Inf`, high-residual summary, or balanced state) with quick jump buttons and notable-group chips |
| **Left · Scatter plot** | Shows a 1D residual distribution before 3 comparable epochs, then switches to a 2D **Residual × Slope** plot. Enable **Zone shading** in the top-right corner and click the upper-right or lower-right shaded region to filter **High (not dropping)** or **High (dropping)** images; click any dot to pin its preview card, then click the preview thumbnail to open details |
| **Right ① · Image status** | Summarizes counts across all 6 statuses; click any row to filter the scatter plot and timestep curve |
| **Right ② · Timestep bands (`1000 → 0`)** | Plots **Mean loss** across 18 bands in denoising order (high noise `1000` left → low noise `0` right), high/mid/low noise sample shares, and the dashed **Expected** sampling curve; hover or select a status, group, or image to overlay its curve |
| **Right ③ · Group breakdown** | Aggregates mean residual by **Subset / Folder / Bucket size / Batch size** (sections duplicating Subset or containing only one group are hidden automatically; **Bucket size** displays a **Crop diff** badge when aspect difference is `≥ 4%`). The first three dimensions include slopes, click-to-filter, and **`↗`** to jump straight to **Images**; **Batch size** supports hover preview only (no slope, click-filter, or `↗`) |
| **Image detail modal** | Compares `Source → Bucket` resolution with crop `%` and `×` upscale indicators on the left; shows per-epoch residual trajectory, per-timestep sample deviations, and the **Caption** (or **Subset class tokens**) read from disk on the right |

<a name="residual"></a>
## Calculation Details and Upstream Differences

Diagnostics reads `loss.jsonl` emitted by `sd-scripts` `--run_control` and extends upstream [`tools/analyze_run_loss.py`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/tools/analyze_run_loss.py) in three ways:

<a name="residual-bins"></a>
### Residual baseline (10 equal-width bins)

The observed timestep range is split into 10 equal-width bins, requiring at least **2 distinct images** in a bin to form a peer baseline (samples missing a timestep or alone in a bin count toward mean loss and sample totals only):

<div class="doc-equation" role="group" aria-label="Sample residual formula">
  <div class="doc-equation-kicker">Sample residual</div>
  <div class="doc-equation-expression">Residual = sample loss ÷ same-bin mean loss − 1</div>
  <p>An image or group residual is the arithmetic mean across all comparable sample residuals (<code>0%</code> is average; positive is harder, negative is easier).</p>
</div>

<a name="slope"></a>
### Same-epoch peer slope and span thresholds

Per-epoch residuals are measured against the positive (`> 0`) mean loss of **other images in the same epoch and timestep bin**, then fitted by least squares once `≥ 3` comparable epochs exist—removing global loss decay from the slope. The **drop slope threshold** separating `High (dropping)` from `High (not dropping)` adapts to each image's comparable epoch span (`span`, last minus first comparable epoch):

| Comparable epoch span (`span`) | Drop slope threshold | Notes |
| --- | --- | --- |
| `span ≤ 5` (`≤ 6` consecutive epochs) | `-2.0% / epoch` | Requires a clear per-epoch drop on short runs |
| `5 < span < 25` | `-10% / span` | Scaled to require `≥ 10%` cumulative drop across the span |
| `span ≥ 25` | `-0.4% / epoch` | Floor for long runs so steady slow learners are not marked stalled |

<a name="timestep-deweighting"></a>
### Timestep deweighting and log flushing

- **Timestep deweighting**: Recorded `loss` values include `--weighting_scheme` (see [Timesteps](timesteps.en-US.md#weighting)) and masked-loss weights, while excluding sample `loss_weight` (such as `--prior_loss_weight`) and `--min_snr_gamma`. On **Anima** and **MOSS-Image** runs using `sigma_sqrt` or `cosmap`, diagnostics divides out the timestep weight before computing bin baselines and residuals.
- **Flush interval and multi-GPU**: `loss.jsonl` is flushed roughly every 5 seconds alongside `status.json`; multi-GPU runs log rank 0 samples only. Full schema details are documented in upstream [`run_control.md#lossjsonl`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#lossjsonl).
