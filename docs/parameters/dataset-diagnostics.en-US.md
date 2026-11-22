# Dataset Diagnostics

Dataset diagnostics summarizes the per-sample `loss.jsonl` log written during training, computing **same-noise residuals** and **per-epoch slopes** for each image and dataset group to help locate mismatched captions, damaged images, or subset and bucket imbalances.

Supported profiles: **SDXL**, **Anima**, and **MOSS-Image** (`musubi-tuner` / Krea 2 does not record `loss.jsonl`).

Residuals and slopes compare relative difficulty across images **within the same training run**; evaluate overall convergence by comparing generated samples across saved checkpoints.

<!-- doc-anchor: residual -->
## Residual: Comparing Samples at Similar Noise Levels

Every training step draws a random noise timestep for each sample, and raw loss varies widely across noise levels (for example, around `0.35` at one timestep and `0.15` at another). A loss of `0.30` is high at the latter timestep and low at the former. An image may have a high raw mean loss simply because it drew more high-loss timesteps by chance, so raw loss cannot be compared directly across samples or images.

Diagnostics uses the **residual** to measure how much higher or lower a sample's loss is than other samples at a similar noise level:

1. Divide the observed timestep range into **10 equal-width timestep bins** and compute the dataset mean loss in each bin.
2. Compute each sample's relative difference from its bin mean, then average across all comparable samples for that image or group:

<div class="doc-equation" role="group" aria-label="Sample residual formula">
  <div class="doc-equation-kicker">Sample residual</div>
  <div class="doc-equation-expression">Residual = sample loss ÷ same-bin mean loss − 1</div>
  <p>An image or group residual is the mean of its comparable sample residuals.</p>
</div>

| Residual | Meaning |
| --- | --- |
| `0%` | Matches the dataset average at similar noise levels |
| `+50%` | 50% higher than the average at similar noise levels (harder than peers) |
| `-20%` | 20% lower than the average at similar noise levels (easier than peers) |

For example, if a bin's mean loss is `0.20` and a sample in that bin has loss `0.30`, its residual is `0.30 ÷ 0.20 - 1 = +50%`.

A timestep bin needs at least two distinct images to provide a same-noise reference. Samples missing a timestep or alone in their bin count only toward raw mean loss and total sample count; images whose comparable sample count is below **Min samples** are marked as `Few samples` or `No noise peers`.

<!-- doc-anchor: slope -->
## Slope: Tracking Multi-Epoch Trends

Images with complex compositions, rare concepts, or styles distant from the base model typically start with higher residuals that drop from epoch to epoch as the model learns them. A high residual that stays flat or rises across epochs usually points to an issue with the image or its caption.

Once an image has comparable samples in **at least 3 epochs**, diagnostics averages its residuals in each epoch and fits a least-squares line to obtain the **per-epoch slope** (two epochs alone are too noisy to fit a slope).
- For example, dropping from `+30%` in epoch 1 to `+20%` in epoch 3 gives a slope of `-5.0%` per epoch.

Using residual and slope together:

| Observation | Typical cause | Recommended action |
| --- | --- | --- |
| High residual (`≥ +20%`) with negative slope (`≤ -2.0%` / epoch) | Complex or unfamiliar concept that the model is actively absorbing | Keep the image and check subsequent epochs |
| High residual (`≥ +20%`) with flat or rising slope (`> -2.0%` / epoch) | Missing or mismatched caption tags, bad crop, degraded image, or conflicting concept definition | **Open the detail modal** to inspect the image and caption, or edit tags in Tag Editor |
| Consistently low residual (`≤ -20%`) | Simple background, easy subject, or near-duplicate images in the dataset | Normal in small numbers; if widespread, check preview samples for overfitting |
| Low sample count or fewer than 3 epochs | Each image trains only `1 × repeats` times per epoch at a random timestep with random noise, so small counts fluctuate | Raise **Min samples** or wait until 3+ epochs have completed |

<!-- doc-anchor: workflow -->
## UI Workflow and Triage Steps

1. **Check `NaN / Inf` losses first**
   - Images that logged any non-finite (`NaN` / `Inf`) loss are pinned to the top and show the `Epoch`, `Step`, and timestep `t` of the first anomaly in the detail modal.
   - If isolated to specific files, verify image integrity, bit depth, and color profile. If widespread across many images, check learning rate, mixed precision, and numerical stability settings.

2. **Expand "Distribution & groups" to spot dataset-wide patterns**
   - **Per-image plot**: Shows a residual distribution histogram and per-image strip before 3 epochs, then switches to a `Residual × Slope` scatter plot once slopes are available. The highlighted top-right region marks high-residual images whose residuals are flat, rising, or dropping slowly. Hover any dot to preview the thumbnail and metrics, or click to open details.
   - **Noise bands (`1000 → 0`)**: Plots the dataset mean loss across the 10 timestep bins from high noise (`1000`, left) to low noise (`0`, right), along with sample counts and shares across the high (`1000–667`), mid (`667–333`), and low (`333–0`) noise zones. Because residuals are normalized against each bin's mean loss, bins with very few total samples have noisier baselines.
   - **Group comparison**: Click any row under **Bucket size**, **Subset**, or **Directory** to filter the image list below. An elevated bucket size often points to cropping or aspect-ratio distortion; an elevated subset or folder usually stems from `num_repeats`, `class_tokens`, or caption quality. **Batch size** compares averages across batch sizes (such as tail batches).

3. **Inspect single-image details and edit captions**
   - Click any image card or row to open the detail modal. The right pane shows per-zone residuals for that image, the **Residual by epoch** line, and **Loss by timestep** (overlaying the image's individual samples against the dataset mean loss curve so you can tell whether the loss is elevated across all noise levels or driven by a single noisy draw; always check the sample count in each zone).
   - The bottom section loads the resolved caption file, metadata entry, or subset `class_tokens`. When the caption comes from a standalone local text file, click **Open in Tag Editor** to jump directly to editing it.

4. **Switch segments and filter regularization images**
   - **Segment**: Starting training again with the same `output_dir` and `output_name` appends a new `run_id` segment to `loss.jsonl`. For **resumed training**, select **All segments combined** in the header to accumulate sample counts and slopes across sessions. For a **fresh run reusing the same output name**, keep the default **Latest** segment so samples from previous runs are not mixed in.
   - **Regularization filter**: When regularization images are present, use **Include regularization / Exclude regularization / Regularization only** in the list toolbar to inspect training and regularization images separately.

<!-- doc-anchor: rules -->
## Status Classification Rules and Logging Scope

### UI status classification rules

Upstream `analyze_run_loss.py` sorts images by residual without fixed cutoffs. This UI classifies images using **Min samples** (default `≥ 3` comparable samples), where the **`High (review)`** filter groups three high-residual states:

| Filter preset | Card / table badge | Condition (evaluated top to bottom) |
| --- | --- | --- |
| `NaN / Inf` | `NaN / Inf` | At least 1 non-finite (`NaN` / `Inf`) loss recorded |
| — | `Few samples` | Total finite sample count `< Min samples` |
| — | `No noise peers` | Total samples meet threshold, but comparable samples with same-bin peers `< Min samples` |
| `High (review)` | `High (review)` | Comparable samples meet threshold, residual `≥ +20%`, and `< 3` comparable epochs (slope unavailable) |
| `High (review)` | `High (stalled)` | Comparable samples meet threshold, residual `≥ +20%`, and slope `≥ 0%` / epoch |
| `High (review)` | `High (slow)` | Comparable samples meet threshold, residual `≥ +20%`, and slope between `-2.0%` and `0%` / epoch |
| `High (dropping)` | `High (dropping)` | Comparable samples meet threshold, residual `≥ +20%`, and slope `≤ -2.0%` / epoch |
| `Below mean` | `Below mean` | Comparable samples meet threshold and residual `≤ -20%` |
| — | `Near mean` | Comparable samples meet threshold and residual is between `-20%` and `+20%` |

### `loss.jsonl` logging scope

- **Included weights**: Per-sample prediction error averaged over pixels or tokens, including model timestep weighting (`--weighting_scheme`, see [Timesteps](timesteps.en-US.md#weighting)) and masked loss weights when enabled.
- **Excluded weights**: Sample `loss_weight` (such as `--prior_loss_weight` on regularization images) and subsequent loss reweighting (such as `--min_snr_gamma`) are not included in the logged `loss` value.
- **Flush interval & multi-GPU**: Flushed roughly every 5 seconds together with `status.json` (the last few steps may be absent if the process is killed); in multi-GPU training, only samples processed on rank 0 are recorded.
