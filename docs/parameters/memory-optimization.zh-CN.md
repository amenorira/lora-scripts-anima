<a name="guide-title"></a>
# 显存优化与速度实测

<a name="quick-guide"></a>
## 按显存档位选择方案

调整显存设置时，建议按“无损缓存 → 量化提速 → 块交换兜底”的顺序逐级启用（所有档位均默认开启**梯度检查点**、**将图像缓存写入磁盘**、**缓存文本编码**与 **`AdamW8bit`** 等 8-bit 优化器，`batch_size = 1` 并用梯度累积控制有效批次）：

| 显卡显存档位 | Anima（约 2B–2.9B） | MOSS-Image / Krea 2（大模型） | 核心取舍 |
| --- | --- | --- | --- |
| **16–24 GB+** | `bf16`，`DiT 交换块数 = 0`；按富余显存调高[末尾跳过梯度检查点的块数](#anima-partial-checkpointing)（`14–28`） | 开启 **ConvRot INT8**（或 Krea 2 的 **DiT FP8 动态量化**）+ `torch.compile`。在 24 GB 显卡上训练 **MOSS-Image** 时，可对末尾 `7–14` 个块跳过梯度检查点 | 用空闲显存换取 **15%–45%** 的单步提速 |
| **10–12 GB** | `bf16` 全开梯度检查点即可流畅训练（1024px 峰值约 **`6.7 GB`**） | 开启 **ConvRot INT8**（或 Krea 2 的 **DiT FP8 动态量化**）+ `compile`（MOSS 1024px 训练峰值约 **`9.1–10.0 GB`**）；MOSS 首次生成文本缓存时开启文本编码器 `ConvRot INT8` 或设[文本编码器块交换数量](#moss-text-encoder-swap) `28–32` | 兼顾低显存与高吞吐，避免启动缓存阶段爆显存 |
| **6–8 GB** | 1024px 仍紧俏时，小幅开启 [DiT 交换块数](#block-swap)（`8–16`）+ `H2D-only` | 开启 **ConvRot INT8**（或 Krea 2 的 **DiT FP8 动态量化**）：**MOSS-Image** 将 [DiT 交换块数](#block-swap) 调至 `20–36`（换出 `36` 块实测训练显存 `5.2 GB`），**Krea 2** 调至 `16–26`（上限 `26`，关闭 **Turbo DiT** 预览加速）；两者均可在开启梯度检查点时启用 `H2D-only` + 锁页内存（需 **16–32 GB+** 系统内存） | 用 PCIe 传输耗时与系统内存换取 6–8 GB 卡可跑 |

<a name="block-swap"></a>
## DiT 交换块数与互斥限制

**DiT 交换块数**（`blocks_to_swap`）将指定数量的 DiT Transformer 块常驻于系统内存（CPU RAM），仅在每步前向与反向计算轮到该块时流式传回 GPU 显存。该机制不改变数值精度，代价是消耗更多系统内存（建议 **16–32 GB+**）并增加单步传输等待时间。

- **各训练类型的换块上限**：
  - **Anima**：最多可换出 `总块数 - 2`（28 块 Anima-Preview 上限为 **`26`** 块，40 块 Anima-2.9B 上限为 **`38`** 块）。
  - **Krea 2**：最多可换出 **`26`** 块；换块数大于 `0` 且已开启梯度检查点时，可启用 `H2D-only` 与锁页内存。使用块交换时需关闭 **Turbo DiT** 预览加速。
  - **MOSS-Image**：上限为 **`40`** 块，不同换块数的显存与内存实测见下方 [MOSS-Image DiT 交换块数](#moss-block-swap)。
- **H2D-only 与锁页内存**：开启 `H2D-only` 后，反向传播用完的块直接在 GPU 端释放，省去从显存拷回内存（D2H）的开销；配合锁页内存（Pinned Memory）在 PCIe 带宽受限环境下可缩短约 20% 步时。
- **与其他选项的互斥规则**：
  - 与 **梯度检查点 CPU 卸载 / Unsloth 异步激活卸载** 互斥，不可同时开启。
  - 开启 **H2D-only** 且同时设置**末尾跳过梯度检查点的块数**时，交换块数与跳过检查点块数二者中至少有一项必须 `≤ block_swap_ring_size`（默认 `2`）；因此大比例换块时请将末尾跳过梯度检查点块数保持为 `0`。
  - 与逐块 `torch.compile` 联用时，必须关闭 `compile_fullgraph`（保持 `compile_fullgraph = false`）。

<a name="anima"></a>
## Anima

<a name="anima-partial-checkpointing"></a>
### 末尾跳过梯度检查点的块数

当显存充裕且未启用大比例块交换时，可让主干末尾若干块保留前向激活、跳过反向重算以加快训练（28 块 Anima-Preview 上限 `28`，40 块 Anima-2.9B 上限 `40`）。

实测条件：约 1 MP（1024×1024）图片，`batch_size = 1`，LoRA Rank `16`，`bf16`，Flash Attention；开启梯度检查点、Latent 缓存与文本缓存。显存为训练期间 `nvidia-smi` 峰值占用：

| 跳过块数 | PRO 6000 Blackwell 显存 | 秒/步 | RTX 4090 显存 | 秒/步 |
| --- | --- | --- | --- | --- |
| `0` | `6.5 GB` | `0.85` | `6.7 GB` | `0.73` |
| `7` | `9.4 GB` | `0.75` | `9.6 GB` | `0.68` |
| `14` | `12.9 GB` | `0.73` | `13.0 GB` | `0.63` |
| `21` | `16.4 GB` | `0.59` | `16.5 GB` | `0.56` |
| `28` | `19.9 GB` | `0.53` | `20.0 GB` | `0.52` |

来源：[sd-scripts `anima_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)

<a name="moss"></a>
## MOSS-Image

<a name="moss-partial-checkpointing"></a>
### 末尾跳过梯度检查点的块数

实测条件：约 1 MP 图片，`batch_size = 1`，LoRA Rank `16`，Flash Attention；开启梯度检查点、Latent 缓存与文本缓存（`ConvRot INT8 + compile` 步时取编译预热后稳定值；显存为含 CUDA 上下文的 `nvidia-smi` 训练峰值）。

<a name="moss-skip-pro6000"></a>
#### RTX PRO 6000 Blackwell

（使用 `bf16` 文本编码器在启动阶段生成缓存时，启动峰值约为 `15.6 GB`。）

| 跳过块数 | `bf16` 显存 | 秒/步 | `ConvRot INT8 + compile` 显存 | 秒/步 |
| --- | --- | --- | --- | --- |
| `0` | `13.5 GB` | `1.29` | `10.0 GB` | `0.84` |
| `11` | `23.4 GB` | `1.21` | `15.4 GB` | `0.79` |
| `21` | `33.6 GB` | `1.13` | `21.9 GB` | `0.74` |
| `32` | `44.9 GB` | `1.02` | `29.1 GB` | `0.70` |
| `42` | `55.0 GB` | `0.93` | `35.5 GB` | `0.64` |

<a name="moss-skip-4090"></a>
#### RTX 4090（文本编码器使用 ConvRot INT8）

| DiT 配置 | 跳过块数 | 显存峰值 | 秒/步 |
| --- | --- | --- | --- |
| `bf16` | `0` | `14.3 GB` | `1.88` |
| `bf16` | `5` | `17.6 GB` | `1.83` |
| `bf16` | `10` | `22.5 GB` | `1.77` |
| `ConvRot INT8 + compile` | `0` | `10.0 GB` | `1.00` |
| `ConvRot INT8 + compile` | `7` | `13.0 GB` | `0.98` |
| `ConvRot INT8 + compile` | `14` | `17.5 GB` | `0.94` |
| `ConvRot INT8 + compile` | `21` | `22.0 GB` | `0.90` |

注：单独开启 `ConvRot INT8` 而不启用 `compile` 主要节省显存，步时与 `bf16` 基本持平（PRO 6000 上为 `1.41 秒/步` 对比 `1.45 秒/步`）；搭配 `torch.compile` 才能同时大幅提速。来源：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)

<a name="moss-block-swap"></a>
### DiT 交换块数

实测条件：RTX PRO 6000 Blackwell，Windows，`1024×1024`，`batch_size = 1`，LoRA Rank `16`，AdamW；开启梯度检查点、Latent 磁盘缓存与文本缓存（传统块交换模式；显存为含 CUDA 上下文的 `nvidia-smi` 峰值，启动显存含文本缓存生成阶段，CPU 内存为进程工作集峰值；互斥规则见上方 [DiT 交换块数与互斥限制](#block-swap)）：

| DiT / 文本编码器精度 | 显存优化配置 | 启动显存 | 训练显存 | CPU 内存 |
| --- | --- | --- | --- | --- |
| `bf16` / `bf16` | 不换块 | `15.3 GB` | `13.2 GB` | `17.2 GB` |
| `ConvRot INT8` / `ConvRot INT8` | 不换块 | `9.1 GB` | `9.1 GB` | `9.9 GB` |
| `ConvRot INT8` / `ConvRot INT8` | Unsloth 异步激活卸载 | `8.2 GB` | `8.2 GB` | `11.2 GB` |
| `bf16` / `ConvRot INT8` | 换出 `20` 块 | `9.0 GB` | `9.0 GB` | `18.5 GB` |
| `ConvRot INT8` / `ConvRot INT8` | 换出 `20` 块 | `7.9 GB` | `6.9 GB` | `14.0 GB` |
| `ConvRot INT8` / `ConvRot INT8` | 换出 `36` 块 | `7.9 GB` | `5.2 GB` | `15.6 GB` |

<a name="moss-swap-h2d"></a>
#### 换出 36 块：传统方式与 H2D-only 步时对照

实测条件：RTX 3090，PCIe Gen3 x4，`bf16`，`1024×1024`，`batch_size = 1`（`—` 表示上游未记录该项显存）：

| 块交换方式 | 显存 | 秒/步 |
| --- | --- | --- |
| 传统块交换 | — | `≈ 11.7` |
| `H2D-only` + 锁页内存 | `≈ 7 GB` | `≈ 9.4` |

来源：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md) · [`block_swap.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)

<a name="moss-text-encoder-swap"></a>
### 文本编码器块交换数量

MOSS-Image 在训练启动阶段为数据集生成文本编码缓存时，若不启用文本编码器换块（换出 `0` 层），完整加载 Qwen 文本编码器的 `nvidia-smi` 显存峰值（含 CUDA 上下文）约为 **`15.5 GB`**（`bf16`）或 **`8.3 GB`**（`ConvRot INT8`）。在 8–12 GB 显卡上，即便 DiT 训练阶段显存够用，也可能卡在这一步爆显存。

调高**文本编码器块交换数量**可在一次性生成文本缓存时按层流式加载编码器，缓存写盘完成后文本编码器即在进入 DiT 训练前卸载（下表左列为单条约 2000 token 描述下的 PyTorch GPU 张量分配峰值）：

| 文本编码器精度 | 换出层数 | 统计口径 | 显存峰值 |
| --- | --- | --- | --- |
| `bf16` | `0`（不换层） | `nvidia-smi` 整卡峰值 | `15.5 GB` |
| `ConvRot INT8` | `0`（不换层） | `nvidia-smi` 整卡峰值 | `8.3 GB` |
| `bf16` | `28` | PyTorch GPU 分配峰值 | `5.1 GB` |
| `bf16` | `32` | PyTorch GPU 分配峰值 | `3.5 GB` |
| `ConvRot INT8` | `32` | PyTorch GPU 分配峰值 | `2.2 GB` |

换层仅增加首次生成文本缓存的耗时（RTX PRO 6000、PCIe 5.0、`bf16` 下，换出 `0` 层为 `0.1–0.3 秒/条描述`，换出 `28` 层约为 `0.7 秒/条描述`），后续复用磁盘缓存的训练步不受影响。来源：[sd-scripts `moss_image_train_network.md`](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md)
