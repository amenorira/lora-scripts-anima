# AdaLN 调制层

<!-- doc-anchor: overview -->
## 调制层是什么

AdaLN 根据当前噪声强度，调整模型内部特征的缩放、偏移和分支强度，使模型适应不同去噪阶段。

开启 AdaLN 训练后，适配器的训练范围会扩展到这些调制层，能影响形体、线条、配色和提示词响应。原生 Anima 网络默认关闭；人物、概念 LoRA 通常保持关闭，画风训练可在基准效果不足时测试开启。

| 设置 | 训练范围 | 影响 |
| --- | --- | --- |
| 关闭 | 原有选定的注意力、MLP 等模块 | AdaLN 的参数保持底模原样 |
| 开启 | 在原范围上加入 AdaLN 调制模块 | 可修改的通路增多，参数量与文件大小增加 |

<!-- doc-anchor: effects -->
## 训练调制层的影响

AdaLN 为模型增加可训练的调制通路，不改变噪声时间步的采样分布。开启后重点比较形体、线条和整体风格，同时检查提示词控制是否保留。

<!-- doc-anchor: usage -->
## 使用建议

- 人物、概念 LoRA：先使用默认训练范围；目标特征已学充分时无需开启。
- 画风 LoRA：需要扩大训练范围时，固定数据、学习率和种子，对比开启与关闭后的结果。

<!-- doc-anchor: default-behavior -->
## 上游默认行为

sd-scripts 创建 LoRA 网络时，内置一条排除正则 `.*(_modulation|_norm|_embedder|final_layer).*`，把调制层、归一化层、嵌入层和输出层一并排除（`vendor/sd-scripts/networks/lora_anima.py`；LoHa/LoKr 经 `network_base.py` 的 Anima 配置，行为相同）。所以默认练出的 LoRA 只作用于注意力与 MLP，"每个去噪阶段该怎么调"保持底模原样。

开启开关后，训练器向 `network_args` 注入：

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

只豁免这三个调制分支。如果自定义网络参数里已写了 `include_patterns`，两者会合并成一条。归一化、嵌入、输出层仍然排除。

增加的参数量和文件大小可在结构预览中查看；算法、rank 和训练范围都会影响增量。

<!-- doc-anchor: settings -->
## 与其他参数的关系

不同网络使用各自的 AdaLN 入口。

| 网络 | 使用入口 | 条件 |
| --- | --- | --- |
| 原生 Anima 网络 | 主表单中的“训练 AdaLN 调制层” | 支持 `networks.lora_anima`、`networks.loha`、`networks.lokr` |
| LyCORIS | LyCORIS 配置中的 AdaLN 选项 | 使用 `attn-mlp` 预设，并启用对齐 sd-scripts 默认范围 |

LyCORIS 的 `attn-mlp` 预设默认未启用“对齐 sd-scripts 默认范围”。此时不能用主表单开关的状态判断 AdaLN 是否参与训练，应查看 LyCORIS 的范围设置和结构预览。
