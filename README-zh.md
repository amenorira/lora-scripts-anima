<div align="center">

# SD-Trainer (lora-scripts-anima)

_✨ Anima + Stable Diffusion 训练 GUI ✨_

基于 [Akegarasu/lora-scripts](https://github.com/Akegarasu/lora-scripts) 的修改版，新增 **Anima 模型支持**，并使用最新的 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts)。

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
  <a href="https://github.com/ameyukisora/lora-scripts-anima/blob/main/README.md">英文README</a>
  ·
  <a href="https://github.com/ameyukisora/lora-scripts-anima/blob/main/README-zh.md">中文README</a>
</p>

LoRA & Dreambooth 训练图形界面，新增 **Anima 模型支持**，基于最新的 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts.git)。

### 支持的模型类型

| 训练类型 | 底模 |
|---------|------|
| LoRA / Dreambooth | SD 1.5 / SD 2.x |
| LoRA / 微调 | SDXL |
| LoRA | SD3 |
| LoRA / 微调 | FLUX（含 Chroma） |
| **LoRA** 🆕 | **Anima** |

## ✨新特性: 训练 WebUI

Stable Diffusion 训练工作台。一切集成于一个 WebUI 中。

按照下面的安装指南安装 GUI，然后运行 `run_gui.ps1`(Windows) 或 `run_gui.sh`(Linux) 来启动 GUI。

![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/d3fcf5ad-fb8f-4e1d-81f9-c903376c19c6)

| Tensorboard | WD 1.4 标签器 | 标签编辑器 |
| ------------ | ------------ | ------------ |
| ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/b2ac5c36-3edf-43a6-9719-cb00b757fc76) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/9504fad1-7d77-46a7-a68f-91fbbdbc7407) | ![image](https://github.com/Akegarasu/lora-scripts/assets/36563862/4597917b-caa8-4e90-b950-8b01738996f2) |


# 使用方法

### 必要依赖

Python 3.10 和 Git

### 克隆仓库

```sh
git clone https://github.com/ameyukisora/lora-scripts-anima.git
```

## ✨ SD-Trainer GUI

### 更新 kohya-ss/sd-scripts

将训练脚本更新到最新版：

| 平台 | 脚本 |
|------|------|
| Windows (CMD) | `update-scripts.bat` |
| Windows (PowerShell) | `update-scripts.ps1` |
| Linux | `bash update-scripts.bash` |

这将用最新版 [kohya-ss/sd-scripts](https://github.com/kohya-ss/sd-scripts) 替换 `scripts/` 目录。

### Windows

#### 安装

运行 `install-cn.ps1` 将自动为您创建虚拟环境并安装必要的依赖。 

#### 训练

运行 `run_gui.ps1`，程序将自动打开 [http://127.0.0.1:28000](http://127.0.0.1:28000)

### Linux

#### 安装

运行 `install.bash` 将创建虚拟环境并安装必要的依赖。

#### 训练

运行 `bash run_gui.sh`，程序将自动打开 [http://127.0.0.1:28000](http://127.0.0.1:28000)

### Docker

#### 编译镜像

```bash
# 国内镜像优化版本
# 其中 lora-scripts-anima:latest 为镜像及其 tag 名，根据镜像托管服务商实际进行修改
docker build -t lora-scripts-anima:latest -f Dockerfile-for-Mainland-China .
docker push lora-scripts-anima:latest
```

#### 使用镜像

```bash
docker run --gpus all -p 28000:28000 -p 6006:6006 lora-scripts-anima:latest 
```

或者使用 `docker-compose.yaml` 。

```yaml
services:
  lora-scripts:
    container_name: lora-scripts-anima
    build:
      context: .
      dockerfile: Dockerfile-for-Mainland-China
    image: "lora-scripts-anima:latest"
    ports:
      - "28000:28000"
      - "6006:6006"  
    environment:
      - HF_HOME=huggingface
      - PYTHONUTF8=1
    security_opt:
      - "label=type:nvidia_container_t"
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['0']
              capabilities: [gpu]
```
 
关于容器使用 GPU 相关依赖安装问题，请自行搜索查阅资料解决。

## 通过手动运行脚本的传统训练方式

### Windows

#### 安装

运行 `install.ps1` 将自动为您创建虚拟环境并安装必要的依赖。

#### 训练

编辑 `train.ps1`，然后运行它。

### Linux

#### 安装

运行 `install.bash` 将创建虚拟环境并安装必要的依赖。

#### 训练

训练

脚本 `train.sh` **不会** 为您激活虚拟环境。您应该先激活虚拟环境。

```sh
source venv/bin/activate
```

编辑 `train.sh`，然后运行它。

#### TensorBoard

运行 `tensorboard.ps1` 将在 http://localhost:6006/ 启动 TensorBoard

## 程序参数

| 参数名称                     | 类型  | 默认值       | 描述                                            |
|------------------------------|-------|--------------|-------------------------------------------------|
| `--host`                     | str   | "127.0.0.1"  | 服务器的主机名                                  |
| `--port`                     | int   | 28000        | 运行服务器的端口                                |
| `--listen`                   | bool  | false        | 启用服务器的监听模式                            |
| `--skip-prepare-environment` | bool  | false        | 跳过环境准备步骤                                |
| `--disable-tensorboard`      | bool  | false        | 禁用 TensorBoard                                |
| `--disable-tageditor`        | bool  | false        | 禁用标签编辑器                                  |
| `--tensorboard-host`         | str   | "127.0.0.1"  | 运行 TensorBoard 的主机                         |
| `--tensorboard-port`         | int   | 6006         | 运行 TensorBoard 的端口                          |
| `--localization`             | str   |              | 界面的本地化设置                                |
| `--dev`                      | bool  | false        | 开发者模式，用于禁用某些检查                     |
