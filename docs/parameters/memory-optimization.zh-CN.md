# 显存与速度实测

<!-- doc-anchor: anima -->
## Anima

<!-- doc-anchor: anima-partial-checkpointing -->
### 跳过检查点的末尾块数

约 1 MP 图片，batch 1，LoRA rank 16，bf16，Flash Attention；启用梯度检查点、latent 和文本缓存。显存取训练时 nvidia-smi 峰值。

| 跳过块数 | PRO 6000 Blackwell 显存 | 秒/步 | RTX 4090 显存 | 秒/步 |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 | 6.7 GB | 0.73 |
| 7 | 9.4 GB | 0.75 | 9.6 GB | 0.68 |
| 14 | 12.9 GB | 0.73 | 13.0 GB | 0.63 |
| 21 | 16.4 GB | 0.59 | 16.5 GB | 0.56 |
| 28 | 19.9 GB | 0.53 | 20.0 GB | 0.52 |

来源：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<!-- doc-anchor: moss -->
## MOSS-Image

<!-- doc-anchor: moss-partial-checkpointing -->
### 跳过检查点的末尾块数

#### RTX PRO 6000 Blackwell

约 1 MP 图片，batch 1，LoRA rank 16，Flash Attention；启用梯度检查点、latent 和文本缓存。INT8 + compile 的步时取预热后。

| 跳过块数 | bf16 显存 | 秒/步 | ConvRot INT8 + compile 显存 | 秒/步 |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 | 10.0 GB | 0.84 |
| 11 | 23.4 GB | 1.21 | 15.4 GB | 0.79 |
| 21 | 33.6 GB | 1.13 | 21.9 GB | 0.74 |
| 32 | 44.9 GB | 1.02 | 29.1 GB | 0.70 |
| 42 | 55.0 GB | 0.93 | 35.5 GB | 0.64 |

#### RTX 4090

图片、batch、rank 和注意力设置同上；文本编码器为 ConvRot INT8。

| DiT 配置 | 跳过块数 | 显存峰值 | 秒/步 |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 |
| bf16 | 5 | 17.6 GB | 1.83 |
| bf16 | 10 | 22.5 GB | 1.77 |
| ConvRot INT8 + compile | 0 | 10.0 GB | 1.00 |
| ConvRot INT8 + compile | 7 | 13.0 GB | 0.98 |
| ConvRot INT8 + compile | 14 | 17.5 GB | 0.94 |
| ConvRot INT8 + compile | 21 | 22.0 GB | 0.90 |

#### ConvRot INT8 训练速度对照

RTX PRO 6000 Blackwell，1024×1024，batch 1，梯度检查点。此组未注明 compile、跳过块数和显存。

| DiT 配置 | 秒/步 |
| --- | --- |
| bf16 | 1.45 |
| ConvRot INT8 | 1.41 |

来源：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<!-- doc-anchor: moss-block-swap -->
### 换出块数

RTX PRO 6000 Blackwell，Windows，1024×1024，batch 1，LoRA rank 16，AdamW；梯度检查点、latent 磁盘缓存。换块为传统方式。

| DiT / 文本编码器 | 配置 | 启动显存 | 训练显存 | CPU 内存 |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | 仅 DiT，文本缓存 | 15.3 GB | 13.2 GB | 17.2 GB |
| ConvRot INT8 / ConvRot INT8 | 仅 DiT，文本缓存 | 9.1 GB | 9.1 GB | 9.9 GB |
| ConvRot INT8 / ConvRot INT8 | 仅 DiT，文本缓存，换出 20 块 | 7.9 GB | 6.9 GB | 14.0 GB |
| ConvRot INT8 / ConvRot INT8 | 仅 DiT，文本缓存，换出 36 块 | 7.9 GB | 5.2 GB | 15.6 GB |
| ConvRot INT8 / ConvRot INT8 | 仅 DiT，文本缓存，Unsloth 卸载 | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / ConvRot INT8 | 仅 DiT，文本缓存，换出 20 块 | 9.0 GB | 9.0 GB | 18.5 GB |
| ConvRot INT8 / ConvRot INT8 | DiT + 文本编码器 LoRA，无文本缓存 | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + 文本编码器 LoRA，无文本缓存 | 32.4 GB | 32.4 GB | 16.1 GB |

显存为 nvidia-smi 峰值，含 CUDA 上下文；启用文本缓存时，启动阶段包含缓存过程。CPU 内存为进程工作集峰值。后两行训练文本编码器，本界面暂不支持。

来源：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

#### 换出 36 块：传统方式与 H2D-only

RTX 3090，PCIe Gen3 x4，bf16，1024×1024，batch 1。

| 方式 | 显存 | 秒/步 |
| --- | --- | --- |
| 传统换块 | — | ≈ 11.7 |
| H2D-only + 锁页 | ≈ 7 GB | ≈ 9.4 |

—：上游未提供。

来源：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<!-- doc-anchor: moss-text-encoder-swap -->
### 文本编码器换出层数

#### 缓存显存

单条约 2000 token；PyTorch GPU 分配峰值。

| 文本编码器 | 换出层数 | GPU 分配峰值 |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

#### 独立文本缓存工具：不换层

nvidia-smi 显存峰值。

| 文本编码器 | 显存峰值 |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

#### 换层耗时

RTX PRO 6000，PCIe 5.0，bf16；此组未注明描述长度。

| 换出层数 | 秒/条描述 |
| --- | --- |
| 0 | 0.1–0.3 |
| 28 | ≈ 0.7 |

来源：[sd-scripts](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
