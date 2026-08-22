# Changelog

[中文](CHANGELOG.md)

All notable changes to this project are documented in this file.

## Unreleased

## v2.7.0 - 2026-08-22

This release adds four optimizers for Anima LoRA training — Adan, AdEMAMix (with an 8-bit variant), and LoRA-RITE, which is purpose-built for the LoRA structure — with all their dedicated parameters wired into the training form and defaults tuned for LoRA work. The optimizer dropdown is regrouped and every option gains a one-line description.

### New optimizers

- Adan: tracks consecutive-gradient differences on top of Adam's moments for a lookahead update, with an optional decoupled weight-decay toggle; default LR 1e-5 (half the AdamW baseline), and the description explains how its effective step relates to AdamW at the same LR.
- AdEMAMix and AdEMAMix8bit: dual-timescale gradient memory — fast (β1=0.9) and slow (β3=0.9999); mixing strength alpha and both ramp-step fields are directly editable, auto-filled from the estimated total steps when left empty.
- LoRA-RITE: removes update differences between equivalent reparameterizations of the same LoRA; ships its own clipping measured on unmagnified gradients (the global clipping threshold locks to 0 in this case), and its eps uses root-epsilon semantics with a dedicated hint. Anima LoRA only, standard LoRA structure only, incompatible with LoRA+ — marked in both the UI and the docs.
- All four passed real-training smoke runs (4 images, 40 steps); LoRA-RITE's metadata name is written as LoRARITE so metadata viewers don't truncate it at the hyphen.

### Optimizer dropdown

- Options are regrouped into six characteristic-based groups: AdamW and storage variants, built-in stabilization, lookahead-difference and sign updates, dual-timescale gradient memory, internal LR estimation and scheduling, and matrix-structure updates; empty groups are hidden automatically.
- Every option gets a one-line description of its characteristics (update mechanism, memory footprint, LR semantics) — facts only, no recommendations.

### Docs

- The optimizer guide gains parameter sections for Adan, AdEMAMix, and LoRA-RITE plus a gradient-clipping section; the LR auto-start table now covers the three new optimizers, and the LoRA+ section notes LoRA-RITE's incompatibility.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.6.0...v2.7.0)

## v2.6.0 - 2026-08-16

This release upgrades the Tagger and the tag editor: the single-image mode gets a reworked layout plus a new "unload model after task" switch, and the tag editor fixes the full-folder fetch crash while gaining a complete keyboard workflow.

### Tagger single-image mode

- The right column now scrolls as a whole instead of each category scrolling inside; categories lose the card look and keep a fixed order, the total-tag block drops its fixed-height frame, and the left column layout no longer truncates.
- Collapse/expand for model settings, output options, and categories now animates.
- The CL model-tag switch in single-image mode is now a real toggle, fixing "add model tag" not taking effect in that mode.
- Both modes gain an "unload model after task" switch: the model is released from VRAM when inference finishes; leave it off to keep the model resident for faster consecutive runs.
- The category-threshold grid no longer overflows in narrow windows (the stepper was pushed out of its border), and the single-image WD threshold becomes a stepper, matching batch mode.

### Tag editor

- Fixed the TypeError from a missing URL parameter when fetching all images: select-all-of-filter, batch operations on filtered/all images, right-click global tag add/remove, and inline tag-cloud renaming all work again.
- Double-clicking a card now opens the full-size view; Enter focuses the add-tag box, ←/→ navigation scrolls the selected card into view, and Tab/Enter focus switching no longer hits hidden inputs.
- The route-leave guard now uses the same custom confirm dialog as the rest of the editor (Esc cancels / Enter confirms).
- Undo/redo/restore-backup get distinguishable icons; the tag cloud gains sort by frequency/name/length; a shortcut-help overlay joins the toolbar.
- Restoring a draft clears it so the prompt no longer repeats, and saving notes that the edit history was archived to the timeline.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.5.1...v2.6.0)

## v2.5.1 - 2026-08-15

This patch fixes the placement of weighting_scheme in the LoRA training form's timestep & weighting group: logit_mean/logit_std/mode_scale were rendered before it because of the frontend parent-key resolution rule (show_if arrays resolve to their last key), pushing weighting_scheme to the end of the group. The three fields now declare their layout parent explicitly, restoring the registry order; the Krea 2 profile gets the same fix. A regression test runs the real frontend ordering logic in node and pins the field order for both profiles.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.5.0...v2.5.1)

## v2.5.0 - 2026-08-15

This release redesigns the environment management page and fixes a batch of interface details: the page moves to a full-width three-section layout with incremental rendering so status is clear at a glance; sidebar interaction, the dashboard tab indicator, the outputs page, and other animation/layout issues are addressed.

### Environment page redesign

- Layout: the card wall becomes a full-width three-section layout (Hero overview + two-column runtimes + full-width models), replacing details cards with row-based components.
- Rendering: incremental per-section updates — progress refreshes only touch the affected section instead of rebuilding the DOM, so collapse animations, input focus, and log scrolling survive.
- Interaction: custom collapse reuses the height animation; busy/failed states auto-expand, and panel expand state is persisted.
- Semantics: statuses shrink to four states — green (ready) / red (real failure) / gray (not configured) / accent (in progress) — and all status lamps are removed; not-installed/not-downloaded items use neutral gray.
- Fixes: install/download failure reasons are no longer swallowed by silent refreshes, version links no longer trigger collapse by accident, and stale download progress no longer misreports failure; action buttons are consistently right-aligned and loading states merge into the Hero.
- Three new node unit tests cover default expand rules, failure-reason retention, and persistence migration.

### Fixes and polish

- Sidebar interaction: the active state drops the bold text and the left blue bar (the icon takes the accent color instead); hover/press backgrounds are gone, leaving the sliding pill as the only highlight; pressing now scales the whole item for a tactile feel, eliminating text flicker.
- Fixed animation/layout issues including Tagger dropdown misplacement/clipping (enter-animation fill changed from both to backwards), content-width jumps from scrollbars when switching dashboard tabs, and the gap bleeding through the sticky header in the outputs panel.
- Dashboard tab indicator: the run-detail response now includes output_count, so the badge is there on first paint and button widths stop changing late; the indicator now tracks button sizes via ResizeObserver and repositions smoothly when badges appear, digit counts change, or the language switches.
- The outputs page no longer flashes on first entry (the loading placeholder skips the enter animation, and the real file list fades in on first render), and leaving history now clears the badge counter.
- The quick-nav rail no longer flashes mid-page on the training page: it is teleported to body, fully out of the route animation ancestors.
- Fixed factual errors in training form help text (vae_disable_cache speed direction, Krea 2 gradient-checkpoint CPU offload being a no-op, conv_dim/conv_alpha empty behavior, Prodigy scheduler exceptions, etc.), added missing field descriptions such as prodigy_d_coef and debiased_estimation_loss, removed dead keys, and synced the Chinese/English copy.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.4.0...v2.5.0)

## v2.4.0 - 2026-08-15

This release focuses on interface motion and navigation: page switches, tab switches, and sidebar navigation all get smooth, layered animations; the training dashboard tabs become persistent panels, so switching no longer rebuilds content and scroll/expand state is preserved.

### Motion and navigation

- Route switching is now "old page fades out quickly → new page content cascades in top to bottom", scoped to the main content area only — the sidebar and top bar no longer move with it. The system "reduce motion" preference is respected throughout.
- The sidebar gains a sliding highlight indicator: the moment a nav item is clicked, the highlight glides over — click feedback no longer waits for the page to mount.
- The four training dashboard tabs (Overview / Logs / Samples / Outputs) are now persistent panels: switching only toggles visibility, so incremental log rendering, sample scroll position, and output-file expand state survive round trips. The tab bar gets a sliding indicator, panel content cascades in top to bottom, and leaving the Samples tab cancels the background media-loading queue.
- The Tagger batch/single mode switch gets a layered enter animation, and its mode tabs now share the dashboard tab styling with the same sliding indicator; the tag editor's sidebar tabs get a fade-in transition.
- The LoRA training page's quick section nav is now built ahead of the heavy form render (it only depends on the train type), so it appears immediately on page entry instead of waiting for the form to mount.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.8...v2.4.0)

## v2.3.8 - 2026-08-15

This patch release focuses on code hygiene and reliability: duplicated backend implementations are consolidated, confirmed dead code is removed, autosave no longer depends implicitly on the launch directory, and mutable default arguments are eliminated; three parameter docs also get factual corrections and polished bilingual wording.

### Refactoring and cleanup

- The Automagic field mapping table now lives in optimizer_contracts, giving adapter and validation a single source of truth; tageditor routes and core share extracted helpers, and monitor centralizes TensorBoard scalar labels and progress-bar kwargs.
- Removed confirmed dead code (zero-call frontend methods, the legacy config.js compatibility branch, and backend aliases such as python_bin and _MUSUBI_RUNTIME_PACKAGES); the training route's five JSON-parse snippets converge into a shared _read_json_object, and monitor progress fields and result.json reading are unified.
- autosave now resolves its output directory from constants.AUTOSAVE_DIR instead of implicitly depending on the launch directory; postprocess_tags replaces its mutable default argument with None plus in-function normalization; removed 13 placeholder-less f-strings.
- New frontend/js/utils.js centralizes cross-module helpers (esc / tMonitor / training-group mapping); test factories move to tests/helpers.py; the bare config rule in .gitignore becomes an allowlist.

### Documentation

- Corrected factual errors in the lora-plus, optimizers, and timesteps parameter docs (Krea 2 support, the LoRA+ compatibility list, Muon applicability, the percentile_clipping parameter name, musubi-tuner source paths, etc.), removed translationese, and polished the bilingual wording.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.7...v2.3.8)

## v2.3.7 - 2026-08-13

This patch release focuses on frontend performance and polish: static assets are now gzip-compressed with versioned caching, so startup and page-refresh transfer drop dramatically; the stale release badge on the home page and a corrupted README command path are fixed.

### Performance and transfer

- gzip compression for all static assets and API responses: first-load transfer drops from ~1.3 MB to ~280 KB (biggest win on LAN or slow links).
- Versioned assets (?v=) now use one-year immutable caching while unversioned files keep revalidation; a page refresh drops from 21 static requests to 1 (index.html only).
- /api/fields answers 304 with an ETag when unchanged, avoiding an ~88 KB re-download on every load.
- i18n now blocks on the active locale only (~96 KB); the other locale preloads in the background, and language switching behaves exactly as before.
- Weak-network mode (serialized thumbnail loading) now defaults adaptively: parallel loading on local/LAN connections, auto-enabled on 2g/3g/save-data, always switchable manually.
- Lazy-loaded pandas/numpy/cv2 cut GUI cold start by ~31%.

### Fixes and cleanup

- The home-page Release badge now shows the real backend version (previously the stale v1.3.3).
- `<html lang>` is synced with the startup language for correct screen-reader and translation behavior.
- Fixed corrupted venv command paths in the README (control-character pollution made the Windows commands un-copyable).
- Fixed a typo and added test-dependency and Linux command docs in the README.
- Removed confirmed dead code (unused functions, imports, constants, and Chart.js static files).

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.6...v2.3.7)

## v2.3.6 - 2026-08-12

This patch release replaces the legacy preset manager with portable training YAML files and refines the training-form hierarchy, parameter preview, and monitoring details so saved configurations restore the behavior users actually trained with.

### Training configuration YAML

- Added versioned training YAML download, import, and automatic per-run saving. Documents preserve all active form values, conditional parameters, and preview settings so older configurations do not silently adopt newer application defaults.
- Training history now prefers `training.yaml` when restoring the complete form while retaining compatibility with legacy flat TOML imports.
- Removed derivable `engine_id` and `adapter_id` metadata from user-facing YAML. Internal run records still retain core information for scheduling and diagnostics.
- Removed the legacy training-preset UI, API, and local state in favor of a single download-and-import file workflow.

### Form and parameter preview

- Simplified duplicate form containers, explanatory UI, and obsolete interactions while keeping conditional fields stably ordered and clearly indented by dependency.
- Moved the optimizer selector before learning-rate and scheduler controls while keeping optimizer-specific parameters below the shared controls.
- The sidebar TOML preview continues to reflect the actual runtime arguments and now de-emphasizes application defaults that must still be passed explicitly. Copied TOML remains unchanged.

### Fixes and cleanup

- Fixed the timestep-distribution chart in parameter documentation and aligned training-monitor log counts and progress-state updates.
- Simplified environment-loading messages and removed stale frontend calls, duplicate constants, and unused styles left by preset removal.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.5...v2.3.6)

## v2.3.5 - 2026-08-10

This release adds native PyTorch Muon support for Anima LoRA and completes the path from UI configuration and validation through sd-scripts startup and CUDA updates. It also unifies image previews across training artifacts, Tagger, and Tag Editor.

### Muon optimizer

- Added native `torch.optim.Muon` to the Anima LoRA optimizer menu while keeping it hidden for SDXL. sd-scripts uses the native `Muon` selector directly without an additional wrapper.
- Added controls for learning-rate scaling, momentum, Nesterov momentum, Newton-Schulz iteration count and coefficients, `eps`, and weight decay. The product default uses `match_rms_adamw`, with `2e-5` as the Anima learning-rate starting point.
- Explicitly passes the product default `weight_decay=0` to sd-scripts, overriding PyTorch Muon's library default of `0.1` so the UI and actual training configuration stay aligned.
- Added parameter-domain, Anima-only visibility, frontend filtering, and configuration-adaptation coverage. The generated argument set creates native Muon through sd-scripts and completes a CUDA `backward()` and `step()` update.
- Expanded the English and Chinese optimizer guides with Muon versus AdamW behavior, parameter effects, compute costs, comparison guidance, and a layout that remains readable in narrow documentation panes.

### Image previews

- Added a unified image-preview API that generates WebP thumbnails, previews, and inspection images for datasets, training artifacts, and Tagger while preserving direct access to originals.
- Added a large-image lightbox, zoom and pan, and open-original actions to Tag Editor, and removed legacy image routes and duplicate cache implementations.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.4...v2.3.5)

## v2.3.4 - 2026-08-09

This patch release fixes training state not appearing immediately on the training page, Dashboard, and sidebar after a task is created successfully.

### Training state synchronization

- Update the shared training state and task identifiers as soon as the start request succeeds, without waiting for the next WebSocket event.
- Fetch a fresh realtime snapshot to reconcile backend task state, so a new task appears without a page refresh when using SSH port forwarding, a proxy, or a delayed network connection.
- Prevent an older in-flight snapshot from masking the newly created task and add frontend regression coverage for state updates and the snapshot race.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.3...v2.3.4)

## v2.3.3 - 2026-08-08

This patch release aligns layout and interaction patterns across the trainer, improves the Tagger single-image review workflow, and fixes details in startup output, training monitoring, and Tag Editor navigation.

### Startup and UI consistency

- Improved Windows and Linux startup progress and ready output. Service, TensorBoard, and log paths now wrap naturally in narrow consoles instead of being constrained by persistent panel borders.
- Aligned page shells, toolbar heights, controls, typography, and scrolling across Dashboard, Tagger, and Settings, reducing pixel shifts and visual discontinuity when switching views.
- Fixed the localized “Running” state in training history and standardized the Chinese training-summary term for Epoch as “轮次”.
- Fixed the top loading indicator remaining active when Tag Editor opens without a selected dataset directory.

### Tagger single-image workspace

- Added wheel zoom, drag-to-pan, and double-click or toolbar reset to fit the preview; removed the ineffective preview-background toggle.
- Made the Total Tags area vertically resizable with pointer and keyboard controls, constrained by the available space in the left pane.
- Made the confidence-category arrow, name, and count region a full-width expand/collapse control while keeping visibility and copy actions independent.

### Timestep settings and documentation

- Moved the per-subset sampling-offset editor after `weighting_scheme` and its conditional fields, with a direct link to the relevant guide section.
- Clarified that subset offsets work only with `sigmoid`, `shift`, and `flux_shift`; under `sigma`, `logit_normal` and `mode` change the shared base distribution rather than an individual subset offset.
- Updated the English and Chinese timestep guides, field hints, and regression coverage accordingly.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.2...v2.3.3)

## v2.3.2 - 2026-08-08

This patch release fixes training-monitor log and preview behavior and refines the layout of SDXL training-objective settings.

### Training monitor

- Preview samples now prefer the generation timestamp, training progress, and prompt index encoded in trainer filenames. The latest sample and training order remain correct after copied or restored output folders change file modification times.
- Fixed invalid tail parameters on the initial full-log request and immediately clear stale loading state when the training task or log source changes.
- Switching between training order and latest-first on the Samples tab now reorders existing preview nodes in place instead of rebuilding the entire grid, avoiding flicker and transient broken images.
- Removed the duplicate “Latest sample” card from Overview and used the space to expand training diagnostics.

### SDXL parameter form

- Moved `zero_terminal_snr` beside `v_parameterization`. It remains visible only when v-parameterization is enabled, but is no longer rendered as an indented child field.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.1...v2.3.2)

## v2.3.1 - 2026-08-08

This patch release updates the timestep parameter guide with a new per-subset offset section and fixes wording and references.

### Parameter documentation

- Added a "Per-subset timestep offsets" section to the timestep guide (`docs/parameters/timesteps*.md`): numeric-prefix subset rules, the `subset_timestep_offsets` mapping and its `dataset.toml` conversion, the offset formula and the sampling modes where it is active, plus a recommended range and comparison tips.
- Updated the parameter activation matrix and common misconceptions, fixed wording in both languages, and pinned the evidence references to the reviewed revision (2026-08-08).

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.3.0...v2.3.1)

## v2.3.0 - 2026-08-07

This release focuses on a complete per-training-subset timestep sampling offset workflow, with direct visual comparison of the training regions before and after each offset. It also completes regularization dataset support and auditable training-step estimation.

### Per-subset timestep sampling offset

- Added a subset editor below the existing timestep controls so numeric-prefix training folders such as `10_face` and `3_full_body` can configure `timestep_sampling.offset` independently, with decimal keyboard input, steppers, undo, and reset actions.
- Training now generates a complete sd-scripts `dataset.toml` and passes it through `--dataset_config`; empty and zero values are omitted, stale subsets are rejected, and regularization subsets always remain unbiased.
- Expanded the timestep chart with baseline, overall training, and individual subset scopes, comparing distributions, median timestep movement, and low-, mid-, and high-noise region shares.
- Clarified that offset is applied to the normal sample before sigmoid: negative values favor low-noise detail, positive values favor high-noise structure, and the setting is active only for `sigmoid`, `shift`, and `flux_shift`.

### Datasets and training steps

- Added Anima regularization dataset controls for enabling regularization, selecting its directory, and setting prior loss weight, with training and regularization subsets distinguished in step estimates.
- Aligned step estimation with sd-scripts directory registration, bucketing, and ceiling rules, and exposed the complete calculation as verifiable steps.

### Upstream sync

- Updated vendored `sd-scripts` to `37a1cbb` (`v0.11.1-30-g37a1cbb`): added per-subset `timestep_sampling.offset` and the `--show_timesteps_offset` preview flag, updated IPEX libraries, and fixed typos.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.2.4...v2.3.0)

## v2.2.4 - 2026-08-05

This patch release improves the training parameter guides with FAQ sections, a unified evidence format, and consistent terminology.

### Parameter Documentation

- Added "Frequently asked questions" sections to the LoRA+ and optimizer guides, covering ratio selection, disabled combinations, and replaced recommended values.
- Unified the evidence format across all three guides with a fact-check date and pinned revision links; the timestep guide now has an "Evidence and references" section.
- Standardized terminology (checkpoint, seed, repeats) and fixed the corrupted Lion reference hash in the English guide.
- Added a "Training Parameter Guides" entry to both READMEs.

[Full changelog](https://github.com/amenorira/lora-scripts-anima/compare/v2.2.3...v2.2.4)

## v2.2.3 - 2026-08-03

This patch release restores more natural, practical timestep, LoRA+, and optimizer parameter guides while removing brittle tests that locked documentation wording, visual styling, and internal implementation details.

### Parameter Documentation

- Restored the practical bilingual timestep and LoRA+ guides while preserving links from training fields to their relevant sections.
- Restored the bilingual optimizer guide to its readable pre-rewrite version while retaining coverage of supported optimizers and settings.

### Test Maintenance

- Removed low-value assertions for fixed wording, source revisions, CSS layouts, and source-code string snapshots.
- Retained tests for documentation routes, registered field anchors, configuration generation, training adapters, and runtime behavior.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.2.2...v2.2.3)

## v2.2.2 - 2026-08-03

This patch release aligns LoRA form behavior across the UI, configuration adapter, and validator; it also updates bilingual guidance and built-in parameter documentation with reviewable pinned upstream sources.

### Parameter Contracts and Form

- Unified the effective Automagic3 default for a missing `max_lr` at `1e3` while preserving explicit values from existing presets and API requests.
- Corrected the behavior boundaries and linked guidance for LoRA+, AdaFactor, Prodigy-family optimizers, offload modes, scheduler cycles, and non-square resolution previews.
- Reworked shorthand wording, terminology casing, and redundant parentheticals in both locales so labels, hints, and lock reasons have distinct roles.

### Documentation and Sources

- Updated the timestep, LoRA+, and optimizer guides to distinguish upstream mechanisms, current-trainer behavior, and configuration values, with pinned revisions and a verification date.
- Corrected source attribution for Automagic3 and EmoSens: they are integrated upstream optimizers, while the current trainer supplies sd-scripts adapters, runtime connections, and compatibility constraints.

### Regression Protection

- Added automated coverage for Automagic3 defaults, LoRA+ restrictions, offload combinations, scheduler guidance, resolution previews, and pinned upstream links.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.2.1...v2.2.2)

## v2.2.1 - 2026-08-02

This patch release refactors the Tag Editor's data and session workflows and improves the desktop training dashboard when working with large sample, log, and output collections.

### Tag Editor

- Refactored the Tag Editor repository, session, snapshot, and timeline layers, consolidating frontend/backend state contracts and expanding regression coverage.
- Improved responsive image-grid cards so images and editing details remain stable and readable across desktop window widths.

### Training Dashboard

- Fixed sample cards overlapping across rows and hiding filenames, introduced a stable responsive gallery that preserves full images, and added training-order and latest-first modes.
- Removed exact overlap between HTTP snapshots and WebSocket replay, collapsed adjacent `tqdm` updates for the same step, and aligned visible rows across full-log, paginated, and live modes.
- Added output-file search, type filters, independent sorting for models and other files, visible-result selection, and batch actions, while improving table typography, row height, and narrow-window scrolling.
- Unified desktop typography across the four dashboard tabs, diagnostics, status badges, and supporting metrics, with complete Chinese and English UI copy.

### Regression Protection

- Added automated coverage for log overlap, same-step replacement, paginated totals, sample ordering, and output filtering and sorting.
- Verified regular and narrow desktop layouts in the browser, ensuring sample cards do not overlap, output tables scroll locally, and the page has no horizontal overflow.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.2.0...v2.2.1)

## v2.2.0 - 2026-08-01

This release unifies the desktop workspace and startup experience, expands optimizer metadata and Anima learning-rate coupling, and further refines the Tagger UI and training documentation.

### Desktop Workspace and Startup Experience

- Refactored application startup, logging initialization, and server output to present access URLs, runtime details, and startup state together, with clearer failure fallback.
- Unified desktop layouts and control sizing across training pages, Tagger, and shared UI, reducing duplicate styles and improving information density in narrow windows.
- Refined the Tagger single-image workspace, model configuration, and result presentation so category thresholds, character tags, and editing actions are easier to scan.

### Anima Learning-Rate Coupling and Compatibility

- Changed every `setIfDefault` rule to use explicit field provenance, preserving manual input, imports, presets, and legacy local drafts even when a value happens to equal a default.
- Persisted provenance per training route and profile; resetting one field re-enables its current dependency-aware recommendation, while a full reset restores all profile defaults.
- Derived Anima learning-rate placeholders directly from registry `autoValue` rules and removed the separately maintained frontend recommendation map.

### Optimizers and Training Configuration

- Added centralized optimizer metadata covering parameter defaults, applicability, and serialization contracts, while refining Anima optimizer learning-rate and scheduler defaults.
- Refactored Krea 2 configuration adaptation and training-field registration to reduce duplicated frontend/backend definitions and broaden regression coverage.
- Fixed preset-application undo and field-provenance restoration so automatic recommendations do not overwrite user configuration.

### Documentation

- Corrected the evidence boundaries for `cosine_with_restarts`, Anima rank/alpha, Schedule-Free warmup, and Lion weight decay, with upstream references pinned to revisions reviewed on 2026-07-31.
- Reduced repeated LR values so the optimizer guide's learning-rate table is the single detailed recommendation matrix.
- Fully refreshed the Chinese and English READMEs, parameter guides, and UI copy so training backends, installation flows, and runtime boundaries remain consistent.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.1.0...v2.2.0)

## v2.1.0 - 2026-07-30

This release redesigns the Tagger workflow and systematically refines training parameter copy, optimizer documentation, and advanced Krea 2 configuration.

### Tagger Workspace

- Rebuilt Tagger as a dedicated workspace for single-image inspection, batch processing, result editing, and caption-file output.
- Added WD EVA02 Large v3, WD ViT Large v3, CL Tagger v1.02, and Camie Tagger v2 with model-specific category thresholds and character-tag controls.
- Improved model selection, single-image layout, confidence results, and tag formatting, while fixing stale selection state and incorrect model names.
- Removed the local LLM tag-generation path that did not form a stable workflow, keeping the ONNX Tagger runtime boundary predictable.

### Training Parameters and Optimizers

- Audited visible SDXL, Anima, and Krea 2 fields, separating concise labels from defaults, applicability, coupling, and side-effect guidance.
- Corrected the semantics of Batch size, gradient accumulation, Dropout, timestep sampling, Loss weighting, CAME, AdaFactor, Schedule-Free, and ten learning-rate schedulers.
- Added bilingual optimizer parameter guides and completed StableAdamW support for weight decay, Kahan summation, and argument serialization.
- Added dropdown guidance for Krea 2 timestep, attention, and optimizer choices, and corrected Lion8bit, cache fingerprint, and RAW/Turbo DiT descriptions.

### Krea 2 FP8 and Compatibility

- Merged `fp8_base` and the non-independent `fp8_scaled` setting into one dynamic-scaling FP8 toggle while still emitting both musubi arguments when enabled.
- Continued accepting legacy `fp8_scaled` values in presets and API payloads, normalizing them from `fp8_base` during validation.
- Versioned the field-schema fallback asset so upgrades do not retain stale labels or omit newly added hints.

### Regression Coverage

- Added contracts for merged FP8 behavior, legacy payloads, scheduler descriptions, bilingual i18n, visible field titles, and field-asset cache invalidation.
- The full unit suite covers the Tagger workspace, multi-core training, field schemas, optimizer arguments, and Krea 2 configuration generation.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.0.1...v2.1.0)

## v2.0.1 - 2026-07-26

This patch release focuses on training-monitoring, optimizer coupling, dependency-download, and documentation-navigation issues found after v2.0.0.

### Training Logs and Live Monitoring

- Compacted terminal-width `tqdm` progress bars in web training logs to a stable width, preventing long blank regions and wrapped metrics.
- Unified learning-rate scientific notation across log parsing, TensorBoard increments, and frontend fallback paths, eliminating format changes such as `e-5` versus `e-05`.
- Suppressed routine `httpx` request logs from the TensorBoard reverse proxy so Rich's live progress row is not repeatedly frozen into the console history.

### Optimizer Configuration

- Fixed optimizer switches resetting linked fields such as `weight_decay`, `max_grad_norm`, `betas`, and `eps` to incorrect defaults.
- Changed the recommended `AdamWScheduleFree` learning rate for Anima and SDXL from the library-wide `0.0025` default to the more conservative LoRA-oriented value `3e-4`.
- Synchronized the frontend offline field fallback and optimizer contract tests while preserving user-entered learning rates.

### Installation and Documentation

- Shortened per-source Flash Attention connection timeouts, removed duplicate retries against the same source, and separated API and wheel proxies for more reliable fallback.
- Fixed documentation navigation highlighting that could jump from a short section to the following section too early while scrolling.
- Completed and aligned the bilingual v2.0.0 changelogs with full version history and language-switch links.

### Regression Coverage

- Added tests for optimizer-linked resets, Flash Attention fallback, training-log cleanup, live LR formatting, console logger levels, and documentation section tracking.

[Full changes](https://github.com/amenorira/lora-scripts-anima/compare/v2.0.0...v2.0.1)

## v2.0.0 - 2026-07-25

This is a training-architecture-level update. v2.0.0 introduces a multi-core training system, officially integrates Krea 2 RAW DiT LoRA, and upgrades the default training stack to PyTorch 2.10.0 + CUDA 13.0. Training configuration, cache preflight checks, environment management, parameter previews, and built-in documentation have also been systematically reorganized around multi-core workflows.

### Multi-Core Training Architecture

- Added an explicit training-core registry that isolates fields, parameter validation, command generation, and launch flows for each trainer.
- `sd-scripts` continues to handle SDXL and Anima, while `musubi-tuner` handles Krea 2 RAW DiT LoRA.
- LyCORIS remains available as an optional adapter core through `lycoris.kohya`.
- The frontend switches fields, presets, optimizers, and timestep options based on the active training type, preventing parameters from different cores from contaminating each other.
- TOML import and export, parameter previews, training preflight checks, and task monitoring all support core switching.

### Krea 2 RAW DiT LoRA

- Fully integrated Krea 2 models, VAE, the Qwen3-VL text encoder, and dataset TOML configuration.
- Added latent and text-encoder caching with pre-training checks that ensure caches are complete and still match the images, captions, and models.
- Automatically collect Krea 2 dataset caches, reducing manual maintenance of cache paths and intermediate files.
- Added training command generation, progress estimation, log monitoring, stopping, and interrupted-run recovery.
- Added Krea 2-specific optimizer, scheduler, timestep sampling, and network parameter options.
- Fixed Krea 2 parameter-preview highlighting, preset export, field naming, and custom-optimizer injection boundaries.

### Shared CUDA 13 Training Environment

- Upgraded the default training environment from PyTorch 2.10.0 + cu128 to PyTorch 2.10.0 + cu130.
- RTX 30, 40, and 50 series GPUs now use a unified CUDA 13.0 training stack.
- Existing cu128 `venv` environments migrate on the next launch, while new installations use cu130 directly.
- Installed xformers, FlashAttention, Triton, and bitsandbytes packages are rematched to the new environment.
- ONNX Runtime GPU moves to the CUDA 13-compatible version, with a fix for accidental removal caused by a stale dependency-version cache during the same launch.
- Machines without an NVIDIA GPU can still complete environment installation and run the GUI; only training requires an NVIDIA GPU.

### Krea 2 Runtime Management

- Krea 2 shares the project-root `venv` with the main application, replacing the separate core environment.
- `requirements-musubi-krea2.txt` converges the shared dependencies required by Krea 2.
- Normal startup performs only a fast metadata check. When versions are correct, it does not rerun pip, uninstall dependencies, or import the complete training stack.
- Full import verification still runs after dependency synchronization and before actual Krea 2 tasks.
- A legacy `venv/cores/musubi` is no longer read, written, or deleted automatically and can be removed manually after the new environment is confirmed working.

### Parameter Configuration and Previews

- Enhanced TOML and training-command previews so each form change can be located in the generated parameters.
- Improved multi-select menus, preset loading, core switching, and automatic cross-field value synchronization.
- Fixed inconsistent timestep sampling options between Anima and Krea 2.
- Added Anima and Krea 2 timestep distribution previews with histogram, density, cumulative-distribution, and signal-to-noise-ratio views.
- Improved LoRA+ parameter coupling, optimizer compatibility constraints, and interface guidance.

### Built-In Training Guides

- Added complete bilingual timestep guides covering common sampling methods, parameter meanings, distribution characteristics, and recommended use cases.
- Rewrote the LoRA+ guide with learning-rate ratios, optimizer compatibility, and configuration guidance.
- Added tables of contents, anchor navigation, formula layout, and contextual entry points from parameter controls.
- Improved desktop and narrow-screen layouts so long formulas, tables, and navigation remain readable in smaller windows.

### Startup and Environment Management

- Added immediate stage messages and dynamic progress to the Windows and Linux launchers.
- Simplified normal startup output while preserving diagnostic logs for installation and dependency issues.
- Changed the environment page to progressive loading to reduce the initial wait and perceived unresponsiveness.
- Optimized Krea 2 runtime probing so healthy environments do not repeat expensive checks on every launch.

### Upstream Synchronization

- Updated vendored `sd-scripts` to `6565877` (`v0.11.1-9-g6565877`).
- Added compatibility for Anima aesthetics weight keys and fixed dataset handling for custom caption separators and tags-only metadata.
- Updated vendored LyCORIS to `a72bb1b`, adding a weight-only FP8 bypass and matching for new model modules.
- Added a pinned `musubi-tuner` snapshot as the Krea 2 training core while keeping upstream sources inside the `vendor/` boundary.

### Upgrade Notes

- The first launch after upgrading may spend additional time migrating CUDA and PyTorch dependencies. Allow the launcher to finish.
- CUDA 13.0 requires NVIDIA driver R580 or newer.
- The project requires 64-bit Python 3.10 through 3.12; Python 3.12 is recommended.
- If the existing `venv` was created with Python 3.13 or 3.14, remove or rename only the project-local `venv`, then run the launcher again.
- Krea 2 requires both latent and Qwen3-VL text-encoder caches before training. The interface blocks launch when caches are missing or stale.

### Regression Protection

This release adds regression coverage for the multi-core architecture, Krea 2 configuration and caching, timestep previews, built-in documentation, launchers, the shared runtime, parameter contracts, and realtime state, covering the primary behavioral boundaries of this architecture upgrade.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.3.3...v2.0.0)

## v1.3.3 - 2026-07-19

Unified trainer realtime communication and improved slow remote connections while strengthening output discovery and the reliability and responsive behavior of the tag editor.

### Realtime Communication and Slow Connections

- Unified task state, training progress, log increments, and hardware data over the same-origin `/ws/realtime` endpoint, with backend instance identification, snapshot restoration, and reconnection.
- Clearly distinguished delayed realtime data from a disconnected backend, and cleared stale instance state after backend restarts to avoid presenting expired tasks and monitoring data as current.
- Enabled slow-connection compatibility by default: the complete sample list remains visible, thumbnails load through a low-priority single-request queue, and background image requests pause when realtime data is delayed.
- Added versioned cache URLs for previews and optimized the monitor-tab layout and history loading so image transfers do not compete with critical realtime information.

### Training Outputs and Tag Editor

- Added a bilingual `output_dir.txt` to every training run directory to record the actual locations of models, checkpoints, training state, and previews, with synchronized cleanup when history is deleted.
- Changed tag-editor text mode to update in-memory state immediately and record history with debouncing; pending edits are settled before saving, changing images, undoing, or leaving the page.
- Fixed empty-tag draft restoration, unsaved-change protection during recursive scans and reloads, and preservation of dirty state and drafts after partial save failures.
- Made batch operations target selected images by default, prioritized relative paths in file search and display, and fixed `Ctrl+F`, native input undo, and rename-button overlap with counters.
- Improved editor-panel width, image-preview height, toolbar wrapping, and narrow layouts at 1100px and 900px.

### Verification

- Added contract tests for realtime communication, weak-network loading, cross-directory outputs, and the tag editor.
- Verified the tag editor on desktop and narrow layouts with a dataset containing 12 images and 88 unique tags.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.3.2...v1.3.3)

## v1.3.2 - 2026-07-19

Completed a code-quality pass that strictly preserves existing behavior and API contracts, lowers maintenance costs, and adds regression protection for important compatibility behavior.

### Server Structure and Task Maintenance

- Split the previous monolithic API router into system, tagger, and environment modules while preserving the `backend.server.api.router` compatibility entry point, every `/api/*` path, and all request and response structures.
- Extracted shared TTL cleanup for three types of completed environment jobs while preserving install-log deletion callbacks and the existing 600-second cleanup timing.
- Extracted shared lazy ONNX Session creation for taggers while preserving Torch CUDA library loading, CUDA/CPU provider order, SessionOptions logging level, and exception propagation.

### Dead-Code Cleanup and Verification

- Removed frontend definitions overridden by final mixins, unused private members, unused local imports, and comment-only legacy code while preserving effective conditions and stop-training interactions.
- Added source-contract tests for API routes, task cleanup, ONNX helpers, and frontend mixins to lock down behavior-preserving boundaries.
- Passed all 93 unit tests, Python compilation checks, and configuration-fallback consistency checks.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.3.1...v1.3.2)

## v1.3.1 - 2026-07-18

Fixed Rich log colors lost when the v1.3.0 Windows launcher took ownership of GUI output, and moved the Python automatic-startup hook from the repository root into an internal tools directory.

### Console Colors and Exit Codes

- Stopped piping the GUI process through PowerShell `Out-Host`, allowing Rich to recognize the interactive terminal again and restore colored timestamps, levels, and messages.
- Stored the GUI exit code in independent launcher state, preserving normal exits, error returns, and automatic restart after ZIP repair returns code 23.
- Added real-PTY smoke verification and normal ZIP-repair entry tests for colored ANSI output, argument forwarding, and restart return codes.

### Internal Python Startup Hook

- Moved root-level `sitecustomize.py` into `tools/python_startup/` so new users are less likely to open an internal compatibility file accidentally.
- Made Windows and Linux launchers and training subprocesses inject the internal startup-hook directory consistently; direct backend-module execution also loads it explicitly.
- Preserved the bitsandbytes compatibility fix for Windows Chinese code pages and expanded automatic-loading and subprocess-encoding tests.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.3.0...v1.3.1)

## v1.3.0 - 2026-07-18

Redesigned first-run installation on Windows so users downloading the GitHub ZIP can prepare the environment automatically and safely convert the folder into a repository that supports future `git pull` updates.

### First-Run Installation on Windows

- Reduced `start.bat` to a Windows PowerShell 5.1-compatible entry point and moved environment detection, installation, repository repair, and GUI launch into the new PowerShell bootstrap.
- Automatically reused 64-bit Python 3.10-3.12; when no compatible interpreter is available, the bootstrap can install official Python 3.12.10 for the current user without replacing newer versions or changing the default interpreter.
- Preferred Git installation through winget, with fallback to a pinned official Git for Windows installer validated by SHA-256 and Authenticode signature.
- Added percentage, size, live speed, and ETA to downloads; silent installation and `venv` creation stages show activity and elapsed time, while pip and Git retain native progress output.
- Standardized English / Chinese installation messages and configured the current-user PATH, Git Bash Here, and required Explorer context-menu entries.

### ZIP Repository Repair and Data Protection

- Detected GitHub ZIP folders without `.git`, fetched complete `main` history and tags, and saved changed files, the remote commit, and a manifest to `bootstrap-backups/<timestamp>.zip` before aligning sources.
- Created a local `main` tracking `origin/main` after repair, set `pull.ff=only`, and restarted the launcher once; later updates remain an explicit user action through `git pull`.
- Excluded `venv`, models, caches, outputs, logs, Hugging Face data, and the entire user `config` directory from source alignment, without running `git clean` or hard-resetting user directories.
- Left valid repositories untouched; damaged repositories or repositories with an unverifiable origin receive a bilingual warning. Git installation or repair failure does not block the trainer from starting.

### Arguments, Linux, and Tests

- Kept core dependency installation enabled under `--quiet/-q` while skipping optional Git changes by default, and added `--setup-git` and `--skip-git-setup` for noninteractive or explicit behavior.
- Added bilingual Python, Git, and ZIP-download guidance to the Linux launcher without invoking distribution package managers or `sudo` automatically.
- Added Windows contract and temporary-remote integration tests covering Chinese and spaced paths, source backups, user-data protection, damaged repositories, download failures, and ordinary `git pull` after repair.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.2.0...v1.3.0)

## v1.2.0 - 2026-07-16

Added complete support for saving training artifacts outside the trainer directory, including other directories on the same drive and different drive letters. Each run can choose its own output directory while TensorBoard, previews, logs, and history monitoring remain stable.

### Custom Output Directories

- Write models, training checkpoints, and sample previews to the selected output directory while keeping configuration, terminal logs, TensorBoard data, training results, and task mappings inside the trainer.
- Allow every run to use a different output directory, with unified handling for same-drive, cross-directory, and cross-drive paths instead of relying on paths relative to the trainer.
- Validate directory availability and write permission before launch. The default directory adds no notice; custom directories show only one necessary status line and block launch when unavailable.

### Monitoring, History, and Compatibility

- Read external artifacts through task mappings in the monitor, preserving sample previews, file listings, downloads, and minimum-loss checkpoint detection.
- Read TensorBoard data from the trainer's internal log directory so historical curves remain available when tasks use different artifact directories or an external directory is temporarily unavailable.
- Automatically import compatible legacy cross-directory training records; deleting history removes only internal logs and monitoring data, never user training artifacts.
- Added task-path mappings and path-traversal validation to prevent invalid access through external paths.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.1.3...v1.2.0)

## v1.1.3 - 2026-07-16

Improved first-time Windows installation and startup by handling unsupported Python versions and Microsoft Store placeholders automatically, while reducing the chance that new users launch internal source files by mistake.

### Python Installation and Environment Selection

- Made the Windows launcher prefer a compatible project `venv`, then search for 64-bit Python 3.12, 3.11, and 3.10 in order while skipping Microsoft Store Python placeholders.
- When only Python 3.13/3.14 is installed, allow official Python 3.12 to be installed side by side for the current user without removing existing versions or changing the system default PATH.
- Validate the Python Software Foundation digital signature when downloading Python 3.12 automatically, stopping with a manual download URL when validation fails.
- Applied the same supported-version limits to the Linux launcher and added explicit recovery instructions for an incompatible existing `venv`.

### Launch Entry Points and Documentation

- Moved root-level `gui.py` into `backend/gui.py` and made launch scripts use the internal module consistently, reducing accidental launches that bypass environment preparation.
- Show an immediate, friendly error when an internal module is launched with an unsupported interpreter instead of attempting dependency repair and later failing on incompatible wheels.
- Updated Chinese and English prerequisite documentation for Python, Git, automatically installed PyTorch/CUDA, and the differences between Windows and Linux environment handling.
- Fixed overlap between the training-page scrollbar and the hit area of adjacent controls.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.1.2...v1.1.3)

## v1.1.2 - 2026-07-15

Improved visual hierarchy and interaction feedback in both themes, preserving neutral-gray surfaces while restoring clear, vivid text, group colors, and status colors.

### Themes and Visual Hierarchy

- Changed the dark theme to a more comfortable neutral-gray hierarchy and rebalanced brightness differences among the page background, sidebar, cards, inputs, and overlays.
- Kept gray concentrated in backgrounds and surfaces while restoring vivid body text, parameter groups, status messages, and code highlighting so the interface no longer appears uniformly muted.
- Fine-tuned surface hierarchy and borders in the light theme so both themes share the same information density and visual logic.

### Toggles and Notification Feedback

- Redesigned global toggles with improved dimensions, tracks, knobs, and state feedback, including hover, pressed, keyboard-focus, and disabled states with restrained motion.
- Changed notifications to neutral surfaces with colored icons, lightweight status fills, and low-contrast full borders, removing the left color stripe and large saturated status areas.
- Completed warning notifications with multiline wrapping, long-text handling, stacking, and narrow-screen layouts, and adjusted duration by error, warning, and normal-message severity.
- Replaced bouncing and scaling with short-distance fades while continuing to respect reduced-motion preferences.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.1.1...v1.1.2)

## v1.1.1 - 2026-07-13

Upgraded training monitoring into a dense professional console and fixed several interaction issues involving historical logs, output files, and realtime refreshes.

### Training Monitor Console

- Added a sticky task control bar, compact hardware metrics, responsive tabs, and a 12-column overview layout that concentrates status, progress, key metrics, and samples in the first viewport.
- Replaced the duplicate large Loss chart with rule-based training diagnostics showing trend changes, coefficient of variation, minimum observed Loss, decision rationale, and the exact statistical window.
- Added collapsed algorithm details and applicability boundaries that disclose data sources, window rules, and thresholds, and clarify that diagnostics do not determine image quality, overfitting, or the best checkpoint.
- Changed SSE updates to lightweight partial refreshes, preserved existing Loss data during reconnection, and redrew monitor content immediately after language changes.

### Logs, Samples, and Output Files

- Fixed incorrect log counts when opening history for the first time, the unavailable initial-screen "Top" button in full logs, and carriage-return log updates splitting into multiple lines.
- Preserved incremental log append, pagination, search, copy, download, and scroll position while reorganizing the sticky toolbar hierarchy.
- Changed sample previews to a non-cropping layout with progressive loading and keyboard lightbox navigation; output files now use an aligned table and batch-selection actions.
- Always highlight the minimum-Loss checkpoint, preferring the newer archive when Loss values are equal.

### Visual Design and Accessibility

- Standardized site panels to square corners and tightened buttons and inputs to subtle corners, removing unnecessary gradients, shadows, and highly saturated callouts from the monitor.
- Added standard tab semantics, keyboard navigation, focus styling, connection-status text, and reduced-motion support.
- Improved Chinese and English monitor copy, idle-state explanations, historical-data labels, and training-diagnostic descriptions.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.1.0...v1.1.1)

## v1.1.0 - 2026-07-13

Upgraded the desktop interface and interactions while preserving the existing layout and color-coded LoRA parameter groups, improving information density, state readability, and page responsiveness.

### Interface and State Redesign

- Unified borders, corner radii, and hierarchy across cards, forms, buttons, selects, and the sidebar, reducing excessive curves, shadows, and decoration for a more desktop-productivity-oriented interface.
- Preserved color identification for LoRA parameter groups and narrowed the selected sidebar marker to a short vertical line for quick location with restrained visual weight.
- Redesigned environment status, model entries, and download actions to reduce highly saturated state colors and correct content alignment.
- Simplified the log toolbar by removing the low-frequency "Go to line N" control and freeing horizontal space for search, pagination, and copy actions.
- Unified training-type and ordinary select interactions and indicator widths, and improved alignment of labels, values, and formulas in the training-step area.

### Page Transitions and Animation Performance

- Added lightweight page-transition progress so the first visit to the training page responds visually before mounting the heavier form.
- Cached the training-form DOM and Alpine state, pausing only polling when leaving and reusing the existing state when returning to avoid repeated initialization pauses.
- Batched conditional parameter visibility into a single FLIP layout transition with more natural nonlinear easing for showing, hiding, and repositioning surrounding fields.
- Added cleanup and fallbacks for background tabs, interrupted animations, rapid reverse transitions, and reduced-motion preferences to avoid stale animation state and wasted resources.
- Reduced persistent dropdown DOM and repeated window-size reads, lowering rendering and listener overhead on inactive views.

### Training Steps and Localization

- Changed the training-step estimation API to return structured error codes and parameters so the frontend can show readable messages in the active language.
- Added Chinese and English messages for dataset, resolution, GPU, bucketing, and image-reading errors instead of displaying mixed-language backend errors directly.
- Corrected the source of step-validation error text before training and added localized error-context and frontend-contract regression tests.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.0.2...v1.1.0)

## v1.0.2 - 2026-07-12

Updated training-step estimation and the interface so users can confirm the actual training scale before a run starts.

### Training-Step Calculation

- Added a training-step calculation area showing source image count, directory repeats, batch size, gradient accumulation, epochs, GPU count, and estimated total steps.
- Explained training samples, batches per epoch, optimizer steps per epoch, and final total steps through a readable step-by-step formula.
- Reused sd-scripts image scanning, bucketing, and ceiling rules so estimates match actual training.
- Recalculated automatically after changing the dataset directory or related training parameters, with a manual refresh action.
- Forced a fresh scan and validation before starting training to avoid stale dataset statistics.

### Interface Improvements

- Preserved the previous result during recalculation and fixed the calculation area's height so controls below it do not move vertically.
- Added theoretical effective-batch display to clarify the relationship among batch size, gradient accumulation, and multiple GPUs.
- Preserved the existing descriptions of gradient accumulation and gradient checkpointing so the independent parameters are not mistaken for automatic coupling.
- Added regression tests for backend calculation, comparison against sd-scripts bucketing, and frontend refresh behavior.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.0.1...v1.0.2)

## v1.0.1 - 2026-07-11

A stability and usability update focused on tag-editing efficiency for large datasets and training-monitor state management.

### Tag Editor Improvements

- Combined image listing and tag-frequency scanning to reduce repeated disk traversal for large datasets.
- Added 320px list thumbnails and a 960px preview cache to reduce image loading time.
- Moved batch saving, batch editing, and preview operations to background threads so service responses remain responsive.
- Changed history to incremental changes to reduce memory usage during continuous editing.
- Fixed undo and redo for global tag renaming and improved history-detail display.
- Added select-current-page, select-all-filtered-results, and a narrow-screen vertical layout.
- Improved dialog semantics, automatic focus, and image-preview interactions.

### Stability Fixes

- Fixed historical logs remaining in the training monitor after leaving a historical task detail view.
- Fixed recursive dataset caches returning stale tags after saving a single image.
- Fixed stale indexes causing inaccurate statistics after a tag-frequency request failed.
- Added automatic size-limited thumbnail-cache cleanup to prevent unbounded disk usage over time.
- Added backend and frontend contract regression tests for the tag editor.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.0.0...v1.0.1)

## v1.0.0 - 2026-07-11

The first stable release, providing complete local Anima and SDXL LoRA training workflows.

### Major Features

- A local FastAPI and Alpine.js training workspace integrating the `sd-scripts` training engine.
- Anima (Qwen3 + T5 dual encoders) and SDXL LoRA training.
- Training parameter forms, TOML previews, preset management, and strict model-specific validation.
- Realtime hardware monitoring, training logs, history, Loss statistics, and a preview lightbox.
- A built-in tag editor, WD14 automatic tagging, model downloads, and training-environment management.
- Chinese and English interfaces, light and dark themes, and Windows/Linux launch scripts.

### Stable-Release Improvements

- Fixed mixed training-sample previews, scanning stalls, and multiline sample-prompt composition.
- Improved training-log viewing and training-task concurrency-slot management.
- Aligned field ranges, model groups, and Anima/SDXL resolution constraints with `sd-scripts`.
- Strengthened validation for Anima models, VAE, Qwen3, dropout, token, and timestep parameters.
- Improved performance of image counting, preview scanning, and training launch paths.
- Reduced duplicate field hints and synchronized API configuration with the frontend offline fallback.

[Full diff](https://github.com/amenorira/lora-scripts-anima/compare/v1.0.0-rc.3...v1.0.0)
