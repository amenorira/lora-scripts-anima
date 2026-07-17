<div align="center">

# lora-scripts-anima

_✨ 专为 Anima 模型打造的 LoRA 训练工具 ✨_

基于 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)（位于 `vendor/sd-scripts/`）的训练 GUI，为 **Anima 模型**（Qwen3 + T5 双编码器）提供 LoRA 训练支持，同时兼容 SDXL。

</div>

<p align="center">
  <a href="https://github.com/amenorira/lora-scripts-anima" style="margin: 2px;">
    <img alt="GitHub 仓库星标" src="https://img.shields.io/github/stars/amenorira/lora-scripts-anima">
  </a>
  <a href="https://raw.githubusercontent.com/amenorira/lora-scripts-anima/main/LICENSE" style="margin: 2px;">
    <img src="https://img.shields.io/github/license/amenorira/lora-scripts-anima" alt="许可证">
  </a>
</p>

<p align="center">
  <a href="https://github.com/amenorira/lora-scripts-anima/blob/main/README-en.md">English</a>
</p>

> ✅ **v1.3.0 正式版已发布**
> 本次更新重做 Windows 首次启动流程：可自动准备 Python/Git，将 GitHub ZIP 安全修复为可通过 `git pull` 更新的仓库，并提供全程中英双语进度与用户数据保护。

lora-scripts-anima 是基于 [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) 继续开发的 LoRA 训练图形界面，内置完整的 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts.git) 训练引擎。当前 UI 支持 **SDXL** 和 **Anima** 两种模型的 LoRA 训练（SD 1.5 已移除）。

### 支持的模型类型

| 训练类型 | 底模 |
|---------|------|
| LoRA | SDXL |
| **LoRA** | **Anima**（Qwen3 + T5 双编码器） |

> ℹ️ `vendor/sd-scripts/` 训练引擎本身支持 SD3 / FLUX / HunyuanImage / Lumina 等更多模型，但当前 UI 尚未接入这些模型的训练入口。

## ✨ 功能特性

- **训练 WebUI** — 一站式工作台：LoRA 训练表单、TOML 配置预览、预设管理（保存/加载/删除）、训练历史记录
- **实时硬件监控** — GPU 利用率/显存/温度、CPU/RAM 使用率，Chart.js 动态图表，TensorBoard 集成，实时日志查看
- **原生标签编辑器** — 内置图片标签编辑器，支持批量查找替换、去重、排序、清理等操作
- **WD14 自动打标** — 集成 WD14 标签器，一键为数据集图片生成标签
- **Flash Attention 智能安装** — 自动检测 Python/CUDA/PyTorch 版本及 ABI，通过 GitHub API 匹配最佳预编译 wheel，一键安装
- **EmoSens 自适应优化器** — 内置 EmoSens v3.9，对 Anima DiT 训练有更好的收敛效果
- **国际化 (i18n)** — 中英双语界面（676 个翻译键），浏览器语言自动检测，偏好持久保存
- **暗色/亮色主题** — 支持自动跟随系统、手动切换
- **后端连接状态指示器** — 实时显示前后端连接状态及断连时长

## 项目结构

```
lora-scripts-anima/
├── vendor/sd-scripts/          ← 训练引擎（kohya-ss/sd-scripts 完整原版）
├── backend/                    ← FastAPI 后端
│   ├── server/                 ← API 核心（路由、状态、代理）
│   ├── training/               ← 训练引擎封装（参数适配、字段注册表、进程管理）
│   ├── monitor/                ← 训练监控（GPU/系统/日志/预览/历史）
│   ├── tageditor/              ← 原生标签编辑器
│   ├── tagger/                 ← WD14 标注模块
│   └── gui.py                  ← GUI 内部入口（由启动脚本调用）
├── frontend/                   ← Alpine.js SPA 前端
├── config/                     ← TOML 配置预设
├── tools/                      ← 独立工具（Flash Attn 安装等）
├── vendor/emo_optimizer/       ← EmoSens 自适应优化器
├── start.bat / start.sh        ← 启动脚本
└── requirements.txt            ← 项目依赖
```

# 使用方法

### 必要依赖

- **Python**：需要 64 位 Python 3.10–3.12（推荐 3.12）
- **Git**：用于下载和更新项目；Windows ZIP 下载版可在首次启动时自动安装
- **PyTorch 2.10.0 + CUDA 12.8**：由启动脚本自动安装，兼容 RTX 30/40/50 全系列

> **Windows 用户无需提前降级或另外安装 Python/Git。** 首次运行 `start.bat` 时，启动器会自动寻找 64 位 Python 3.10–3.12，并跳过 Microsoft Store 的 Python 占位符。如果电脑只有 Python 3.13/3.14，可按提示为当前用户并行安装官方 Python 3.12；不会卸载现有 Python，也不会修改系统默认 Python。下载过程会显示百分比、大小、速度和 ETA，静默安装阶段会显示加载动画。
>
> **Linux 用户**需要自行安装 64 位 Python 3.10–3.12。多数 Python 安装已包含创建 `venv` 的功能；只有 Ubuntu/Debian 等系统提示缺少该功能时，才需要额外安装对应的软件包（例如 `python3.12-venv`）。
>
> 如果项目中已经存在由 Python 3.13/3.14 创建的不兼容 `venv`，请只删除或重命名项目内的 `venv` 文件夹，再重新运行 `start.bat`。

| GPU 系列 | 自动安装的 PyTorch | CUDA |
|----------|:------------------:|:----:|
| RTX 30 系 (Ampere) | 2.10.0 | 12.8 |
| RTX 40 系 (Ada) | 2.10.0 | 12.8 |
| RTX 50 系 (Blackwell) | 2.10.0 | 12.8 |

> 国内用户设置清华镜像：`set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple` 后运行 `start.bat`。

### Windows：直接下载 ZIP（小白推荐）

1. 在 GitHub 点击 **Code → Download ZIP**，完整解压后双击 `start.bat`。
2. 如果目录中没有 `.git`，启动器会询问是否安装 Git for Windows 并修复为可更新仓库；选择推荐项即可。
3. 修复时会拉取最新 `main`。若 ZIP 源码与最新版不同，待覆盖的源码会先备份到 `bootstrap-backups/<时间>.zip`；`venv`、模型、输出、缓存、日志和整个 `config` 用户配置目录会从源码对齐中排除，不会被覆盖或清理。
4. 源码更新完成后，启动器会自动重启一次，再创建 `venv` 并安装训练依赖。

Git 安装或仓库修复失败不会阻止训练器启动，下次运行仍可重试。Python 或核心依赖安装失败时则会停止并显示双语错误。

### 使用 Git 克隆

```sh
git clone https://github.com/amenorira/lora-scripts-anima.git
cd lora-scripts-anima
```

### 快速开始

| 平台 | 安装 + 启动 |
|------|------------|
| Windows | `.\start.bat` |
| Linux | `bash start.sh` |

首次启动会自动创建虚拟环境并安装所有依赖。启动后 GUI 自动打开 [http://127.0.0.1:12333](http://127.0.0.1:12333)。

> **RTX 40/50 系显卡用户**：启动脚本会自动检测 flash_attn 状态。如未安装，可在 GUI 的 **环境** 标签页中一键安装。

### 后续更新

完成 ZIP 仓库修复或使用 `git clone` 后，在项目文件夹空白处右键：

- 选择 Windows 的 **在终端中打开**，然后运行 `git pull`；或
- 选择 **Git Bash Here** 后运行 `git pull`。Windows 11 中该菜单可能位于 **显示更多选项** 内。

仓库使用仅快进更新策略；如果源码被手动修改，`git pull` 会安全停止并提示先处理本地改动，不会自动覆盖。

## 程序参数

| 参数名称 | 类型 | 默认值 | 描述 |
|---------|------|--------|------|
| `--host` | str | "127.0.0.1" | 服务器主机名 |
| `--port` | int | 12333 | 服务器端口 |
| `--listen` | bool | false | 启用监听模式（允许外部访问） |
| `--skip-prepare-environment` | bool | false | 跳过环境准备步骤 |
| `--disable-tensorboard` | bool | false | 禁用 TensorBoard |
| `--tensorboard-host` | str | "127.0.0.1" | TensorBoard 主机 |
| `--tensorboard-port` | int | 6006 | TensorBoard 端口 |
| `--localization` | str | | 界面本地化设置 |
| `--dev` | bool | false | 开发者模式 |
| `--quiet` / `-q` | bool | false | 自动安装 Python/venv 依赖；默认不执行可选的 Git 仓库修复 |
| `--setup-git` | bool | false | Windows：非交互执行推荐的 Git 安装/ZIP 仓库修复 |
| `--skip-git-setup` | bool | false | Windows：本次启动不提示 Git 安装或仓库修复 |

## Flash Attention 加速

RTX 40/50 系显卡推荐安装 flash_attn 以获得最佳训练性能。

### GUI 安装

启动 GUI 后，在 **环境** 标签页中点击安装即可。脚本自动检测 Python / PyTorch / CUDA ABI / 平台，通过 GitHub API 匹配最佳预编译 wheel。

### 手动安装

```sh
python tools/install_flash_attn.py              # 交互式安装
python tools/install_flash_attn.py --dry-run    # 仅预览环境与候选
python tools/install_flash_attn.py --url URL    # 手动指定 wheel
python tools/install_flash_attn.py --yes        # 非交互自动安装
```

## EmoSens 自适应优化器

项目内置了 EmoSens v3.9 自适应优化器（`vendor/emo_optimizer/`），对 Anima DiT 模型训练有更好的收敛效果。

### 推荐设置

| 训练类型 | 学习率 | 调度器 | max_grad_norm |
|---------|:------:|:------:|:-------------:|
| SDXL LoRA | 1.0 | constant | 0 |
| Anima LoRA (DiT) | 0.1 | constant | 0 |

在训练表单的优化器下拉菜单中选择 `EmoSens` 即可使用。

## 预设管理

支持 TOML 格式的训练预设保存、加载和删除，预设文件存储在 `config/presets/` 目录。

- **保存**：在训练页面配置好参数后，点击右上角"保存预设"
- **加载**：在预设下拉菜单中选择已保存的预设
- **删除**：在预设管理界面删除不需要的预设

## 环境管理

GUI 的 **环境** 标签页提供：
- Python / PyTorch / CUDA 版本信息
- sd-scripts 训练引擎版本
- Flash Attention 安装状态检测与一键安装
- 候选 wheel 列表预览

## 致谢

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — 训练核心脚本
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — 训练 GUI 框架
- [WalkingMeatAxolotl/AnimaLoraStudio](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio) — flash_attn wheel 智能匹配算法参考
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel 源
