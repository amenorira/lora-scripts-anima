# LoRA+

> LoRA+ 提高指定参数组的学习率，用于加快特征学习，不增加参数量。默认关闭；需要加快学习时，从默认倍率 `2.0` 开始比较，并留意最佳检查点是否提前。

<!-- doc-anchor: overview -->
## 快速理解

LoRA+ 给同一个 LoRA 的两组参数设置不同学习率，用来调整它们的相对学习速度。标准 LoRA 中，`lora_down` 保持基础学习率，`lora_up` 使用基础学习率乘以倍率。

倍率越高，两组学习率的差距越大；降至 `1.0` 时两组相同。倍率过大容易让重复背景、服装或姿势更早被记住。

以基础学习率 `2e-5` 为例：

| 倍率 | `lora_down` 学习率 | `lora_up` 学习率 |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

提高基础学习率会同时影响两组参数；提高 LoRA+ 倍率只提高指定参数组。两者不是相同的调整。

<!-- doc-anchor: good-cases -->
## 什么时候值得试

未启用 LoRA+ 的基准训练稳定，但目标特征出现较慢时，适合测试 LoRA+。已有损失尖峰时，先降低基础学习率，再比较倍率。

<!-- doc-anchor: effects -->
## 对不同训练目标的影响

人物、画风、服装和概念使用相同的分组机制。主要观察目标特征出现的速度，以及新姿势、新背景下的表现；固定构图更早出现时，应降低倍率或提前停止。

<!-- doc-anchor: ratio-guidance -->
## 倍率选多少

先使用 `2.0`。学习仍不足时再比较 `4.0`；过拟合提前出现时降低倍率。

| 倍率 | 实际含义 | 注意事项 |
| --- | --- | --- |
| `1.0` | 两组学习率相同 | 没有 LoRA+ 效果 |
| `2.0` | 高倍率组为 2 倍 | 本训练器默认值，差异较温和 |
| `4.0` | 高倍率组为 4 倍 | 需结合基础学习率判断实际强度 |
| `8.0`～`16.0` | 高倍率组远高于基础组 | 对基础学习率、停止时机和数据重复更敏感 |

论文与 sd-scripts 文档中的 `16` 来自特定实验。本训练器采用较温和的 `2.0` 作为起点。

<!-- doc-anchor: parameters -->
## 训练器参数

“启用 LoRA+”是本训练器的总开关。它只决定是否把下面的倍率参数写入训练配置，开关本身不是训练命令参数。

开关关闭时不输出倍率。开启时只使用界面倍率字段；高级“自定义网络参数”中的同名 `loraplus_*` 项会被清理，不能覆盖界面值。

以下示例展示导出训练 TOML 的写法。倍率属于 `network_args`；设置多个倍率时，合并到同一个列表中。界面配置仍使用对应的倍率字段。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局倍率。UNet/DiT 和文本编码器未设置单独倍率时使用该值。界面默认 `2.0`，最小 `1.0`，步进为 `0.5`。

```toml
network_args = ["loraplus_lr_ratio=2.0"]
```

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

只覆盖 UNet/DiT 的倍率，默认留空并使用全局值。Anima 沿用 `unet` 参数名，实际对应 DiT 主干。

```toml
network_args = ["loraplus_unet_lr_ratio=2.0"]
```

仅训练文本编码器时，此参数无效。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

只覆盖文本编码器 LoRA 参数的倍率，默认留空并使用全局值。

```toml
network_args = ["loraplus_text_encoder_lr_ratio=2.0"]
```

仅在文本编码器参与训练时生效。“仅训练 UNet”或文本编码器输出缓存会使其无效。调整后重点检查触发词响应和其他提示词的控制力。

两处都留空的组件不使用 LoRA+。

| 训练部分 | 优先使用 | 留空时使用 |
| --- | --- | --- |
| 主干网络 | 主干 LoRA+ 倍率 | 全局 LoRA+ 倍率 |
| 文本编码器 | 文本编码器 LoRA+ 倍率 | 全局 LoRA+ 倍率 |

<!-- doc-anchor: effective-lr -->
## 实际学习率

倍率要结合基础学习率来看。训练器先确定每个训练部分的基础学习率，再对高倍率组应用倍率：

| 训练部分 | 优先读取 | 为空时回退到 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| 文本编码器 | `text_encoder_lr` | `learning_rate` |

单独填写 `unet_lr` 或 `text_encoder_lr` 时，对应组件按自己的学习率计算。例如 `learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT 倍率为 `2.0` 时：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet LoRA+ 实际学习率示例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## 风险与限制

高基础学习率叠加高倍率会放大更新，重复数据更容易被提前记住。测试较高倍率时应提高保存频率，比较多个检查点。

<!-- doc-anchor: testing -->
## 如何判断效果

LoRA+ 的效果需要区分学习速度和最终质量。

| 比较对象 | 回答的问题 |
| --- | --- |
| 相同步数的模型 | 是否更早学到人物、画风或目标概念 |
| 每组训练各自最好的模型 | 最终能得到的结果是否更好 |
| 新姿势、新背景和未见主体 | 学到的特征是否仍能灵活使用 |

如果 LoRA+ 只让最佳结果提前出现，主要收益是减少训练步数。如果目标特征与固定构图一起更早被记住，应同时检查倍率和停止时机。

<!-- doc-anchor: optimizer-compatibility -->
## 优化器与调度器

| 优化器 | LoRA+ 状态 | 说明 |
| --- | --- | --- |
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留不同参数组的独立学习率，倍率关系直观易懂 |
| Lion、Lion8bit、PagedLion8bit | 支持 | 保留不同参数组的独立学习率 |
| CAME | 支持 | 保留不同参数组的独立学习率 |
| StableAdamW、Muon、Adan、AdEMAMix、AdEMAMix8bit、SOAP | 支持 | 保留不同参数组的独立学习率 |
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

以下网络模块提供 LoRA+ 开关：

| 网络模块 | 高学习率参数 | 说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 标准 LoRA+ 分组 |
| `networks.lora_anima` | `lora_up` | Anima 使用的标准 LoRA+ 分组 |
| `networks.loha` | `hada_w2_a` | sd-scripts 对 LoHa 的扩展映射 |
| `networks.lokr` | `lokr_w1` | sd-scripts 对 LoKr 的扩展映射 |
| `lycoris.kohya`（仅 LoCon/算法 lora） | `lora_up` 等 | LyCORIS 适配层按参数名 `lora_up` 分组；其余 LyCORIS 算法（LoHa/LoKr 等）参数名不命中该分组，不起作用 |

原生 LoHa、LoKr 使用各自的分组映射；LyCORIS 仅支持 LoCon（`lora`）。Krea 2（`networks.lora_krea2`，musubi-tuner 路径）不提供 LoRA+ 开关。

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

普通优化器可用两组曲线核对倍率。内部自适应或 Schedule-Free 优化器还会调整实际更新，应同时查看专用指标与生成结果。

<!-- doc-anchor: mechanism -->
## 技术原理

标准 LoRA 用两个较小矩阵表示原层的权重变化。`lora_down` 把输入映射到 rank 维，`lora_up` 再映射到该层的输出维度。

例如，某层输入为 2048 维、输出为 8192 维，rank 为 32 时，LoRA 分支是：

```text
2048 维输入 → lora_down → 32 维 → lora_up → 8192 维输出
```

权重增量为 `ΔW = (Alpha / rank) × B × A`，其中 A 对应 `lora_down`，B 对应 `lora_up`。

在当前 sd-scripts 实现中，`lora_down` 随机初始化，`lora_up` 初始化为零。第一次反向传播时，因为 `lora_up` 为零，`lora_down` 的梯度也暂时为零；`lora_up` 更新后，`lora_down` 才开始获得非零梯度。因此训练早期两组矩阵的更新过程不同。

标准 LoRA 训练通常让两组参数使用相同学习率。LoRA+ 保留 `lora_down` 的基础学习率，只提高 `lora_up` 的学习率：

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ 学习率计算公式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

倍率改变的是每次更新的幅度，而不是参数开始更新的时刻。倍率为 `1.0` 时，两组学习率仍然相同。

<!-- doc-anchor: faq -->
## 常见问题

**启用 LoRA+ 后效果反而变差或过拟合更早出现，怎么办？**

先关闭 LoRA+ 或把倍率降回 `1.0`，再检查基础学习率、数据重复度和停止时机。

**怎么确认 LoRA+ 真的生效了？**

启用后，TensorBoard 中会同时出现基础组和高倍率组两条曲线（如 `lr/unet` 与 `lr/unet plus`）。对常规优化器，两条曲线的比例应接近设定的倍率。

**为什么界面自动关闭了 LoRA+？**

请查看“优化器与调度器”兼容表；界面会按当前组合自动关闭并显示原因，后端也会拒绝不兼容配置。

**只训练文本编码器时，LoRA+ 还有用吗？**

会生效，但只作用于文本编码器。文本编码器的单独倍率优先，留空时使用全局倍率。

<!-- doc-anchor: references -->
## 依据与参考资料

配置传递与兼容性以 `backend/training/adapter.py`、`optimizer_contracts.py` 为准；参数分组、初始化与日志名称见 vendor 中的 `networks/lora.py`、`lora_anima.py`、`network_base.py`。下列固定提交链接保留为实现参考：

- [本项目 sd-scripts fork：`train_network_advanced.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [本项目 sd-scripts fork：`loha_lokr.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
