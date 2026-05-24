<div align="center">

# lora-scripts-anima

_✨ 专为 Anima 模型打造的 LoRA 训练工具 ✨_

基于 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)（位于 `vendor/sd-scripts/`）的训练 GUI，为 **Anima 模型** 提供 LoRA 训练支持，同时兼容 SD 1.5 / SDXL。

</div>

<p align="center">
  <a href="https://github.com/ameyukisora/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub 仓库星标" src="https://img.shields.io/github/stars/ameyukisora/lora-scripts-anima">
  </a>
  <a href="https://github.com/ameyukisora/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub 仓库分支" src="https://img.shields.io/github/forks/ameyukisora/lora-scripts-anima">
  </a>
  <a href="https://raw.githubusercontent.com/ameyukisora/lora-scripts-anima/main/LICENSE" style="margin: 2px;">
    <img src="https://img.shields.io/github/license/ameyukisora/lora-scripts-anima" alt="许可证">
  </a>
</p>

<p align="center">
  <a href="https://github.com/ameyukisora/lora-scripts-anima/blob/main/README-en.md">English</a>
</p>

Anima LoRA 训练图形界面，内置完整的 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts.git) 训练引擎。目前 UI 支持 SD / SDXL / Anima 三种模型的 LoRA 训练。

### 支持的模型类型

| 训练类型 | 底模 |
|---------|------|
| LoRA | SD 1.5 / SD 2.x |
| LoRA | SDXL |
| **LoRA** | **Anima** |

> ℹ️ `vendor/sd-scripts/` 训练引擎本身支持 SD3 / FLUX / HunyuanImage / Lumina 等更多模型，但当前 UI 尚未接入这些模型的训练入口。

## ✨新特性: 训练 WebUI

Stable Diffusion 训练工作台。一切集成于一个 WebUI 中。

按照下面的安装指南安装 GUI，然后运行 `start.bat`(Windows) 或 `bash start.sh`(Linux) 来启动 GUI。

![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/d3fcf5ad-fb8f-4e1d-81f9-c903376c19c6)

| Tensorboard | WD 1.4 标签器 | 标签编辑器 |
| ------------ | ------------ | ------------ |
| ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/b2ac5c36-3edf-43a6-9719-cb00b757fc76) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/9504fad1-7d77-46a7-a68f-91fbbdbc7407) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/4597917b-caa8-4e90-b950-8b01738996f2) |


# 使用方法

### 必要依赖

- Python 3.10+ 和 Git
- **PyTorch ≥ 2.10.0 + CUDA 12.8**（安装脚本自动配置，兼容 RTX 30/40/50 全系列）

| GPU 系列 | 最低 PyTorch | 推荐 CUDA |
|----------|:----------:|:---------:|
| RTX 30 系 (Ampere) | 2.6.0 | 12.8 |
| RTX 40 系 (Ada) | 2.6.0 | 12.8 |
| RTX 50 系 (Blackwell) | **2.8.0** | **12.8** |

> 安装脚本默认 PyTorch 2.10.0 + CUDA 12.8，全系列通用，cp312 有预编译 flash-attn。
> 国内用户运行 `install-cn.ps1`，pip 使用清华镜像加速，PyTorch 使用官方 CDN（国内可达 15-20 MB/s）。

### 克隆仓库

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
cd lora-scripts-anima
```

### 快速开始

| 平台 | 安装 | 直接启动 | 更新仓库并启动 |
|------|------|----------|----------------|
| Windows | `.\install-cn.ps1` | `.\start.bat` | `.\update-and-start.bat` |
| Linux | `bash install.sh` | `bash start.sh` | `bash update-and-start.sh` |

启动后 GUI 自动打开 [http://127.0.0.1:12333](http://127.0.0.1:12333)。

> **RTX 40/50 系显卡用户**：启动脚本会自动检测 flash_attn 状态。
> 如显示 ❌ 未安装，运行 `.\install-flash-attn.bat` (Windows) 或 `bash install-flash-attn.sh` (Linux) 一键安装。

## ✨ SD-Trainer GUI

训练 WebUI，集成 TensorBoard、WD14 标签器、标签编辑器。

启动后即可使用，无需额外命令。

| Tensorboard | WD 1.4 标签器 | 标签编辑器 |
| ------------ | ------------ | ------------ |
| ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/b2ac5c36-3edf-43a6-9719-cb00b757fc76) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/9504fad1-7d77-46a7-a68f-91fbbdbc7407) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/4597917b-caa8-4e90-b950-8b01738996f2) |

> ℹ️ 旧版手动脚本（`train.ps1`、`tagger.ps1` 等）已归档至 `legacy/scripts/` 目录。
> ℹ️ 前端代码位于 `frontend/`（Alpine.js SPA），后端位于 `backend/`（FastAPI），训练引擎位于 `vendor/sd-scripts/`。
> ℹ️ 旧版前端和脚本已归档至 `legacy/`。

## 程序参数

| 参数名称                     | 类型  | 默认值       | 描述                                            |
|------------------------------|-------|--------------|-------------------------------------------------|
| `--host`                     | str   | "127.0.0.1"  | 服务器的主机名                                  |
| `--port`                     | int   | 12333        | 运行服务器的端口                                |
| `--listen`                   | bool  | false        | 启用服务器的监听模式                            |
| `--skip-prepare-environment` | bool  | false        | 跳过环境准备步骤                                |
| `--disable-tensorboard`      | bool  | false        | 禁用 TensorBoard                                |
| `--disable-tageditor`        | bool  | false        | 禁用标签编辑器                                  |
| `--tensorboard-host`         | str   | "127.0.0.1"  | 运行 TensorBoard 的主机                         |
| `--tensorboard-port`         | int   | 6006         | 运行 TensorBoard 的端口                          |
| `--localization`             | str   |              | 界面的本地化设置                                |
| `--dev`                      | bool  | false        | 开发者模式，用于禁用某些检查                     |

## Flash Attention 加速

RTX 40/50 系显卡推荐安装 flash_attn 以获得最佳训练和推理性能。

### 一键安装

```sh
# Windows
.\install-flash-attn.bat

# Linux
bash install-flash-attn.sh
```

### 功能特性

- **自动环境检测**：Python / PyTorch / CUDA ABI / 平台
- **智能匹配**：从 GitHub Releases 动态拉取候选 prebuilt wheel，评分排序
- **交互式选择**：展示所有候选及兼容性说明，数字键选择版本
- **内建修复**：已装版本 ABI 不匹配时自动卸载并重新安装正确版本
- **安装后验证**：完成后自动 import + CUDA forward 测试

### 手动使用

```sh
python tools/install_flash_attn.py              # 交互式安装
python tools/install_flash_attn.py --dry-run    # 仅预览环境与候选
python tools/install_flash_attn.py --url URL    # 手动指定 wheel
python tools/install_flash_attn.py --yes        # 非交互自动安装
```

## 致谢

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — 训练核心脚本
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — 训练 GUI 框架
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel 智能匹配算法参考
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel 源
