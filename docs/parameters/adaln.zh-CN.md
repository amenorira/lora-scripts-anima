<a name="guide-title"></a>
# AdaLN 调制层

<a name="overview"></a>
## 作用、参数增量与适用场景

AdaLN（自适应层归一化）根据当前去噪时间步的噪声强度，动态调节各 Transformer 块内部特征的缩放、偏移与残差门控强度，控制模型在高噪构图期与低噪细节期的响应方式。

原生 Anima 网络默认排除该分支。开启“训练 AdaLN 调制层”后，会在原有注意力与 MLP 目标之上为每个主干块的 3 组调制线性层额外挂接适配器，参数量与权重体积增幅显著（以 28 块 Anima-Preview、标准 LoRA Rank `32`、`bf16` 为例，40 块 Anima-2.9B 按块数同比例放大）：

| 开关状态 | 覆盖线性层数 | 可训练参数量 | 预计文件大小（`bf16`） |
| --- | --- | --- | --- |
| 关闭（原生默认） | `280` 层 | `45.88M` | `87.6 MiB` |
| 开启 | `448` 层（`+168` 层） | `69.27M`（**`+51.0%`**） | `132.3 MiB`（`+44.7 MiB`） |

<div id="effects"></div>
<div id="usage"></div>

- **建议保持关闭（默认）**：常规单一角色、五官发型、服装道具或样本量较少（`< 30` 张）的训练集。仅靠注意力与 MLP 已足以还原身份特征，关闭可节省约三分之一的权重体积并降低过拟合风险。
- **值得测试开启**：需要跨不同噪声阶段重塑画面整体色调、光影氛围、对比度层次或强烈画风的风格训练。
- **过拟合症状与对照方法**：若开启后生成图的打光方向、背景色调被死锁在训练集均值，或更换环境类提示词时响应迟钝，说明调制层过度记忆了训练图分布。评估收益时，固定数据集、Rank、学习率、种子与总步数，仅切换 AdaLN 开关对比同轮次存档。

<a name="settings"></a>
## 原生网络与 LyCORIS 的范围差异

<div id="default-behavior"></div>

原生 Anima 网络与 LyCORIS 预设对 AdaLN 的默认覆盖逻辑相反，切换网络模块时务必留意：

| 网络实现 | 界面入口 | 默认行为与开启条件 |
| --- | --- | --- |
| 原生 Anima 网络（`networks.lora_anima`、`networks.loha`、`networks.lokr`） | 主表单“训练 AdaLN 调制层” | **默认排除**；开启开关后豁免每个块的 3 组 AdaLN 调制层 |
| LyCORIS（`full`、`full-lin`，或未勾选范围对齐的 `attn-mlp`） | 无需额外勾选 | **默认已包含** AdaLN 调制层 |
| LyCORIS（`attn-mlp` + 勾选“对齐 sd-scripts 默认范围”） | LyCORIS 面板内的“训练 AdaLN 调制层” | 勾选范围对齐后会像原生网络一样排除 AdaLN；需再打开内嵌的 AdaLN 开关才会重新纳入 |

在原生 Anima 网络中，上游默认按正则排除匹配 `.*(_modulation|_norm|_embedder|final_layer).*` 的层（涵盖调制层、归一化层、条件嵌入层与输出层 `final_layer`）。打开主表单开关后，训练器会向 `network_args` 注入：

```text
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

该规则仅精确放行自注意力、交叉注意力与 MLP 三条调制分支（若“自定义网络参数”中已填写 `include_patterns`，会自动合并为同一条列表）；归一化层、嵌入层与输出层 `final_layer` 保持排除。修改开关或切换 LyCORIS 预设后，可在[矩阵结构与文件大小](matrix-preview.zh-CN.md)弹窗中直接核对实际覆盖层数与预计体积。
