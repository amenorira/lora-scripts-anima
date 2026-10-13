# AdaLN 调制层

<!-- doc-anchor: overview -->
## 调制层是什么

AdaLN 根据当前噪声强度，调整模型内部特征的缩放、偏移和分支强度，使模型适应不同去噪阶段。

开启后，在原训练范围上加入 AdaLN 调制层的适配器，增加参数量和权重文件大小。原生 Anima 网络默认关闭。该开关扩大可训练范围，不改变时间步采样分布。

<!-- doc-anchor: effects -->
## 训练范围的变化

| 设置 | 训练范围 | 影响 |
| --- | --- | --- |
| 关闭 | 原有选定的注意力、MLP 等模块 | AdaLN 的参数保持底模原样 |
| 开启 | 在原范围上加入 AdaLN 调制模块 | 可修改的通路增多，参数量与文件大小增加 |

<!-- doc-anchor: usage -->
## 如何比较开启与关闭

需要判断扩大训练范围是否有效时，固定数据、学习率、Rank、种子和总步数，只切换 AdaLN 开关；同时比较目标特征和提示词控制。

<!-- doc-anchor: default-behavior -->
## 上游默认行为

原生 Anima 网络默认排除匹配 `.*(_modulation|_norm|_embedder|final_layer).*` 的层，包括调制、归一化、嵌入和输出层（`networks/lora_anima.py`；原生 LoHa / LoKr 经 `network_base.py` 使用相同配置）。注意力和 MLP 的适配器仍会改变模型在不同时间步的预测，不能把“调制层未训练”理解为去噪行为不变。

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
