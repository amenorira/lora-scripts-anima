<div align="center">

# lora-scripts-anima

_✨ Multi-core LoRA Training Tool: Anima, SDXL, and Krea 2 ✨_

A local GUI built on a multi-core training architecture: [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) (in `vendor/sd-scripts/`) continues to serve Anima / SDXL, while [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) provides **Krea 2 LoRA** training.

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

> ✅ **v1.3.3 is now available**
> This release unifies realtime communication and improves slow remote connections, while strengthening tag-editor save reliability, shortcuts, and responsive layout.

lora-scripts-anima is a LoRA training GUI forked from [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts). Its core registry keeps trainer boundaries explicit: **sd-scripts** handles SDXL / Anima, **LyCORIS** is a selectable adapter core mounted through `lycoris.kohya`, and **musubi-tuner** handles Krea 2 RAW DiT LoRA.

### Supported Model Types

| Training Type | Base Model |
|---------------|------------|
| LoRA | SDXL |
| **LoRA** | **Anima** (Qwen3 + T5 dual encoder) |
| **LoRA** | **Krea 2 RAW DiT** (musubi-tuner) |

> ℹ️ Krea 2 requires both latent and Qwen3-VL text-encoder caches before training. The UI verifies that they are complete and still match the images, captions, and models before a run can start.

> ℹ️ The `vendor/sd-scripts/` engine supports SD3 / FLUX / HunyuanImage / Lumina and more, but these are not yet wired into the current UI.

## ✨ Features

- **Training WebUI** — All-in-one workspace: LoRA training form, TOML config preview, preset management (save/load/delete), training history
- **Real-time Hardware Monitor** — GPU utilization / VRAM / temperature, CPU / RAM usage, Chart.js dynamic charts, TensorBoard integration, live log viewer
- **Native Tag Editor** — Built-in image tag editor with batch find-and-replace, deduplication, sorting, cleanup, and more
- **WD14 Auto-Tagger** — Integrated WD14 tagger for one-click dataset labeling
- **Flash Attention Smart Install** — Auto-detects Python / CUDA / PyTorch versions and ABI, matches the best prebuilt wheel via GitHub API, one-click install
- **EmoSens Adaptive Optimizer** — Built-in EmoSens v3.9 with better convergence for Anima DiT training
- **Internationalization (i18n)** — Bilingual UI (676 translation keys), browser language auto-detection, persistent preference
- **Dark / Light Theme** — Auto-follow system preference or manual toggle
- **Backend Connectivity Indicator** — Real-time frontend-backend connection status with disconnect duration
- **Slow Remote Connection Compatibility** — Same-origin realtime transport, a weak-network thumbnail queue, and versioned browser caching keep previews from competing with live status

## Project Structure

```
lora-scripts-anima/
├── vendor/sd-scripts/          ← Training engine (full kohya-ss/sd-scripts)
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
└── requirements-musubi-krea2.txt ← Isolated musubi core dependencies
```

# Usage

### Prerequisites

- **Python**: 64-bit Python 3.10–3.12 (3.12 recommended)
- **Git**: used to download and update the project; Windows ZIP installs can set it up on first launch
- **PyTorch 2.10.0 + CUDA 13.0**: installed automatically by the startup scripts for RTX 30/40/50 series
- **NVIDIA driver R580 or newer**: the CUDA 13.0 minimum

> **Windows users do not need to downgrade or preinstall Python/Git.** On the first run, `start.bat` searches for 64-bit Python 3.10–3.12 and skips Microsoft Store placeholders. If only Python 3.13/3.14 is installed, it can install the official Python 3.12 side by side for the current user without removing newer versions or changing the default Python. Downloads show percentage, size, speed, and ETA; silent installer stages show an activity spinner.
>
> **Linux users** must install 64-bit Python 3.10–3.12. Most Python installations include `venv` support; install a separate package such as `python3.12-venv` only if a distribution such as Ubuntu or Debian reports that it is missing.
>
> If the project already contains an incompatible `venv` created with Python 3.13/3.14, remove or rename only the project's `venv` folder, then run `start.bat` again.

| GPU Series | Automatically Installed PyTorch | CUDA |
|------------|:-------------------------------:|:----:|
| RTX 30 (Ampere) | 2.10.0 | 13.0 |
| RTX 40 (Ada) | 2.10.0 | 13.0 |
| RTX 50 (Blackwell) | 2.10.0 | 13.0 |

Existing cu128 `venv` installations upgrade on the next launch. Installed xformers, FlashAttention, Triton, and bitsandbytes packages are rematched to cu130, while ONNX Runtime GPU moves to its CUDA 13-compatible version; optional packages that were not installed remain unchanged. Machines without an NVIDIA GPU still receive the complete GPU environment and can run the GUI; only training requires a GPU.

> **Krea 2 core environment**: the launch scripts also create `venv/cores/musubi`. Its musubi dependencies (including `transformers 4.57.6`) are isolated from the main environment. It read-only reuses the main CUDA-enabled PyTorch build, so sd-scripts' required `transformers 4.54.1` is never upgraded or replaced.

### Windows: Download ZIP (beginner-friendly)

1. On GitHub, choose **Code → Download ZIP**, fully extract it, and double-click `start.bat`.
2. If `.git` is missing, the bootstrap asks to install Git for Windows and repair the folder as an updateable repository; choose the recommended option.
3. Repair fetches the latest `main`. Source files that would be replaced are first saved to `bootstrap-backups/<timestamp>.zip`; `venv`, models, outputs, caches, logs, and the entire user `config` directory are excluded from source alignment and are never overwritten or cleaned.
4. After source alignment, the bootstrap restarts once and then creates `venv` and installs the training dependencies.

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

All HTTP requests and realtime traffic use the current page's same Origin. The trainer does not configure SSH, port forwarding, proxies, cloud-platform-specific logic, or an extra realtime port. If you already reach the remote page through your own setup, the browser continues to use that entry point.

- `/ws/realtime` carries only compact JSON state, progress, log increments, and hardware data. Commands, images, files, and metadata remain HTTP requests.
- The sidebar shows “Backend connected” only after both the WebSocket `ready` message and a realtime snapshot succeed. No valid realtime data for two seconds means “Realtime data delayed”; it changes to “Backend disconnected” only after the socket is closed and the health probe also fails.
- A backend restart creates a new instance ID. The page clears task, progress, log, curve, and hardware data from the old instance and explicitly marks the previous in-memory task state as unknown. This version does not scan for or take over leftover training processes.
- **UI Settings → Slow connection compatibility** is enabled by default. It shows the complete sample list for the current run or history record, loads thumbnails one at a time at low priority, and pauses those background requests while realtime data is delayed. Versioned thumbnails can stay in the browser cache for 24 hours; opening the original image remains an explicit user action.

### Updating later

After ZIP repair or `git clone`, right-click an empty area inside the project folder:

- Choose Windows **Open in Terminal**, then run `git pull`; or
- Choose **Git Bash Here**, then run `git pull`. On Windows 11 it may appear under **Show more options**.

The repository uses fast-forward-only pulls. If tracked source was edited manually, `git pull` stops safely and asks you to handle the local changes instead of overwriting them.

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
| `--localization` | str | | Interface localization setting |
| `--dev` | bool | false | Developer mode |
| `--quiet` / `-q` | bool | false | Automatically install Python/venv dependencies; optional Git repair remains disabled |
| `--setup-git` | bool | false | Windows: non-interactively perform the recommended Git install/ZIP repair |
| `--skip-git-setup` | bool | false | Windows: suppress Git installation or repository-repair prompts for this launch |

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
- sd-scripts, mounted LyCORIS, and musubi-tuner core status
- musubi runtime status (it reuses the main CUDA PyTorch build without changing sd-scripts dependencies)
- Flash Attention installation status with one-click install
- Candidate wheel list preview

## Acknowledgements

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — Core training scripts
- [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) — Krea 2 training core
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — Training GUI framework
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel matching algorithm reference
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel source
