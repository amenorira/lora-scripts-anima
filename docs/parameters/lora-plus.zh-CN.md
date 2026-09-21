# LoRA+

> LoRA+ 给 LoRA 的两组参数设置不同的学习率，作用是改变学习速度：目标特征可能更早出现，重复的背景、姿势和构图也可能更早被记住。它不是画质增强选项，也不保证最终质量更高。不启用 LoRA+ 仍是完整、标准的 LoRA 训练方式。

<!-- doc-anchor: overview -->
## 快速理解

LoRA+ 给同一个 LoRA 的两组参数设置不同学习率，用来调整它们的相对学习速度。标准 LoRA 中，`lora_down` 保持基础学习率，`lora_up` 使用基础学习率乘以倍率。

它有机会让目标特征在较少步数内出现，但不会增加参数量。倍率过大时，固定背景、服装或姿势也可能更早被记住，因此最佳保存时机可能提前。

下面用基础学习率 `2e-5` 演示倍率的含义，数值仅用于计算示例。

| 倍率 | `lora_down` 学习率 | `lora_up` 学习率 |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

提高基础学习率会同时影响两组参数；提高 LoRA+ 倍率只提高指定参数组。两者不是相同的调整。

<!-- doc-anchor: effects -->
## 对不同训练目标的影响

人物、画风、服装和概念使用同一 LoRA+ 分组机制；具体比较见“如何判断效果”中的相同步数、最佳检查点和新场景。

<!-- doc-anchor: effective-lr -->
## 实际学习率

倍率要结合基础学习率来看。训练器先确定每个训练部分的基础学习率，再对高倍率组应用倍率：

| 训练部分 | 优先读取 | 为空时回退到 |
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

LoRA+ 论文在实验中使用 `16` 倍（论文原文表述为 `2^4`），sd-scripts 文档也沿用这一数值；它来自特定模型和任务，不能当作人物、画风或概念 LoRA 的通用推荐值。本训练器默认 `2.0`，从较温和的差距起步。

<!-- doc-anchor: parameters -->
## 训练器参数

“启用 LoRA+”是本训练器的总开关。它只决定是否把下面的倍率参数写入训练配置，开关本身不是训练命令参数。

开关关闭时，界面中保留的倍率值不会进入训练配置，高级“自定义网络参数”里的同名 `loraplus_*` 项也会被忽略，保证界面显示和后端校验使用同一组设置。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局倍率。UNet/DiT 和文本编码器没有单独倍率时使用该值。界面默认 `2.0`，最小 `1.0`，以 `0.5` 为步进；更细粒度可通过自定义 `network_args` 设置。

```toml
loraplus_lr_ratio = 2.0
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

只覆盖 UNet 主干的倍率。Anima 训练中，sd-scripts 沿用 `unet` 参数名，但实际对应主要的 DiT 网络。

```toml
loraplus_unet_lr_ratio = 2.0
```

仅训练文本编码器时此参数无效（训练配置中仍会写入该值，但 UNet/DiT 参数不参与训练，因此它不会影响训练结果）。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

只覆盖文本编码器 LoRA 参数的倍率。

```toml
loraplus_text_encoder_lr_ratio = 2.0
```

文本编码器未参与训练时此参数无效：可能是启用了“仅训练 UNet”，也可能是缓存设置让文本编码器不参与训练。提高文本编码器倍率可能让触发词更早产生明确响应，也可能让模型更早依赖固定触发词、削弱其他提示词的控制力。

各组件优先使用自己的倍率；留空时使用全局 LoRA+ 倍率。两处都留空的组件不使用 LoRA+。

| 训练部分 | 优先使用 | 留空时使用 |
| --- | --- | --- |
| 主干网络 | 主干 LoRA+ 倍率 | 全局 LoRA+ 倍率 |
| 文本编码器 | 文本编码器 LoRA+ 倍率 | 全局 LoRA+ 倍率 |

<!-- doc-anchor: good-cases -->
## 什么时候值得试

当基准在预期步数内仍学习不足，或整体学习率已经不稳定而只想调整部分 LoRA 参数时，可以把 LoRA+ 作为单变量对照。已有未启用 LoRA+ 的结果应作为基准；没有基准时不要把某个倍率当作必需配置。

<!-- doc-anchor: cautions -->
## 风险与限制

高倍率与重复数据、较高基础学习率或内部动态优化器一起使用时，固定内容可能更早被记住。LoRA+ 不会补充缺失数据、修复标注，也不会自动决定停止步数；结果应按实际保存阶段比较。

<!-- doc-anchor: testing -->
## 如何判断效果

LoRA+ 的效果需要区分学习速度和最终质量。

| 比较对象 | 回答的问题 |
| --- | --- |
| 相同步数的模型 | 是否更早学到人物、画风或目标概念 |
| 每组训练各自最好的模型 | 最终能得到的结果是否更好 |
| 新姿势、新背景和未见主体 | 学到的特征是否仍能灵活使用 |

如果 LoRA+ 只让最佳结果提前出现，主要收益是减少训练步数。如果目标特征与固定构图一起更早被记住，应同时检查倍率和停止时机。

<!-- doc-anchor: mechanism -->
## 技术原理

标准 LoRA 用两个较小矩阵表示原层的权重变化。`lora_down` 把输入映射到 rank 维，`lora_up` 再映射到该层的输出维度。输入和输出维度不一定相等。

例如，某层输入为 2048 维、输出为 8192 维，rank 为 32 时，LoRA 分支是：

```text
2048 维输入 → lora_down → 32 维 → lora_up → 8192 维输出
```

权重增量为 `ΔW = (Alpha / rank) × B × A`，其中 A 对应 `lora_down`，B 对应 `lora_up`。这里的乘积不是先恢复输入维度，而是匹配原层所需的输出维度。

在当前 sd-scripts 实现中，`lora_down` 随机初始化，`lora_up` 初始化为零。第一次反向传播时，因为 `lora_up` 为零，`lora_down` 的梯度也暂时为零；`lora_up` 更新后，`lora_down` 才开始获得非零梯度。因此训练早期两组矩阵的更新过程不同。

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
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留不同参数组的独立学习率，倍率关系直观易懂 |
| Lion、Lion8bit、PagedLion8bit | 支持 | 保留不同参数组的独立学习率 |
| CAME | 支持 | 保留不同参数组的独立学习率 |
| AdamWScheduleFree | 支持 | 保留参数组，但内部调整会改变训练中的实际学习率 |
| Automagic3 | 条件支持 | “基础学习率 × 倍率”的结果必须在 `min_lr` 与 `max_lr` 之间；实际倍率可能随自适应过程变化 |
| AdaFactor | 仅手动学习率模式 | `relative_step` 与 `warmup_init` 必须关闭。默认相对步长模式会忽略参数组学习率，界面会自动关闭并锁定 LoRA+ |
| Prodigy、ProdigyPlus | 不支持 | 当前 sd-scripts 训练路径无法可靠保留不同参数组的独立学习率，界面与后端都会阻止该组合 |
| EmoSens | 不支持 | EmoSens 用单一全局 `emoPulse` 更新所有参数，并在每步后统一各参数组学习率，倍率会失效 |
| LoRA-Muon | 不支持 | 当前联合更新实现需要完整的 LoRA 因子配对 |
| LoRA-RITE | 不支持 | 当前实现的因子配对与 LoRA+ 参数分组不兼容 |

切换到不兼容模式时，界面会自动关闭 LoRA+ 并显示原因。后端也会拒绝旧预设或直接调用 API 形成的不兼容组合。

使用常规学习率调度器时，各参数组通常按相同比例变化，初始倍率关系得以保留。Warmup 控制训练早期的整体学习率变化，不等同于 LoRA+ 倍率。Schedule-Free、Automagic3 等内部动态优化器，应以训练日志中的实际曲线为准。

<!-- doc-anchor: support -->
## 支持范围

本训练器只为部分原生网络模块提供开关——即当前 sd-scripts 中已实现 LoRA+ 参数分组的模块：

| 网络模块 | 高学习率参数 | 说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 标准 LoRA+ 分组 |
| `networks.lora_anima` | `lora_up` | Anima 使用的标准 LoRA+ 分组 |
| `networks.loha` | `hada_w2_a` | sd-scripts 对 LoHa 的扩展映射 |
| `networks.lokr` | `lokr_w1` | sd-scripts 对 LoKr 的扩展映射 |
| `lycoris.kohya`（仅 LoCon/算法 lora） | `lora_up` 等 | LyCORIS 适配层按参数名 `lora_up` 分组；其余 LyCORIS 算法（LoHa/LoKr 等）参数名不命中该分组，不起作用 |

`lycoris.kohya` 下开关只在算法为 LoCon（lora）时显示；其余 LyCORIS 算法不显示也不起效。LoHa 和 LoKr 的支持只表示 sd-scripts 能为相应参数设置较高学习率；LoRA+ 论文本身并没有对这些分解方式给出相同的实验结论。Krea 2（`networks.lora_krea2`，musubi-tuner 路径）不提供 LoRA+ 开关。

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

TensorBoard 中，普通优化器的基础组与 plus 组曲线可用于检查学习率倍率。对于内部自适应或 Schedule-Free 优化器，参数组学习率不一定完整反映实际更新幅度；应结合该优化器记录的指标与生成结果判断。

<!-- doc-anchor: faq -->
## 常见问题

**启用 LoRA+ 后效果反而变差或过拟合更早出现，怎么办？**

先关闭 LoRA+ 或把倍率降回 `1.0`，确认问题是否随之消失。随后依次检查基础学习率、数据重复度和停止时机：倍率只是放大高倍率参数组的学习率，不能单独决定最终质量。

**倍率应该设多大？**

`2.0` 是本训练器的默认值，也是较温和的起点。论文实验使用的是 `16`（原文表述为 `2^4`），但那是特定模型和任务的推荐值，不是人物、画风或概念 LoRA 的通用答案。

**怎么确认 LoRA+ 真的生效了？**

启用后，TensorBoard 中会同时出现基础组和高倍率组两条曲线（如 `lr/unet` 与 `lr/unet plus`）。对常规优化器，两条曲线的比例应接近设定的倍率。

**为什么界面自动关闭了 LoRA+？**

请查看“优化器与调度器”兼容表；界面会按当前组合自动关闭并显示原因，后端也会拒绝不兼容配置。

**只训练文本编码器时，LoRA+ 还有用吗？**

有用，但只作用于文本编码器：`loraplus_text_encoder_lr_ratio` 生效，`loraplus_unet_lr_ratio` 没有对应的 UNet/DiT 参数参与训练，因此不产生作用。

<!-- doc-anchor: references -->
## 依据与参考资料

事实核查日期：**2026-08-14**。下列代码链接固定到核查时的提交。2026-08-07 vendor 又同步过一次（commit `37a1cbb`），复核后上述结论不变。

**实现事实：** 倍率参数、组件回退顺序、初始化方式与 TensorBoard 分组名称，以本项目 vendor 中 sd-scripts fork 的实际实现为准（`networks/lora.py`、`networks/lora_anima.py`、`networks/network_base.py`）。

**论文与上游依据：** [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)（Hayou 等人）介绍了为 LoRA 两组矩阵使用不同学习率的理论动机和实验结果，论文原文将推荐倍率表述为 `2^4`（即 `16`）。sd-scripts 的 `train_network_advanced.md` 转述了这一数值，并说明 `loraplus_lr_ratio`、组件倍率与优化器限制；`loha_lokr.md` 说明 LoHa 与 LoKr 的高学习率参数映射。注意：arXiv 页面内容可能被后续修订更新，倍率 `16` 的表述以论文原文为准。

**需要实测的经验判断：** “LoRA+ 可能有助于身份或画风更快出现”以及倍率高低的风险倾向，属于工程经验，应通过固定条件的 A/B 测试确认。

参考资料：

- [本项目 sd-scripts fork：`train_network_advanced.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [本项目 sd-scripts fork：`loha_lokr.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
