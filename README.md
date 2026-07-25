<div align="center">

# lora-scripts-anima

_✨ 多核心 LoRA 训练工具：Anima、SDXL 与 Krea 2 ✨_

基于多核心训练架构的本地训练 GUI：保留 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)（位于 `vendor/sd-scripts/`）用于 Anima / SDXL，同时接入 [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) 的 **Krea 2 LoRA** 训练。

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

> ✅ **v2.0.1 已发布**
> 本次补丁版本修复优化器联动默认值、训练日志与实时指标显示，并改善 Flash Attention 下载回退和文档目录导航。

lora-scripts-anima 是基于 [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) 继续开发的 LoRA 训练图形界面。它以核心注册表隔离不同训练器：**sd-scripts** 负责 SDXL / Anima，**LyCORIS** 是可选的挂载式适配器核心（`lycoris.kohya`），**musubi-tuner** 负责 Krea 2 RAW DiT LoRA。

### 支持的模型类型

| 训练类型 | 底模 |
|---------|------|
| LoRA | SDXL |
| **LoRA** | **Anima**（Qwen3 + T5 双编码器） |
| **LoRA** | **Krea 2 RAW DiT**（musubi-tuner） |

> ℹ️ Krea 2 在训练前必须生成 latent 与 Qwen3-VL 文本编码输出两类缓存。界面会在“开始训练”前验证缓存是否完整、且是否仍与图片、标签和模型匹配。

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
- **慢速远程连接兼容** — 同源实时通道、弱网缩略图队列与版本化浏览器缓存，避免预览图片挤占实时状态

## 项目结构

```
lora-scripts-anima/
├── vendor/sd-scripts/          ← 训练引擎（kohya-ss/sd-scripts 完整原版）
├── vendor/musubi-tuner/        ← Krea 2 训练核心（固定上游版本）
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
├── requirements.txt            ← 主应用 / sd-scripts 依赖
└── requirements-musubi-krea2.txt ← 主环境的 Krea 2 版本收敛依赖
```

# 使用方法

### 必要依赖

- **Python**：需要 64 位 Python 3.10–3.12（推荐 3.12）
- **Git**：用于下载和更新项目；Windows ZIP 下载版可在首次启动时自动安装
- **PyTorch 2.10.0 + CUDA 13.0**：由启动脚本自动安装，兼容 RTX 30/40/50 全系列
- **NVIDIA 驱动 R580 或更高版本**：CUDA 13.0 的最低驱动要求

> **Windows 用户无需提前降级或另外安装 Python/Git。** 首次运行 `start.bat` 时，启动器会自动寻找 64 位 Python 3.10–3.12，并跳过 Microsoft Store 的 Python 占位符。如果电脑只有 Python 3.13/3.14，可按提示为当前用户并行安装官方 Python 3.12；不会卸载现有 Python，也不会修改系统默认 Python。下载过程会显示百分比、大小、速度和 ETA，静默安装阶段会显示加载动画。
>
> **Linux 用户**需要自行安装 64 位 Python 3.10–3.12。多数 Python 安装已包含创建 `venv` 的功能；只有 Ubuntu/Debian 等系统提示缺少该功能时，才需要额外安装对应的软件包（例如 `python3.12-venv`）。
>
> 如果项目中已经存在由 Python 3.13/3.14 创建的不兼容 `venv`，请只删除或重命名项目内的 `venv` 文件夹，再重新运行 `start.bat`。

| GPU 系列 | 自动安装的 PyTorch | CUDA |
|----------|:------------------:|:----:|
| RTX 30 系 (Ampere) | 2.10.0 | 13.0 |
| RTX 40 系 (Ada) | 2.10.0 | 13.0 |
| RTX 50 系 (Blackwell) | 2.10.0 | 13.0 |

已有 cu128 `venv` 会在下次启动时自动升级；已经安装的 xformers、FlashAttention、Triton 和 bitsandbytes 会同步匹配 cu130，ONNX Runtime GPU 会切换到 CUDA 13 对应版本，未安装的可选库保持不变。无 NVIDIA 显卡的机器仍会安装完整 GPU 环境并正常运行 GUI，仅训练功能需要显卡。

> **Krea 2 共享环境**：Krea 2 与 sd-scripts 共用项目主 `venv` 和 CUDA PyTorch。启动器先安装上游 sd-scripts 依赖，再以本项目的 `requirements-musubi-krea2.txt` 将共享版本收敛到 `transformers 4.57.6` / `tokenizers 0.22.2`；日常启动只做快速元数据检查，版本正确时不会重复运行 pip、卸载重装或导入完整 Krea 2 栈。同步后及实际 Krea 2 预检会做完整导入验证。不会修改 `vendor/` 中的上游依赖文件。

> 从旧版本遗留的 `venv/cores/musubi` 不再被读取、写入或自动删除；确认新主环境可正常训练后，可由用户自行删除以回收磁盘空间。

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

### 实时连接与慢速远程连接

网页的 HTTP 请求和实时连接始终使用当前页面的同一 Origin。训练器不会为此配置 SSH、端口映射、代理、特定云平台逻辑或额外的实时端口；若你已用自己的方式访问远程页面，浏览器会沿用该访问入口。

- `/ws/realtime` 仅传递小型 JSON 状态、进度、日志增量和硬件数据；命令、图片、文件和元数据仍使用 HTTP。
- 侧栏显示“后端已连接”前，必须同时完成 WebSocket `ready` 和实时快照。2 秒没有有效实时数据只显示“实时数据延迟”；连接关闭且健康探测也失败时才显示“后台离线”。
- 后端重启会更换实例 ID。网页会清除旧实例的任务、进度、日志、曲线与硬件快照，并明确提示先前的内存任务状态未知；当前版本不会扫描或接管遗留训练进程。
- **UI 设置 → 慢速远程连接兼容**默认开启：完整显示当前运行或历史记录的样本列表，缩略图以单请求、低优先级队列加载，并会在实时数据延迟时暂停。版本化缩略图可被浏览器缓存 24 小时；查看原图仍需用户主动点击。

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
- sd-scripts、挂载式 LyCORIS 与 musubi-tuner 核心状态
- musubi Krea 2 共享运行时状态（与 sd-scripts 共用 CUDA PyTorch，并显示版本是否已收敛）
- Flash Attention 安装状态检测与一键安装
- 候选 wheel 列表预览

## 致谢

- [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) — 训练核心脚本
- [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) — Krea 2 训练核心
- [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) — 训练 GUI 框架
- [mjun0812/flash-attention-prebuild-wheels](https://github.com/mjun0812/flash-attention-prebuild-wheels) — flash_attn prebuilt wheel 源
