# AI Coding Agent Instructions for lora-scripts-anima

## About This Project

This is the **lora-scripts-anima** project — a Web UI (FastAPI backend + Alpine.js frontend) for Stable Diffusion LoRA training. The training engine is **sd-scripts** by kohya-ss, located in `vendor/sd-scripts/`.

**Python environment**: This project uses a virtual environment at `venv/` (created by `python -m venv venv`). All `python` and `pip` commands must be run with the venv activated:
- Windows: `venv\Scripts\Activate.ps1`
- Linux/macOS: `source venv/bin/activate`

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

- `backend/` — Backend (FastAPI)
- `frontend/` — Frontend (Alpine.js SPA)
  - `frontend/js/constants.js` — Centralized UI constants + optimizer defaults
  - `frontend/js/config.js` — Route table + field definition fallback
  - `frontend/js/training-core.js` — Form builder + field logic
  - `frontend/js/training-toml.js` — TOML generation + training start/stop
  - `frontend/js/training-presets.js` — Preset CRUD
- `gui.py` — Entry point
- `config/` — Training presets
- `.ai/` — Agent instructions (copilot.md, i18n.md)
- Root-level scripts: `install*.ps1`, `start.bat`, etc.

## Localization

All user-visible UI text MUST use i18n keys. See `.ai/i18n.md` for detailed rules. Translation files are in `frontend/i18n/` (zh-CN.json + en-US.json, 676 keys). Never hardcode Chinese/English strings.

**Optimizer defaults**: Shared optimizer parameter defaults (betas, eps, weight_decay, etc.) are defined in `frontend/js/constants.js` as `OPTIMIZER_DEFAULTS`. Both `training-core.js` and `training-toml.js` reference this single source of truth. When adding a new optimizer, update `OPTIMIZER_DEFAULTS` first, then the consuming files will pick up the changes automatically.

## Architecture

- Backend: FastAPI → `backend/server/`
- Frontend: Alpine.js SPA → `frontend/`
- Training: subprocess calls to `vendor/sd-scripts/*.py` via `accelerate launch`
- Config: TOML format, generated from UI form data
- Field definitions: `backend/training/field_registry.py` (single source of truth)

### Core Design: We Are a Wrapper

**This project does NOT implement training logic.** The actual training is done entirely by `vendor/sd-scripts/`. Our job is two things:

1. **Collect** — gather training parameters from the Web UI form
2. **Deliver** — convert them to a TOML config file and pass it to sd-scripts

The data flow:
```
UI form (JSON) → field_registry.py (validation) → adapter.py (whitelist/filter) → TOML file → accelerate launch vendor/sd-scripts/train_network.py --config_file xxx.toml
```

Key implications:
- If a training parameter exists in sd-scripts but not in our UI form, we need to add it to `field_registry.py`
- If our generated TOML is valid but training fails, the bug is almost certainly in sd-scripts or the user's setup (GPU/drivers/dataset), not in our code
- Never re-implement training logic that sd-scripts already handles (loss calculation, optimizer steps, sample generation, etc.)

### Source of Truth: sd-scripts

**Everything related to actual training lives in `vendor/sd-scripts/`.** When you need to understand or answer questions about:

- What a training parameter does → read `vendor/sd-scripts/library/train_util.py` (argument parser)
- How loss is computed → read `vendor/sd-scripts/library/custom_train_functions.py`
- What optimizer args are supported → read `vendor/sd-scripts/library/optimizer_utils.py`
- How the network (LoRA) is structured → read `vendor/sd-scripts/networks/`
- Training script CLI flags → read the training scripts in `vendor/sd-scripts/` root:
  - `train_network.py` — LoRA training (SD 1.5 / SDXL)
  - `train_db.py` — Dreambooth
  - `sdxl_train_network.py`, `sdxl_train.py`, `sdxl_train_control_net.py` — SDXL variants
  - `flux_train_network.py`, `flux_train.py` — FLUX
  - `sd3_train_network.py`, `sd3_train.py` — SD3
  - `lumina_train_network.py`, `lumina_train.py` — Lumina
  - `hunyuan_image_train_network.py` — HunyuanImage
  - `anima_train_network.py`, `anima_train.py` — Anima
  - `train_control_net.py`, `train_textual_inversion.py`, `train_leco.py` — other methods
  - These are the actual entry points launched by `accelerate`; their argparse defines all CLI parameters

**Always consult kohya's own documentation first** — it explains the training concepts and parameters in detail:

- `vendor/sd-scripts/README.md` — overview and quick start
- `vendor/sd-scripts/docs/` — detailed per-topic docs (network configuration, dataset preparation, etc.)
- [kohya-ss/sd-scripts on GitHub](https://github.com/kohya-ss/sd-scripts) — upstream repo, issues, and discussions

Do NOT guess or invent training parameter behavior. Always trace back to the sd-scripts source code or kohya's docs.
