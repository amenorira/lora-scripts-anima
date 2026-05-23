# AI Coding Agent Instructions for lora-scripts-anima

## About This Project

This is the **lora-scripts-anima** project — a Web UI (FastAPI backend + Alpine.js frontend) for Stable Diffusion LoRA training. The training engine is **sd-scripts** by kohya-ss, located in `vendor/sd-scripts/`.

## CRITICAL: Protected Directory — `vendor/sd-scripts/`

**`vendor/sd-scripts/` is a VENDOR dependency. DO NOT MODIFY any files inside it.**

The `vendor/sd-scripts/` directory contains the complete training engine from [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts). It must remain fully functional as a standalone training toolkit — users familiar with sd-scripts should be able to `cd vendor/sd-scripts && python train_network.py ...` directly without our Web UI.

### Rules for `vendor/sd-scripts/`

1. **NEVER** create, edit, delete, or rename any `.py` file in `vendor/sd-scripts/library/`
2. **NEVER** create, edit, delete, or rename any training script in `vendor/sd-scripts/` (e.g., `train_network.py`, `flux_train_network.py`, etc.)
3. **NEVER** modify `vendor/sd-scripts/requirements.txt`
4. **NEVER** modify `vendor/sd-scripts/networks/`, `vendor/sd-scripts/finetune/`, `vendor/sd-scripts/tools/`, `vendor/sd-scripts/configs/`
5. If you need sd-scripts functionality, **IMPORT** it as a library — do NOT copy or modify its code

### The ONLY files you may touch in `vendor/sd-scripts/`

- `vendor/sd-scripts/.upstream-version` — version tracking metadata (OUR file)
- `vendor/sd-scripts/.local-changes.md` — documents local modifications (OUR file)

### Our Code (safe to modify)

- `mikazuki/` — Backend (FastAPI)
- `anima-ui/` — Frontend (Alpine.js SPA)
- `frontend/` — Legacy frontend
- `gui.py` — Entry point
- `config/` — Training presets
- `legacy-scripts/` — Old shell scripts
- Root-level scripts: `install*.ps1`, `start.bat`, etc.

## Localization

All user-visible UI text MUST use i18n keys (see `.ai/i18n.md` or `anima-ui/i18n/`). Never hardcode Chinese/English strings.

## Architecture

- Backend: FastAPI → `mikazuki/app/`
- Frontend: Alpine.js SPA → `anima-ui/`
- Training: subprocess calls to `vendor/sd-scripts/*.py` via `accelerate launch`
- Config: TOML format, generated from UI form data
