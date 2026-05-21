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

### Required Dependencies

Python 3.10 and Git

### Clone

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
```

## ✨ SD-Trainer GUI

### Update kohya-ss/sd-scripts

To update the training scripts to the latest version:

| Platform | Script |
|----------|--------|
| Windows (CMD) | `update-scripts.bat` |
| Windows (PowerShell) | `update-scripts.ps1` |
| Linux | `bash update-scripts.bash` |

This will replace the `sd-scripts/` directory with the latest [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts).

### Windows

#### Installation

Run `install.ps1` will automatically create a venv for you and install necessary deps. 
If you are in China mainland, please use `install-cn.ps1`

#### Train

run `run_gui.ps1`, then program will open [http://127.0.0.1:28000](http://127.0.0.1:28000) automanticlly

### Linux

#### Installation

Run `install.bash` will create a venv and install necessary deps. 

#### Train

run `bash run_gui.sh`, then program will open [http://127.0.0.1:28000](http://127.0.0.1:28000) automanticlly

## Legacy training through run script manually

### Windows

#### Installation

Run `install.ps1` will automatically create a venv for you and install necessary deps.

#### Train

Edit `train.ps1`, and run it.

### Linux

#### Installation

Run `install.bash` will create a venv and install necessary deps.

#### Train

Training script `train.sh` **will not** activate venv for you. You should activate venv first.

```sh
source venv/bin/activate
```

Edit `train.sh`, and run it.

#### TensorBoard

Run `tensorboard.ps1` will start TensorBoard at http://localhost:6006/

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

## Flash Attention Auto-Install

The `tools/install_flash_attn.py` script provides smart prebuilt wheel matching and installation:

- Auto-detects your Python / PyTorch / CUDA / platform environment
- Fetches candidate prebuilt wheels from GitHub Releases dynamically
- Scores candidates by match precision and picks the optimal one

```sh
# Auto-match and install
python tools/install_flash_attn.py

# Preview environment & candidates (no install)
python tools/install_flash_attn.py --dry-run

# Manual wheel URL
python tools/install_flash_attn.py --url <URL>
```

## Acknowledgements

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — Core training scripts
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — Training GUI framework
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel matching algorithm reference
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel source
