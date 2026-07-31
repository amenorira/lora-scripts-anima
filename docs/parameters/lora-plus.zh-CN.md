# LoRA+

> LoRA+ 让 LoRA 内部的不同参数使用不同学习率。它可能改变目标特征出现的速度，但不是画质增强选项，也不保证提高最终质量。不启用 LoRA+ 仍然是完整、标准的 LoRA 训练方式。

<!-- doc-anchor: overview -->
## 快速理解

一个标准 LoRA 可以简单理解为由两个协作的部分组成。普通训练让它们使用相同学习率；LoRA+ 保留其中一组的基础学习率，并让另一组使用更高学习率。

例如，基础学习率为 `1e-4`、LoRA+ 倍率为 `2.0` 时：

- 基础组仍使用 `1e-4`。
- 高倍率组使用 `2e-4`。
- 原模型、LoRA 参数数量和导出的文件格式都不会改变。

因此，LoRA+ 主要影响的是“在多少训练步后学到多明显”，而不是“模型能够学习什么”。训练数据和标注决定模型会反复看到哪些内容；LoRA+ 可能让目标特征更早出现，也可能让重复背景、姿势和构图更早被记住。

<!-- doc-anchor: effects -->
## 与实际 LoRA 训练的关系

LoRA+ 对人物、画风、服装和普通概念使用相同的学习率机制，但不同训练目标需要观察的结果不同：

| 训练目标 | 可能观察到的变化 | 同时需要检查 |
| --- | --- | --- |
| 人物 LoRA | 脸部、发型或身份特征可能更早稳定 | 服装能否替换，背景和姿势是否被绑定 |
| 画风 LoRA | 颜色、线条和形体特征可能更早出现 | 风格能否迁移到新人物、新物体和新构图 |
| 服装或物体 LoRA | 目标外观可能在较早 checkpoint 中变得明显 | 是否能与不同人物、姿势和场景组合 |
| 触发词概念 | 触发词可能更早产生明确响应 | 其他提示词是否仍能正常控制结果 |

图片数量不会直接决定 LoRA+ 的结果。有效独立图片数和内容多样性会改变同一倍率产生的训练轨迹：

- 少量人物图更容易同时记住身份、服装、背景和姿势。LoRA+ 可能让这些内容一起更早出现。
- 图片较多且视角、姿势和背景足够多样时，更容易分辨 LoRA+ 改变的是学习速度，还是最终泛化能力。
- 文件数量很多但内容高度重复时，训练风险仍然更接近少图数据。
- `repeats` 增加图片被训练的次数，不会增加新的视角、姿势或构图。

LoRA+ 还会与其他训练设置共同影响结果：

- **基础学习率**决定倍率相乘前的数值。同一个 `2.0` 倍率，在 `1e-4` 和 `2e-4` 基础学习率下代表不同的实际训练强度。
- **训练步数**决定参数一共更新多少次。LoRA+ 可能让最佳 checkpoint 提前出现，也可能让过拟合更早出现。
- **Rank**决定 LoRA 可以容纳多少变化，不直接代表学习速度。高 rank 欠拟合不一定需要 LoRA+，也可能来自学习率、步数或标注。
- **Alpha**参与 LoRA 权重增量的缩放。修改 alpha 后，原有 LoRA+ 倍率不一定仍然合适。
- **数据与标注**决定哪些内容会被反复学习。LoRA+ 不能补充数据中缺少的信息，也不能修复错误触发词或不准确标注。

<!-- doc-anchor: effective-lr -->
## 实际学习率

LoRA+ 倍率必须和基础学习率一起理解。训练器会先确定每个训练部分的基础学习率，再对高倍率参数组应用 LoRA+ 倍率：

| 训练部分 | 学习率读取顺序 | 回退值 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| 文本编码器 | `text_encoder_lr` | `learning_rate` |

下面的例子展示了基础学习率和 LoRA+ 倍率如何共同决定实际学习率：

| 配置 | 基础组 | 高倍率组 |
| --- | --- | --- |
| 基础学习率 `1e-4`，未启用 LoRA+ | `1e-4` | `1e-4` |
| 基础学习率 `1e-4`，倍率 `2.0` | `1e-4` | `2e-4` |
| 基础学习率 `2e-4`，倍率 `2.0` | `2e-4` | `4e-4` |

如果单独填写了 `unet_lr` 或 `text_encoder_lr`，计算会使用对应组件的学习率。例如，`learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT 倍率为 `2.0` 时：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet LoRA+ 实际学习率示例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

提高整体学习率会同时加快所有 LoRA 参数；提高 LoRA+ 倍率只会加快高倍率参数组。这一区别是 LoRA+ 在实际训练中的主要作用。

<!-- doc-anchor: ratio-guidance -->
## 倍率的含义

倍率表示高倍率组相对于基础组的学习率倍数，不是画质等级：

| 倍率 | 实际含义 | 使用时需要注意 |
| --- | --- | --- |
| `1.0` | 两组使用相同学习率 | 不产生 LoRA+ 的差异化学习率效果 |
| `2.0` | 高倍率组使用 2 倍学习率 | 本训练器的默认值，差异相对温和 |
| `4.0` | 高倍率组使用 4 倍学习率 | 需要结合基础学习率判断实际强度 |
| `8.0`～`16.0` | 高倍率组使用显著更高的学习率 | 对基础学习率、停止时机和数据重复更敏感 |

LoRA+ 论文在其实验设置中使用 `16`，sd-scripts 文档也记录了这一数值。该实验来自特定模型和任务，不能推出人物、画风或概念 LoRA 的倍率排序。本训练器的字段默认值为 `2.0`，对应高倍率组使用基础组两倍的学习率。

<!-- doc-anchor: parameters -->
## 训练器参数

“启用 LoRA+”是本训练器的总开关。它只控制是否向 sd-scripts 写入下列倍率参数，本身不会成为训练命令参数。

关闭开关时，界面中保留的倍率值不会进入训练配置。高级“自定义网络参数”中的同名 `loraplus_*` 项也会被忽略，以保证界面显示值和后端校验使用同一组设置。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局倍率。UNet/DiT 或文本编码器没有填写单独倍率时，会使用这个值。界面默认值为 `2.0`，最小值为 `1.0`。

```toml
loraplus_lr_ratio = 2.0
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

只覆盖 UNet 主干的倍率。在 Anima 训练中，sd-scripts 沿用 `unet` 参数名，但它实际对应主要的 DiT 网络。

```toml
loraplus_unet_lr_ratio = 2.0
```

仅训练文本编码器时，这个参数没有作用。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

只覆盖文本编码器 LoRA 参数的倍率。

```toml
loraplus_text_encoder_lr_ratio = 2.0
```

未训练文本编码器、启用“仅训练 UNet”，或缓存设置使文本编码器不参与训练时，这个参数没有作用。提高文本编码器倍率可能让触发词更早产生明确响应，也可能让模型更早依赖固定触发词，降低其他提示词的控制能力。

三个倍率参数的使用顺序为：

| 训练部分 | 使用的倍率 |
| --- | --- |
| UNet/DiT | 读取 `loraplus_unet_lr_ratio`；为空时读取 `loraplus_lr_ratio` |
| 文本编码器 | 读取 `loraplus_text_encoder_lr_ratio`；为空时读取 `loraplus_lr_ratio` |

全局倍率为空时，可以只填写一个组件倍率，使 LoRA+ 只作用于该训练部分。启用 LoRA+ 后至少需要填写一个倍率；某个组件的专用倍率和全局倍率都为空时，该组件不会应用 LoRA+。

<!-- doc-anchor: good-cases -->
## LoRA+ 改变的可观察量

LoRA+ 只提高高倍率参数组的有效学习率，因此会改变以下量：

- 相同步数时，高倍率组累计的参数更新幅度。
- 目标特征首次出现在 checkpoint 中的时间。
- 重复背景、姿势或构图开始固化的时间。
- 不同参数组在 TensorBoard 中记录的实际学习率曲线。

普通 LoRA 与 LoRA+ 在各自训练过程中得到的最佳 checkpoint 可能相同，也可能不同；开关本身不包含对最终质量的判断。

<!-- doc-anchor: cautions -->
## 数值范围与限制

以下数据条件会让较高倍率同时放大重复证据的累计速度：

- 数据量很小，或多张图片共享相同背景、姿势和构图。
- 图片文件很多，但包含连续帧、重复裁剪或高度相似的图。
- 基础学习率已经较高，乘以倍率后的实际学习率可能过大。
- 数据中反复出现伙伴角色、水印、特效或没有正确标注的元素。
- 当前训练已经容易出现构图僵化、背景绑定或提示词响应下降。
- 优化器在内部管理学习率，训练中的实际倍率可能发生变化。

LoRA+ 不能改变模型容量、补充训练数据或修正标注。它也不会计算停止步数。倍率增大时，目标特征与重复证据都可能在更早的 checkpoint 中出现。

<!-- doc-anchor: testing -->
## 对照所表达的结果

两种对照回答不同问题：

| 比较方式 | 可以判断 |
| --- | --- |
| 相同步数的 checkpoint | LoRA+ 是否改变了学习速度 |
| 每组配置中观测指标最高的 checkpoint | LoRA+ 是否改善了实际得到的最佳结果 |

当数据集、训练 seed、rank、alpha、基础学习率、优化器、调度器、总步数、生成 seed 和提示词保持一致时，差异才可能归因到 LoRA+ 开关或倍率。

不同训练目标对应的可观察现象包括：

- **人物 LoRA**：身份是否稳定，服装能否更换，新背景和新姿势下是否仍像目标人物。
- **画风 LoRA**：风格能否应用到训练集中没有出现过的主体和构图，而不只是复现训练图。
- **服装或物体 LoRA**：目标是否能与不同人物、姿势和场景正常组合。
- **触发词概念**：触发词是否有效，提示词中的其他人物、动作和环境描述是否仍然生效。

较高倍率只让相近结果更早出现时，观测到的是学习速度变化。背景绑定、构图重复或提示词控制下降也更早出现时，观测同时包含倍率、基础学习率、数据重复和停止时机的共同作用。

Loss 可以帮助发现训练异常和变化趋势，但不能单独判断人物还原度、画风迁移或提示词控制能力。

<!-- doc-anchor: mechanism -->
## 技术原理

标准 LoRA 不直接修改原模型权重，而是用两个低秩矩阵表示权重增量。以 sd-scripts 的命名为例，`lora_down` 先把输入映射到较低维度，`lora_up` 再把结果映射回原维度：

<div class="doc-equation" role="group" aria-label="标准 LoRA 权重增量公式">
  <div class="doc-equation-expression"><span class="doc-math-var">ΔW</span> = <span class="doc-frac"><span><span class="doc-math-var">α</span></span><span><span class="doc-math-var">r</span></span></span> · <span class="doc-math-var">B</span> · <span class="doc-math-var">A</span></div>
  <p><span class="doc-math-var">A</span> 对应 <code>lora_down</code>，<span class="doc-math-var">B</span> 对应 <code>lora_up</code>；<span class="doc-math-var">r</span> 是 rank，<span class="doc-math-var">α</span> 是 alpha。</p>
</div>

在当前 sd-scripts 实现中，`lora_down` 使用随机值初始化，`lora_up` 初始化为零。第一次反向传播时，`lora_down` 的梯度也会因为 `lora_up` 为零而暂时为零；`lora_up` 更新后，`lora_down` 才开始获得非零梯度。两个矩阵在训练早期因此具有不同的更新过程。

未启用 LoRA+ 时，两组参数使用同一基础学习率。LoRA+ 保留 `lora_down` 的基础学习率，并提高 `lora_up` 的学习率：

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ 学习率计算公式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

倍率改变的是每次更新的幅度，不是参数开始更新的时刻。倍率为 `1.0` 时，两组仍使用相同学习率。

<!-- doc-anchor: optimizer-compatibility -->
## 优化器与调度器

| 优化器 | LoRA+ 状态 | 说明 |
| --- | --- | --- |
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留不同参数组的独立学习率，倍率关系较容易解释。 |
| Lion、Lion8bit、PagedLion8bit | 支持 | 保留不同参数组的独立学习率。 |
| CAME | 支持 | 保留不同参数组的独立学习率。 |
| AdamWScheduleFree | 支持 | 保留参数组，但内部调整会影响训练中的实际学习率。 |
| Automagic3 | 条件支持 | “基础学习率 × LoRA+ 倍率”的结果必须位于 `min_lr` 与 `max_lr` 之间；实际倍率可能随自适应过程变化。 |
| AdaFactor | 仅手动学习率模式支持 | `relative_step` 与 `warmup_init` 必须关闭。默认相对步长模式会忽略参数组学习率，界面会自动关闭并锁定 LoRA+。 |
| Prodigy、ProdigyPlus | 不支持 | 当前 sd-scripts 训练路径不能可靠保留不同参数组的独立学习率，界面与后端都会阻止该组合。 |
| EmoSens | 不支持 | EmoSens 使用单一全局 `emoPulse` 更新所有参数，并在每步后统一各参数组学习率，因此 LoRA+ 倍率会失效。 |

切换到不兼容模式时，界面会自动关闭 LoRA+ 并显示原因。后端也会拒绝旧预设或直接调用 API 形成的不兼容组合。

常规学习率调度器对各参数组应用相同比例的学习率曲线，因此初始 LoRA+ 倍率关系会保留。Warmup 控制训练早期的整体学习率变化，不等同于 LoRA+ 倍率。Schedule-Free、Automagic3 等内部动态优化器的训练日志记录其实际学习率曲线。

<!-- doc-anchor: support -->
## 支持范围

本训练器只为当前 sd-scripts 已实现 LoRA+ 参数分组的原生网络模块提供开关：

| 网络模块 | 高学习率参数 | 说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 标准 LoRA+ 分组。 |
| `networks.lora_anima` | `lora_up` | Anima 使用的标准 LoRA+ 分组。 |
| `networks.loha` | `hada_w2_a` | sd-scripts 对 LoHa 的扩展映射。 |
| `networks.lokr` | `lokr_w1` | sd-scripts 对 LoKr 的扩展映射。 |

`lycoris.kohya` 不显示这个开关，避免向当前模块传入未经确认的参数。LoHa 和 LoKr 的支持表示 sd-scripts 能为相应参数设置较高学习率，不表示标准 LoRA+ 论文对这些分解方式给出了相同的实验结论。

<!-- doc-anchor: tensorboard -->
## TensorBoard 记录

启用 LoRA+ 后，sd-scripts 会分别记录基础组和高倍率组。标准 SDXL LoRA 记录以下名称：

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Anima 的文本编码器带有编号，记录以下名称：

```text
lr/textencoder 1
lr/textencoder 1 plus
```

名称中的 `plus` 表示高倍率参数组。使用分块学习率或其他多组参数配置时，名称和曲线数量还可能增加。

训练器会记录优化器当前实际使用的参数组学习率。对 Automagic3、Schedule-Free 等内部动态优化器，应以 TensorBoard 曲线中的实时值为准；对常规优化器，可以通过两条曲线检查倍率关系是否符合预期。

<!-- doc-anchor: references -->
## 参考资料

- Hayou 等人的论文 [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)，介绍了为 LoRA 两组矩阵使用不同学习率的理论动机和实验结果。
- sd-scripts 的 `train_network_advanced.md`，说明 `loraplus_lr_ratio`、组件倍率以及优化器限制。
- sd-scripts 的 `loha_lokr.md`，说明 LoHa 与 LoKr 的高学习率参数映射。
