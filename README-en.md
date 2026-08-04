<div align="center">

# lora-scripts-anima

_✨ Multi-backend LoRA Training Tool: Anima, SDXL, and Krea 2 ✨_

A local GUI for LoRA training. Anima / SDXL use [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) (in `vendor/sd-scripts/`), while **Krea 2 LoRA** uses [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner).

</div>

<p align="center">
  <a href="https://github.com/amenorira/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/amenorira/lora-scripts-anima">
  </a>
  <a href="https://raw.githubusercontent.com/amenorira/lora-scripts-anima/main/LICENSE" style="margin: 2px;">
    <img src="https://img.shields.io/github/license/amenorira/lora-scripts-anima" alt="license">
  </a>
</p>

<p align="center">
  <a href="https://github.com/amenorira/lora-scripts-anima/blob/main/README.md">中文</a>
</p>

> ✅ **v2.2.3 is now available**
> This release restores more natural, practical parameter guides and removes brittle tests that locked wording, visual styling, and internal implementation details.

lora-scripts-anima is a LoRA training GUI forked from [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts). A training-core registry keeps each backend isolated: **sd-scripts** handles SDXL / Anima, **LyCORIS** is an optional adapter backend mounted through `lycoris.kohya`, and **musubi-tuner** handles Krea 2 RAW DiT LoRA.

### Supported Model Types

| Training Type | Base Model |
|---------------|------------|
| LoRA | SDXL |
| **LoRA** | **Anima** (Qwen3 + T5 dual encoder) |
| **LoRA** | **Krea 2 RAW DiT** (musubi-tuner) |

> ℹ️ Krea 2 requires both latent and Qwen3-VL text-encoder caches before training. The UI verifies that they are complete and still match the images, captions, and models before a run can start.

> ℹ️ The `vendor/sd-scripts/` engine supports SD3 / FLUX / HunyuanImage / Lumina and more, but the current UI does not yet provide training entry points for them.

## ✨ Features

- **Training WebUI** — An all-in-one workspace with a LoRA training form, TOML configuration preview, preset management (save/load/delete), and training history
- **Real-time Hardware Monitor** — GPU utilization, VRAM, and temperature; CPU and RAM usage; Chart.js charts, TensorBoard integration, and live logs
- **Native Tag Editor** — Built-in image tag editor with batch find-and-replace, deduplication, sorting, cleanup, and more
- **Multi-model Tagger Workspace** — WD, CL Tagger, and Camie Tagger with single-image inspection, category thresholds, and batch caption output
- **Flash Attention Smart Install** — Provides prebuilt wheels for the fixed Python 3.12 + PyTorch 2.10+cu130 baseline; multi-mirror fallback downloads with resume and local caching; one-click installation
- **EmoSens Adaptive Optimizer** — Built-in EmoSens v3.9 with better convergence for Anima DiT training
- **Internationalization (i18n)** — Chinese and English UI with browser-language detection and a persistent language preference
- **Dark / Light Theme** — Auto-follow system preference or manual toggle
- **Backend Connectivity Indicator** — Real-time frontend-backend connection status with disconnect duration
- **Slow Remote Connection Compatibility** — Same-origin realtime transport, a weak-network thumbnail queue, and versioned browser caching reduce the effect of preview requests on live status delivery

## Project Structure

```
lora-scripts-anima/
├── vendor/sd-scripts/          ← Anima / SDXL training engine (pinned upstream snapshot)
├── vendor/musubi-tuner/        ← Krea 2 core (pinned upstream snapshot)
├── backend/                    ← FastAPI backend
│   ├── server/                 ← API core (routes, state, proxy)
│   ├── training/               ← Training engine wrapper (adapter, field registry, supervisor)
│   ├── monitor/                ← Training monitor (GPU/system/logs/preview/history)
│   ├── tageditor/              ← Native tag editor
│   ├── tagger/                 ← WD14 tagging module
│   └── gui.py                  ← Internal GUI entry (called by launch scripts)
├── frontend/                   ← Alpine.js SPA frontend
├── config/                     ← TOML config presets
├── tools/                      ← Standalone tools (Flash Attn installer, etc.)
├── vendor/emo_optimizer/       ← EmoSens adaptive optimizer
├── start.bat / start.sh        ← Launch scripts
├── requirements.txt            ← Main application / sd-scripts dependencies
└── requirements-musubi-krea2.txt ← Shared Krea 2 version-convergence dependencies
```

## Usage

### Prerequisites

- **Python**: 64-bit Python 3.12 (the project baseline; prebuilt dependencies and the setup flow target this version)
- **Git**: used to download and update the project; Windows ZIP installs can set it up on first launch
- **PyTorch 2.10.0 + CUDA 13.0**: installed automatically by the startup scripts for RTX 30/40/50 series
- **NVIDIA driver R580 or newer**: the minimum driver version for CUDA 13.0

> **Windows users do not need to preinstall Python/Git.** On the first run, `start.bat` searches for 64-bit Python 3.12 and skips Microsoft Store placeholders.
>
> If only Python 3.13/3.14 is installed, the launcher can install the official Python 3.12 side by side for the current user. It does not remove newer versions or change the default Python. Downloads show progress, size, speed, and ETA; silent installer stages show an activity spinner.
>
> **Linux users** must install 64-bit Python 3.12. Most Python installations include `venv` support; install a separate package such as `python3.12-venv` only if a distribution such as Ubuntu or Debian reports that it is missing.
>
> If the project already contains an incompatible `venv` created with another Python version, remove or rename only the project's `venv` folder, then rerun the launcher for your platform.

| GPU Series | Automatically Installed PyTorch | CUDA |
|------------|:-------------------------------:|:----:|
| RTX 30 (Ampere) | 2.10.0 | 13.0 |
| RTX 40 (Ada) | 2.10.0 | 13.0 |
| RTX 50 (Blackwell) | 2.10.0 | 13.0 |

Existing cu128 `venv` installations upgrade on the next launch. Installed xformers, FlashAttention, Triton, and bitsandbytes packages are aligned with cu130, while ONNX Runtime GPU moves to its CUDA 13-compatible version. Optional packages that were not installed remain unchanged.

Machines without an NVIDIA GPU still receive the complete GPU dependency environment and can run the GUI. Training itself requires an NVIDIA GPU.

> **Krea 2 shared environment**: Krea 2 and sd-scripts use the project's main `venv` and the same CUDA-enabled PyTorch build. The launcher installs the upstream sd-scripts requirements first, then uses this project's `requirements-musubi-krea2.txt` to align the shared dependencies to `transformers 4.57.6` / `tokenizers 0.22.2`.
>
> Normal startup performs only a fast metadata check. When the versions match, it does not rerun pip, uninstall or reinstall packages, or import the full Krea 2 runtime. A complete import check runs after dependency synchronization and during Krea 2 preflight. No upstream dependency file under `vendor/` is modified.

> A legacy `venv/cores/musubi` is no longer read, written, or deleted automatically. After confirming that the project's main `venv` can train correctly, you can remove the legacy directory manually to reclaim disk space.

### Windows: Download ZIP (beginner-friendly)

1. On GitHub, choose **Code → Download ZIP**, fully extract it, and double-click `start.bat`.
2. If `.git` is missing, the bootstrap asks to install Git for Windows and repair the folder as an updateable repository; choose the recommended option.
3. Repair fetches the latest `main`. Source files that would be replaced are first saved to `bootstrap-backups/<timestamp>.zip`. The process excludes `venv`, models, outputs, caches, logs, and the entire user `config` directory, so they are never overwritten or cleaned.
4. After the source files are synchronized, the bootstrap restarts once, creates `venv`, and installs the training dependencies.

A Git installation or repository-repair failure only produces a warning and does not block the trainer. Python or core dependency failures stop startup with a bilingual error.

### Clone with Git

```sh
git clone https://github.com/amenorira/lora-scripts-anima.git
cd lora-scripts-anima
```

### Quick Start

| Platform | Install + Launch |
|----------|-----------------|
| Windows | `.\start.bat` |
| Linux | `bash start.sh` |

First launch automatically creates a virtual environment and installs all dependencies. The GUI opens at [http://127.0.0.1:12333](http://127.0.0.1:12333).

> **RTX 40/50 users**: the startup script detects flash_attn status. If not installed, use the GUI **Environment** tab for one-click install.

### Realtime and Slow Remote Connections

All HTTP requests and realtime connections are same-origin with the current page. The trainer does not configure SSH, port forwarding, proxies, cloud-specific logic, or an extra realtime port. If you already reach the remote page through your own setup, the browser continues to use that entry point.

- `/ws/realtime` carries only compact JSON state, progress, log increments, and hardware data. Commands, images, files, and metadata remain HTTP requests.
- The sidebar shows “Backend connected” only after it receives both the WebSocket `ready` message and a realtime snapshot. Two seconds without valid realtime data produces “Realtime data delayed”; the status changes to “Backend disconnected” only after the socket closes and the health probe also fails.
- A backend restart creates a new instance ID. The page clears task, progress, log, curve, and hardware data from the old instance and explicitly marks the previous in-memory task state as unknown. This version does not scan for or take over leftover training processes.
- **UI Settings → Slow connection compatibility** is enabled by default. It shows the complete sample list for the current run or history record, loads thumbnails one at a time at low priority, and pauses those background requests while realtime data is delayed. Versioned thumbnails can stay in the browser cache for 24 hours; opening the original image remains an explicit user action.

### Updating later

After ZIP repair or `git clone`, right-click an empty area inside the project folder:

- Choose Windows **Open in Terminal**, then run `git pull`; or
- Choose **Git Bash Here**, then run `git pull`. On Windows 11 it may appear under **Show more options**.

The repository allows fast-forward-only pulls. If tracked source files were edited manually, `git pull` stops and asks you to handle the local changes instead of overwriting them.

## Program Arguments

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--host` | str | "127.0.0.1" | Server hostname |
| `--port` | int | 12333 | Server port |
| `--listen` | bool | false | Enable listening mode (allow external access) |
| `--skip-prepare-environment` | bool | false | Skip environment preparation |
| `--disable-tensorboard` | bool | false | Disable TensorBoard |
| `--tensorboard-host` | str | "127.0.0.1" | TensorBoard host |
| `--tensorboard-port` | int | 6006 | TensorBoard port |
| `--localization` | str | | Interface language and localization setting |
| `--dev` | bool | false | Developer mode |
| `--quiet` / `-q` | bool | false | Automatically install Python/venv dependencies; optional Git repair remains disabled |
| `--setup-git` | bool | false | Windows: non-interactively perform the recommended Git install/ZIP repair |
| `--skip-git-setup` | bool | false | Windows: suppress Git installation or repository-repair prompts for this launch |

## Flash Attention Acceleration

Recommended for RTX 40/50 series GPUs for optimal training performance.

### GUI Install

Launch the GUI and install from the **Environment** tab. The script targets the fixed Python 3.12 + PyTorch 2.10+cu130 baseline, downloads prebuilt wheels with multi-mirror fallback (resume + local cache), and supports offline install from a local .whl.

### Manual Install

Windows:

```powershell
.\venv\Scripts\python.exe tools/install_flash_attn.py           # Interactive install
.\venv\Scripts\python.exe tools/install_flash_attn.py --url URL # Specify a wheel URL or local .whl path
.\venv\Scripts\python.exe tools/install_flash_attn.py --yes     # Non-interactive install
.\venv\Scripts\python.exe tools/install_flash_attn.py --force   # Force reinstall even if installed
```

Linux:

```sh
./venv/bin/python tools/install_flash_attn.py           # Interactive install
./venv/bin/python tools/install_flash_attn.py --url URL # Specify a wheel URL or local .whl path
./venv/bin/python tools/install_flash_attn.py --yes     # Non-interactive install
./venv/bin/python tools/install_flash_attn.py --force   # Force reinstall even if installed
```

## EmoSens Adaptive Optimizer

The project includes the EmoSens v3.9 adaptive optimizer (`vendor/emo_optimizer/`), which improves convergence when training Anima DiT models.

### Recommended Settings

| Training Type | Learning Rate | Scheduler | max_grad_norm |
|---------------|:------------:|:---------:|:-------------:|
| SDXL LoRA | 1.0 | constant | 0 |
| Anima LoRA (DiT) | 0.1 | constant | 0 |

Select `EmoSens` from the optimizer dropdown in the training form.

## Preset Management

Save, load, and delete training presets in TOML format. Presets are stored in `config/presets/`.

- **Save**: Configure the training parameters, then click **Save Preset**
- **Load**: Select a saved preset from the dropdown
- **Delete**: Remove unwanted presets from the management panel

## Environment Management

The GUI **Environment** tab provides:
- Python / PyTorch / CUDA version info
- core status for sd-scripts, the LyCORIS adapter backend, and musubi-tuner
- musubi-tuner Krea 2 shared-runtime status (shared CUDA-enabled PyTorch and dependency-version alignment)
- Flash Attention installation status with one-click install
- Candidate wheel list preview

## Acknowledgements

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — Anima / SDXL training engine
- [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) — Krea 2 training core
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — Training GUI framework
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel source
