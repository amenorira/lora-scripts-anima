# LoRA+

> LoRA+ 给 LoRA 的两组参数设置不同的学习率，作用是改变学习速度：目标特征可能更早出现，重复的背景、姿势和构图也可能更早被记住。它不是画质增强选项，也不保证最终质量更高。不启用 LoRA+ 仍是完整、标准的 LoRA 训练方式。

<!-- doc-anchor: overview -->
## 快速理解

标准 LoRA 由两个协作的部分组成：一个把输入压缩到低维，另一个把结果映射回原维度。普通训练让两组使用相同学习率；LoRA+ 保留其中一组的基础学习率，只让另一组乘以一个倍率。

例如基础学习率为 `1e-4`、倍率为 `2.0` 时：

- 基础组仍使用 `1e-4`。
- 高倍率组使用 `2e-4`。
- 底模、LoRA 参数量和导出文件格式都不变。

因此 LoRA+ 改变的是“训练多少步后学到多明显”，而不是“模型能学到什么”。数据与标注决定模型反复接触哪些内容；LoRA+ 可能让目标特征更早出现，也可能让重复背景、姿势和构图更早被记住。

<!-- doc-anchor: effects -->
## 对不同训练目标的影响

LoRA+ 对所有训练目标使用相同的学习率机制，但值得观察的现象不同：

| 训练目标 | 可能看到的变化 | 需要同时检查 |
| --- | --- | --- |
| 人物 LoRA | 脸部、发型或身份特征可能更早稳定 | 服装能否替换，背景和姿势是否被绑定 |
| 画风 LoRA | 颜色、线条和形体特征可能更早出现 | 风格能否迁移到新人物、新物体和新构图 |
| 服装或物体 LoRA | 目标外观可能在较早 checkpoint 中变得明显 | 能否与不同人物、姿势和场景组合 |
| 触发词概念 | 触发词可能更早产生明确响应 | 其他提示词是否仍能正常控制结果 |

图片数量本身不决定是否适合 LoRA+，有效独立图片数和内容多样性更关键：

- 少量人物图更容易把身份、服装、背景和姿势一起记住，LoRA+ 可能让这些内容同时更早出现。
- 图片较多且视角、姿势和背景足够多样时，更容易分辨 LoRA+ 改变的是学习速度还是最终泛化能力。
- 文件很多但内容高度重复的数据集，风险更接近少图数据。
- `repeats` 只增加每张图被训练的次数，不增加新的视角、姿势或构图。

LoRA+ 的效果还取决于其他训练设置：

- **基础学习率**是倍率相乘前的起点。同样的 `2.0` 倍率，在 `1e-4` 和 `2e-4` 基础学习率下代表完全不同的实际强度。
- **训练步数**决定参数更新的总次数。LoRA+ 可能让最佳 checkpoint 提前出现，也可能让过拟合更早出现。
- **Rank**决定 LoRA 的容量，不直接代表学习速度。高 rank 欠拟合时，应先检查学习率、步数和标注，而不是直接开 LoRA+。
- **Alpha**参与权重增量的缩放。修改 alpha 后，原有的倍率需要重新评估。
- **数据与标注**决定哪些内容被反复学习。LoRA+ 不能补充缺失的数据，也修复不了错误的触发词或标注。

<!-- doc-anchor: effective-lr -->
## 实际学习率

倍率必须和基础学习率一起理解。训练器先确定每个训练部分的基础学习率，再对高倍率组应用倍率：

| 训练部分 | 基础学习率优先使用 | 为空时使用 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| 文本编码器 | `text_encoder_lr` | `learning_rate` |

下面的例子展示基础学习率与倍率如何共同决定实际学习率：

| 配置 | 基础组 | 高倍率组 |
| --- | --- | --- |
| 基础学习率 `1e-4`，未启用 LoRA+ | `1e-4` | `1e-4` |
| 基础学习率 `1e-4`，倍率 `2.0` | `1e-4` | `2e-4` |
| 基础学习率 `2e-4`，倍率 `2.0` | `2e-4` | `4e-4` |

单独填写 `unet_lr` 或 `text_encoder_lr` 时，对应组件按自己的学习率计算。例如 `learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT 倍率为 `2.0` 时：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet LoRA+ 实际学习率示例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

提高整体学习率会加快所有 LoRA 参数的更新速度；提高倍率只加快高倍率组。这正是 LoRA+ 的实际用途。

<!-- doc-anchor: ratio-guidance -->
## 倍率选多少

倍率表示高倍率组相对基础组的学习率倍数，数值本身没有画质含义：

| 倍率 | 实际含义 | 注意事项 |
| --- | --- | --- |
| `1.0` | 两组学习率相同 | 没有 LoRA+ 效果 |
| `2.0` | 高倍率组为 2 倍 | 本训练器默认值，差异较温和 |
| `4.0` | 高倍率组为 4 倍 | 需结合基础学习率判断实际强度 |
| `8.0`～`16.0` | 高倍率组远高于基础组 | 对基础学习率、停止时机和数据重复更敏感 |

LoRA+ 论文在实验中使用 `16` 倍，sd-scripts 文档也沿用这一数值；它来自特定模型和任务，不能当作人物、画风或概念 LoRA 的通用推荐值。本训练器默认 `2.0`，从较温和的差异开始。

<!-- doc-anchor: parameters -->
## 训练器参数

“启用 LoRA+”是本训练器的总开关。它只决定是否把下面的倍率参数写入训练配置，开关本身不是训练命令参数。

开关关闭时，界面中保留的倍率值不会进入训练配置，高级“自定义网络参数”里的同名 `loraplus_*` 项也会被忽略，保证界面显示和后端校验使用同一组设置。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局倍率。UNet/DiT 和文本编码器没有单独倍率时使用该值。界面默认 `2.0`，最小 `1.0`。

```toml
loraplus_lr_ratio = 2.0
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

只覆盖 UNet 主干的倍率。Anima 训练中，sd-scripts 沿用 `unet` 参数名，但实际对应主要的 DiT 网络。

```toml
loraplus_unet_lr_ratio = 2.0
```

仅训练文本编码器时此参数无效。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

只覆盖文本编码器 LoRA 参数的倍率。

```toml
loraplus_text_encoder_lr_ratio = 2.0
```

文本编码器未参与训练时此参数无效，包括：未训练文本编码器、启用“仅训练 UNet”，或缓存设置让文本编码器不参与训练。提高文本编码器倍率可能让触发词更早产生明确响应，也可能让模型更早依赖固定触发词、削弱其他提示词的控制力。

三个倍率的优先级：

| 训练部分 | 使用的倍率 |
| --- | --- |
| UNet/DiT | 优先用 `loraplus_unet_lr_ratio`，为空时用 `loraplus_lr_ratio` |
| 文本编码器 | 优先用 `loraplus_text_encoder_lr_ratio`，为空时用 `loraplus_lr_ratio` |

全局倍率为空时，只填一个组件倍率即可让 LoRA+ 只作用于该组件。启用 LoRA+ 后至少需要一个倍率；某个组件的专用倍率和全局倍率都为空时，该组件不应用 LoRA+。

<!-- doc-anchor: good-cases -->
## 什么时候值得试

LoRA+ 的价值要靠当前训练结果判断。出现以下情况时值得对比：

- 预期步数内，人物身份、画风或目标概念仍明显不足。
- 提高整体学习率会破坏细节或造成不稳定，但只想加快部分 LoRA 参数。
- 训练时间或总步数有限，想知道相同步数内能否更早得到可用结果。
- 已有未启用 LoRA+ 的结果，可以作为学习速度和最终质量的对照。

普通 LoRA 在预期步数内已经稳定时，LoRA+ 的额外收益通常有限。训练器提供这个选项，不表示当前配置需要它。

<!-- doc-anchor: cautions -->
## 风险与限制

以下情况更容易让高倍率同时加快过拟合：

- 数据量很小，或多张图共享相同背景、姿势和构图。
- 文件很多，但包含连续帧、重复裁剪或高度相似的图。
- 基础学习率已经较高，乘上倍率后的实际学习率可能过大。
- 数据中反复出现伙伴角色、水印、特效或未标注的元素。
- 当前训练已出现构图僵化、背景绑定或提示词响应下降。
- 优化器内部管理学习率时，训练中的实际倍率会变化。

LoRA+ 无法解决模型容量不足、数据缺失或标注错误，也不会自动给出新的停止步数。倍率越高，最佳结果和过拟合都可能越早出现，原来的停止时机不一定仍然合适。

<!-- doc-anchor: testing -->
## 如何判断效果

从两个角度比较：

| 比较方式 | 可以判断 |
| --- | --- |
| 相同步数的 checkpoint | LoRA+ 是否改变了学习速度 |
| 每组配置的最佳 checkpoint | LoRA+ 是否改善了实际得到的最佳结果 |

有可比性的实验应固定数据集、训练 seed、rank、alpha、基础学习率、优化器、调度器和总步数，只改变 LoRA+ 开关或一个倍率。预览使用相同的生成 seed 和提示词，减少随机干扰。

不同训练目标关注的现象：

- **人物 LoRA**：身份是否稳定，服装能否更换，换背景和姿势后是否仍像目标人物。
- **画风 LoRA**：风格能否应用到训练集中没有出现过的主体和构图，而不只是复现训练图。
- **服装或物体 LoRA**：目标能否和不同人物、姿势和场景正常组合。
- **触发词概念**：触发词是否有效，提示词中的其他人物、动作和环境描述是否仍然生效。

如果高倍率只让最佳结果更早出现，而各配置的最佳质量相近，它的主要价值是节省训练步数。如果背景绑定、构图重复或提示词控制下降也更早出现，就需要同时评估倍率、基础学习率、数据重复和停止时机。

Loss 能帮助发现训练异常和趋势，但不能单独判断人物还原度、画风迁移或提示词控制能力。

<!-- doc-anchor: mechanism -->
## 技术原理

标准 LoRA 不直接修改原模型权重，而是用两个低秩矩阵表示权重增量。按 sd-scripts 的命名，`lora_down` 先把输入映射到低维，`lora_up` 再映射回原维度：

<div class="doc-equation" role="group" aria-label="标准 LoRA 权重增量公式">
  <div class="doc-equation-expression"><span class="doc-math-var">ΔW</span> = <span class="doc-frac"><span><span class="doc-math-var">α</span></span><span><span class="doc-math-var">r</span></span></span> · <span class="doc-math-var">B</span> · <span class="doc-math-var">A</span></div>
  <p><span class="doc-math-var">A</span> 对应 <code>lora_down</code>，<span class="doc-math-var">B</span> 对应 <code>lora_up</code>；<span class="doc-math-var">r</span> 是 rank，<span class="doc-math-var">α</span> 是 alpha。</p>
</div>

在当前 sd-scripts 实现中，`lora_down` 随机初始化，`lora_up` 初始化为零。第一次反向传播时，因为 `lora_up` 为零，`lora_down` 的梯度也暂时为零；`lora_up` 更新后，`lora_down` 才开始获得非零梯度。训练早期两组矩阵因此有不同的更新过程。

标准 LoRA 训练通常让两组参数使用相同学习率。LoRA+ 保留 `lora_down` 的基础学习率，只提高 `lora_up` 的学习率：

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ 学习率计算公式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

倍率改变的是每次更新的幅度，而不是参数开始更新的时刻。倍率为 `1.0` 时，两组学习率仍然相同。

<!-- doc-anchor: optimizer-compatibility -->
## 优化器与调度器

| 优化器 | LoRA+ 状态 | 说明 |
| --- | --- | --- |
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留不同参数组的独立学习率，倍率关系容易解释 |
| Lion、Lion8bit、PagedLion8bit | 支持 | 保留不同参数组的独立学习率 |
| CAME | 支持 | 保留不同参数组的独立学习率 |
| AdamWScheduleFree | 支持 | 保留参数组，但内部调整会改变训练中的实际学习率 |
| Automagic3 | 条件支持 | “基础学习率 × 倍率”的结果必须在 `min_lr` 与 `max_lr` 之间；实际倍率可能随自适应过程变化 |
| AdaFactor | 仅手动学习率模式 | `relative_step` 与 `warmup_init` 必须关闭。默认相对步长模式会忽略参数组学习率，界面会自动关闭并锁定 LoRA+ |
| Prodigy、ProdigyPlus | 不支持 | 当前 sd-scripts 训练路径无法可靠保留不同参数组的独立学习率，界面与后端都会阻止该组合 |
| EmoSens | 不支持 | EmoSens 用单一全局 `emoPulse` 更新所有参数，并在每步后统一各参数组学习率，倍率会失效 |

切换到不兼容模式时，界面会自动关闭 LoRA+ 并显示原因。后端也会拒绝旧预设或直接调用 API 形成的不兼容组合。

使用常规学习率调度器时，各参数组通常按相同比例变化，初始倍率关系得以保留。Warmup 控制训练早期的整体学习率变化，不等同于 LoRA+ 倍率。Schedule-Free、Automagic3 等内部动态优化器，应以训练日志中的实际曲线为准。

<!-- doc-anchor: support -->
## 支持范围

本训练器只对当前 sd-scripts 已实现 LoRA+ 参数分组的原生网络模块提供开关：

| 网络模块 | 高学习率参数 | 说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 标准 LoRA+ 分组 |
| `networks.lora_anima` | `lora_up` | Anima 使用的标准 LoRA+ 分组 |
| `networks.loha` | `hada_w2_a` | sd-scripts 对 LoHa 的扩展映射 |
| `networks.lokr` | `lokr_w1` | sd-scripts 对 LoKr 的扩展映射 |

`lycoris.kohya` 不显示这个开关，避免向该模块传入未经确认的参数。LoHa 和 LoKr 的支持只表示 sd-scripts 能为相应参数设置较高学习率；LoRA+ 论文本身并没有对这些分解方式给出相同的实验结论。

<!-- doc-anchor: tensorboard -->
## TensorBoard 记录

启用 LoRA+ 后，sd-scripts 会分别记录基础组和高倍率组。标准 SDXL LoRA 通常显示：

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Anima 的文本编码器带编号，通常显示：

```text
lr/textencoder 1
lr/textencoder 1 plus
```

名称中的 `plus` 表示高倍率参数组。使用分块学习率或其他多组参数配置时，名称和曲线数量还会增加。

训练器记录的是优化器实际使用的参数组学习率。对 Automagic3、Schedule-Free 等内部动态优化器，以 TensorBoard 曲线中的实时值为准；对常规优化器，可通过两条曲线检查倍率关系是否符合预期。

<!-- doc-anchor: references -->
## 参考资料

- Hayou 等人的论文 [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)，说明了为 LoRA 两组矩阵使用不同学习率的理论动机和实验结果。
- sd-scripts 的 `train_network_advanced.md`，说明 `loraplus_lr_ratio`、组件倍率以及优化器限制。
- sd-scripts 的 `loha_lokr.md`，说明 LoHa 与 LoKr 的高学习率参数映射。