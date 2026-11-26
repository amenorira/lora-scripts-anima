<a name="guide-title"></a>
# Dataset Diagnostics

Supports **SDXL**, **Anima**, and **MOSS-Image** (`musubi-tuner` / Krea 2 does not write `loss.jsonl`).

Every training step draws a random noise timestep per sample, and raw loss varies severalfold across noise levels—an image can show a high average loss simply from drawing extra high-loss timesteps. Building on Kohya `sd-scripts` per-sample residual analysis (see upstream [`loss.jsonl` and residual analysis](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#analyzing-the-loss-log--loss-%E3%83%AD%E3%82%B0%E3%81%AE%E5%88%86%E6%9E%90)), diagnostics compares each sample against **peers in the same timestep band**:

- **Residual (relative difficulty)**: How far a sample's loss sits above or below the mean loss of its timestep bin. `0%` is the dataset average; higher positive values are harder to fit, negative values are easier.
- **Per-epoch slope (whether residual is converging)**: Once an image has at least `3` comparable epochs, how fast its residual changes per epoch relative to same-epoch peers. Negative slopes mean the gap to the dataset average is closing; values near `0%` or positive mean progress has stalled.

Both metrics measure relative standing **within the same run**; judge overall model quality from checkpoint sample previews.

<a name="rules"></a>
## Status Signals and Recommended Actions

Diagnostics classifies images from top to bottom using **Min samples** (default `≥ 3` comparable samples), `±20%` residual cutoffs, and an adaptive **drop slope threshold**:

| Signal | Match condition (evaluated top to bottom) | Common causes and action |
| --- | --- | --- |
| `NaN / Inf` | Any non-finite loss recorded | Check isolated files for corruption or broken color profiles; if widespread, inspect learning rate and mixed precision immediately |
| `Pending` | Finite or comparable same-bin samples `< Min samples` (**Few samples / Few noise peers** in details) | Wait for more epochs to accumulate samples, or temporarily lower **Min samples** in the header |
| `High (review)` | Residual `≥ +20%`, with `< 3` epochs or slope above the drop threshold (**High (review / stalled / slow)** in details) | Persistently above average without converging—typically missing/wrong tags, damaged images, clipped subjects, or conflicting styles. Open the detail modal to inspect crop and caption, or click **Open in Tag Editor** for standalone `.txt` captions |
| `High (dropping)` | Residual `≥ +20%` and slope `≤ drop slope threshold` | Complex pose, perspective, or outfit that the model is steadily absorbing; keep the image and monitor later epochs |
| `Below mean` | Residual `≤ -20%` | Simple backgrounds or near-duplicates; if a large share of the dataset sits here, check sample previews for overfitting or trim duplicates |
| `Near mean` | `-20% < residual < +20%` | Progressing in line with the dataset average; no action needed |

Note: The drop slope threshold scales automatically between `-2.0%` and `-0.4% / epoch` based on each image's comparable epoch span (see [Same-epoch peer slope](#slope) below); combine status badges with scatter outliers and table sorting to prioritize top outliers.

<a name="workflow"></a>
## Inspection Workflow and Panel Controls

1. **Use Overview to separate isolated bad files from group-wide skew**
   - **Left scatter plot**: Shows a 1D residual distribution before 3 epochs, then switches to a 2D **Residual × Slope** plot. Turn on **Zone shading** in the top-right corner of the chart and click the upper-right or lower-right shaded region to filter all `High (review)` or `High (dropping)` images (where per-image thresholds differ, use dot color in the unshaded band between zones). Click any dot to pin its preview card and open details.
   - **Right ① Image status**: Summarizes counts across all 6 statuses; click any row to filter the scatter plot and timestep curve.
   - **Right ② Timestep bands (`1000 → 0`)**: Plots mean loss across 18 bands in denoising order (high noise `1000` on the left → low noise `0` on the right), high/mid/low noise sample shares, and the dashed theoretical sampling curve. Hovering or selecting a status, group, or image overlays its curve so you can see where excess loss concentrates:
     - **Elevated in high-noise bands (left, coarse layout & color blocks)**: Points to unannotated plain/white backgrounds mixed with complex scenes, heavy letterbox padding, or wide aspect-ratio crop jumps—audit background tags, bucket settings, or subset timestep offsets.
     - **Elevated in low-noise bands (right, fine texture & detail)**: Points to blurry upscales, heavy JPEG artifacts, screentone moiré, or leftover watermarks/text—clean or remove degraded source files.
   - **Right ③ Group comparison**: Aggregates mean residual and slope by **Subsets / Folder / Bucket size / Batch size** (tabs that duplicate Subsets or contain only a single group hide automatically). If an entire group sits high, check its `num_repeats`, caption conventions, or crop framing; click a row to filter Overview, or click **`↗`** at the end of the row to jump straight to that group in **Images**.
2. **Check crop geometry and effective captions in the detail modal**
   - On the left, compare `Source → Bucket` resolution and crop/upscale percentages to verify the main subject was neither cut off nor over-magnified.
   - On the right, inspect per-epoch residual trajectory, per-timestep sample deviations from the dataset baseline, and the active caption text.
3. **Header dataset scope and resumed runs**
   - **Dataset scope**: Defaults to **Training only** when regularization images are present so reg samples do not skew the training baseline; switch to **Regularization only / All datasets** when needed.
   - **Run segment**: Reusing an output folder and name appends a new run segment to `loss.jsonl`. Choose **All {n} runs combined** under **Run** when resuming from saved state so slopes span the full run, or keep **Latest** when retraining from scratch.

<a name="residual"></a>
## Calculation Details and Upstream Differences

Diagnostics reads `loss.jsonl` emitted by `sd-scripts` `--run_control` and extends upstream [`tools/analyze_run_loss.py`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/tools/analyze_run_loss.py) in three ways:

<a name="residual-bins"></a>
### Residual baseline (10 equal-width bins)

Splits the observed timestep range into 10 equal-width bins, requiring at least **2 distinct images** in a bin to form a peer baseline (samples missing a timestep or alone in a bin count toward mean loss and sample totals only):

<div class="doc-equation" role="group" aria-label="Sample residual formula">
  <div class="doc-equation-kicker">Sample residual</div>
  <div class="doc-equation-expression">Residual = sample loss ÷ same-bin mean loss − 1</div>
  <p>An image or group residual is the arithmetic mean across all comparable sample residuals (<code>0%</code> is average; positive is harder, negative is easier).</p>
</div>

<a name="slope"></a>
### Same-epoch peer slope and span thresholds

Per-epoch residuals are measured against the mean loss of **other images in the same epoch and timestep bin** (`> 0`), then fitted by least squares once `≥ 3` comparable epochs exist—removing global loss decay from the slope.

The **drop slope threshold** separating `High (dropping)` from `High (review)` adapts to each image's comparable epoch span (`span`, last minus first comparable epoch):

- `span ≤ 5` (`≤ 6` consecutive epochs): **`-2.0% / epoch`**;
- `5 < span < 25`: scaled to require **`≥ 10%` cumulative drop across that span** (`-10% / span`);
- `span ≥ 25`: floored at **`-0.4% / epoch`** so steady long-run learners are not mislabeled as stalled.

<a name="timestep-deweighting"></a>
### Timestep deweighting and log flushing

- **Timestep deweighting**: Recorded `loss` values include `--weighting_scheme` (see [Timesteps](timesteps.en-US.md#weighting)) and masked-loss weights, while excluding sample `loss_weight` (such as `--prior_loss_weight`) and `--min_snr_gamma`. On **Anima** and **MOSS-Image** runs using `sigma_sqrt` or `cosmap`, diagnostics divides out the timestep weight before computing bin baselines and residuals.
- **Flush interval and multi-GPU**: Flushed roughly every 5 seconds alongside `status.json`; multi-GPU runs log rank 0 samples only. Full schema details are documented in upstream [`run_control.md#lossjsonl`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#lossjsonl).
