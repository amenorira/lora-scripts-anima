# LoRA+

> LoRA+ 是一种训练时学习率分组方法。它不是优化器，也不是学习率调度器，不会改变导出的 LoRA 格式或推理方式。

<!-- doc-anchor: overview -->
## 概览

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

<!-- doc-anchor: effects -->
## 它会影响什么

- **训练启动速度**：`lora_up` 能更快离开零初始化，目标特征可能更早出现在采样图中。
- **参数更新平衡**：只提高 `lora_up` 的学习率，避免为了加快收敛而同时放大所有 LoRA 参数。
- **固定步数下的学习量**：训练预算较短时，可能在相同步数内学到更明显的角色、服装或风格特征。
- **过拟合速度**：干净特征会更快学习，背景、特效、水印和错误标签也可能更快被记住。
- **训练日志**：启用后会产生普通参数组和 `plus` 参数组两条学习率记录，例如 `lr/unet` 与 `lr/unet plus`。

LoRA+ 不会增加推理显存，不会改变 `.safetensors` 的使用方法，也不会在生成图片时增加额外计算。

<!-- doc-anchor: good-cases -->
## 哪些训练更可能受益

以下情况更值得测试 LoRA+：

1. 使用 AdamW、AdamW8bit 等常规优化器，学习率行为容易解释。
2. 当前配置明显欠拟合，目标特征出现较慢，但直接提高整体学习率会造成不稳定。
3. 使用中高 Rank，例如 `16`、`32` 或 `64`，希望在固定步数内更充分利用 LoRA 容量。
4. 数据集主体一致、标签干净，背景和无关元素已经正确描述或清理。
5. 训练步数有限，希望更早看到有效学习结果。

对少图角色 LoRA，LoRA+ 可能让脸部、发型、服装等身份特征更早形成。但如果多张图片共享同一背景或构图，这些关联也会更快进入模型。

<!-- doc-anchor: cautions -->
## 哪些情况应谨慎使用

- 数据极少、重复图很多，普通训练已经容易过拟合。
- 基础学习率已经较高，再乘较大倍率可能导致震荡、细节破坏或泛化下降。
- 数据含有固定背景、特效、水印、伙伴角色或不准确标签。
- Rank 很低，或者当前配置已经在预期步数内稳定收敛，收益可能不明显。
- 使用内部接管学习率的优化器时，需要先确认它是否保留各参数组的独立学习率。

<!-- doc-anchor: optimizer-compatibility -->
## 优化器兼容性

| 优化器 | LoRA+ 状态 | 说明 |
| --- | --- | --- |
| AdamW、AdamW8bit、PagedAdamW8bit、Lion、CAME | 支持 | 保留各参数组学习率，倍率行为最容易解释。 |
| AdamWScheduleFree | 支持 | 保留参数组，但内部动态会参与实际学习率变化。 |
| Automagic3 | 条件支持 | 每个“基础学习率 × LoRA+ 倍率”的结果都必须位于 `min_lr` 与 `max_lr` 之间；训练过程中的组间倍率可能随自适应逻辑变化。 |
| AdaFactor | 仅手动学习率模式支持 | 必须关闭 `relative_step` 与 `warmup_init`。默认相对步长模式会忽略参数组学习率，界面会自动关闭并锁定 LoRA+。 |
| Prodigy、ProdigyPlus | 不支持 | 当前 sd-scripts 训练路径不能可靠保留 LoRA+ 多学习率语义，界面与后端都会阻止该组合。 |
| EmoSens | 不支持 | EmoSens 使用单一全局 `emoPulse` 更新所有参数，并在每步后统一各参数组学习率，因此 LoRA+ 倍率会失效。 |

切换到不兼容模式时，界面会自动关闭 LoRA+ 并显示锁定原因。后端仍会拒绝旧预设或手工 API 提交形成的不兼容组合。

<!-- doc-anchor: parameters -->
## sd-scripts 参数

界面的“启用 LoRA+”是本训练器的唯一控制开关，不会传给 sd-scripts。真正写入 `network_args` 的只有下面三个原生参数。高级“自定义网络参数”中的同名 `loraplus_*` 会被忽略，避免绕过界面联动和后端兼容性校验。

<!-- doc-anchor: loraplus-lr-ratio -->
### `loraplus_lr_ratio`

全局 LoRA+ 倍率，同时作为 UNet/DiT 和文本编码器的默认倍率。

```text
loraplus_lr_ratio=2.0
```

如果填写了更具体的组件倍率，对应组件会优先使用具体值。清空全局倍率并只填写组件倍率，可以只对某个组件启用 LoRA+。

<!-- doc-anchor: loraplus-unet-lr-ratio -->
### `loraplus_unet_lr_ratio`

仅设置 UNet 主干的倍率。在 Anima 训练路径中，sd-scripts 沿用这个参数名，但它实际对应主要的 DiT 网络。

```text
loraplus_unet_lr_ratio=2.0
```

少图角色训练建议先只对 UNet/DiT 使用 `2.0`，避免同时加速文本编码器。

<!-- doc-anchor: loraplus-text-encoder-lr-ratio -->
### `loraplus_text_encoder_lr_ratio`

仅设置文本编码器 LoRA 参数的倍率。

```text
loraplus_text_encoder_lr_ratio=2.0
```

文本编码器更容易快速绑定触发词，也更容易降低提示词泛化。除非明确需要训练文本编码器并观察到其学习不足，否则不建议一开始设置很高倍率。

<!-- doc-anchor: support -->
## 支持范围

本训练器按 sd-scripts 的实际实现，只在以下原生网络模块中提供开关：

| 网络模块 | LoRA+ 参数组 |
| --- | --- |
| `networks.lora` | `lora_up` |
| `networks.lora_anima` | `lora_up` |
| `networks.loha` | 第二组 LoHa 参数 |
| `networks.lokr` | LoKr 缩放参数组 |

`lycoris.kohya` 不显示这个开关，避免向当前模块传入未经确认的参数。

<!-- doc-anchor: testing -->
## 推荐测试方法

第一次测试建议保持数据集、Seed、Rank、Alpha、基础学习率和总步数不变，只改变 LoRA+：

1. 先运行不开 LoRA+ 的基线。
2. 仅设置 `loraplus_unet_lr_ratio=2.0`。
3. 如果仍明显欠拟合，再测试 `4.0`。
4. `8.0` 或 `16.0` 应在确认基础学习率不过高后再尝试，不要直接照搬论文倍率。

比较相同步数的采样图，重点观察身份特征形成速度、背景泄漏、构图僵化和提示词泛化。Loss 只能辅助判断，不能单独证明 LoRA+ 更好。

<!-- doc-anchor: tensorboard -->
## TensorBoard 记录

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

训练器的真实学习率记录层会读取各参数组的实际学习率，因此 TensorBoard 中的普通曲线与 `plus` 曲线都能反映优化器当前使用的数值。对 Automagic3、ScheduleFree 等内部动态优化器，应以曲线中的实时值为准，不要假定训练全过程始终保持初始倍率。
