# AdaLN 调制层

Anima 的每个 DiT 块包含三类可被 LoRA 修改的结构：自注意力、交叉注意力、MLP，以及一组 AdaLN 调制层。sd-scripts 默认把调制层排除在 LoRA 之外；参数页的"训练 AdaLN 调制层"开关可以把它们加回训练目标。

<!-- doc-anchor: overview -->
## 调制层是什么

去噪过程中，特征在每个通道上会被乘一个系数、加一个偏移，部分位置再乘一个门控。在 Anima 中这些系数不是固定参数，而是由一个小型网络根据当前的时间步（噪声水平）现场算出来的。AdaLN（自适应归一化）指的就是这个过程：归一化所需的缩放与平移由条件实时生成，负责计算它们的模块就是调制层。

每个块有三个调制模块，分别对应自注意力、交叉注意力、MLP 三条分支：`adaln_modulation_self_attn`、`adaln_modulation_cross_attn`、`adaln_modulation_mlp`。每个模块是 SiLU → 2048→256 → 256→6144 的瓶颈结构，6144 = 3 × 2048，对应缩放、平移、门控三组输出。三个子层各自按 `x + gate × sublayer(norm(x) × (1 + scale) + shift)` 使用这些输出。调制模块只读取时间步信息，不读取文本。

调制层改变的是整个特征图的通道统计（整体变亮或变暗、对比增强或减弱），而不是"在哪个位置生成什么内容"，所以它的作用维度与注意力、MLP 不同。

<!-- doc-anchor: default-behavior -->
## 上游默认行为

sd-scripts 创建 LoRA 网络时内置一条排除正则 `.*(_modulation|_norm|_embedder|final_layer).*`，把调制层、归一化层、嵌入层和输出层一并排除（`vendor/sd-scripts/networks/lora_anima.py`；LoHa/LoKr 经 `network_base.py` 的 Anima 配置，行为相同）。因此默认配置下 LoRA 只作用在注意力与 MLP 上。

开启开关后，训练器向 `network_args` 注入：

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

仅这三个调制分支获得豁免。如果自定义网络参数中已有 `include_patterns`，两者合并为一条。归一化、嵌入、输出层仍然排除。

文件大小：rank=32 时约增大五成。作为对照，diffusion-pipe 默认训练全部层；它与 sd-scripts 默认产物在同参数下的体积差异主要来源于此。

<!-- doc-anchor: effects -->
## 训练调制层的影响

不训练时，LoRA 只修改注意力与 MLP 的权重，特征的缩放、平移、门控保持底模原状。训练后，LoRA 还能修改"时间步 → 缩放/平移/门控"的映射，即改变每个去噪阶段特征的整体统计。

两点限制：

1. **稳定性**。一次调制更新影响整个块所有通道的统计，作用面比注意力/MLP 大，训练中更可能出现不稳定（例如色调偏移）。
2. **证据**。对官方 turbo 与 base 权重差做 SVD 分析，调制层上投影是整个差值中变化最大的部分之一（见 [anima_lora 的 AdaLN 文档](https://github.com/sorryhyun/anima_lora/blob/v1.14.3/docs/methods/adaln.md)，核查于 2026-08），说明官方蒸馏过程确实显著改动了这条通路。但"训练调制层能改善画风 LoRA"这一说法，截至核查日期没有公开的对照出图实验。

<!-- doc-anchor: usage -->
## 使用建议

- 人物、概念 LoRA：身份特征主要由注意力与 MLP 承载，目前没有观察到调制层带来的明显差别，一般无需开启。
- 画风 LoRA：可以开启，与关闭版本用相同种子对照，以出图结果为准。

<!-- doc-anchor: settings -->
## 与其他参数的关系

- **rank 与 alpha**：与主网络相同，不可单独设置。上游不支持按模块设置 alpha（`lora_anima.py` 中命中 rank 正则的模块强制使用全局 `network_alpha`）；单独调低调制层 rank 而不改 alpha，会使该分支的缩放系数 alpha/rank 相对主网络偏大。
- **单独学习率**：在自定义网络参数中写 `network_reg_lrs=.*adaln_modulation.*=5e-5`。
- **ComfyUI**：产物直接加载。ComfyUI 为每个模型权重建立 `lora_unet_` 键映射，调制层键可正常命中（[comfy/lora.py](https://github.com/comfyanonymous/ComfyUI/blob/2a610155821d670a2d8047e654e5fce96b790eb5/comfy/lora.py)，commit 2a61015，核查于 2026-08）。仓库自带的 `convert_anima_lora_to_comfy.py` 只在对外分发或与 diffusion-pipe 产物混用时需要。
- **适用范围**：`networks.lora_anima`、`networks.loha`、`networks.lokr`。`lycoris.kohya` 的 Anima 训练路径未验证，不受本开关影响。