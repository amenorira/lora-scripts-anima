# 网络参数

网络参数决定适配器的矩阵结构、训练范围和权重文件大小。新配置的默认丢弃率为 `0`，Rank / Alpha 按训练类型设置：

| 训练类型 | 默认 Rank / Alpha |
| --- | --- |
| Anima、SDXL、Krea 2 | `32/32` |
| MOSS-Image | `16/1` |

MOSS-Image 可选择原生 `networks.lora_generic`、`networks.loha` 或 `networks.lokr`。三者支持 rank/module dropout、LoRA+、正则 rank/学习率设置，以及可选的 DiT 文本投影与细化层；Qwen 文本编码器保持冻结。LoKr 额外支持 `lokr_factor`。

MOSS 的目标层均为线性层，界面仅提供线性层适用的参数，网络实现限定为上述三种原生模块。相同 rank 下，各算法的参数量和缩放可能不同，可用结构预览核对。

<!-- doc-anchor: moss-text-embedder -->
## MOSS 文本投影与细化层

`train_text_embedder` 默认关闭。开启后，按所选 LoRA / LoHa / LoKr 算法，为 DiT 的文本输入投影和两个细化块增加适配器。Qwen 文本编码器仍冻结，因此可继续使用文本缓存。

这部分默认使用主干学习率。需要单独指定时，在自定义网络参数中填写 `network_reg_lrs=.*text_embedder.*=5e-5`，将匹配层的学习率设为 `5e-5`。EmoSens 对所有参数使用统一学习率，此覆盖规则对它无效。

<!-- doc-anchor: dimension -->
## 网络维度

`network_dim` 是标准 LoRA 两个矩阵之间的维度，通常称为 rank。默认值见开头的训练类型表。

| 调整 | 可以得到什么 | 代价与限制 |
| --- | --- | --- |
| 提高维度 | 能表示更丰富的权重变化 | 参数、文件和优化器状态增加 |
| 降低维度 | 参数更少、文件更小 | 权重增量可表示的最大秩降低 |

比较不同算法时，使用结构预览中的实际参数量衡量配置规模。

<!-- doc-anchor: alpha -->
## Alpha

`network_alpha` 控制分支缩放，默认值见开头的训练类型表。标准 LoRA 的权重增量为：

```text
ΔW = (Alpha / rank) × B × A
```

固定 rank 和 A/B 权重时，Alpha 越大，分支输出越强；越小则越弱。初次训练保留默认值。Alpha 也影响训练梯度，调整后应重新检查学习率。

| 配置 | 标准分支缩放 | 说明 |
| --- | --- | --- |
| rank 32，Alpha 32 | 1 | 不额外缩小矩阵乘积 |
| rank 32，Alpha 16 | 0.5 | 同一矩阵乘积的输出贡献减半 |
| rank 16，Alpha 16 | 1 | 缩放也是 1，但中间维度和参数量与 rank 32 不同 |

`rs_lora` 默认关闭。受支持的低秩路径开启后，分母改为 √rank，减轻高维度下的缩放衰减。测试高 rank 配置时可比较这一选项，并重新检查学习率。

以上公式介绍标准 LoRA。LoKr 中直接存储完整因子时还有特殊处理，见下文。

<!-- doc-anchor: algorithms -->
## LoRA、LoHa 与 LoKr

| 算法 | 怎样表示变化 | 对配置的含义 |
| --- | --- | --- |
| LoRA | 两个低秩矩阵相乘 | rank 直接决定中间维度 |
| LoHa | 两组低秩结果再逐元素相乘 | dim 决定两组低秩乘积各自的中间维度 |
| LoKr | 两个因子做 Kronecker 积，因子还可继续低秩分解 | factor 与 dim 分别控制两层不同的分解 |

标准 LoRA 是默认起点。比较 LoHa、LoKr 时，使用结构预览核对参数量，再用相同提示词与种子比较还原度和新场景表现。

<!-- doc-anchor: lokr-factor -->
## LoKr 分解因子

LoKr 的基本形式是 `ΔW = scale × (W1 ⊗ W2)`。W1 和 W2 通过 Kronecker 积共同表示权重增量。

`factor` 决定两个因子的尺寸搭配，在完整矩阵模式下仍然有效。`dim` 决定因子内部继续低秩分解时的中间维度。

界面字段为 `lokr_factor`，传入网络时使用 `factor`。`-1` 自动选择接近均衡的尺寸拆分；填写具体值会改变两个 Kronecker 因子的尺寸，修改后查看结构预览中的形状和参数量。

下面比较一个 2048×2048 权重层的完整因子表示，使用均衡分解：

| factor | W1 形状 | W2 形状 | 两因子参数量 |
| --- | --- | --- | --- |
| 4 | 4×4 | 512×512 | 262,160 |
| 8 | 8×8 | 256×256 | 65,600 |

在此例中，factor 从 4 增至 8 会减小参数量。其他层按各自尺寸拆分，整个适配器的大小以结构预览为准。

<!-- doc-anchor: full-matrix -->
## 完整矩阵与双因子分解

LyCORIS LoKr 的 `full_matrix` 和 `decompose_both` 默认关闭。开启 `full_matrix` 后，W1 和 W2 都直接保存为矩阵，忽略 `decompose_both`。关闭时，dim 达到对应因子的尺寸阈值也会触发完整矩阵存储。

| 设置 | W1 | W2 |
| --- | --- | --- |
| 非完整矩阵，关闭双因子分解 | 直接矩阵 | 由 dim 与尺寸决定是否低秩分解 |
| 非完整矩阵，开启双因子分解 | 满足条件时继续低秩分解 | 由 dim 与尺寸决定是否低秩分解 |
| 显式开启完整矩阵 | 直接矩阵 | 直接矩阵 |

两个因子都直接保存时，提高 dim 不再增加这两个因子的参数量，但当前实现的缩放仍需区分：

| 两因子均为完整矩阵 | 内部 Alpha | 模块的 scale |
| --- | --- | --- |
| `rs_lora=false` | 使用 dim | 1 |
| `rs_lora=true` | 使用 dim | √dim |

上述缩放规则适用于本项目的 LyCORIS LoKr，可在结构预览中核对。

<!-- doc-anchor: unbalanced -->
## 不平衡分解

不平衡分解交换输出维度拆分后两部分的分配，使 W1 和 W2 采用另一组长宽搭配。参数量取决于层的输入、输出维度和分解方式；在结构预览中比较切换前后的实际数值。

`unbalanced_factorization` 默认关闭。仅在比较矩阵形状或压缩方案时调整，并同时查看参数量和缩放。

<!-- doc-anchor: dropout -->
## 网络丢弃与标注丢弃

网络丢弃在训练时随机屏蔽特征或分支，默认概率为 `0`。提高概率会使更多前向计算跳过对应元素、通道或分支。出现固定姿势、背景绑定时，先比较更早的检查点，再单独测试丢弃设置。

| 类型与配置键 | 丢弃对象 | 主要目的 |
| --- | --- | --- |
| 标准 LoRA 特征丢弃 `network_dropout` | 中间特征中的部分元素 | 减少对固定特征组合的依赖 |
| 标准 LoRA 秩丢弃 `rank_dropout` | 部分低秩通道 | 减少对少数通道的依赖 |
| 模块丢弃 `module_dropout` | 某层的整个适配器分支 | 该层在被丢弃的前向计算中使用底模输出 |
| 完整标注丢弃 `caption_dropout_rate` | 整段文字条件 | 加入无文字条件的训练，图片仍参与 |
| 标签丢弃 `caption_tag_dropout_rate` | 部分标签 | 减少对完整标签组合的依赖 |

丢弃不会删除保存文件中的参数。固定保留的开头标签能避开单标签丢弃，但不能阻止整段标注被丢弃。

当前 LyCORIS LoKr 还必须按实际前向计算路径区分：

| LoKr 的实际计算路径 | 普通特征 Dropout | Rank Dropout |
| --- | --- | --- |
| 旁路输出计算 | 作用于适配器输出 | 此路径不使用 |
| 重建权重计算 | 此路径不使用 | 按输出通道屏蔽合成的更新权重 |

模块丢弃在两条路径中均生效。量化和权重分解设置会影响实际路径；调整特征或秩丢弃前，应确认当前使用哪条路径。

Anima 的 LyCORIS DoRA（`dora_wd`）按层类型选择计算路径：

| 层类型 | DoRA 的使用条件 |
| --- | --- |
| 普通 Linear/Conv：LoCon、LoHa、LoKr | 关闭 `bypass_mode`，通过重建权重应用可训练的幅度参数；该路径不使用特征丢弃 |
| FP8 weight-only：LoKr | 开启 DoRA 后强制重建权重，覆盖 Bypass 设置 |
| FP8 weight-only：LoCon、LoHa | 当前实现不支持在这些层创建 DoRA 适配器 |

Krea 2 的量化与旁路限制见下方专节。

<!-- doc-anchor: preview -->
## 用结构预览核对配置

修改维度、factor、完整矩阵或不平衡分解后，可在结构预览中检查实际矩阵、参数量和缩放。比较不同算法时记录实际可训练参数量；对照方法见[时间步指南中的实验步骤](timesteps.zh-CN.md#comparison-method)。

<!-- doc-anchor: krea-targets -->
## Krea 2：默认训练范围与筛选

默认 Rank / Alpha 为 `32/32`，覆盖 DiT 的全部 264 个 Linear 层：主块 attention、MLP、文本融合 transformer 和投影 MLP。文本融合层属于 DiT，Qwen 文本编码器仍冻结并使用缓存。调制和 RMSNorm 使用原始张量，自动排除在 Linear LoRA 的目标范围外。

Krea 2 可选择原生 LoRA，或通过 LyCORIS 配置面板选择 LoCon、LoKr、LoHa。四种方式共用“训练目标层”选项：全部 Linear（264 层）、主干 Attention（140 层）、主干 Attention + MLP（224 层）、自定义正则。全部 Linear 包含输入输出、时间投影及文本融合投影层。

自定义正则每行一项，对原始 Linear 层名完整匹配；排除优先于包含。例如，包含 `blocks\.[0-9]+\.attn\..*` 选择主干注意力，包含 `.*` 并排除 `txtfusion\..*` 则去掉文本融合层。没有匹配目标时，启动前会报错。

LyCORIS 面板按算法提供 factor、Full Matrix、双因子分解、不平衡分解、标量、rsLoRA、DoRA、旁路模式和内核后端等适用选项。Krea 2 的训练目标均为线性层。

| 算法 | 丢弃与 LoRA+ 支持 |
| --- | --- |
| 原生 LoRA | 支持 rank/module dropout 与 LoRA+ |
| LyCORIS LoCon | 支持普通 dropout、rank/module dropout 与 LoRA+；普通 dropout 为正数时启用旁路，使用 DoRA 时需将普通 dropout 设为 `0` |
| LyCORIS LoHa | 支持 rank/module dropout |
| LyCORIS LoKr | 当前路径仅提供 module dropout |

FP8 或 ConvRot INT8 底模会强制 LyCORIS 使用旁路模式。使用 DoRA 时，需要关闭这两种量化和 `bypass_mode`。

保存或迁移配置请使用 `training.yaml`，运行目录中的目标预设由程序自动生成。

旧版原生 LoRA 的“网络附加参数”仍兼容下列写法，但须将目标范围保留为“全部 Linear”；新配置建议直接选择目标范围：

```text
exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']
```

旧版原生参数中，`include_patterns` 会加回匹配层，不会自动排除默认目标。LyCORIS 请使用目标范围和参数控件，避免将原生 LoRA 参数混入 LyCORIS。

[Krea 2 上游指南](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー)
