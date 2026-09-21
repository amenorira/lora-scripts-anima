# AdaLN 调制层

<!-- doc-anchor: overview -->
## 调制层是什么

AdaLN 根据当前噪声强度调整模型处理特征的方式。可以把它理解为各处理分支的调节器：模型在高噪声下建立整体形象、在低噪声下修正细节时，需要不同的特征缩放、偏移和分支强度。

开启 AdaLN 训练后，LoRA 不仅能修改注意力和 MLP，还能修改这些调节器。它改变的是模型内部特征，不是直接给图像调亮度或对比度，也不只影响配色。

| 设置 | 训练范围 | 影响 |
| --- | --- | --- |
| 关闭 | 原有选定的注意力、MLP 等模块 | AdaLN 的参数保持底模原样 |
| 开启 | 在原范围上加入 AdaLN 调制模块 | 可修改的通路增多，参数量与文件大小增加 |

<!-- doc-anchor: default-behavior -->
## 上游默认行为

sd-scripts 创建 LoRA 网络时，内置一条排除正则 `.*(_modulation|_norm|_embedder|final_layer).*`，把调制层、归一化层、嵌入层和输出层一并排除（`vendor/sd-scripts/networks/lora_anima.py`；LoHa/LoKr 经 `network_base.py` 的 Anima 配置，行为相同）。所以默认练出的 LoRA 只作用于注意力与 MLP，"每个去噪阶段该怎么调"保持底模原样。

开启开关后，训练器向 `network_args` 注入：

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

只豁免这三个调制分支。如果自定义网络参数里已写了 `include_patterns`，两者会合并成一条。归一化、嵌入、输出层仍然排除。

代价是文件变大：rank=32 时约增大五成。作为对照，diffusion-pipe 默认把块内所有 Linear 一并列为训练目标——调制层不排除，连 DiT 里的 LLM 适配器也一并训练，但嵌入层与输出层同样不在它的目标内。它与 sd-scripts 默认产物的体积差主要来自调制层。

<!-- doc-anchor: effects -->
## 训练调制层的影响

对于画风训练，加入 AdaLN 可以作为扩大训练范围的对照实验，观察形体、线条、配色和提示词响应是否变化。人物训练也没有理论上的禁止条件；是否有必要，应根据基准结果判断。

不能仅凭“作用于通道”推断它只控制色调，也不能由此断言它比注意力或 MLP 更不稳定。

<!-- doc-anchor: usage -->
## 使用建议

- 人物、概念 LoRA：身份特征主要由注意力与 MLP 承载，一般无需开启。
- 画风 LoRA：可以开启，和关闭版用相同种子各练一次，以出图结果为准。

<!-- doc-anchor: settings -->
## 与其他参数的关系

不同网络使用各自的 AdaLN 入口。

| 网络 | 使用入口 | 条件 |
| --- | --- | --- |
| 原生 Anima 网络 | 主表单中的“训练 AdaLN 调制层” | 以当前原生网络的支持范围为准 |
| LyCORIS | LyCORIS 配置中的 AdaLN 选项 | 使用 `attn-mlp` 预设，并启用对齐 sd-scripts 默认范围 |

文件增量取决于算法、维度与训练范围，使用结构预览查看当前配置，不把某次标准 LoRA 的增幅套用到所有网络。
