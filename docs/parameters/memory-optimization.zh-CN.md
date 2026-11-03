# 显存与速度

按出问题的阶段选择配置：加载、缓存、训练或预览。以下为当前内置上游版本的实测，各章节附有来源；比较时需保持分辨率、batch、rank、注意力后端和量化方式一致。

<!-- doc-anchor: overview -->
## 按瓶颈选择设置

| 当前情况 | 优先检查 | 主要代价 |
| --- | --- | --- |
| 正式训练显存不足 | batch、分辨率、梯度检查点、缓存 | 降低吞吐或增加重算；分辨率影响训练内容 |
| 冻结模型权重占用过大 | 换块；MOSS 的 ConvRot INT8 | 更多系统内存、PCIe 传输或量化误差 |
| 文本编码器缓存时显存不足 | MOSS 文本编码器换层、INT8 | 换层会使缓存变慢；量化会改变模型数值 |
| VAE 编码／预览解码时显存不足 | Anima 2D VAE、VAE batch、预览尺寸 | 编码吞吐或预览尺寸变化 |
| 已能稳定训练，还有显存余量 | 逐步增加跳过检查点的末尾块数 | 显存增加、重算减少 |

先跑通缓存、数个训练步和一次预览，再逐项调整。为最大 bucket 和预览留出约 1–2 GB 余量。LoRA 的优化器状态通常小于基础权重和激活，选择见[优化器说明](optimizers.zh-CN.md#optimizer-type)。

<!-- doc-anchor: partial-checkpointing -->
## 跳过检查点的末尾块数

`gradient_checkpointing_skip_blocks=N` 在开启梯度检查点后，让末尾 N 个主块保留激活，省去它们反向传播时的重算。N 越大，显存越高、通常越快。`0` 为全部主块使用检查点；Anima 为 `0–28`，MOSS 为 `0–42`，MOSS 的文本嵌入块仍使用检查点。

先从 `0` 跑通，再以少量块递增，比较稳定步时和峰值显存。上游在以下配置下观察到，增加跳过块数通常比增大 batch 更能利用剩余显存。[H2D-only 换块](#h2d-only)还要求跳过块数或换出块数至少一项不超过环形缓冲槽数。

### Anima：上游实测

约 1 MP 图片、batch 1、LoRA dim 16、bf16、Flash Attention、缓存 latent 和文本输出。峰值取训练时 `nvidia-smi` 读数；两张卡使用相同训练设置。

| 跳过块数 | PRO 6000 Blackwell 显存 | 步时 | RTX 4090 显存 | 步时 |
| --- | --- | --- | --- | --- |
| 0 | 6.5 GB | 0.85 s | 6.7 GB | 0.73 s |
| 7 | 9.4 GB | 0.75 s | 9.6 GB | 0.68 s |
| 14 | 12.9 GB | 0.73 s | 13.0 GB | 0.63 s |
| 21 | 16.4 GB | 0.59 s | 16.5 GB | 0.56 s |
| 28 | 19.9 GB | 0.53 s | 20.0 GB | 0.52 s |

这组 RTX 4090 数据从 `0` 到 `28`，步时约减少 29%，显存增加约 13.3 GB。本项目默认 rank 和注意力后端可能与实测不同。

来源：[Anima 上游优化指南（固定提交）](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md#71-vram-usage-optimization--vram使用量の最適化)。

### MOSS-Image：上游实测

RTX PRO 6000 Blackwell、约 1 MP 图片、batch 1、LoRA dim 16、Flash Attention、缓存 latent 和文本输出。INT8 一组同时开启 `compile`，步时取编译和 autotune 预热后；这两列同时改变了量化与编译，须作为整体配置比较。

| 跳过块数 | bf16 显存 | 步时 | ConvRot INT8 + compile 显存 | 步时 |
| --- | --- | --- | --- | --- |
| 0 | 13.5 GB | 1.29 s | 10.0 GB | 0.84 s |
| 11 | 23.4 GB | 1.21 s | 15.4 GB | 0.79 s |
| 21 | 33.6 GB | 1.13 s | 21.9 GB | 0.74 s |
| 32 | 44.9 GB | 1.02 s | 29.1 GB | 0.70 s |
| 42 | 55.0 GB | 0.93 s | 35.5 GB | 0.64 s |

上游对此表启动峰值的口径描述有冲突，表中保留原始数值；启动占用另看[分阶段实测](#memory-phases)。

RTX 4090、同样的图片／batch／rank／注意力设置，文本编码器使用 ConvRot INT8：

| DiT 配置 | 跳过块数 | 显存峰值 | 步时 |
| --- | --- | --- | --- |
| bf16 | 0 | 14.3 GB | 1.88 s |
| bf16 | 5 | 17.6 GB | 1.83 s |
| bf16 | 10 | 22.5 GB | 1.77 s |
| INT8 + compile | 0 | 10.0 GB | 1.00 s |
| INT8 + compile | 7 | 13.0 GB | 0.98 s |
| INT8 + compile | 14 | 17.5 GB | 0.94 s |
| INT8 + compile | 21 | 22.0 GB | 0.90 s |

来源：[MOSS 上游实测与完整条件（固定提交）](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化)。

<!-- doc-anchor: checkpointing -->
## 梯度检查点

`gradient_checkpointing` 减少为反向传播保留的中间激活，代价是重算。它主要影响训练阶段；模型加载或文本缓存时的显存不足要调整对应阶段的设置。显存紧张时先开启，再调 batch 和分辨率。

Anima / MOSS 的 H2D-only 换块要求开启检查点。显存有余量时，用[部分检查点与实测表](#partial-checkpointing)逐步减少重算。普通 CPU 激活卸载与 Unsloth 激活卸载见[激活卸载](#activation-offload)。

<!-- doc-anchor: block-swap -->
## 换块：用系统内存减少权重常驻

`blocks_to_swap` 把部分主块权重放在 CPU，需要时再传入 GPU。增加换出块数会降低权重常驻显存，同时增加系统内存和传输开销。Anima 最多 `26`，MOSS 最多 `40`；Krea 2 使用自身模型和界面上限，不套用这些数值。

Anima / MOSS 换块与普通 CPU、Unsloth 激活卸载互斥。优先在开启梯度检查点的基础上逐步增加换出块数，确认 RAM 仍有余量。换块时 `compile_fullgraph` 需关闭，编译的提速空间也可能变小。

可进一步比较 [H2D-only 换块](#h2d-only)。MOSS 的显存与 RAM 数值见[分阶段实测](#memory-phases)。

<!-- doc-anchor: h2d-only -->
## H2D-only、环形缓冲与锁页内存

Anima / MOSS 的 `block_swap_h2d_only` 为冻结基础权重的 CUDA 训练省去 GPU→CPU 权重回传，要求 `blocks_to_swap>0` 且开启梯度检查点。环形缓冲会额外占用显存：`block_swap_ring_size=2` 可让传输和计算重叠，`1` 更省显存但少了重叠。

同样的换出块数下，H2D-only 可能比传统换块多用显存。需要相近占用时，可增加换出块数或减少槽数，同时遵守界面上限。与部分检查点一起使用时，必须满足：**跳过块数 ≤ 槽数，或换出块数 ≤ 槽数**。

`use_pinned_memory_for_block_swap` 把 CPU 权重副本固定在锁页内存中，可能加快传输，但会增加 Windows 共享 GPU 内存和系统内存压力；只在 H2D-only 下生效。关闭时上游仍使用小型锁页暂存池。

上游 MOSS、RTX 3090、PCIe Gen3 x4、bf16、1024²、batch 1、换出 36 块：

| 换块方式 | 显存 | 步时 |
| --- | --- | --- |
| 传统换块 | 未单列 | 11.7 s |
| H2D-only + 锁页 | 约 7 GB | 9.4 s |

PCIe 带宽和功耗限制会影响速度。

来源：[上游换块指南（固定提交）](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/block_swap.md)。

<!-- doc-anchor: activation-offload -->
## 激活卸载

普通 CPU 卸载（`cpu_offload_checkpointing`）和 Unsloth 异步卸载（`unsloth_offload_checkpointing`）把检查点激活放到系统内存，降低训练显存、增加 RAM 与传输。适合在梯度检查点后仍受激活占用限制的情况。

Anima / MOSS 中两者互斥，也不能与 `blocks_to_swap>0` 并用。比较“换块”和“激活卸载”两套配置的显存、RAM 与稳定步时后再选择。Krea 2 的 `gradient_checkpointing_cpu_offload` 是独立训练引擎选项，遵循该训练类型的界面限制。

MOSS 的一个上游 INT8 配置中，Unsloth 卸载训练峰值为 `8.2 GB`，不卸载为 `9.1 GB`；完整测试条件见[分阶段实测](#memory-phases)。

<!-- doc-anchor: caching -->
## Latent 与文本输出缓存

`cache_latents` 复用 VAE 编码结果；`cache_text_encoder_outputs` 复用文本编码结果，允许训练阶段释放对应编码器。缓存到磁盘还能跨运行复用，并减少缓存常驻 RAM，但仍需存储空间和读取时间。

首次生成缓存仍需要运行 VAE／文本编码器。MOSS 的文本缓存阶段可单独使用[文本编码器换层](#text-encoder-swap)。

Latent 缓存与随机裁剪冲突。文本缓存要求冻结相应文本编码器，与标签打乱、标签级丢弃及 token 预热等动态文本处理存在限制，以当前训练类型的界面提示为准。修改图片、编码器权重、描述或相关预处理后，需重建受影响的缓存。

<!-- doc-anchor: text-encoder-swap -->
## MOSS 文本编码器换层

`text_encoder_blocks_to_swap` 在生成文本缓存时从 CPU 流式传入部分 Qwen3.5-9B 层，范围 `0–32`；`0` 关闭，`32` 全层流式传入。它降低文本缓存峰值，代价是 PCIe 传输与更多 RAM，要求文本编码器冻结。本项目 MOSS 界面保持文本编码器冻结。

上游单条约 2000 token 的文本缓存实测：

| 文本编码器 | 换层数 | GPU 分配峰值（PyTorch） |
| --- | --- | --- |
| bf16 | 28 | 5.1 GB |
| bf16 | 32 | 3.5 GB |
| ConvRot INT8 | 32 | 2.2 GB |

该口径不含完整驱动占用。上游另测了独立文本缓存工具、不换层的驱动显存峰值：

| 文本编码器 | GPU 峰值（nvidia-smi） |
| --- | --- |
| bf16 | 15.5 GB |
| ConvRot INT8 | 8.3 GB |

两张表的测试条件与读数口径不同。MOSS 的 `text_encoder_batch_size` 控制缓存时每批处理的描述数；编码器始终逐条运行，因此该设置主要影响循环批次。

来源：[MOSS 上游缓存实测](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#71-vram-usage-optimization--vram-使用量の最適化)。

<!-- doc-anchor: quantization -->
## MOSS ConvRot INT8

`convrot_int8` 量化冻结 DiT 主块的基础 Linear 权重，减少权重显存；LoRA 分支继续训练。`convrot_int8_text_encoder` 量化冻结文本编码器，上游模型大小约从 `15.9 GB` 降至 `7.4 GB`。已量化的 ConvRot 文件自动识别；原始 bf16 文件可以在加载时量化。

融合 INT8 核需要兼容当前 torch 的 Triton；没有 Triton 时会回退到临时反量化的 bf16 路径，仍可省权重显存，但可能更慢。`convrot_int8_bwd` 默认 `bf16`；`int8` 还量化输入梯度，上游在检查点配置下未测得明显步时收益，先保留默认。

量化会改变基础模型数值，需比较损失和检查点效果。MOSS 不支持 FP8；其他训练类型的 FP8、GGUF 等选项按各自后端使用。预合并基础 LoRA 与 MOSS ConvRot INT8 有限制，以界面校验为准。

带显存数据的组合见[分阶段实测](#memory-phases)，INT8 配合编译的速度见[部分检查点实测](#partial-checkpointing)。

<!-- doc-anchor: memory-phases -->
## 启动、训练与系统内存

上游 MOSS 实测：Windows、RTX PRO 6000 Blackwell、1024²、batch 1、LoRA dim 16、AdamW、梯度检查点、latent 磁盘缓存。下表仅训练 DiT、缓存文本输出；启动包含文本缓存，换块为传统方式。

| DiT / 文本编码器 | 附加设置 | 启动 GPU 峰值 | 训练 GPU 峰值 | CPU RAM 峰值 |
| --- | --- | --- | --- | --- |
| bf16 / bf16 | 无 | 15.3 GB | 13.2 GB | 17.2 GB |
| INT8 / INT8 | 无 | 9.1 GB | 9.1 GB | 9.9 GB |
| INT8 / INT8 | 换出 20 块 | 7.9 GB | 6.9 GB | 14.0 GB |
| INT8 / INT8 | 换出 36 块 | 7.9 GB | 5.2 GB | 15.6 GB |
| INT8 / INT8 | Unsloth 激活卸载 | 8.2 GB | 8.2 GB | 11.2 GB |
| bf16 / INT8 | 换出 20 块 | 9.0 GB | 9.0 GB | 18.5 GB |

上游还测了同时训练文本编码器的组合。本项目 MOSS 界面固定冻结文本编码器，以下两行用于对照训练范围的影响。

| DiT / 文本编码器 | 训练范围 | 启动 GPU 峰值 | 训练 GPU 峰值 | CPU RAM 峰值 |
| --- | --- | --- | --- | --- |
| INT8 / INT8 | DiT + 文本编码器 LoRA，无文本缓存 | 17.1 GB | 17.1 GB | 8.4 GB |
| bf16 / bf16 | DiT + 文本编码器 LoRA，无文本缓存 | 32.4 GB | 32.4 GB | 16.1 GB |

GPU 是含 CUDA 上下文的 `nvidia-smi` 峰值，CPU RAM 是进程工作集。Windows 提交内存可能高于工作集，上游 bf16 运行可达约 `38 GB`，需留意系统可用内存和页面文件。

8 GB 显卡即使训练只需约 5.2 GB，启动缓存也可能先超限。上游 8 GB 路径使用独立工具先缓存，并结合文本编码器换层；本界面的缓存开关不会自动把两阶段拆成独立进程。预览生成还有额外峰值，需要一起验证。

`lowram` 让更多模型常驻 GPU，减少系统 RAM 占用，但会增加显存占用。

来源：[MOSS 上游分阶段内存表](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値)。

<!-- doc-anchor: vae -->
## VAE 编码与解码

Anima 的 `qwen_image_vae_2d` 对单张图片使用等价 2D 路径，沿用相同 VAE 权重。上游 RTX 3090、10 张 1024² 图片的 VAE 编码实测：

| VAE 路径 | GPU 峰值 | 编码时间 |
| --- | --- | --- |
| 3D | 约 4.4 GB | 7.7 s |
| 2D | 约 1.4 GB | 4.5 s |

MOSS 上游还测了独立 latent 缓存工具：FP32 VAE、1024² 图片，GPU 峰值约 `3.2 GB`；与上面的 Anima 数据属于不同 VAE。

VAE 显存不足先降低 `vae_batch_size`。`vae_chunk_size` 是 Anima 空间分块；2D 路径的峰值往往由全分辨率中间激活和注意力决定，分块的节省可能有限。`vae_disable_cache` 针对 3D VAE 内部时间缓存，2D 路径无效。

SDXL 的 `no_half_vae` 使用 FP32 VAE，可缓解部分精度问题但增加占用。MOSS 使用 FLUX.2 VAE，Krea 2 使用自身 VAE 缓存／tiling 选项，不套用 Anima 2D VAE 数据。预览解码不足时也应降低预览分辨率。

来源：[Anima VAE 选项](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/anima_train_network.md)、[MOSS 缓存实测](https://github.com/kohya-ss/sd-scripts/blob/b8da8698a05ed26f647760c0a42481d8c825d7fe/docs/moss_image_train_network.md#measured-memory-usage--メモリ使用量の実測値)。

<!-- doc-anchor: batch-resolution -->
## Batch、分辨率与梯度累积

`train_batch_size` 决定单次处理的图片数，增大通常会增加激活显存。显存不足时先用 `1`，再以 `gradient_accumulation_steps` 保持所需的有效样本数；完整批次下约为 batch × 累积步数 × GPU 数。

累积把多次小 batch 的梯度合并为一次更新，不会让所有图片同时占用激活显存，但相同 epoch 下更新次数也会变化。比较速度时同时看每样本时间、更新数和训练效果。

`resolution` 与实际 bucket 决定图像 token 和激活规模，更高分辨率通常需要更多显存。最大 bucket、最长文本和额外训练范围均可能抬高峰值。

<!-- doc-anchor: precision-attention -->
## 精度与注意力后端

`mixed_precision` 控制部分计算精度；`full_bf16` 还把模型及可训练参数转换为 BF16，可能进一步省内存，但会降低参数精度，需确认当前优化器支持。保留训练类型默认值建立基准后再比较。

SDPA、Flash Attention、xformers 的实际占用与速度取决于硬件、依赖和输入长度。上游显存表使用 Flash Attention；本项目 `torch` / SDPA 默认值的结果可能不同。

`split_attn` 按样本分开处理注意力，可能减少变长文本 batch 的 padding；Anima / MOSS 使用 xformers 时会自动启用。它的收益取决于 batch 与描述长度，batch 1 时通常没有同等的 padding 节省。

<!-- doc-anchor: compile -->
## 编译与显存

Anima / MOSS 的 `compile` 编译各 DiT 块；首次运行需编译与 autotune，比较步时前先等待稳定。MOSS 上游 INT8 + compile 的检查点保留激活约为每跳过一块 `0.6 GB`，bf16 实测约 `1 GB`，具体条件见[部分检查点实测](#partial-checkpointing)。

编译也可能增加峰值或缓存占用，不保证所有配置都省显存。换块会限制可编译层，启用换块时关闭 `compile_fullgraph`。Krea 2 的编译路径独立，不直接使用上述 MOSS 数值。
