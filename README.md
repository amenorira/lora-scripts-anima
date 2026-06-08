<div align="center">

# lora-scripts-anima

_✨ 专为 Anima 模型打造的 LoRA 训练工具 ✨_

基于 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)（位于 `vendor/sd-scripts/`）的训练 GUI，为 **Anima 模型**（Qwen3 + T5 双编码器）提供 LoRA 训练支持，同时兼容 SDXL。

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

> ⚠️ **重要提示**  
> 本项目正在积极开发中（v2.1.0-dev），部分功能可能尚不稳定。如需稳定版本，请关注后续正式发布。

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
│   └── tagger/                 ← WD14 标注模块
├── frontend/                   ← Alpine.js SPA 前端
├── config/                     ← TOML 配置预设
├── tools/                      ← 独立工具（Flash Attn 安装等）
├── vendor/emo_optimizer/       ← EmoSens 自适应优化器
├── gui.py                      ← 主入口
├── start.bat / start.sh        ← 启动脚本
└── requirements.txt            ← 项目依赖
```

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
> 国内用户设置清华镜像：`set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple` 后运行 `start.bat`。

### 克隆仓库

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
cd lora-scripts-anima
```

### 快速开始

| 平台 | 安装 + 启动 |
|------|------------|
| Windows | `.\start.bat` |
| Linux | `bash start.sh` |

首次启动会自动创建虚拟环境并安装所有依赖。启动后 GUI 自动打开 [http://127.0.0.1:12333](http://127.0.0.1:12333)。

> **RTX 40/50 系显卡用户**：启动脚本会自动检测 flash_attn 状态。如未安装，可在 GUI 的 **环境** 标签页中一键安装。

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
