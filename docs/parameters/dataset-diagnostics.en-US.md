# Dataset Diagnostics

Supports **SDXL**, **Anima**, and **MOSS-Image** (`musubi-tuner` / Krea 2 does not record `loss.jsonl`).

Every training step draws a random noise timestep for each sample, and raw loss varies widely across noise levels. An image can end up with a high average loss simply because it happened to draw several high-loss timesteps, so raw loss cannot be compared directly across images.

Following the per-sample analysis approach from Kohya `sd-scripts` (see upstream [`loss.jsonl` and residual analysis](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#analyzing-the-loss-log--loss-%E3%83%AD%E3%82%B0%E3%81%AE%E5%88%86%E6%9E%90)), diagnostics compares each sample against **other samples at a similar timestep (noise level)** using two metrics:

- **Residual (relative difficulty)**: How high a sample's loss is relative to the mean loss of the same timestep bin. `0%` is the dataset average; positive values are harder to learn, negative values are easier.
- **Per-epoch slope (whether residual is dropping)**: Once an image has at least 3 comparable epochs, how fast its residual changes per epoch relative to same-epoch peers. Negative values indicate the gap to the dataset average is narrowing; values near `0%` or positive indicate a plateau.

Both metrics measure relative performance **within the same training run**; evaluate overall convergence with checkpoint sample previews.

<!-- doc-anchor: rules -->
## Reading Statuses and Recommended Actions

While upstream `analyze_run_loss.py` only sorts images by residual, this UI groups images automatically using **Min samples** (default `≥ 3` comparable samples), `±20%` residual cutoffs, and a **drop slope threshold**.

The drop slope threshold is calculated from **each image's comparable epoch span** (last minus first comparable epoch): **`-2.0% / epoch`** for spans `≤ 5` (`≤ 6` consecutive epochs), scaled automatically by **`≥ 10%` cumulative drop across that span** for spans between `5` and `25`, and floored at **`-0.4% / epoch`** for spans `≥ 25` so steady long-run learners are not flagged as stalled. Treat these cutoffs as quick grouping guides—combine them with scatter plot outliers and list sorting to inspect the top-ranked images:

| Signal | Condition (matched top to bottom) | Common causes & recommended action |
| --- | --- | --- |
| `NaN / Inf` | Non-finite loss recorded (top priority) | Check individual files for corruption or abnormal color spaces; if widespread, review learning rate and mixed precision |
| `Pending` | Finite or comparable same-bin samples `< Min samples` (**Few samples / Few noise peers** in details) | Not enough samples accumulated yet; wait for more epochs or lower **Min samples** in the header |
| `High (review)` | Residual `≥ +20%`, with `< 3` epochs or slope above the drop threshold (**High (review / stalled / slow)** in details) | Persistently above average without dropping—often missing/wrong tags, bad files, awkward crops, or conflicting features. Open details to check the image and caption, or click **Open in Tag Editor** for standalone files |
| `High (dropping)` | Residual `≥ +20%` and slope `≤ drop slope threshold` | Complex composition or features that the model is actively learning; keep the image and monitor subsequent epochs |
| `Below mean` | Residual `≤ -20%` | Simple composition or near-duplicate images; if many images are very low, check previews for overfitting |
| `Near mean` | `-20% < residual < +20%` | Tracking the dataset average normally; no action needed |

<!-- doc-anchor: workflow -->
## Inspection Workflow and Key Controls

1. **Start in Overview to separate isolated bad images from group-wide skew**
   - **Left scatter plot**: Shows a 1D residual beeswarm before 3 epochs, then switches to a 2D **Residual × Slope** plot. With zones enabled, click the upper-right or lower-right shaded area to select all high-residual images with the corresponding status. When images have different slope thresholds, the gap between the areas can contain either status. Use the dot color to tell them apart. Click a dot to pin its preview card and open details.
   - **Right group comparison**: Aggregates mean residual and slope across **Subsets / Folder / Bucket size / Batch size**. If an entire subset, folder, or aspect-ratio bucket is elevated, check its `num_repeats`, tagging style, crop error, or subset timestep offset; click **`↗`** at the end of a row to jump to that group in Images.
   - **Right timestep bands (`1000 → 0`)**: Plots mean loss across 18 bins from high noise (`1000`) to low noise (`0`), high/mid/low noise sample shares, and the dashed theoretical distribution. Hovering or selecting any status, group, or image overlays a comparison curve to show which noise zone drives the difference.
2. **Verify source image, bucket crop, and caption in the detail modal**
   - Compare `Source → Bucket` dimensions and crop/upscale ratios on the left to check whether the subject was cropped out or overly stretched.
   - Review the per-epoch residual trend, per-timestep sample deviations against the dataset baseline, and the effective caption on the right.
3. **Header dataset scope and resumed runs**
   - **Dataset scope**: When regularization images exist, defaults to **Training only** so reg images do not skew the training baseline; switch to **Regularization only / All datasets** as needed.
   - **Run segment**: Reusing the same output directory and name appends a new segment to `loss.jsonl`. Select **All runs combined** under **Run** when resuming from a state, or keep **Latest** when retraining from scratch.

<!-- doc-anchor: residual -->
## Calculation Details and Upstream Differences

Diagnostics reads `loss.jsonl` written by `sd-scripts` `--run_control` and extends upstream [`tools/analyze_run_loss.py`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/tools/analyze_run_loss.py) with the following adjustments:

- **Residual baseline (10 bins)**: Divides the observed timestep range into 10 equal-width bins, requiring at least **2 distinct images** per bin (samples missing a timestep or alone in a bin count only toward mean loss and total samples):

<div class="doc-equation" role="group" aria-label="Sample residual formula">
  <div class="doc-equation-kicker">Sample residual</div>
  <div class="doc-equation-expression">Residual = sample loss ÷ same-bin mean loss − 1</div>
  <p>Image or group residual is the mean of its comparable sample residuals (<code>0%</code> is average; positive is harder, negative is easier).</p>
</div>

<!-- doc-anchor: slope -->
- **Same-epoch peer slope**: Computes per-epoch residuals against the mean loss of **other images in the same epoch and timestep bin** (`> 0`), then fits a least-squares slope once `≥ 3` epochs are available, removing global loss decay from the slope.
- **Timestep deweighting**: The `loss` field in `loss.jsonl` includes `--weighting_scheme` (see [Timesteps](timesteps.en-US.md#weighting)) and masked loss weights, while excluding sample `loss_weight` (such as `--prior_loss_weight`) and `--min_snr_gamma`. On **Anima** and **MOSS-Image** with `sigma_sqrt` or `cosmap`, diagnostics divides out the timestep weight before computing bin averages and residuals.
- **Flush interval & multi-GPU**: Flushed roughly every 5 seconds with `status.json`; multi-GPU runs record rank 0 samples only. For full field specifications, see upstream [`run_control.md#lossjsonl`](https://github.com/kohya-ss/sd-scripts/blob/v0.13.1/docs/run_control.md#lossjsonl).
