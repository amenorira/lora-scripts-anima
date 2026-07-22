# LoRA+

> LoRA+ 是一种训练时学习率分组方法。它不是优化器，也不是学习率调度器，不会改变导出的 LoRA 格式或推理方式。

## 概览 {#overview}

标准 LoRA 将权重增量写成两个低秩矩阵的乘积：

```text
delta W = scale * lora_up * lora_down
```

常见初始化方式是 `lora_down` 使用较小随机值、`lora_up` 初始化为零。因此训练刚开始时，`lora_up` 先承担主要更新，而 `lora_down` 的有效梯度较弱。普通 LoRA 给两部分相同学习率；LoRA+ 则让 `lora_up` 使用更高学习率：

```text
lora_down LR = base LR
lora_up LR   = base LR * LoRA+ ratio
```

例如基础学习率为 `1e-4`、倍率为 `2` 时，普通参数组使用 `1e-4`，`plus` 参数组使用 `2e-4`。

## 它会影响什么 {#effects}

- **训练启动速度**：`lora_up` 能更快离开零初始化，目标特征可能更早出现在采样图中。
- **参数更新平衡**：只提高 `lora_up` 的学习率，避免为了加快收敛而同时放大所有 LoRA 参数。
- **固定步数下的学习量**：训练预算较短时，可能在相同步数内学到更明显的角色、服装或风格特征。
- **过拟合速度**：干净特征会更快学习，背景、特效、水印和错误标签也可能更快被记住。
- **训练日志**：启用后会产生普通参数组和 `plus` 参数组两条学习率记录，例如 `lr/unet` 与 `lr/unet plus`。

LoRA+ 不会增加推理显存，不会改变 `.safetensors` 的使用方法，也不会在生成图片时增加额外计算。

## 哪些训练更可能受益 {#good-cases}

以下情况更值得测试 LoRA+：

1. 使用 AdamW、AdamW8bit 等常规优化器，学习率行为容易解释。
2. 当前配置明显欠拟合，目标特征出现较慢，但直接提高整体学习率会造成不稳定。
3. 使用中高 Rank，例如 `16`、`32` 或 `64`，希望在固定步数内更充分利用 LoRA 容量。
4. 数据集主体一致、标签干净，背景和无关元素已经正确描述或清理。
5. 训练步数有限，希望更早看到有效学习结果。

对少图角色 LoRA，LoRA+ 可能让脸部、发型、服装等身份特征更早形成。但如果多张图片共享同一背景或构图，这些关联也会更快进入模型。

## 哪些情况应谨慎使用 {#cautions}

- 数据极少、重复图很多，普通训练已经容易过拟合。
- 基础学习率已经较高，再乘较大倍率可能导致震荡、细节破坏或泛化下降。
- 数据含有固定背景、特效、水印、伙伴角色或不准确标签。
- Rank 很低，或者当前配置已经在预期步数内稳定收敛，收益可能不明显。
- 使用 Prodigy、DAdapt 等自动调整有效学习率的优化器。sd-scripts 文档明确说明它们不能与 LoRA+ 组合，本训练器会阻止 Prodigy 与 ProdigyPlus 在 LoRA+ 开启时使用。

ScheduleFree 和其他内部管理学习率的优化器通常能接收不同参数组，但实际倍率会和优化器内部动态共同作用，不能直接套用 AdamW 的经验。

## sd-scripts 参数 {#parameters}

界面的“启用 LoRA+”是本训练器的控制开关，不会传给 sd-scripts。真正写入 `network_args` 的只有下面三个原生参数。

### `loraplus_lr_ratio` {#loraplus-lr-ratio}

全局 LoRA+ 倍率，同时作为 UNet/DiT 和文本编码器的默认倍率。

```text
loraplus_lr_ratio=2.0
```

如果填写了更具体的组件倍率，对应组件会优先使用具体值。清空全局倍率并只填写组件倍率，可以只对某个组件启用 LoRA+。

### `loraplus_unet_lr_ratio` {#loraplus-unet-lr-ratio}

仅设置 UNet 主干的倍率。在 Anima 训练路径中，sd-scripts 沿用这个参数名，但它实际对应主要的 DiT 网络。

```text
loraplus_unet_lr_ratio=2.0
```

少图角色训练建议先只对 UNet/DiT 使用 `2.0`，避免同时加速文本编码器。

### `loraplus_text_encoder_lr_ratio` {#loraplus-text-encoder-lr-ratio}

仅设置文本编码器 LoRA 参数的倍率。

```text
loraplus_text_encoder_lr_ratio=2.0
```

文本编码器更容易快速绑定触发词，也更容易降低提示词泛化。除非明确需要训练文本编码器并观察到其学习不足，否则不建议一开始设置很高倍率。

## 支持范围 {#support}

本训练器按 sd-scripts 的实际实现，只在以下原生网络模块中提供开关：

| 网络模块 | LoRA+ 参数组 |
| --- | --- |
| `networks.lora` | `lora_up` |
| `networks.lora_anima` | `lora_up` |
| `networks.loha` | 第二组 LoHa 参数 |
| `networks.lokr` | LoKr 缩放参数组 |

`lycoris.kohya` 不显示这个开关，避免向当前模块传入未经确认的参数。

## 推荐测试方法 {#testing}

第一次测试建议保持数据集、Seed、Rank、Alpha、基础学习率和总步数不变，只改变 LoRA+：

1. 先运行不开 LoRA+ 的基线。
2. 仅设置 `loraplus_unet_lr_ratio=2.0`。
3. 如果仍明显欠拟合，再测试 `4.0`。
4. `8.0` 或 `16.0` 应在确认基础学习率不过高后再尝试，不要直接照搬论文倍率。

比较相同步数的采样图，重点观察身份特征形成速度、背景泄漏、构图僵化和提示词泛化。Loss 只能辅助判断，不能单独证明 LoRA+ 更好。

## TensorBoard 记录 {#tensorboard}

启用 LoRA+ 后，sd-scripts 会把普通组和高学习率组分开记录：

```text
lr/unet
lr/unet plus
```

如果训练文本编码器，还可能出现：

```text
lr/textencoder
lr/textencoder plus
```

训练器的真实学习率记录层会读取各参数组的实际学习率，因此 TensorBoard 中的普通曲线与 `plus` 曲线都能反映优化器当前使用的数值。
