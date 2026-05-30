# Changelog

All notable changes to lora-scripts-anima.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.1.0-dev] — Unreleased

> ⚠️ This is a development version. The project is under active restructuring.

### Added
- i18n: browser language auto-detection via `navigator.language`
- Frontend/backend connectivity indicator with real-time disconnect duration
- Training artifact isolated storage per run
- Environment management: sd-scripts version info card
- `constants.js`: centralized UI constants + `OPTIMIZER_DEFAULTS` (single source of truth for optimizer defaults)

### Changed
- **i18n fallback changed from zh-CN to en-US** (more international default)
- **SD 1.5 training type removed** (only SDXL + Anima LoRA remain)
- Port changed from 28000 to 12333
- Runtime cache migrated from `output/` to `cache/` directory
- Training records renamed for clarity
- Sidebar group colors: blue-green-purple-yellow top-to-bottom
- Training form de-card-ified with flattened design
- Right panel toggle button: unified sizing, centered, icon-only
- Install section: spinning loader + timer + live log output
- Optimizer defaults unified: `training-core.js` and `training-toml.js` now share `OPTIMIZER_DEFAULTS`

### Removed
- sd-scripts update management feature (local version info only)
- Custom scrollbar styling (unstable across browsers)
- Empty "Tools" route page (placeholder, not yet implemented)
- Unused CSS classes: `.sidebar-bottom .divider`, `.sidebar-bottom .bottom-label`

### Fixed
- Training form rendering regression after restructuring
- Progress bar stuck at 90% after navigation
- History page blank after refactoring
- Encoding issues and crash-on-launch in Windows startup scripts
- Log level filter buttons now use i18n (were hardcoded English)
- Monitor chart placeholder labels now use i18n (were hardcoded English)
- Home page quick-action card now shows "Anima / SDXL" (was "SD / SDXL / Anima")
- Tagger model list now cached to avoid redundant API calls on page switch
- Tag editor: tag pill click handlers use data attributes (eliminates injection risk from inline onclick)

---

## [2.0.0] — 2026-05-23

### Added
- **Project restructuring**: `mikazuki/` → `backend/`, `anima-ui/` → `frontend/`, `legacy-scripts/` → `legacy/`
- `backend/app/state.py` — shared schema/preset state extracted from api.py
- `backend/app/routes/training.py` — POST /run route module
- `backend/app/routes/presets.py` — preset CRUD route module
- `backend/anima_backend/adapter.py` — UI→TOML whitelist + defensive filtering
- `backend/anima_backend/supervisor.py` — unified training process manager
- `tools/install_flash_attn.py` — smart prebuilt wheel installer with GitHub API matching
- `.ai/i18n.md` — localization guide for AI coding agents
- `.ai/copilot.md` — AI agent guardrails (vendor protection, i18n rules)
- Alpine.js SPA frontend at `frontend/` (385 i18n keys, zh-CN/en-US)
- GPU hardware monitor + training dashboard
- Flash Attention auto-install with environment detection

### Changed
- **Breaking**: `mikazuki/` renamed to `backend/` — update any external scripts
- **Breaking**: `anima-ui/` renamed to `frontend/` — update any external scripts
- **Breaking**: `legacy-scripts/` moved to `legacy/scripts/`
- PyTorch upgraded to **2.10.0+cu128** (RTX 30/40/50 all supported)
- sd-scripts vendored to `vendor/sd-scripts/` (was git submodule)
- UI now supports 3 training modes: SD LoRA, SDXL LoRA, Anima LoRA
- All CLI/log output now bilingual (English / Chinese)
- Shell scripts use project name `lora-scripts-anima` consistently
- xformers is now a fallback (flash_attn is preferred)
- `api.py` split: training routes → `routes/training.py`, presets → `routes/presets.py`
- `process.py` training logic merged into `supervisor.run_train()`
- Env vars prefer `ANIMA_*` naming (fallback to `MIKAZUKI_*`)

### Removed
- SD3 / FLUX / HunyuanImage / Dreambooth UI training entries (engine still supports them)
- Standalone `tensorboard.ps1` reference (integrated in WebUI)
- xformers as primary dependency (flash_attn is now preferred)

### Fixed
- README model support table now matches actual UI capabilities
- Schema directory path corrected in architecture docs
- Training lifecycle messages now bilingual for better accessibility
- Duplicate training launcher (`process.py` vs `supervisor.py`) unified

---

*Based on lora-scripts v1.10.0 (Akegarasu) + sd-scripts (kohya-ss)*
