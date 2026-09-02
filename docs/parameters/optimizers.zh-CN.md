# 优化器选择与参数指南

> 大多数 Anima / SDXL LoRA 训练，建议先用 **AdamW8bit** 建立基准。基准训练稳定时，通常无需更换优化器。
>
> 数据来源和质量差异较大时，可以对比 **CAME**；日志中出现可复现的梯度尖峰，或 LoRA 可训练权重为 FP16/BF16 时，可以对比 **StableAdamW**。

优化器影响收敛速度、显存占用和数值稳定性，但通常不是人物还原度的首要决定因素。少图人物训练出现问题，应先检查数据、标注、重复次数、学习率和停止时机。

本文区分“实现与论文事实”和“Anima 工程起点”：CAME、Lion、Schedule-Free 的论文结果或库默认值，都不能直接当作 Anima LoRA 的最优配置。Anima 官方模型卡建议使用 **Anima-Base**、不训练 LLM Adapter、rank 32，并从 `2e-5` 附近小幅调整。本训练器以 `rank=32, alpha=32` 为工程起点，其中 `alpha=32` 是项目自己的选择，仍需要按数据集验证。Krea 2 训练不适用本文的起点值（其优化器基线不同，如 ScheduleFree 为 `0.0025`）。

<!-- doc-anchor: quick-choice -->
## 快速选择

| 训练情况 | 建议起点 | 说明 |
| --- | --- | --- |
| 首次训练，或没有明确的稳定性问题 | AdamW8bit | 参数习惯成熟、状态显存较低，便于和常见配置比较 |
| DMM 卡面、立绘、截图、特效图混合 | 先用 AdamW8bit，再对比 CAME | CAME 的内部裁剪可能改善更新稳定性，但它并不能辨别低质量图片 |
| 出现明显且可复现的 loss 或梯度尖峰 | 先排查异常图片和学习率，再对比 StableAdamW | StableAdamW 主要改善更新稳定性，不代表必然提高画质 |
| LoRA 可训练权重为 FP16/BF16 | StableAdamW | `kahan_sum` 主要在低精度参数更新中发挥作用 |
| 优化器状态显存不足 | AdamW8bit；仍不足时用 PagedAdamW8bit | Paged 版本改变内存调度方式；发生 CPU/GPU 数据交换时可能降低训练速度 |
| 想减少学习率调参 | Prodigy | 项目要求基础学习率为 `1.0` |
| 想比较矩阵正交化更新 | Muon | 先保持 AdamW 基线学习率，只更换优化器 |
| 想测试针对 LoRA 因子设计的矩阵优化 | LoRA-Muon | 与 AdamW8bit 固定条件对照；学习率需要单独校准 |

少图人物训练可以优先比较 **AdamW8bit、CAME、StableAdamW**。对照时一次只改一个主要变量，否则无法判断差异来源。

<!-- doc-anchor: optimizer-type -->
## 当前可用优化器

| 优化器 | 主要用途 | 限制与注意事项 |
| --- | --- | --- |
| AdamW | 全精度 AdamW 基准 | 优化器状态显存比 8-bit 版本高 |
| AdamW8bit | 通用默认 | 小张量默认保留 FP32 状态，这是正常行为 |
| PagedAdamW8bit | 常规 8-bit 优化器仍放不下显存时 | 与 AdamW8bit 的区别只有分页；发生 CPU/GPU 数据交换时可能降低训练速度 |
| StableAdamW | 梯度尖峰、低精度 LoRA 权重 | 状态显存通常高于 AdamW8bit；不能防止过拟合 |
| Lion | 对比符号动量优化器 | 合理学习率范围与 AdamW 不同，需要重新调整 |
| Lion8bit | 降低 Lion 的状态显存 | 需要独立调整学习率 |
| PagedLion8bit | Lion8bit 同时需要分页时 | 分页不改善生成质量，并可能降低训练速度 |
| Prodigy | 由优化器估计更新尺度 | 基础学习率用 `1.0`；本项目不支持搭配 LoRA+ |
| ProdigyPlusScheduleFree | 用于试验内部调度及其组合特性 | 外部 scheduler 和 warmup 不生效，少图短训练中的收益不确定 |
| Automagic3 | 项目实验性自适应方案 | 建议在有明确基准时测试；要求梯度累积为 1、禁用 mixed_precision=fp16、仅支持单卡 |
| AdaFactor | 优化器状态显存紧张 | relative step 模式会接管学习率，并限制 LoRA+ |
| CAME | 数据来源混合、更新尺度波动较大时用作对照 | 使用三个 beta 和内部 RMS 裁剪 |
| AdamWScheduleFree | 测试不依赖外部 scheduler 的 AdamW | 支持内部 warmup，但本项目默认 `warmup_steps=0`；短训练不建议作为第一选择 |
| EmoSens | 项目实验性优化器 | 要求梯度累积为 1、禁用 mixed_precision=fp16、仅支持单卡，不支持 LoRA+ |
| Muon | 对二维 LoRA 矩阵执行动量正交化 | 仅 Anima LoRA 可用；当前使用 PyTorch 原生实现；建议与 AdamW8bit 做同条件对照 |
| LoRA-Muon | 联合处理 LoRA 的两个低秩因子 | 仅 Anima LoRA 可用；学习率尺度与 AdamW 不同，需要单独校准 |
| Adan | 想在相近步数内更快建立特征时对照 AdamW | 收敛更激进，学习率应低于 AdamW 基线；使用三个 beta |
| AdEMAMix | 长训练或梯度噪声明显时用作对照 | 短训练中慢速状态的收益不确定；alpha 与缓升步数需要和训练总长匹配 |
| AdEMAMix8bit | 使用 AdEMAMix 且优化器状态显存紧张时 | 与全精度版本的差异主要在状态量化 |
| LoRA-RITE | 试验专为 LoRA 结构设计的更新方式 | 仅 Anima LoRA、仅标准 LoRA 结构；不支持 LoRA+；自带梯度裁剪，`max_grad_norm`（全局梯度裁剪阈值）锁定为 0 |

表中的显存说明仅针对优化器状态。实际峰值还受分辨率、rank、batch、缓存和预览生成影响。

<!-- doc-anchor: stable-comparison -->
## AdamW8bit、CAME、StableAdamW 的区别

**AdamW8bit 适合做基准。** 状态显存低、用的人多、经验成熟，也便于区分学习率、步数和数据问题。没有明确的稳定性或显存问题时，优先用它。

**CAME 使用因子化状态和内部 RMS 裁剪。** 卡面、截图、立绘的画质和构图差异较大时，可作 AdamW8bit 的对照。CAME 处理的是参数更新，不会判断图片质量；伙伴角色、文字、特效和错误标注仍需在数据处理阶段解决。

**StableAdamW 限制异常大的参数更新。** 它支持常规学习率调度器、预热、`max_grad_norm` 和 LoRA+。本项目在 Anima 中沿用 AdamW 基线：`lr=2e-5`、`betas=(0.9, 0.99)`、`eps=1e-8`、`weight_decay=0`；SDXL 的界面起点仍为 `1e-4`。它不是 8-bit 优化器，状态显存通常高于 AdamW8bit。

基准训练的曲线和预览都正常时，StableAdamW 的额外收益可能较小，它的主要用途是改善更新稳定性。

<!-- doc-anchor: parameters -->
## 参数说明

<!-- doc-anchor: learning-rate -->
### 学习率（learning rate）

Anima 只训练 DiT 主干时，可从下面的工程起点开始。官方 Anima 依据只覆盖 rank 32 与约 `2e-5`；表中其他优化器数值和 `alpha=32` 属于迁移或项目选择。不同优化器的学习率不在同一数值尺度上：AdamW 依靠逐元素的一阶/二阶统计缩放，而 LoRA-Muon 将学习率直接作用于白化后的矩阵符号更新，因此相同的 `2e-5`、`1e-4` 或 `1e-3` 并不代表相同的实际参数步长，不能直接横向照搬。

| 优化器 | Anima 工程起点 | 依据与含义 |
| --- | ---: | --- |
| AdamW / AdamW8bit / PagedAdamW8bit | `2e-5` | Anima 官方模型卡的 rank 32 基线；8-bit 与分页不改变 LR 语义 |
| StableAdamW | `2e-5` | 先与 AdamW 同尺度，单独比较稳定化更新 |
| Muon (`match_rms_adamw`) | `2e-5` | 按矩阵尺寸匹配 AdamW 更新 RMS；尚不是 Anima 实测最优值 |
| LoRA-Muon | `0.02` | 学习率尺度不同；论文的 `0.1` 只在小型 Transformer 上测试，本项目将 `0.02` 作为保守的工程起点 |
| CAME | `1.5e-5` | CAME 官方建议用 AdamW 的 `0.5`～`0.9` 倍；这是迁移起点，不是 Anima 实测最优值 |
| Adan | `1e-5` | 实际步长大于同学习率的 AdamW，按基线的 `0.5` 倍起步 |
| AdEMAMix / AdEMAMix8bit | `2e-5` | 论文沿用 Adam 量级的学习率；8-bit 不改变学习率语义 |
| LoRA-RITE | `1e-4` | 论文中最优值约为 Adam 的 20 倍；本项目小样本实测 `2e-4` 平稳、`5e-4` 出现过热 |
| Lion / Lion8bit / PagedLion8bit | `5e-6` | Lion 官方建议 LR 比 AdamW 小约 `3`～`10` 倍 |
| AdamWScheduleFree | `1e-4` | 官方建议常比基准优化器高 `1`～`10` 倍；Anima 缺少充分验证，按实验方案使用 |
| Prodigy / ProdigyPlus | `1.0` | D-adaptation 缩放基准，不能与 `2e-5` 直接比较 |
| AdaFactor relative step | 由优化器接管 | 关闭 relative step 后，Anima 手动模式从 `2e-5` 开始 |
| Automagic3 / EmoSens | `1e-4` / `0.1` | 算法内部动态 LR 的基准值，不是普通固定 LR |

Lion 的 `5e-6` 只沿用了官方给出的“LR 比 AdamW 小约 3～10 倍”这一比例。官方还建议同时把 weight decay 增大 3～10 倍，本项目未沿用，因此这不是完整的官方 Lion 配方。

SDXL 保留独立的通用起点：AdamW/StableAdamW 为 `1e-4`、CAME 为 `1e-4`、Lion 为 `2e-5`、AdamWScheduleFree 为 `3e-4`。切换模型类型或优化器时，界面只替换尚未手动修改的推荐值；导入的配置和自定义值保持原样。

`network_alpha / network_dim` 会缩放 LoRA 分支。上游 sd-scripts 的 `1e-4` 示例对应 `alpha=1`，并明确说明提高 alpha 时应重新降低或验证 LR；因此不能把这个示例直接套到本项目默认的 `rank=32, alpha=32`。

人物过早出现构图僵化、串色或提示词响应下降时，可以降低学习率或减少训练步数。学习不足时，先确认触发词和有效训练步数，再小幅提高学习率。Lion 的合理学习率范围与 AdamW 不同，需要单独测试。

LoRA-Muon 不建议只试一个学习率。对 Anima，建议固定数据、seed、`network_dim/network_alpha`、scheduler 和总步数，先做一轮由低到高的扫参：`2e-5`、`5e-5`、`1e-4`、`2e-4`、`5e-4`、`1e-3`、`2e-3`、`5e-3`、`1e-2`、`2e-2`。如果相邻结果接近，再围绕较好的区间加密测试；`5e-2` 和 `0.1` 可作为更激进的实验值或论文尺度复现实验，不应当作默认值。短训练只用于排除明显过小或过大的范围，最终应结合中途预览、loss 曲线和过拟合情况判断。

<!-- doc-anchor: scheduler-warmup -->
### 学习率调度器与预热（scheduler 和 warmup）

AdamW、AdamW8bit、StableAdamW、Lion、CAME、Muon 和 LoRA-Muon 都使用外部学习率调度器。Anima 新配置默认用 `constant`，以匹配上游 Anima 示例，并减少短训练中的额外变量。`cosine_with_restarts` 在默认 `num_cycles=1` 时不会在训练中途重启，只有 cycles 大于 1 才会周期重启。已有的手动配置可以继续使用；想测试预热，可改用 `constant_with_warmup`，并把预热步数控制在总优化器步数的 `5%` 以内。

AdamWScheduleFree 和 ProdigyPlusScheduleFree 自己管理调度，界面会把外部调度器固定为 constant。AdamWScheduleFree 的内部预热与 `lr_warmup_steps` 是两回事；ProdigyPlusScheduleFree 没有暴露对应的可调预热参数。

<!-- doc-anchor: betas -->
### 动量参数（betas）

没有明确的调整依据时，保留默认值：

- AdamW 系列：通常是 `0.9, 0.999`
- StableAdamW、Lion：通常是 `0.9, 0.99`
- CAME：需要三个 beta

beta 越高，更新越平滑，但对新梯度的响应越慢。常规调优优先调整学习率，而不是 beta。

<!-- doc-anchor: eps -->
### 数值稳定项（eps）

`eps` 防止分母过小导致数值放大。StableAdamW 默认 `1e-8`；PyTorch Muon 默认 `1e-7`。没有可复现的数值问题时，不建议修改。

<!-- doc-anchor: weight-decay -->
### 权重衰减（weight decay）

对本文重点介绍的优化器，本训练器提供以下起点：AdamW、AdamW8bit 和 PagedAdamW8bit 为 `0.01`；CAME、StableAdamW 与 Muon 为 `0`。PyTorch Muon 自身默认 `0.1`，本训练器为 LoRA 起步显式覆盖为 `0`，用户仍可修改。

人物 LoRA 容量有限，没有对照结果时不宜使用较大的权重衰减。想为 AdamW8bit 测试 `weight_decay=0`，应把它当作单独的参数实验，保持数据、步数和其他设置不变。

StableAdamW 库默认 `weight_decay=0.01`，本训练器会明确写出 `weight_decay=0` 覆盖它。这是有意设置，不是参数缺失。

<!-- doc-anchor: muon-options -->
### Muon 参数

Muon 先累积梯度动量，再把二维矩阵的更新做近似正交化。AdamW 按元素的二阶统计缩放更新，Muon 更关注整个矩阵的更新方向。对 LoRA 来说，它会分别处理 `lora_down` 和 `lora_up`；可能改变收敛速度和学习到的方向，但不保证最终画质优于 AdamW8bit。

Muon 每个参数只维护一组动量状态，少于全精度 AdamW 的两组状态，但每一步会增加矩阵乘法。实际显存和速度仍取决于矩阵大小、rank、batch 和注意力实现。

#### 更新幅度

- **学习率**（`learning_rate`，Anima 默认 `2e-5`）：直接控制更新幅度。过高时可能很快过拟合、loss 波动或更新不稳定；过低时学习缓慢。使用默认缩放时可从 AdamW 基线开始比较。
- **学习率缩放**（`adjust_lr_fn`，默认 `match_rms_adamw`）：`match_rms_adamw` 可沿用 AdamW 配方的学习率和权重衰减，适合比较两种优化器本身的差异。`original` 按矩阵长宽比缩放更新，通常需要单独确定学习率；不同形状的矩阵在相同学习率下并不具有相同的实际更新幅度。
- **权重衰减**（`weight_decay`，默认 `0`）：数值增大会使 LoRA 因子进一步收缩，可能抑制过拟合，也可能削弱角色学习。PyTorch Muon 的库默认值为 `0.1`，本训练器会显式传入界面中的值。

#### 动量

- **动量系数**（`momentum`，默认 `0.95`）：数值越高，更新越平滑，但对新梯度的响应越慢；数值越低，对当前 batch 越敏感。
- **Nesterov 动量**（`nesterov`，默认开启）：决定正交化前如何组合当前梯度和历史动量。关闭后会改变优化轨迹，不是单纯的性能开关。

#### 正交化

- **迭代次数**（`ns_steps`，默认 `5`）：次数越多，正交化近似越充分，单步计算量也越高；减少次数可以降低计算量，但会改变更新结果。界面允许的上限为 `99`。
- **迭代系数**（`ns_coefficients`，默认 `3.4445, -4.775, 2.0315`）：决定 Newton-Schulz 迭代使用的多项式。其他取值可能降低近似效果或带来数值问题，主要用于受控实验。
- **数值稳定项**（`eps`，默认 `1e-7`）：防止归一化时除数过小。它通常不影响正常训练，主要用于排查可复现的 NaN 或异常放大。

第一次比较建议只把 AdamW8bit 换成 Muon，保持数据、rank、alpha、scheduler、步数和学习率不变。确认训练稳定后，再单独测试学习率或 weight decay。同时修改 NS 系数和迭代次数会让结果难以解释，建议一次只调整一个。

<!-- doc-anchor: lora-muon-options -->
### LoRA-Muon 参数

LoRA-Muon 是专门针对 LoRA 因子设计的独立优化器，不是 Muon 的一个配置选项。Muon 通常把二维参数矩阵作为整体优化；在 LoRA 训练中，`lora_down` 和 `lora_up` 是共同构成更新的两个低秩因子，原生 Muon 会分别处理它们。

LoRA-Muon 会把这两个因子作为一对参数联合处理，并利用另一侧因子的 Gram 矩阵调整当前因子的更新，再进行矩阵符号计算。这样计算更新时就会利用两个因子之间的结构关系，但不代表它在所有数据集或训练设置下都优于其他优化器。

| | Muon | LoRA-Muon |
| --- | --- | --- |
| 处理对象 | 二维参数矩阵 | LoRA 的两个低秩因子 |
| `lora_down` / `lora_up` | 分别处理 | 联合考虑 |
| 主要矩阵操作 | 动量与正交化 | 因子耦合、Gram 白化与矩阵符号 |
| 学习率 | 可使用 `match_rms_adamw` 对齐 AdamW 更新 RMS | 与 AdamW 不同，需要单独校准 |

对大多数用户，先调整 `learning_rate` 即可；`momentum`、`ns_steps` 和 `inv_sqrt_steps` 建议保持默认值。`gauge_rebalance` 只在需要测试因子重平衡时启用。界面中的这些字段最终都通过 `optimizer_args` 传递，不会作为顶层 TOML 参数。

- **学习率**（`learning_rate`，论文设置 `0.1`；Anima 工程起点 `0.02`）：控制每一步 LoRA 更新走多远，不是 `lora_up` 或 `lora_down` 单个参数的变化上限。调大：更新更猛，学得快，也更容易过拟合或训练不稳定；调小：更稳，但训练更慢。Anima 从 `0.02` 附近开始，按上面的多点扫参调整；论文的 `0.1` 只在小型 Transformer 上验证过，不宜当作 Anima 默认值。
- **为什么 AdamW 的数值不能直接用**：AdamW 把学习率按元素乘到每个参数上，含义是"每个参数走多远"；LoRA-Muon 先得到整体更新的方向，再沿这个方向步进，含义是"整体走多远"。两者单位不同，所以 `2e-5`、`1e-4` 在 LoRA-Muon 上通常几乎看不出更新，`1e-3` 到 `2e-2` 才是明显的更新区间——这不是固定规律，仍要按数据和 rank 验证。
- **原理**（可选阅读）：先用另一侧因子的 Gram 逆平方根把动量各方向拉到同一尺度（白化），再取矩阵符号得到更新方向，最后按 `η` 缩放。论文把 `η` 称为信赖域半径，即合成权重沿谱方向（spectral steepest descent）前进的更新预算；预算分成两半，各走一条因子路径，所以实际因子变化量不会直接等于 `η`。
- **动量系数**（`momentum`，默认 `0.9`）：一阶梯度 EMA，让更新参考之前几步的梯度方向。数值越大，更新越平滑，但对新梯度的响应越慢。
- **矩阵符号计算次数**（`ns_steps`，默认 `8`）：使用 Polar Express / Newton-Schulz 近似计算矩阵符号方向。次数越多，近似通常越充分，但计算量也越高。
- **Gram 逆平方根迭代次数**（`inv_sqrt_steps`，代码与论文默认都是 `7`）：控制因子白化计算的精度。这里的白化指按 Gram 矩阵调整因子不同方向的尺度。
- **数值保护项**（`msign_eps=1e-20`、`inv_sqrt_eps=1e-5`、`inv_sqrt_gamma=1.001`）：分别控制矩阵符号归一化保护、Gram 正则化和逆平方根阻尼。没有可复现的数值问题时保持默认。
- **因子重平衡**（`gauge_rebalance`，默认关闭）：同一个 LoRA 更新可以由不同大小的 down/up 组合表示，训练中两边尺度可能越来越失衡。开启后，优化器会定期把两边调回平衡，同时保持 LoRA 当前产生的效果不变，并把动量状态按相反比例搬移。
- **重平衡参数**（`gauge_rebalance_alpha=1`、`gauge_rebalance_interval=1`、`gauge_power_steps=2`）：分别控制重平衡强度、执行间隔和谱范数估计次数；仅在开启 `gauge_rebalance` 后显示并生效。
- **权重衰减**（`weight_decay`，默认 `0`）：使用分拆式解耦衰减；要求 `learning_rate * weight_decay < 1`。
- **全局梯度裁剪**（`max_grad_norm`，Anima 界面起点 `0`）：这是训练器在 `optimizer.step` 前执行的外部全局 L2 裁剪，不是 LoRA-Muon 构造参数，论文算法也没有此步骤。`0` 表示关闭；若训练中确有异常梯度尖峰，仍可手动设为正数。

`network_dim` 与 `network_alpha` **不要求相等**。`network_dim` 决定 rank，`network_alpha / network_dim` 决定前向 LoRA 分支缩放；`alpha=dim` 只表示前向缩放为 `1`。优化器真正要求的是同一模块的 `lora_down` rank 与 `lora_up` rank 维度相匹配。选择 LoRA-Muon 时，Anima 界面对未手动修改的字段推荐 `dim=16, alpha=16`：与 `32/32` 相比，LoRA 参数和一阶动量状态约减半，而 Gram 相关计算随 rank 的平方增长，因此 rank 16 更适合作为速度/资源平衡起点。这不是所有 Anima LoRA 的全局默认，也不会覆盖手动、导入或已保存的值。

实现支持 Linear LoRA 和 Anima 使用的 Conv LoRA 形状，在 FP16/BF16 参数上用 FP32 完成矩阵计算，并按兼容的 device、dtype 与 rank 批量计算 Gram 逆平方根。首次实验建议从界面推荐值开始，只单独比较学习率；`gauge_rebalance` 默认关闭，需要时再独立测试。

<!-- doc-anchor: adan-options -->
### Adan 参数

Adan 在 Adam 的一阶、二阶统计之外，额外跟踪相邻两步梯度的差分，并用它做前瞻式更新。直观效果是收敛更激进：相同步数下特征建立更快，但过拟合和过冲也更早出现。论文证据来自视觉与语言模型的中长训练，不是小数据 LoRA。

- **学习率**（Anima 默认 `1e-5`）：Adan 的实际步长大于同学习率的 AdamW，建议在 AdamW 基线（`2e-5`）的 0.3～1 倍之间尝试，不宜照搬论文预训练任务中的高学习率。
- **动量参数**（`betas`，默认 `0.98, 0.92, 0.99`）：三个值分别控制梯度平均、梯度差分平均和梯度平方统计。
- **数值稳定项**（`eps`，默认 `1e-8`）：与 AdamW 语义相同。
- **权重衰减**（`weight_decay`，默认 `0.01`）与**解耦开关**（`weight_decouple`，默认开启）：权重衰减是每步把权重向 0 轻微收缩，防止 LoRA 权重无限制增大。开启解耦后，收缩在参数更新之前按比例进行，与 AdamW 一致；库默认的耦合式在更新之后整体缩放参数。默认 `0.01` 下两者差异很小，开启解耦是为了与他人分享的 AdamW 配方保持语义一致。
- Adan 自带的 `max_grad_norm` 参数在本训练器中保持 `0`，梯度裁剪统一由界面上的 `max_grad_norm`（全局梯度裁剪阈值）字段负责。

<!-- doc-anchor: ademamix-options -->
### AdEMAMix 参数

AdEMAMix 同时维护两组梯度移动平均：一组反应快（β1=0.9），一组反应慢（β3=0.9999），更新 = 快速平均 + alpha × 慢速平均。论文的出发点是几千乃至几万步之前的梯度仍有价值，主要证据来自长时间语言模型训练。对步数有限的 LoRA 训练，慢速状态可能平滑时间步采样带来的梯度噪声，也可能把早期方向留得过久，需要通过对照实验确认。

- **慢速状态混合强度**（`alpha`，默认 `5.0`）：慢速平均在更新中的占比；`0` 表示退化为单个移动平均。
- **缓升步数**（`t_alpha`、`t_beta3`，默认留空）：让 alpha 从 0、β3 从 β1 在该步数内缓升到目标值，论文取训练总步数。留空时本训练器在启动前按预估总步数自动填入；填 `0` 表示不缓升。
- **动量参数**（`betas`，默认 `0.9, 0.999, 0.9999`）、**数值稳定项**（`eps`，默认 `1e-8`）：语义与 AdamW 相同。`weight_decay`（默认 `0.01`）把“衰减值 × 当前权重”并入每次更新，力度随学习率缩放；本训练器默认恒定学习率，可视为固定强度。
- 8-bit 变体把三组状态量化存储，显存约为全精度的四分之一；小于 4096 元素的张量不量化，这是正常行为。

<!-- doc-anchor: lorarite-options -->
### LoRA-RITE 参数

LoRA-RITE 是少数专门为 LoRA 结构设计的优化器。普通优化器分别更新 A、B 两个低秩因子，但同一个 LoRA 更新可以由无数组等价的 (A, B) 表示，普通优化器对不同的表示会给出不同的实际更新。LoRA-RITE 用未放大梯度和低秩侧的矩阵预条件消除这种任意性。论文证据来自语言模型（Gemma、mT5），在扩散模型 LoRA 上尚无公开结果，建议先与 AdamW8bit 做同条件对照。

- **学习率**（Anima 默认 `1e-4`）：它的更新量级与 Adam 族不同，论文实验里 LoRA-RITE 的最优学习率约为 Adam 的 20 倍。可在 `5e-5`～`2e-4` 之间对照；本项目 4 图 40 步的稳定性实测中，`1e-4` 与 `2e-4` 平稳，`5e-4` 出现明显 loss 尖峰。
- **动量参数**（`betas`，默认 `0.9, 0.999`）：常规两项。
- **数值稳定项**（`eps`，默认 `1e-6`）：语义是"根 eps"，内部会平方后使用，请勿沿用 Adam 习惯的 `1e-8`。
- **梯度裁剪阈值**（`clip_unmagnified_grad`，默认 `1.0`）：抑制个别突然激增的梯度对整步更新的影响，一般保持默认即可；范数按不受 LoRA 因子缩放影响的方式计算。选中本优化器后，界面的 `max_grad_norm`（全局梯度裁剪阈值）锁定为 `0`，由本项接管；`0` 表示不裁剪。
- 限制：仅 Anima LoRA 可用；仅标准 LoRA 结构（LyCORIS 的 LoHa、LoKr、DoRA 等不适用）；不能与 LoRA+ 同用（分组学习率会破坏 A/B 配对假设）。
- 冷启动提示：LoRA 的 up 矩阵零初始化时，最初几步的更新主要落在 up 上，down 随后才加入，这是该方法的正常行为，并非训练停滞。

<!-- doc-anchor: gradient-clipping -->
### 全局梯度裁剪（max_grad_norm）

`max_grad_norm=1` 是常用起点，`0` 表示关闭。StableAdamW 可以正常搭配这个参数。

同时使用 `percentile_clipping=95` 和较低的 `max_grad_norm` 时，同一次更新可能被裁剪两次。没有日志依据时，建议只保留一种温和裁剪。

<!-- doc-anchor: percentile-clipping -->
### 百分位裁剪（percentile clipping）

只对 AdamW8bit、PagedAdamW8bit、Lion8bit、PagedLion8bit 生效。

- `100`：关闭，也是默认值
- `99`：较温和的实验对照值
- `95`：较强的实验对照值，只在确认存在异常梯度后考虑

`99` 和 `95` 是工程测试起点，没有经过 Anima LoRA 实验验证。该功能根据近期梯度范数计算，不会判断图片质量。裁剪过强时，少见服装、表情和构图带来的有效更新也可能一起被削弱。

<!-- doc-anchor: min-8bit-size -->
### 8-bit 状态最小张量尺寸（minimum 8-bit tensor size）

默认 `4096`，小于这个规模的张量保留 FP32 优化器状态。

低 rank 训练出现疑似小张量数值问题时，可以测试 `16384`：更多 LoRA 张量保留 FP32 状态，显存占用略增。此参数不会改变模型参数本身的精度。

<!-- doc-anchor: stableadamw-options -->
### StableAdamW 专用参数

`kahan_sum=True` 用补偿求和减少低精度更新的舍入误差，主要作用于 LoRA 可训练权重本身为 FP16/BF16 的情况。本项目只选择 `mixed_precision=bf16` 时，LoRA 可训练权重仍是 FP32；开启 `full_bf16` 才会把 LoRA 参数也转为 BF16。因此未用 `full_bf16` 时，Kahan 求和通常没有明显差异。

`weight_decouple=True` 使用 AdamW 式解耦权重衰减。`weight_decay=0` 时此开关不改变计算结果，建议保持开启。

<!-- doc-anchor: came-clipping -->
### CAME 内部裁剪

`came_clip_threshold` 裁剪 CAME 内部更新的均方根（RMS），默认 `1.0`。它与全局 `max_grad_norm` 是不同参数。先保留默认值，只在固定条件下反复出现尖峰时再调整。

<!-- doc-anchor: schedulefree-warmup -->
### Schedule-Free 预热（warmup）

AdamWScheduleFree 使用内部 `warmup_steps`，外部 `lr_warmup_steps` 会被关闭。Schedule-Free 上游通常建议使用 warmup；本项目考虑到少图短训练中固定 warmup 会占用较大比例，暂时保持内部 `warmup_steps=0`。`1e-4` 只是未经 Anima 充分验证的实验起点，不是官方或实测最优值。

<!-- doc-anchor: stochastic-rounding -->
### 随机舍入（stochastic rounding）

随机舍入减少低精度更新长期朝同一方向取整造成的误差。ProdigyPlus 沿用库默认行为，本训练器不另加开关。它属于数值处理，不是数据增强。

<!-- doc-anchor: loraplus -->
### LoRA+

大多数优化器都可以搭配 LoRA+，包括 Muon 和 Automagic3；例外是 Prodigy、ProdigyPlus、EmoSens、LoRA-RITE 和 LoRA-Muon（LoRA+ 的分组学习率与 LoRA-RITE 的 A/B 配对、LoRA-Muon 的联合更新路径均不兼容），AdaFactor 则需要先关闭 relative step。

切换优化器后，应重新评估 LoRA+ 倍率。倍率改变部分 LoRA 参数的有效学习率，本身不提供独立的画质收益。

<!-- doc-anchor: scenarios -->
## 按数据集选择

<!-- doc-anchor: one-image -->
### 只有一张立绘

Anima 用 AdamW8bit 从 `1e-5`～`2e-5` 开始，并提高检查点（checkpoint）保存频率。SDXL 按自己的独立基线调整。这个场景最大的风险是把姿势和构图一起记住；StableAdamW 只能处理更新尖峰，补不出侧面、背面或新表情。

<!-- doc-anchor: few-shot -->
### 2～5 张少图人物

先完成 AdamW8bit 基准训练。图片来源和质量差异明显时，在相同步数下比较 CAME；日志出现尖峰时，再比较 StableAdamW。复杂的内部调度在短训练中可能没有足够步数体现效果。

<!-- doc-anchor: galgame -->
### Galgame 多表情立绘

这类数据构图很固定，AdamW8bit 通常够用。比更换优化器更重要的是正确标注表情，并避免把固定背景、站姿学成人物身份的一部分。表情数量很不均衡时，可以增加一组 CAME 对照。

<!-- doc-anchor: dmm-mixed -->
### DMM 卡面、特效、伙伴角色混合

先标注或移除伙伴角色、文字、水印、特效和不同形态，再比较 AdamW8bit 与 CAME。训练日志仍有稳定性问题时，可增加 StableAdamW 对照。优化器无法识别哪个角色是训练目标。

<!-- doc-anchor: mixed-quality -->
### 图片质量参差

先处理模糊图、压缩截图、重复裁剪和 Live2D 连续帧。必须保留的图片可以通过标注（caption）、分组和重复次数加以控制。可对比 CAME；8-bit 优化器可先测试 `percentile_clipping=99`，不建议直接用 `95`。

<!-- doc-anchor: outfits-forms -->
### 多服装、多形态

此场景更依赖准确的服装/形态标签和合理的分组采样。AdamW8bit、CAME、StableAdamW 均可使用。评估时检查服装控制、身份保持和形态串色，而不是只比较单张预览的锐度。

<!-- doc-anchor: style-lora -->
### 风格 LoRA

仍从 AdamW8bit 开始。风格能否泛化，主要取决于题材覆盖，以及标注是否把内容与风格分开。StableAdamW 可以减轻异常批次的影响，但过强的裁剪也可能削弱少见的风格特征。

<!-- doc-anchor: vram -->
### 显存紧张

先使用 AdamW8bit 或 Lion8bit，只在确认存在内存压力时改用 Paged 版本。分页实际触发时，CPU 与 GPU 之间的状态传输可能降低训练速度。`min_8bit_size` 建议保留 `4096`，避免为节省少量状态显存而量化更多小张量。

<!-- doc-anchor: starting-configs -->
## 保守起始配置

| 用途 | 优化器与参数 | 其他设置 |
| --- | --- | --- |
| Anima 通用基准 | AdamW8bit，LR 用上方主表，`weight_decay=0.01` | constant，`max_grad_norm=1`，项目默认 rank/alpha，只训练 DiT |
| Anima 混合来源对照 | CAME，LR 用上方主表；其余保持默认 | constant，`max_grad_norm=1`；结果需用固定条件验证 |
| Anima 梯度尖峰对照 | StableAdamW，LR 用上方主表，保留项目默认稳定性参数 | Kahan 开启，constant，`max_grad_norm=1` |
| Anima LoRA-Muon 实验 | LoRA-Muon，LR 用上方主表，其他参数保持默认 | constant，`max_grad_norm=0`，先使用界面推荐的 rank/alpha；只单独比较学习率 |
| Anima Lion 实验 | Lion / Lion8bit，LR 用上方主表 | constant；这不是完整的官方 Lion 配方 |
| 温和的 8-bit 裁剪 | AdamW8bit，沿用基准参数，`percentile_clipping=99` | 保持其他参数不变 |

出现过拟合时，优先减少训练步数、重复次数（repeats）或学习率；学习不足时，先检查触发词和有效步数；曲线出现尖峰时，先定位对应批次，再考虑裁剪或 StableAdamW。

<!-- doc-anchor: troubleshooting -->
## 按现象排查

| 现象 | 优先检查 | 可考虑的优化器调整 |
| --- | --- | --- |
| 损失值平稳，但预览质量差 | 数据、标注、预览提示词、检查点时机 | 通常不应先更换优化器 |
| 孤立且可复现的 loss 或梯度尖峰 | 对应批次、异常图片、学习率 | 对比 StableAdamW，或单独测试 `percentile_clipping=99` |
| 出现 NaN / Inf | 立即停止；检查学习率、精度设置、异常数据和恢复点 | 排除配置或数据问题后再比较 StableAdamW；不要用裁剪掩盖持续性问题 |
| 优化器状态导致显存不足 | 确认峰值来自优化器状态，而不是分辨率、batch 或预览 | 先用 8-bit；仍不足时再用 Paged 版本 |
| 很快记住姿势、背景或服装 | 步数、repeats、学习率、数据重复 | 降低学习率或缩短训练；换优化器通常不能解决 |
| 人物特征长期学不进去 | 触发词、caption、有效步数、rank 和训练目标 | 确认上述项目后，再小幅提高学习率 |

<!-- doc-anchor: ab-testing -->
## 怎么做有效的 A/B

1. 固定数据集、标注（caption）、随机种子（seed）、底模、VAE、rank/alpha、批次大小和总步数。
2. 固定预览提示词、采样参数和生成随机种子。
3. Anima 配方对照使用上方学习率主表中对应的工程起点。这比较的是完整起始配方；想单独区分算法本身的差异，需要另做相同 LR 的实验。
4. 比较相同步数的训练检查点，同时记录梯度范数、峰值显存和训练时间。
5. 评估不止看损失值，还要看人物还原、服装控制、背景或姿势绑定以及提示词响应。

Muon 和 LoRA-Muon 应分别使用各自的工程起点。若要比较两者的更新机制，再另做相同 LR 的对照，不要把 `0.02` 或 `2e-5` 视为通用换算值。

每组对照从同一底模重新开始。不要加载另一优化器保存的训练状态后再切换优化器，动量和状态结构并不等价。

Prodigy 等需要不同学习率尺度的优化器不能纳入上述单变量对照。可先分别调到合理设置，再比较完整训练方案；结论应表述为“该方案更适合当前数据集”，而不是把差异全部归因于优化器。

同时修改优化器、学习率、rank 和训练步数会使结果无法归因。即使结果改善，也无法确定具体原因。

<!-- doc-anchor: limits -->
## 适用边界

- CAME 只处理梯度和优化器状态，不会自动降低低质量图片的权重。
- StableAdamW 主要改善更新稳定性；基准训练已经稳定时，画质差异可能很小。
- Paged 版本只改变内存分页方式，没有独立的画质收益；实际发生分页时可能降低训练速度。
- 优化器不能单独阻止单图过拟合；停止时机、重复次数和数据多样性更关键。
- 不同优化器的合理学习率范围不同，统一使用同一学习率不一定构成公平比较。

<!-- doc-anchor: faq -->
## 常见问题

**为什么切换模型类型或优化器后，学习率被替换了？**

界面只在推荐值尚未被手动修改时替换它；手动调整过、导入的配置和自定义值都会保持原样。

**为什么 Prodigy 的学习率被锁定为 1.0？**

Prodigy 属于 D-adaptation 系的自适应优化器，学习率作为缩放基准使用，sd-scripts 文档建议设为 `1.0` 左右，因此界面会锁定并提示。

**为什么 StableAdamW 的 weight_decay 在配置里是 0？**

库默认值是 `0.01`，本项目有意输出 `weight_decay=0` 覆盖它，用于建立一个可与 AdamW 基准直接对齐比较的起点。这是有意设置，不是参数缺失。

**为什么切换优化器后 LoRA+ 被关闭了？**

Prodigy、ProdigyPlus 和 EmoSens 不能可靠保留不同参数组的学习率；AdaFactor 在默认相对步长模式下也会接管学习率。界面会自动关闭 LoRA+ 并显示原因，后端也会拒绝通过旧预设或 API 提交的不兼容组合。

**训练出问题时，先换优化器还是先查数据？**

先查数据、标注、重复次数（repeats）、学习率和停止时机。优化器主要影响收敛速度、显存占用和数值稳定性，通常不是人物还原度的首要决定因素。

<!-- doc-anchor: evidence -->
## 依据与参考资料

事实核查日期：**2026-08-05**。下列代码与模型卡链接固定到核查时的提交。

**实现事实：** 本项目通过 sd-scripts 的完整类路径加载 `pytorch_optimizer.StableAdamW`。已安装的 `pytorch-optimizer 3.10.0` 中，它的构造器默认值为 `betas=(0.9,0.99)`、`eps=1e-8`、`weight_decay=0.01`、`weight_decouple=True`、`kahan_sum=True`。本项目有意将 `weight_decay` 覆盖为 `0`。

**模型与上游依据：** Anima 官方模型卡建议使用 Anima-Base、不训练 LLM Adapter、rank 32 从 `2e-5` 左右起步，但没有规定 `alpha=32`。sd-scripts 的 Anima 文档把 `1e-4` 标为 `alpha=1` 的示例，并要求在增大 alpha 后重新调低或重新验证 LR。

**论文依据：** CAME、Lion、Prodigy、Schedule-Free、LoRA+ 的论文解释了算法动机，并报告了各自任务上的结果。CAME 的 `0.5`～`0.9` 倍和 Lion 的 `1/3`～`1/10` LR 是相对 AdamW 的官方调参建议；语言模型、分类或其他扩散实验的结果，不能直接推出 Anima 人物 LoRA 的画质排序。

**需要实测的经验判断：** CAME 可能更适合来源混合的数据，StableAdamW 可能更能容忍尖峰批次。这些属于社区与工程经验，应通过固定条件的 A/B 测试确认是否适用于当前数据集。

**LoRA-Muon 依据：** 本节参数语义、默认值与论文出处按本项目接入的 vendor 实现及其来源说明核对（vendor/lora_muon/SOURCE.md）。

参考资料：

- [Anima 官方模型卡（固定提交）](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [sd-scripts Anima LoRA 训练文档（固定提交）](https://github.com/kohya-ss/sd-scripts/blob/37a1cbbc5725ed2a3575506e7bd2001c9908ac92/docs/anima_train_network.md)
- [CAME 官方实现与调参说明（固定提交）](https://github.com/yangluo7/CAME/tree/e77c5c022eaf71f1efb82a1433032cdcd5c52610)
- [Lion 官方实现与调参说明（固定提交）](https://github.com/google/automl/tree/6a54c8741e7c3265d4547c4f35f47a0391122dc5/lion)
- [Schedule-Free 官方实现与调参说明（固定提交）](https://github.com/facebookresearch/schedule_free/tree/70785b53e778d0e872c0bbb75ff4ee54ee10c291)
- [Transformers 余弦重启调度器实现（固定提交）](https://github.com/huggingface/transformers/blob/71c6f699ac9b3f8fc42a6a3e9dc59034c349a678/src/transformers/optimization.py)
- [CAME: Confidence-guided Adaptive Memory Efficient Optimization](https://arxiv.org/abs/2307.02047)
- [Symbolic Discovery of Optimization Algorithms (Lion)](https://arxiv.org/abs/2302.06675)
- [Prodigy: An Expeditiously Adaptive Parameter-Free Learner](https://arxiv.org/abs/2306.06101)
- [The Road Less Scheduled](https://arxiv.org/abs/2405.15682)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
- [Adan: Adaptive Nesterov Momentum Algorithm for Faster Optimizing Deep Models](https://arxiv.org/abs/2208.06677)
- [The AdEMAMix Optimizer: Better, Faster, Older](https://arxiv.org/abs/2409.03137)
- [LoRA Done RITE: Robust Invariant Transformation Equilibration for LoRA Optimization](https://arxiv.org/abs/2410.20625)
- [LoRA-RITE 官方实现（固定提交）](https://github.com/gkevinyen5418/LoRA-RITE/tree/d4186b6fedb39300d23c00ce0334db09719da9fc)
- [LoRA-Muon: Spectral Steepest Descent on the Low-Rank Manifold](https://arxiv.org/abs/2606.12921)
- [pytorch-optimizer 实现（固定提交）](https://github.com/kozistr/pytorch_optimizer/tree/3d08fa02cb6617d4d12365ca0f7d643b72e8cbe8)
- [bitsandbytes 优化器实现（固定提交）](https://github.com/bitsandbytes-foundation/bitsandbytes/tree/a2b90e6eae31a958e6b4d85edf2cfb2b91e9ce29)
