# AdaLN 调制层

> Anima 的每个 DiT 块里，除了自注意力、交叉注意力和 MLP，还有一组 AdaLN 调制层，负责按噪声程度调整特征的整体基调。sd-scripts 默认不训练这组层；参数页的"训练 AdaLN 调制层"开关可以把它们加进训练目标。画风类 LoRA 可以尝试开启，人物/概念类一般无需开启。

<!-- doc-anchor: overview -->
## 调制层是什么

去噪的每一步开始前，Anima 会按当前的噪声程度调整特征：每个通道乘一个系数、加一个偏移，自注意力、交叉注意力、MLP 三条分支的输出再各自按通道乘一个门控系数。这组系数不是写死在模型里的参数，而是由每个块里的三个小网络根据时间步即时算出来的。AdaLN（自适应归一化）说的就是这套机制，负责算系数的模块就是调制层。

每个块有三个调制模块，分别服务三条分支：`adaln_modulation_self_attn`、`adaln_modulation_cross_attn`、`adaln_modulation_mlp`。三个子层各自按 `x + gate × sublayer(norm(x) × (1 + scale) + shift)` 使用这些输出。每个模块是 SiLU → 2048→256 → 256→6144 的两段线性层（无偏置），6144 = 3 × 2048，对应缩放、平移、门控三组输出。调制模块只读时间步，不读文本。

调制层改变的是整张特征图的通道基调——整体变亮或变暗、对比变强或变弱——而不是"在哪个位置画什么"。它和注意力、MLP 起作用的面不同，所以单独设一个开关。

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

不训练时，LoRA 只改注意力与 MLP 的权重，特征的缩放、平移、门控与底模一致。训练后，LoRA 还能修改"时间步 → 缩放/平移/门控"这条映射，也就是每个去噪阶段特征的整体基调。

两点限制：

1. **稳定性**。调制层的一次更新影响整个块所有通道，作用面比注意力/MLP 大，训练更容易不稳（典型表现是色调漂移）。
2. **证据**。对官方 turbo 与 base 的权重差做 SVD 分析，调制层的上投影是整个差值里变化最大的部分之一（见 [anima_lora 的 AdaLN 文档](https://github.com/sorryhyun/anima_lora/blob/v1.14.3/docs/methods/adaln.md)，核查于 2026-08），说明官方蒸馏确实明显改动了这条通路。但"训练调制层能改善画风 LoRA"目前没有公开的对照出图实验支撑。

<!-- doc-anchor: usage -->
## 使用建议

- 人物、概念 LoRA：身份特征主要由注意力与 MLP 承载，一般无需开启。
- 画风 LoRA：可以开启，和关闭版用相同种子各练一次，以出图结果为准。

<!-- doc-anchor: settings -->
## 与其他参数的关系

- **rank 与 alpha**：与主网络相同，不可单独设置。上游不支持按模块设置 alpha（lora_anima.py 中命中 rank 正则的模块强制使用全局 network_alpha）；单独调低调制层 rank 而不改 alpha，会让该分支的缩放系数 alpha/rank 相对主网络偏大。
- **单独学习率**：在自定义网络参数中写 `network_reg_lrs=.*adaln_modulation.*=5e-5`。
- **块外的可训练模块**：DiT 里还有一组把 Qwen3 输出翻译成交叉注意力上下文的适配器（6 层、共 60 个线性层），由自定义网络参数 `train_llm_adapter=true` 单独控制，默认不训，与本开关无关。文本编码器（Qwen3）默认同样不训。
- **ComfyUI**：产物直接加载。ComfyUI 为每个模型权重建立 `lora_unet_` 键映射，调制层键可正常命中（[comfy/lora.py](https://github.com/comfyanonymous/ComfyUI/blob/2a610155821d670a2d8047e654e5fce96b790eb5/comfy/lora.py)，commit 2a61015，核查于 2026-08）。仓库自带的 `convert_anima_lora_to_comfy.py` 只在对外分发或与 diffusion-pipe 产物混用时需要。
- **适用范围**：`networks.lora_anima`、`networks.loha`、`networks.lokr`。`lycoris.kohya` 的 Anima 训练路径未验证，不受本开关影响。
