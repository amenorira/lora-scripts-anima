# 优化器机制与参数参考

优化器负责把梯度转换为参数更新。不同实现采用不同的状态统计方式、状态存储精度、步长来源、裁剪位置和调度机制。优化器不读取图片语义，也无法识别目标角色、错误标注或缺失视角。

本文只说明项目当前的实现和参数关系。切换优化器时，界面可能自动调整学习率、`betas`、`weight_decay` 和 scheduler；这些联动属于配置行为，不代表算法排名，也不能预判训练结果。

<!-- doc-anchor: quick-choice -->
## 机制维度速查

| 机制维度 | 对应实现 | 可观察影响 |
| --- | --- | --- |
| 一阶与二阶状态 | AdamW、StableAdamW、Prodigy | 梯度历史和梯度平方历史共同决定更新尺度 |
| 符号方向更新 | Lion 系列 | 更新方向由动量与当前梯度的混合结果取符号得到 |
| 因子化状态 | AdaFactor、CAME | 二维参数的平方梯度统计以行列因子保存 |
| 低位状态存储 | AdamW8bit、Lion8bit | 可量化的优化器状态以 8-bit 形式保存 |
| 分页状态 | PagedAdamW8bit、PagedLion8bit | 分页触发时，状态页在 CPU 与 GPU 之间传输 |
| 内部调度 | AdamWScheduleFree、ProdigyPlusScheduleFree | 参数平均与步长调度在优化器内部完成 |
| 项目实验状态 | Automagic3、EmoSens | 分别根据梯度符号历史或 loss 历史调整全局更新尺度 |

<!-- doc-anchor: optimizer-type -->
## 当前优化器

| 分组 | 优化器 | 更新机制 |
| --- | --- | --- |
| AdamW 与状态存储变体 | AdamW | 梯度与梯度平方的指数移动平均、自适应缩放、解耦权重衰减 |
| AdamW 与状态存储变体 | AdamW8bit | AdamW 更新，可量化状态使用 8-bit 存储 |
| AdamW 与状态存储变体 | PagedAdamW8bit | 8-bit AdamW 状态，并支持状态分页 |
| AdamW 与状态存储变体 | `pytorch_optimizer.StableAdamW` | AdamW 式状态、更新 RMS 裁剪和 Kahan 求和 |
| 符号更新 | Lion | 符号方向更新和一组动量状态 |
| 符号更新 | Lion8bit | Lion 更新，可量化动量状态使用 8-bit 存储 |
| 符号更新 | PagedLion8bit | 8-bit Lion 状态，并支持状态分页 |
| 因子化状态 | AdaFactor | 因子化平方梯度统计和可选相对步长 |
| 因子化状态 | CAME | 因子化状态、残差置信度估计和内部 RMS 裁剪 |
| 步长估计与内部调度 | Prodigy | D-adaptation 步长估计 |
| 步长估计与内部调度 | ProdigyPlusScheduleFree | D-adaptation 与 Schedule-Free 参数序列 |
| 步长估计与内部调度 | AdamWScheduleFree | AdamW 式状态与 Schedule-Free 参数序列 |
| 项目实验实现 | Automagic3 | 梯度符号历史、参数组学习率适应和内部裁剪 |
| 项目实验实现 | EmoSens | loss 移动平均、全局学习率倍率和停止信号 |

8-bit 与分页描述的都是优化器状态。训练峰值显存还包括模型参数、激活、缓存、梯度和采样过程。

<!-- doc-anchor: stable-comparison -->
## AdamW8bit、CAME 与 StableAdamW

| 实现 | 状态与更新 | 额外行为 |
| --- | --- | --- |
| AdamW8bit | 一阶、二阶 AdamW 状态；可量化状态以 8-bit 保存 | `percentile_clipping` 在 bitsandbytes 优化器内部处理近期梯度范数 |
| CAME | 因子化二阶状态、一阶更新状态、残差平方置信度状态 | 置信度缩放和内部更新 RMS 裁剪 |
| StableAdamW | 完整 AdamW 式一阶、二阶状态 | 更新 RMS 裁剪；Kahan 求和补偿低精度参数累加误差 |

三者都只处理数值更新。图片质量、主体身份、服装标签和构图重复不会由优化器自动分类。

<!-- doc-anchor: parameters -->
## 参数说明

<!-- doc-anchor: learning-rate -->
### 学习率

学习率控制每一步参数更新的整体尺度。AdamW、Lion、CAME 和 StableAdamW 将其作为外部步长。AdaFactor 在 `relative_step=true` 时根据训练进度生成步长；Prodigy 系列将输入学习率与 D-adaptation 估计的尺度结合；Automagic3 与 EmoSens 还会在内部生成动态倍率。

项目当前使用的自动值如下。只有满足相应联动条件时，界面才会写入这些数值；手动设置和导入值继续沿用现有的来源规则：

| 训练配置 | 选择值 | 自动学习率 |
| --- | --- | ---: |
| Anima | AdamW / AdamW8bit / PagedAdamW8bit / StableAdamW | `2e-5` |
| Anima | Lion / Lion8bit / PagedLion8bit | `5e-6` |
| Anima | CAME | `1.5e-5` |
| Anima | AdamWScheduleFree | `1e-4` |
| Anima | AdaFactor 且 `relative_step=false` | `2e-5` |
| Anima | EmoSens | `0.1` |
| 通用 sd-scripts | Prodigy / ProdigyPlusScheduleFree | `1.0` |
| 通用 sd-scripts | Automagic3 | `1e-4` |
| SDXL | CAME / StableAdamW | `1e-4` |
| SDXL | Lion 系列 | `2e-5` |
| SDXL | AdamWScheduleFree | `3e-4` |

`network_alpha / network_dim` 会缩放 LoRA 分支，因此相同优化器学习率在不同 alpha/dim 组合下不代表相同的 LoRA 分支尺度。

<!-- doc-anchor: scheduler-warmup -->
### 外部 scheduler 与 warmup

AdamW、8-bit/Paged AdamW、StableAdamW、Lion、CAME 和手动步长 AdaFactor 使用外部 scheduler，`lr_warmup_steps` 也由该 scheduler 处理。`cosine_with_restarts` 只有在 `num_cycles` 大于 1 时才会在一次训练中产生多个周期；`num_cycles=1` 不会中途重启。

AdamWScheduleFree 与 ProdigyPlusScheduleFree 在优化器内部管理参数平均和调度，因此外部 scheduler 固定为 `constant`，`lr_warmup_steps` 也不参与训练。AdaFactor 在 `relative_step=true` 时同样由优化器生成步长，外部 scheduler 不参与训练。

<!-- doc-anchor: betas -->
### 指数移动平均衰减系数（betas）

数值越大，历史状态保留比例越高，当前观测在本次状态更新中的占比越低。

| 优化器机制 | 输入数量 | 各项语义 |
| --- | ---: | --- |
| AdamW、8-bit/Paged AdamW、StableAdamW、EmoSens | 2 | `β1` 控制梯度移动平均，`β2` 控制梯度平方移动平均 |
| Lion 系列 | 2 | `β1` 控制当前符号方向使用的历史动量与当前梯度混合，`β2` 控制供后续步骤使用的动量状态 |
| CAME | 3 | `β1` 控制归一化更新的一阶状态，`β2` 控制梯度平方统计，`β3` 控制归一化更新与一阶状态之间的残差平方统计，并参与置信度缩放 |
| Prodigy | 2 | `β1` 与 `β2` 分别控制一阶、二阶状态；D-adaptation 的额外衰减不属于该输入 |
| AdamWScheduleFree、ProdigyPlusScheduleFree | 2 | `β1` 参与当前参数与平均参数序列的组合，`β2` 控制平方梯度统计 |

界面根据所选优化器显示对应解释，并按实现校验输入数量。

<!-- doc-anchor: eps -->
### 数值稳定项（eps）

`eps` 加到自适应缩放分母或相关统计量中，限制分母接近零时的数值放大。它影响数值计算下限，不直接控制图片内容或正则化强度。AdaFactor 使用独立的两项 `eps` 输入。

<!-- doc-anchor: weight-decay -->
### 权重衰减

权重衰减使参数在更新过程中产生收缩。AdamW 式解耦衰减在梯度更新之外应用；耦合衰减会进入梯度相关计算。`weight_decay=0` 时不产生衰减。

CAME 的界面字段 `came_weight_decouple` 会映射为实际参数 `weight_decouple`，用于选择是否采用解耦形式。界面字段 `came_fixed_decay` 会映射为 CAME 的实际参数 `fixed_decay`，并且只在解耦衰减开启时参与计算。StableAdamW 的 `weight_decouple` 也用于选择相同的衰减形式。

<!-- doc-anchor: gradient-clipping -->
### 最大梯度范数

`max_grad_norm` 会在优化器更新前按全局梯度范数缩放梯度，`0` 表示不执行这项全局裁剪。CAME、AdaFactor、StableAdamW 和 bitsandbytes 还可以在内部裁剪更新值或统计量；同时启用多种裁剪时，它们会作用于计算链中的不同位置。

<!-- doc-anchor: percentile-clipping -->
### 百分位裁剪

`percentile_clipping` 只由 AdamW8bit、PagedAdamW8bit、Lion8bit 和 PagedLion8bit 消费。bitsandbytes 根据近期梯度范数的分布限制当前梯度范数；`100` 表示不进行该百分位裁剪。阈值降低会使更多位于近期分布上端的梯度受到缩放。

<!-- doc-anchor: min-8bit-size -->
### 8-bit 状态最小张量尺寸

`min_8bit_size` 是 bitsandbytes 进行状态量化的张量元素数量门槛。小于门槛的张量保留 FP32 优化器状态。门槛增大时，更多小张量保留 FP32 状态，并增加相应状态显存；该参数不改变模型权重的数据类型。

<!-- doc-anchor: stableadamw-options -->
### StableAdamW 专用参数

`kahan_sum=true` 为参数更新维护补偿项，减少 FP16/BF16 可训练参数累加小更新时的舍入损失。仅设置 `mixed_precision=bf16` 时，sd-scripts 的 LoRA 可训练参数仍可保持 FP32；`full_bf16` 会改变可训练参数精度，因此 Kahan 补偿的作用范围随参数实际 dtype 变化。

`weight_decouple=true` 使用 AdamW 式解耦权重衰减。`weight_decay=0` 时，衰减分支不改变参数。

<!-- doc-anchor: came-clipping -->
### CAME 内部裁剪

`came_clip_threshold` 对 CAME 归一化更新的 RMS 进行裁剪。它发生在 CAME 内部更新构造过程中，与更新前的全局 `max_grad_norm` 不是同一计算。

`came_fixed_decay` 只在 CAME 且 `came_weight_decouple=true` 时显示和输出。它是界面字段，生成的 CAME 优化器参数使用实际名称 `fixed_decay`。启用固定衰减后，衰减量不再按当前学习率缩放。

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free 内部 warmup

`schedulefree_warmup_steps` 属于 AdamWScheduleFree 构造参数，并在优化器内部改变早期步长。它不传给 ProdigyPlusScheduleFree，也不等同于外部 `lr_warmup_steps`。

<!-- doc-anchor: stochastic-rounding -->
### 随机舍入

ProdigyPlusScheduleFree 的随机舍入在低精度写回时按被舍弃部分的概率选择相邻可表示值，以减少长期固定方向的舍入偏差。该过程只作用于数值写回，不改变样本或 caption。

<!-- doc-anchor: loraplus -->
### LoRA+

LoRA+ 为 LoRA 不同矩阵分量设置不同的有效学习率。AdamW、8-bit/Paged AdamW、StableAdamW、Lion、CAME 和 AdamWScheduleFree 可接收 LoRA+ 参数。Prodigy、ProdigyPlusScheduleFree 和 EmoSens 不接收；AdaFactor 在 `relative_step=false` 时接收。

<!-- doc-anchor: scenarios -->
## 数据集情形与能力边界

<!-- doc-anchor: one-image -->
### 单张图片

所有优化器都会反复接收同一张图片提供的证据。更换状态统计方式不会生成缺失的视角、表情或构图变化；训练步数、重复次数和学习率决定同一证据的累积强度。

<!-- doc-anchor: few-shot -->
### 少量图片

样本较少时，单个 batch 在总更新中的占比更高。裁剪机制可以改变异常数值更新的幅度，但无法判断该 batch 包含的是有效的稀有特征还是错误数据。

<!-- doc-anchor: galgame -->
### Galgame 立绘

固定站姿、背景和裁切会作为重复证据进入梯度。优化器只处理这些梯度的数值历史，不区分人物身份和共同构图。

<!-- doc-anchor: dmm-mixed -->
### DMM 卡面与混合来源

卡面、截图、立绘和特效图可能产生不同的梯度尺度。CAME 的置信度状态、StableAdamW 的更新 RMS 裁剪和 bitsandbytes 百分位裁剪会以不同位置处理数值波动，但都不读取来源类别。

<!-- doc-anchor: mixed-quality -->
### 质量差异

模糊、压缩、重复裁剪和连续帧都会改变训练信号。优化器不会自动降低这些图片的采样权重；数据分组、caption 和 repeats 决定它们参与训练的频率和条件。

<!-- doc-anchor: outfits-forms -->
### 多服装与多形态

服装或形态的绑定来自样本共现与 caption 条件。优化器会改变更新轨迹，但不会建立缺失的标签边界。

<!-- doc-anchor: style-lora -->
### 风格 LoRA

题材覆盖和内容/风格标注决定风格信号与主体信号是否分离。内部裁剪会同时作用于异常更新和数值较大的稀有风格更新。

<!-- doc-anchor: vram -->
### 优化器状态显存

8-bit 状态降低可量化状态的存储位宽。Paged 变体在 GPU 内存压力触发分页时把状态页移至 CPU，并产生 CPU/GPU 传输。AdaFactor 与 CAME 通过二维状态因子化减少对应参数的二阶状态规模。

<!-- doc-anchor: starting-configs -->
## 自动联动与硬性关系

| 条件 | 配置结果 | 原因 |
| --- | --- | --- |
| AdamWScheduleFree / ProdigyPlusScheduleFree | 外部 scheduler 为 `constant`，外部 warmup 为 `0` | 调度由优化器内部管理 |
| AdaFactor 且 `relative_step=true` | 外部 scheduler 不参与，LoRA+ 不输出 | 步长由 AdaFactor 内部生成 |
| Prodigy / ProdigyPlusScheduleFree | 基础学习率自动值为 `1.0` | 输入学习率参与 D-adaptation 尺度计算 |
| CAME 且界面字段 `came_weight_decouple=false` | `came_fixed_decay` 不显示且不输出 | 实际参数 `fixed_decay` 只属于解耦衰减分支 |
| 8-bit/Paged bitsandbytes 优化器 | 显示 `percentile_clipping` 与 `min_8bit_size` | 两项由 bitsandbytes 状态实现消费 |
| 内部 scheduler 优化器 | 外部 scheduler 控件只反映硬性配置 | 外部 scheduler 不参与参数更新 |

<!-- doc-anchor: troubleshooting -->
## 现象与可观测量

| 现象 | 能区分问题来源的观测 | 优化器相关机制 |
| --- | --- | --- |
| 孤立梯度峰值 | 对应批次、梯度范数、裁剪前后范数 | 全局裁剪、百分位裁剪、更新 RMS 裁剪 |
| NaN / Inf | 首次出现步骤、参数 dtype、VAE 输出、学习率与恢复状态 | `eps` 与内部稳定项只覆盖各自分母，不修复无效输入 |
| GPU 内存不足 | 参数、激活、梯度、优化器状态各自占用 | 8-bit 状态、因子化状态、Paged 状态 |
| loss 平稳但预览不符合目标 | 固定提示词下的多个 checkpoint、caption 与样本共现 | 优化器只处理梯度，loss 不包含完整的主观生成目标 |
| 训练结果很快固化 | 有效步数、repeats、学习率、重复样本 | 状态历史和步长共同决定更新累积速度 |

<!-- doc-anchor: ab-testing -->
## 可归因对照条件

只有数据集、caption、底模、随机种子、rank/alpha、batch size、梯度累积、总优化器步数和预览条件保持一致，结果差异才可能归因于优化器相关变量。如果优化器与学习率同时变化，对照反映的是整套配置的差异。

不同优化器的状态结构不等价。从另一优化器保存的状态继续训练会同时改变初始动量、二阶统计和步长状态。Prodigy 等内部估计步长的实现还会引入独立的历史尺度。

<!-- doc-anchor: limits -->
## 能力范围

- 优化器不识别图片质量、角色身份、服装类别、文字水印或伙伴角色。
- 裁剪按数值幅度工作，无法判断大更新来自异常数据还是有效稀有特征。
- Paged 变体改变状态内存位置，不提供独立的图像质量目标。
- 内部 scheduler 改变参数序列与步长历史，外部 scheduler 在这些实现中不参与。
- loss 是训练目标的聚合数值，不等同于人物还原、风格泛化或提示词响应。

<!-- doc-anchor: evidence -->
## 实现依据与参考资料

事实核查日期：**2026-07-31**。项目行为以本仓库字段元数据、适配器和锁定版本的上游实现为准。

本项目通过 sd-scripts 的完整类路径加载 `pytorch_optimizer.StableAdamW`。已安装的 `pytorch-optimizer 3.10.0` 构造器包含 `betas=(0.9,0.99)`、`eps=1e-8`、`weight_decay=0.01`、`weight_decouple=true` 和 `kahan_sum=true`；项目生成配置会按界面值覆盖构造器值。

参考资料：

- [Anima 模型卡（固定版本）](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [sd-scripts Anima 训练文档（固定版本）](https://github.com/kohya-ss/sd-scripts/blob/37a1cbbc5725ed2a3575506e7bd2001c9908ac92/docs/anima_train_network.md)
- [CAME 官方实现（固定版本）](https://github.com/yangluo7/CAME/tree/e77c5c022eaf71f1efb82a1433032cdcd5c52610)
- [Lion 官方实现（固定版本）](https://github.com/google/automl/tree/6a54c8741e7c3265d4547c4f35f47a0391122dc5/lion)
- [Schedule-Free 官方实现（固定版本）](https://github.com/facebookresearch/schedule_free/tree/70785b53e778d0e872c0bbb75ff4ee54ee10c291)
- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [pytorch-optimizer 实现（固定版本）](https://github.com/kozistr/pytorch_optimizer/tree/3d08fa02cb6617d4d12365ca0f7d643b72e8cbe8)
- [bitsandbytes 实现（固定版本）](https://github.com/bitsandbytes-foundation/bitsandbytes/tree/a2b90e6eae31a958e6b4d85edf2cfb2b91e9ce29)
