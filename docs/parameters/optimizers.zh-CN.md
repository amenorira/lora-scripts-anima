# 优化器选择与参数指南

> 对于大多数 Anima / SDXL LoRA 训练，建议先使用 **AdamW8bit** 建立基准。基准训练稳定时，通常无需更换优化器。
>
> 数据来源和质量差异较大时，可对比 **CAME**；日志中存在可复现的梯度尖峰，或 LoRA 可训练参数使用 FP16/BF16 时，可对比 **StableAdamW**。

优化器会影响收敛速度、显存占用和数值稳定性，但通常不是人物还原度的首要决定因素。少图人物训练出现问题时，应先检查数据、标注、重复次数、学习率和停止时机。

本文把“实现/论文事实”和“Anima 工程起点”分开：CAME、Lion、Schedule-Free 的论文或库默认值并不是 Anima LoRA 最优值。Anima 官方模型卡给出的基线是使用 **Anima-Base**、不训练 LLM Adapter、rank 32，并从 `2e-5` 附近开始轻微调整；本训练器的 Anima 默认 `rank=32, alpha=32` 与此基线配套。

<!-- doc-anchor: quick-choice -->
## 快速选择

| 训练情况 | 建议起点 | 说明 |
| --- | --- | --- |
| 首次训练，或没有明确的稳定性问题 | AdamW8bit | 参数习惯成熟、状态显存较低，便于与常见配置比较 |
| DMM 卡面、立绘、截图、特效图混合 | 先使用 AdamW8bit，再对比 CAME | CAME 的内部裁剪可能改善更新稳定性，但不会识别低质量图片 |
| 出现明显且可复现的损失值（loss）或梯度尖峰 | 排查异常图片和学习率后，对比 StableAdamW | StableAdamW 主要解决更新稳定性，不代表必然提高画质 |
| LoRA 可训练参数使用 FP16/BF16 | StableAdamW | `kahan_sum` 主要在低精度参数更新中发挥作用 |
| 优化器状态显存不足 | AdamW8bit；仍有内存压力时使用 PagedAdamW8bit | Paged 版本改变内存调度方式；发生 CPU/GPU 数据交换时可能降低训练速度 |
| 减少绝对学习率调参 | Prodigy | 项目要求基础学习率为 `1.0` |

少图人物训练可优先比较 **AdamW8bit、CAME、StableAdamW**。对照时应一次只修改一个主要变量，避免无法判断差异来源。

<!-- doc-anchor: optimizer-type -->
## 当前可用优化器

| 优化器 | 主要用途 | 限制与注意事项 |
| --- | --- | --- |
| AdamW | 标准 AdamW 基准 | 优化器状态显存比 8-bit 版本高 |
| AdamW8bit | 通用默认选择 | 小张量默认仍会保留 FP32 状态，这是正常行为 |
| PagedAdamW8bit | 常规 8-bit 优化器仍无法满足显存需求时 | 与 AdamW8bit 的主要区别是分页；发生 CPU/GPU 数据交换时可能降低训练速度 |
| StableAdamW | 梯度尖峰、低精度 LoRA 参数 | 状态显存通常高于 AdamW8bit；不能防止过拟合 |
| Lion | 测试符号动量优化器 | 合理学习率范围与 AdamW 不同，需要重新调整 |
| Lion8bit | 降低 Lion 的状态显存 | 需要独立调整学习率 |
| PagedLion8bit | Lion8bit 同时需要分页时 | 分页本身不改善生成质量，并可能降低训练速度 |
| Prodigy | 由优化器估计更新尺度 | 基础学习率使用 `1.0`；本项目不支持搭配 LoRA+ |
| ProdigyPlusScheduleFree | 测试内部调度和组合功能 | 外部 scheduler 和 warmup 不生效，少图短训练中的收益不确定 |
| Automagic3 | 项目实验性自适应方案 | 建议在具备明确基准时进行测试 |
| AdaFactor | 优化器状态显存紧张 | relative step 模式会接管学习率，并限制 LoRA+ |
| CAME | 混合来源数据、更新尺度波动较大时进行对照 | 使用三个 beta 和内部 RMS 裁剪；不具备图片质量判断能力 |
| AdamWScheduleFree | 测试不使用外部 scheduler 的 AdamW | 使用内部 warmup；短训练不建议作为第一选择 |
| EmoSens | 项目实验性优化器 | 要求梯度累积为 1，不支持 LoRA+ |

表中的显存说明仅指优化器状态。实际峰值还受分辨率、rank、batch、缓存和预览生成影响。

<!-- doc-anchor: stable-comparison -->
## AdamW8bit、CAME、StableAdamW 的区别

**AdamW8bit** 适合作为基准。它的状态显存较低，使用经验较多，也便于区分学习率、训练步数和数据问题。没有明确的稳定性或显存问题时，可优先使用。

**CAME** 使用因子化状态和内部 RMS 裁剪。卡面、截图、立绘的画质和构图差异较大时，它可作为 AdamW8bit 的对照方案。CAME 处理的是参数更新，不会判断图片质量；伙伴角色、文字、特效和错误标注仍需在数据处理中解决。

**StableAdamW** 会限制异常大的参数更新，并支持常规学习率调度器、预热、`max_grad_norm` 和 LoRA+。Anima 建议先沿用 AdamW 基线：`lr=2e-5`、`betas=(0.9, 0.99)`、`eps=1e-8`、`weight_decay=0`。SDXL 的界面起点仍为 `1e-4`。它不是 8-bit 优化器，因此优化器状态占用通常高于 AdamW8bit。

如果基准训练的曲线和预览均正常，StableAdamW 的额外收益可能较小。它的主要用途是改善更新稳定性。

<!-- doc-anchor: parameters -->
## 参数说明

<!-- doc-anchor: learning-rate -->
### 学习率（learning rate）

Anima 在默认 `rank=32, alpha=32`、只训练 DiT 主干时，可从以下值开始：

| 优化器 | Anima 自动起点 | 依据与含义 |
| --- | ---: | --- |
| AdamW / AdamW8bit / PagedAdamW8bit | `2e-5` | Anima 官方模型卡的 rank 32 基线；8-bit 与分页不改变 LR 语义 |
| StableAdamW | `2e-5` | 先与 AdamW 使用相同尺度，单独比较稳定化更新 |
| CAME | `1.5e-5` | CAME 官方建议通常使用 AdamW 的 `0.5`～`0.9` 倍；这是迁移起点，不是 Anima 实测最优值 |
| Lion / Lion8bit / PagedLion8bit | `5e-6` | Lion 官方建议 LR 比 AdamW 小约 `3`～`10` 倍 |
| AdamWScheduleFree | `1e-4` | 官方建议常比基准优化器高 `1`～`10` 倍；Anima 缺少充分验证，按实验方案使用 |
| Prodigy / ProdigyPlus | `1.0` | D-adaptation 缩放基准，不能与 `2e-5` 直接比较 |
| AdaFactor relative step | 由优化器接管 | 关闭 relative step 后，Anima 手动模式从 `2e-5` 开始 |
| Automagic3 / EmoSens | `1e-4` / `0.1` | 算法内部动态 LR 的基准值，不是普通固定 LR |

SDXL 保留独立的通用起点：AdamW/StableAdamW 为 `1e-4`、CAME 为 `1e-4`、Lion 为 `2e-5`、AdamWScheduleFree 为 `3e-4`。切换模型类型或优化器时，界面只会替换尚未手动修改的推荐值；导入配置和自定义值保持原样。

`network_alpha / network_dim` 会缩放 LoRA 分支。上游 `sd-scripts` 的 `1e-4` 示例对应 `alpha=1`，并明确说明提高 alpha 时应重新降低/验证 LR；因此不能把该示例直接套到本项目默认的 `rank=32, alpha=32`。

人物过早出现构图僵化、串色或提示词响应下降时，可降低学习率或减少训练步数。学习不足时，应先确认触发词和有效训练步数，再小幅提高学习率。Lion 的合理学习率范围与 AdamW 不同，需要单独测试。

<!-- doc-anchor: scheduler-warmup -->
### 学习率调度器与预热（scheduler 和 warmup）

AdamW、AdamW8bit、StableAdamW、Lion、CAME 都使用外部学习率调度器。Anima 新配置默认使用 `constant`，与上游 Anima 示例一致，也避免 `cosine_with_restarts` 在短训练中重新抬高 LR。已有手动配置可以继续使用；要测试预热时，可改为 `constant_with_warmup`，并先控制在总优化器步数的 `5%` 以内。

AdamWScheduleFree 和 ProdigyPlusScheduleFree 自己管理调度，所以界面会把外部调度器固定为 constant。两者的内部预热不能和 `lr_warmup_steps` 混为一谈。

<!-- doc-anchor: betas -->
### 动量参数（betas）

没有明确调整依据时，应保留默认值：

- AdamW 系列：通常是 `0.9, 0.999`
- StableAdamW、Lion：通常是 `0.9, 0.99`
- CAME：需要三个 beta

beta 越高，更新通常越平滑，但对新梯度的响应也更慢。常规调优应优先调整学习率，而不是 beta。

<!-- doc-anchor: eps -->
### 数值稳定项（eps）

`eps` 用来避免分母过小导致数值放大。StableAdamW 默认 `1e-8`。没有可复现的数值问题时，不建议改。

<!-- doc-anchor: weight-decay -->
### 权重衰减（weight decay）

对于本文重点介绍的优化器，本训练器提供以下起点：AdamW、AdamW8bit 和 PagedAdamW8bit 为 `0.01`；CAME 与 StableAdamW 为 `0`。这些值用于建立可复现的基准，不表示 `0.01` 一定优于 `0`。

人物 LoRA 容量有限，不宜在没有对照结果时使用较大的权重衰减。若要为 AdamW8bit 测试 `weight_decay=0`，应将其视为单独的参数实验，并保持数据、步数和其他设置不变。

StableAdamW 库默认 `weight_decay=0.01`，本训练器会明确输出 `weight_decay=0` 进行覆盖。这是有意设置，并非参数缺失。

<!-- doc-anchor: gradient-clipping -->
### 最大梯度范数（max gradient norm）

`max_grad_norm=1` 是常用起点，`0` 表示关闭。StableAdamW 可以正常搭配这个参数。

如果同时使用 `percentile_clipping=95` 和较低的 `max_grad_norm`，同一次更新可能受到两层裁剪。没有日志依据时，建议只保留一种温和裁剪。

<!-- doc-anchor: percentile-clipping -->
### 百分位裁剪（percentile clipping）

只对 AdamW8bit、PagedAdamW8bit、Lion8bit、PagedLion8bit 生效。

- `100`：关闭，也是默认值
- `99`：较温和的实验对照值
- `95`：较强的实验对照值，仅在确认存在异常梯度后考虑

`99` 和 `95` 是工程测试起点，并非经过 Anima LoRA 实验证实的最优值。该功能依据近期梯度范数工作，不会判断图片质量。设得太强，少见服装、表情和构图带来的有效更新也可能一起被削弱。

<!-- doc-anchor: min-8bit-size -->
### 8-bit 状态最小张量尺寸（minimum 8-bit tensor size）

默认 `4096`。小于这个规模的张量会使用 FP32 优化器状态。

低 rank 训练出现疑似小张量数值问题时，可测试 `16384`。更多 LoRA 张量会保留 FP32 状态，同时略微增加显存占用。此参数不会改变模型参数本身的精度。

<!-- doc-anchor: stableadamw-options -->
### StableAdamW 专用参数

`kahan_sum=True` 使用补偿求和减少低精度更新的舍入误差。其作用主要体现在 LoRA 可训练参数本身为 FP16/BF16 时。本项目仅选择 `mixed_precision=bf16` 时，LoRA 可训练参数仍保持 FP32；开启 `full_bf16` 才会将 LoRA 参数也转为 BF16。因此，未使用 `full_bf16` 时，Kahan 求和通常不会带来明显差异。

`weight_decouple=True` 表示使用 AdamW 式解耦权重衰减。`weight_decay=0` 时此开关不改变计算结果，建议保持开启。

<!-- doc-anchor: came-clipping -->
### CAME 内部裁剪

`came_clip_threshold` 裁剪 CAME 内部更新的均方根（RMS），默认 `1.0`。它和全局 `max_grad_norm` 不是同一个参数。应先保留默认值，只有固定条件下反复出现尖峰时再调整。

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free 预热（warmup）

AdamWScheduleFree 使用内部 `warmup_steps`，外部 `lr_warmup_steps` 会被关闭。少图训练的总步数较少，过长的 warmup 会减少有效学习阶段。

<!-- doc-anchor: stochastic-rounding -->
### 随机舍入（stochastic rounding）

随机舍入用于减少低精度更新长期朝同一方向取整造成的误差。ProdigyPlus 沿用库默认行为，本项目不另外加开关。它是数值处理，不是数据增强。

<!-- doc-anchor: loraplus -->
### LoRA+

AdamW、8-bit AdamW、StableAdamW、Lion、CAME、AdamWScheduleFree 可以使用 LoRA+。Prodigy、ProdigyPlus、EmoSens 不支持；AdaFactor 需要先关闭 relative step。

切换优化器后，应重新评估 LoRA+ 倍率。倍率改变的是部分 LoRA 参数的有效学习率，不提供独立的画质收益。

<!-- doc-anchor: scenarios -->
## 按数据集选择

<!-- doc-anchor: one-image -->
### 只有一张立绘

Anima 用 AdamW8bit 从 `1e-5`～`2e-5` 开始，并增加训练检查点（checkpoint）的保存频率。SDXL 可继续按其独立基线调整。这个场景最大的风险是把姿势和构图一起记住；StableAdamW 只能处理更新尖峰，不能补出侧面、背面或新表情。

<!-- doc-anchor: few-shot -->
### 2～5 张少图人物

建议先完成 AdamW8bit 基准训练。图片来源和质量差异明显时，可在相同步数下比较 CAME；日志存在尖峰时，再比较 StableAdamW。复杂的内部调度在短训练中可能没有足够步数体现效果。

<!-- doc-anchor: galgame -->
### Galgame 多表情立绘

这类数据构图很固定，AdamW8bit 通常够用。比更换优化器更重要的是正确标注表情，并避免固定背景、站姿被学进人物身份。表情数量很不均衡时，可以增加一组 CAME 对照。

<!-- doc-anchor: dmm-mixed -->
### DMM 卡面、特效、伙伴角色混合

应先标注或移除伙伴角色、文字、水印、特效和不同形态，再比较 AdamW8bit 与 CAME。训练日志仍存在稳定性问题时，可增加 StableAdamW 对照。优化器无法识别哪一名角色是训练目标。

<!-- doc-anchor: mixed-quality -->
### 图片质量参差

应先处理模糊图、压缩截图、重复裁剪和 Live2D 连续帧。必须保留的图片可通过标注（caption）、分组和重复次数控制。可对比 CAME，或在 8-bit 优化器中先测试 `percentile_clipping=99`；不建议直接使用 `95`。

<!-- doc-anchor: outfits-forms -->
### 多服装、多形态

此场景更依赖准确的服装/形态标签和合理的分组采样。AdamW8bit、CAME、StableAdamW 均可使用。评估时应检查服装控制、身份保持和形态串色，而非仅比较单张预览的锐度。

<!-- doc-anchor: style-lora -->
### 风格 LoRA

仍然从 AdamW8bit 开始。风格能否泛化，主要取决于题材覆盖，以及标注是否将内容与风格分开。StableAdamW 可以减轻异常批次（batch）的影响，但过强的裁剪也可能削弱少见的风格特征。

<!-- doc-anchor: vram -->
### 显存紧张

建议先使用 AdamW8bit 或 Lion8bit，仅在确认存在内存压力时改用 Paged 版本。分页实际触发时，CPU 与 GPU 之间的状态传输可能降低训练速度。`min_8bit_size` 建议保留 `4096`，避免为少量状态显存而量化更多小张量。

<!-- doc-anchor: starting-configs -->
## 保守起始配置

| 用途 | 优化器与参数 | 其他设置 |
| --- | --- | --- |
| Anima 通用基准 | AdamW8bit，`lr=2e-5`，`weight_decay=0.01` | constant，`max_grad_norm=1`，rank/alpha=32，只训练 DiT |
| Anima 混合来源对照 | CAME，`lr=1.5e-5`；其余保持默认 | constant，`max_grad_norm=1`；结果需用固定条件验证 |
| Anima 梯度尖峰对照 | StableAdamW，`lr=2e-5`，`betas=(0.9,0.99)`，`eps=1e-8`，`weight_decay=0` | Kahan 开启，constant，`max_grad_norm=1` |
| Anima Lion 实验 | Lion / Lion8bit，`lr=5e-6`，`betas=(0.9,0.99)` | constant；不要沿用 AdamW 的 LR |
| 温和的 8-bit 裁剪 | AdamW8bit，沿用基准参数，`percentile_clipping=99` | 保持其他参数不变 |

出现过拟合时，优先减少训练步数、重复次数（repeats）或学习率；学习不足时，先检查触发词和有效步数；曲线出现尖峰时，先定位对应批次，再考虑裁剪或 StableAdamW。

<!-- doc-anchor: troubleshooting -->
## 按现象排查

| 现象 | 优先检查 | 可考虑的优化器调整 |
| --- | --- | --- |
| 损失值平稳，但预览质量差 | 数据、标注、预览提示词、检查点时机 | 通常不应先更换优化器 |
| 孤立且可复现的损失值或梯度尖峰 | 对应批次、异常图片、学习率 | 对比 StableAdamW，或单独测试 `percentile_clipping=99` |
| 出现 NaN / Inf | 立即停止；检查学习率、精度设置、异常数据和恢复点 | 排除配置或数据问题后再比较 StableAdamW；不要用裁剪掩盖持续性错误 |
| 优化器状态导致显存不足 | 确认峰值来自优化器状态，而非分辨率、batch 或预览 | 先用 8-bit；仍不足时再用 Paged 版本 |
| 很快记住姿势、背景或服装 | 步数、repeats、学习率、数据重复 | 降低学习率或缩短训练；换优化器通常不能解决 |
| 人物特征长期学不进去 | 触发词、caption、有效步数、rank 和训练目标 | 确认上述项目后，再小幅提高学习率 |

<!-- doc-anchor: ab-testing -->
## 怎么做有效的 A/B

1. 固定数据集、标注（caption）、随机种子（seed）、底模、rank/alpha、批次大小和总步数。
2. 固定预览提示词、采样参数和生成随机种子。
3. Anima 配方对照可先使用 AdamW8bit `2e-5`、StableAdamW `2e-5`、CAME `1.5e-5`、Lion `5e-6`。这比较的是各优化器的合理起始配方；若要单独隔离算法差异，应另做相同 LR 的实验。
4. 比较相同步数的训练检查点，同时记录梯度范数、峰值显存和训练时间。
5. 不应仅比较损失值；还需评估人物还原、服装控制、背景或姿势绑定以及提示词响应。

每组对照应从同一底模重新开始。不要加载另一优化器保存的训练状态后再切换优化器，因为动量和状态结构并不等价。

Prodigy 等需要不同学习率尺度的优化器不能纳入上述单变量对照。可先分别调到合理设置，再比较完整训练方案；结论应表述为“该方案更适合当前数据集”，而不是把差异全部归因于优化器。

同时修改优化器、学习率、rank 和训练步数会使结果无法归因。即使结果改善，也无法确定具体原因。

<!-- doc-anchor: limits -->
## 适用边界

- CAME 只处理梯度和优化器状态，不会自动降低低质量图片的权重。
- StableAdamW 主要改善更新稳定性；基准训练已经稳定时，画质差异可能较小。
- Paged 版本只改变内存分页方式，不提供独立的画质收益；实际发生分页时可能降低训练速度。
- 优化器不能单独阻止单图过拟合；停止时机、重复次数和数据多样性更关键。
- 不同优化器的合理学习率范围不同，因此统一使用同一学习率并不一定构成公平比较。

<!-- doc-anchor: evidence -->
## 依据与参考资料

**实现事实：** 本项目通过 sd-scripts 的完整类路径加载 `pytorch_optimizer.StableAdamW`。已安装的 `pytorch-optimizer 3.10.0` 中，它的构造器默认值包括 `betas=(0.9,0.99)`、`eps=1e-8`、`weight_decay=0.01`、`weight_decouple=True`、`kahan_sum=True`。本项目有意将 `weight_decay` 覆盖为 `0`。

**模型与上游依据：** Anima 官方模型卡建议使用 Anima-Base、不要训练 LLM Adapter、rank 32 从 `2e-5` 左右起步。`sd-scripts` 的 Anima 文档把 `1e-4` 标为 `alpha=1` 的示例，并要求 alpha 增大后重新降低/验证 LR。

**论文依据：** CAME、Lion、Prodigy、Schedule-Free、LoRA+ 的论文解释了算法动机，并报告了各自任务上的结果。CAME 的 `0.5`～`0.9` 倍和 Lion 的 `1/3`～`1/10` LR 是相对 AdamW 的官方调参建议；语言模型、分类或其他扩散实验不能直接推出 Anima 人物 LoRA 的画质排序。

**需要实测的经验判断：** CAME 可能更适合来源混合的数据，StableAdamW 可能更能容忍尖峰 batch。这些属于社区与工程经验，应通过固定条件的 A/B 测试确认是否适用于当前数据集。

参考资料：

- [Anima 官方模型卡](https://huggingface.co/circlestone-labs/Anima)
- [sd-scripts Anima LoRA 训练文档](https://github.com/kohya-ss/sd-scripts/blob/main/docs/anima_train_network.md)
- [CAME 官方实现与调参说明](https://github.com/yangluo7/CAME)
- [Lion 官方实现与调参说明](https://github.com/google/automl/tree/master/lion)
- [Schedule-Free 官方实现与调参说明](https://github.com/facebookresearch/schedule_free)
- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms (Lion)](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [pytorch-optimizer 文档](https://pytorch-optimizers.readthedocs.io/)
- [bitsandbytes 优化器文档](https://huggingface.co/docs/bitsandbytes/optimizers)
