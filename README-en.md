<div align="center">

# lora-scripts-anima

_✨ LoRA Training Tool for Anima Models ✨_

A training GUI based on [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) (in `vendor/sd-scripts/`) for **Anima model** (Qwen3 + T5 dual encoder) LoRA training. Also compatible with SDXL.

</div>

<p align="center">
  <a href="https://github.com/ameyukisora/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/ameyukisora/lora-scripts-anima">
  </a>
  <a href="https://github.com/ameyukisora/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub forks" src="https://img.shields.io/github/forks/ameyukisora/lora-scripts-anima">
  </a>
  <a href="https://raw.githubusercontent.com/ameyukisora/lora-scripts-anima/main/LICENSE" style="margin: 2px;">
    <img src="https://img.shields.io/github/license/ameyukisora/lora-scripts-anima" alt="license">
  </a>
</p>

<p align="center">
  <a href="https://github.com/ameyukisora/lora-scripts-anima/blob/main/README.md">中文</a>
</p>

> ⚠️ **Important Notice**  
> This project is under active development (v2.1.0-dev). Some features may be unstable. Please check back for a stable release.

lora-scripts-anima is a LoRA training GUI forked from [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts), with the full [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts.git) training engine bundled. The UI currently supports **SDXL** and **Anima** LoRA training (SD 1.5 has been removed).

### Supported Model Types

| Training Type | Base Model |
|---------------|------------|
| LoRA | SDXL |
| **LoRA** | **Anima** (Qwen3 + T5 dual encoder) |

> ℹ️ The `vendor/sd-scripts/` engine supports SD3 / FLUX / HunyuanImage / Lumina and more, but these are not yet wired into the current UI.

## ✨ Features

- **Training WebUI** — All-in-one workspace: LoRA training form, TOML config preview, preset management (save/load/delete), training history
- **Real-time Hardware Monitor** — GPU utilization / VRAM / temperature, CPU / RAM usage, Chart.js dynamic charts, TensorBoard integration, live log viewer
- **Native Tag Editor** — Built-in image tag editor with batch find-and-replace, deduplication, sorting, cleanup, and more
- **WD14 Auto-Tagger** — Integrated WD14 tagger for one-click dataset labeling
- **Flash Attention Smart Install** — Auto-detects Python / CUDA / PyTorch versions and ABI, matches the best prebuilt wheel via GitHub API, one-click install
- **EmoSens Adaptive Optimizer** — Built-in EmoSens v3.9 with better convergence for Anima DiT training
- **Internationalization (i18n)** — Bilingual UI (448 translation keys), browser language auto-detection, persistent preference
- **Dark / Light Theme** — Auto-follow system preference or manual toggle
- **Backend Connectivity Indicator** — Real-time frontend-backend connection status with disconnect duration

## Project Structure

```
lora-scripts-anima/
├── vendor/sd-scripts/          ← Training engine (full kohya-ss/sd-scripts)
├── backend/                    ← FastAPI backend
│   ├── server/                 ← API core (routes, state, proxy)
│   ├── training/               ← Training engine wrapper (adapter, field registry, supervisor)
│   ├── monitor/                ← Training monitor (GPU/system/logs/preview/history)
│   ├── tageditor/              ← Native tag editor
│   └── tagger/                 ← WD14 tagging module
├── frontend/                   ← Alpine.js SPA frontend
├── config/                     ← TOML config presets
├── tools/                      ← Standalone tools (Flash Attn installer, etc.)
├── vendor/emo_optimizer/       ← EmoSens adaptive optimizer
├── gui.py                      ← Main entry point
├── start.bat / start.sh        ← Launch scripts
└── requirements.txt            ← Project dependencies
```

# Usage

### Prerequisites

- Python 3.10+ and Git
- **PyTorch ≥ 2.10.0 + CUDA 12.8** (auto-configured by install scripts, compatible with RTX 30/40/50 series)

| GPU Series | Min PyTorch | Recommended CUDA |
|------------|:----------:|:----------------:|
| RTX 30 (Ampere) | 2.6.0 | 12.8 |
| RTX 40 (Ada) | 2.6.0 | 12.8 |
| RTX 50 (Blackwell) | **2.8.0** | **12.8** |

> Install scripts default to PyTorch 2.10.0 + CUDA 12.8 — all GPUs, cp312 has prebuilt flash-attn.

### Clone

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
cd lora-scripts-anima
```

### Quick Start

| Platform | Install + Launch |
|----------|-----------------|
| Windows | `.\start.bat` |
| Linux | `bash start.sh` |

First launch automatically creates a virtual environment and installs all dependencies. The GUI opens at [http://127.0.0.1:12333](http://127.0.0.1:12333).

> **RTX 40/50 users**: the startup script detects flash_attn status. If not installed, use the GUI **Environment** tab for one-click install.

## Program Arguments

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--host` | str | "127.0.0.1" | Server hostname |
| `--port` | int | 12333 | Server port |
| `--listen` | bool | false | Enable listening mode (allow external access) |
| `--skip-prepare-environment` | bool | false | Skip environment preparation |
| `--disable-tensorboard` | bool | false | Disable TensorBoard |
| `--enable-tageditor` | bool | false | Enable legacy Gradio tag editor (port 28001) |
| `--tensorboard-host` | str | "127.0.0.1" | TensorBoard host |
| `--tensorboard-port` | int | 6006 | TensorBoard port |
| `--localization` | str | | Interface localization setting |
| `--dev` | bool | false | Developer mode |

## Flash Attention Acceleration

Recommended for RTX 40/50 series GPUs for optimal training performance.

### GUI Install

Launch the GUI and install from the **Environment** tab. The script auto-detects Python / PyTorch / CUDA ABI / platform and matches the best prebuilt wheel via GitHub API.

### Manual Install

```sh
python tools/install_flash_attn.py              # Interactive install
python tools/install_flash_attn.py --dry-run    # Preview only
python tools/install_flash_attn.py --url URL    # Manual wheel URL
python tools/install_flash_attn.py --yes        # Non-interactive auto
```

## EmoSens Adaptive Optimizer

The project includes EmoSens v3.9 adaptive optimizer (`vendor/emo_optimizer/`) for better convergence on Anima DiT training.

### Recommended Settings

| Training Type | Learning Rate | Scheduler | max_grad_norm |
|---------------|:------------:|:---------:|:-------------:|
| SDXL LoRA | 1.0 | constant | 0 |
| Anima LoRA (DiT) | 0.1 | constant | 0 |

Select `EmoSens` from the optimizer dropdown in the training form.

## Preset Management

Save, load, and delete training presets in TOML format. Presets are stored in `config/presets/`.

- **Save**: Configure training parameters and click "Save Preset"
- **Load**: Select a saved preset from the dropdown
- **Delete**: Remove unwanted presets from the management panel

## Environment Management

The GUI **Environment** tab provides:
- Python / PyTorch / CUDA version info
- sd-scripts engine version
- Flash Attention installation status with one-click install
- Candidate wheel list preview

## Acknowledgements

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — Core training scripts
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — Training GUI framework
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel matching algorithm reference
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel source
