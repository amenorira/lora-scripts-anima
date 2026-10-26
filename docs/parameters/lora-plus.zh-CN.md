# LoRA+

> LoRA+ 为适配器的两组参数设置不同学习率，参数量保持不变。默认关闭，开启后的默认倍率为 `2.0`。

支持 SDXL、Anima、MOSS-Image 的适用网络，以及 Krea 2 的原生 LoRA 和 LyCORIS LoCon。各网络的分组见“支持范围”，优化器限制见兼容表。

<!-- doc-anchor: overview -->
## 快速理解

标准 LoRA 中，`lora_down` 保持基础学习率，`lora_up` 使用基础学习率乘以倍率。

倍率为 `1.0` 时两组学习率相同。Krea 2 还允许小于 `1` 的正倍率，此时 `lora_up` 的学习率低于基础值。

以基础学习率 `2e-5` 为例：

| 倍率 | `lora_down` 学习率 | `lora_up` 学习率 |
| --- | --- | --- |
| 1 | `2e-5` | `2e-5` |
| 2 | `2e-5` | `4e-5` |
| 4 | `2e-5` | `8e-5` |

提高基础学习率会同时影响两组参数；提高 LoRA+ 倍率只提高指定参数组。

<!-- doc-anchor: good-cases -->
## 什么时候值得试

已有不启用 LoRA+ 的基准结果后，固定基础学习率和其余设置，单独比较倍率 `1` 与 `2`。记录相同步数的结果，以及各组最佳结果所在的步数。

<!-- doc-anchor: ratio-guidance -->
## 倍率选多少

从默认倍率 `2.0` 开始，与等学习率基准 `1.0` 比较。测试其他倍率时保持基础学习率不变，按上方示例计算应用倍率后的学习率。

论文和 sd-scripts 文档中的 `16` 是相应实验使用的倍率，本训练器默认使用 `2.0`。两者应结合各自基础学习率比较。

<!-- doc-anchor: parameters -->
## 训练器参数

“启用 LoRA+”关闭时不输出倍率，开启后使用界面的倍率字段。SDXL、Anima、MOSS-Image 的自定义网络参数中的同名 `loraplus_*` 项会被清理，以界面值为准。Krea 2 导入旧配置时，会将附加参数中的全局倍率迁移到界面字段。

以下示例展示导出训练 TOML 的写法。倍率属于 `network_args`；设置多个倍率时，合并到同一个列表中。Krea 2 仅提供全局倍率，使用 LoRA+ 时需手动配置 Rank 和 Alpha，并关闭“从权重推导维度”。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局倍率，默认 `2.0`。UNet/DiT 和文本编码器的单独倍率留空时使用该值。

| 训练类型 | 界面最小值 | 步进 |
| --- | --- | --- |
| SDXL、Anima、MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

只覆盖 UNet/DiT 的倍率，默认留空并使用全局值。Anima、MOSS-Image 沿用 `unet` 参数名，实际对应 DiT 主干。该字段用于 sd-scripts 训练路径。

仅训练文本编码器时，此参数无效。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

只覆盖文本编码器 LoRA 参数的倍率，默认留空并使用全局值。

仅在文本编码器参与训练时生效。“仅训练 UNet”或文本编码器输出缓存会使其无效。MOSS-Image、Krea 2 的文本编码器保持冻结。调整后检查触发词响应和其他提示词的控制力。

倍率按“组件倍率 → 全局倍率 → 关闭该组件的 LoRA+”依次回退：

| 训练部分 | 优先使用 | 留空时使用 |
| --- | --- | --- |
| 主干网络 | 主干 LoRA+ 倍率 | 全局 LoRA+ 倍率 |
| 文本编码器 | 文本编码器 LoRA+ 倍率 | 全局 LoRA+ 倍率 |

sd-scripts 的多倍率导出示例：

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

<!-- doc-anchor: effective-lr -->
## 实际学习率

sd-scripts 路径先确定各组件的基础学习率，再对指定参数组应用倍率：

| 训练部分 | 优先读取 | 为空时回退到 |
| --- | --- | --- |
| UNet/DiT | `unet_lr` | `learning_rate` |
| 文本编码器 | `text_encoder_lr` | `learning_rate` |

Krea 2 使用 `learning_rate` 作为 DiT 的基础学习率。

单独填写 `unet_lr` 或 `text_encoder_lr` 时，对应组件按自己的学习率计算。例如 `learning_rate=1e-4`、`unet_lr=8e-5`、UNet/DiT 倍率为 `2.0` 时：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet LoRA+ 实际学习率示例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<!-- doc-anchor: cautions -->
## 风险与限制

比较较高倍率时，缩短保存间隔，检查最佳结果是否提前，以及后续检查点是否出现固定姿势、背景或提示词控制下降。

<span id="effects"></span>

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
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留不同参数组的独立学习率 |
| Lion、Lion8bit、PagedLion8bit | 支持 | 保留不同参数组的独立学习率 |
| CAME | 支持 | 保留不同参数组的独立学习率 |
| StableAdamW、Muon、Adan、AdEMAMix、AdEMAMix8bit、SOAP | 支持 | 保留不同参数组的独立学习率 |
| AdamWScheduleFree | 支持 | 保留参数组，但内部调整会改变训练中的实际学习率 |
| Automagic3 | 条件支持 | 两组初始学习率必须在 `min_lr` 与 `max_lr` 之间。各参数组独立调整学习率，初始倍率关系不固定 |
| AdaFactor | 仅手动学习率模式 | `relative_step` 与 `warmup_init` 必须关闭。默认相对步长模式会忽略参数组学习率，界面会自动关闭并锁定 LoRA+ |
| Prodigy、ProdigyPlus | 不支持 | 当前 sd-scripts 训练路径无法可靠保留不同参数组的独立学习率，界面与后端都会阻止该组合 |
| EmoSens | 不支持 | EmoSens 用单一全局 `emoPulse` 更新所有参数，并在每步后统一各参数组学习率，倍率会失效 |
| LoRA-Muon | 不支持 | 当前联合更新实现需要完整的 LoRA 因子配对 |
| LoRA-RITE | 不支持 | 当前实现的因子配对与 LoRA+ 参数分组不兼容 |

切换到不兼容模式时，界面会自动关闭 LoRA+ 并显示原因。后端也会拒绝旧预设或直接调用 API 形成的不兼容组合。

本训练器的常规外部调度器对各参数组应用相同缩放比例，保留初始倍率关系。Warmup 调整训练早期的整体学习率，不改变分组方式。内部自适应优化器还会改变实际步长，查看日志时区分参数组学习率和实际更新尺度。

<!-- doc-anchor: support -->
## 支持范围

以下网络模块提供 LoRA+ 开关：

| 网络模块 | 应用倍率的参数 | 说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | 标准 LoRA+ 分组 |
| `networks.lora_anima` | `lora_up` | Anima 使用的标准 LoRA+ 分组 |
| `networks.lora_generic` | `lora_up` | MOSS 使用的标准 LoRA+ 分组 |
| `networks.lora_krea2` | `lora_up` | Krea 2 原生 LoRA 分组 |
| `networks.loha` | `hada_w2_a` | sd-scripts 对 LoHa 的扩展映射 |
| `networks.lokr` | `lokr_w1` | sd-scripts 对 LoKr 的扩展映射 |
| `lycoris.kohya`（仅 LoCon/算法 `lora`） | `lora_up` 等 | Anima、Krea 2 的 LoCon 按参数名 `lora_up` 分组 |

sd-scripts 的原生 LoHa、LoKr 使用各自的分组映射。LyCORIS 的 LoRA+ 仅支持 LoCon（`lora`）。

<!-- doc-anchor: tensorboard -->
## TensorBoard 记录

启用 LoRA+ 且同时训练主干与文本编码器时，标准 SDXL LoRA 记录以下组名：

```text
lr/unet
lr/unet plus
lr/textencoder
lr/textencoder plus
```

Krea 2 仅训练 DiT，启用 LoRA+ 后记录 `lr/unet` 与 `lr/unet plus`。

Anima 的文本编码器组名带编号；训练该组件时记录：

```text
lr/textencoder 1
lr/textencoder 1 plus
```

名称中的 `plus` 表示应用倍率的参数组。使用分块学习率或其他多组参数配置时，名称和曲线数量还会增加。核对倍率的方法见下方常见问题。

<!-- doc-anchor: mechanism -->
## 技术原理

标准 LoRA 用两个较小矩阵表示原层的权重变化。`lora_down` 把输入映射到 rank 维，`lora_up` 再映射到该层的输出维度。

例如，某层输入为 2048 维、输出为 8192 维，rank 为 32 时，LoRA 分支是：

```text
2048 维输入 → lora_down → 32 维 → lora_up → 8192 维输出
```

权重增量为 `ΔW = (Alpha / rank) × B × A`，其中 A 对应 `lora_down`，B 对应 `lora_up`。

在当前 sd-scripts 实现中，`lora_down` 随机初始化，`lora_up` 初始化为零。第一次反向传播时，因为 `lora_up` 为零，`lora_down` 的梯度也暂时为零；`lora_up` 更新后，`lora_down` 才开始获得非零梯度。因此训练早期两组矩阵的更新过程不同。

未启用 LoRA+ 时，两组使用相同学习率。启用后，`lora_down` 保持基础学习率，`lora_up` 乘指定倍率：

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ 学习率计算公式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

<!-- doc-anchor: faq -->
## 常见问题

**启用 LoRA+ 后效果反而变差或过拟合更早出现，怎么办？**

先关闭 LoRA+ 或把倍率降回 `1.0`，再检查基础学习率、数据重复度和停止时机。

**怎么确认 LoRA+ 真的生效了？**

启用 TensorBoard 记录后，查看参与训练组件的基础组与 plus 组曲线，例如 `lr/unet` 与 `lr/unet plus`。常规优化器在两组都训练且学习率非零的区间，曲线比率应与设定倍率一致。自适应分组学习率按各组状态变化，需逐组查看曲线，并结合专用指标和生成结果评估。

<!-- doc-anchor: references -->
## 依据与参考资料

sd-scripts 的配置传递见 `backend/training/adapter.py`；Krea 2 的倍率与网络限制见 `krea2_network.py`、`krea2_optimizers.py`。优化器兼容性见 `optimizer_contracts.py`。参数分组、初始化与日志名称见 vendor 中的 `networks/lora.py`、`lora_anima.py`、`network_base.py`。下列链接固定到对应提交：

- [本项目 sd-scripts fork：`train_network_advanced.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md)
- [本项目 sd-scripts fork：`loha_lokr.md`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
- [LoRA+: Efficient Low Rank Adaptation of Large Models](https://arxiv.org/abs/2402.12354)
