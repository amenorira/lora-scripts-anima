<div align="center">

# Anima LoRA Trainer

_✨ LoRA Training Tool for Anima Models ✨_

A training GUI based on [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) and [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts), with extended **Anima model** LoRA support. Also compatible with SD 1.5 / SDXL / SD3 / FLUX.

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

Anima LoRA training GUI, powered by the latest [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts.git). Also supports SD 1.5 / SDXL / SD3 / FLUX.

### Supported Model Types

| Training Type | Base Model |
|---------------|------------|
| LoRA / Dreambooth | SD 1.5 / SD 2.x |
| LoRA / Finetune | SDXL |
| LoRA | SD3 |
| LoRA / Finetune | FLUX (including Chroma) |
| **LoRA** 🆕 | **Anima** |

## ✨NEW: Train WebUI

The **REAL** Stable Diffusion Training Studio. Everything in one WebUI.

Follow the installation guide below to install the GUI, then run `run_gui.ps1`(windows) or `run_gui.sh`(linux) to start the GUI.

![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/d3fcf5ad-fb8f-4e1d-81f9-c903376c19c6)

| Tensorboard | WD 1.4 Tagger | Tag Editor |
| ------------ | ------------ | ------------ |
| ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/b2ac5c36-3edf-43a6-9719-cb00b757fc76) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/9504fad1-7d77-46a7-a68f-91fbbdbc7407) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/4597917b-caa8-4e90-b950-8b01738996f2) |


# Usage

### Prerequisites

Python 3.10+ and Git

### Clone

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
cd lora-scripts-anima
```

### Quick Start

| Platform | Install | Launch |
|----------|---------|--------|
| Windows | `.\install-cn.ps1` | `.\start.bat` |
| Linux | `bash install.bash` | `bash start.sh` |

The GUI opens automatically at [http://127.0.0.1:28000](http://127.0.0.1:28000).

> **RTX 40/50 users**: the startup script detects flash_attn status.
> If ❌ not installed, run `.\install-flash-attn.bat` (Windows) or `bash install-flash-attn.sh` (Linux).

### Updates

| Operation | Script |
|-----------|--------|
| Update this repo | `update-repo.bat` / `bash update-repo.sh` |
| Update training scripts (sd-scripts) | `update-scripts.bat` / `bash update-scripts.bash` |

## ✨ SD-Trainer GUI

Training WebUI with integrated TensorBoard, WD14 tagger, and tag editor.

```sh
# Windows
.\run_gui.ps1

# Linux
bash run_gui.sh
```

## Manual Scripts (Advanced)

Traditional workflow: edit and run training scripts directly.

### Windows

```sh
# Install
.\install.ps1              # International
.\install-cn.ps1           # China mirror

# Train — edit train.ps1 then run
.\train.ps1
```

### Linux

```sh
# Install
bash install.bash

# Train — activate venv first, edit train.sh then run
source venv/bin/activate
bash train.sh
```

#### TensorBoard

Run `.\tensorboard.ps1` to start TensorBoard at http://localhost:6006/.

## Program arguments

| Parameter Name                | Type  | Default Value | Description                                      |
|-------------------------------|-------|---------------|--------------------------------------------------|
| `--host`                      | str   | "127.0.0.1"   | Hostname for the server                          |
| `--port`                      | int   | 28000         | Port to run the server                           |
| `--listen`                    | bool  | false         | Enable listening mode for the server             |
| `--skip-prepare-environment`  | bool  | false         | Skip the environment preparation step            |
| `--disable-tensorboard`       | bool  | false         | Disable TensorBoard                              |
| `--disable-tageditor`         | bool  | false         | Disable tag editor                               |
| `--tensorboard-host`          | str   | "127.0.0.1"   | Host to run TensorBoard                          |
| `--tensorboard-port`          | int   | 6006          | Port to run TensorBoard                          |
| `--localization`              | str   |               | Localization settings for the interface          |
| `--dev`                       | bool  | false         | Developer mode to disale some checks             |

## Flash Attention Acceleration

Recommended for RTX 40/50 series GPUs for optimal training and inference performance.

### One-Click Install

```sh
# Windows
.\install-flash-attn.bat

# Linux
bash install-flash-attn.sh
```

### Features

- **Auto-detection**: Python / PyTorch / CUDA ABI / platform
- **Smart matching**: fetches candidates from GitHub Releases, scored & ranked
- **Interactive selection**: numbered list with compatibility notes, pick by key
- **Built-in repair**: auto-uninstalls mismatched versions and reinstalls the correct one
- **Post-install verification**: auto import + CUDA forward test

### Manual Usage

```sh
python tools/install_flash_attn.py              # Interactive install
python tools/install_flash_attn.py --dry-run    # Preview only
python tools/install_flash_attn.py --url URL    # Manual wheel URL
python tools/install_flash_attn.py --yes        # Non-interactive auto
```

## Acknowledgements

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — Core training scripts
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — Training GUI framework
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel matching algorithm reference
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel source
