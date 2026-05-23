# Changelog

All notable changes to lora-scripts-anima.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
