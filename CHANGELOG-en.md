# Changelog

[中文](CHANGELOG.md)

All notable changes to this project are documented in this file.

## Unreleased

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
