<a name="guide-title"></a>
# 网络参数

网络参数决定适配器的矩阵分解结构、训练覆盖范围和权重文件大小。新建配置的默认丢弃率为 `0`，Rank / Alpha 默认值按训练类型区分：

| 训练类型 | 默认 Rank / Alpha |
| --- | --- |
| Anima、SDXL、Krea 2 | `32 / 32` |
| MOSS-Image | `16 / 1` |

修改算法、Rank、分解因子或目标层后，可在[矩阵结构与文件大小](matrix-preview.zh-CN.md)弹窗中实时核对可训练参数量、缩放倍率与 `.safetensors` 预计体积。

<a name="algorithms"></a>
## LoRA、LoHa 与 LoKr

| 算法 | 权重增量表示 | 特点与选择建议 |
| --- | --- | --- |
| 标准 LoRA / LoCon | 两个低秩矩阵相乘 `B × A` | 推理端兼容性最广（ComfyUI、WebUI、Diffusers），支持 [LoRA+](lora-plus.zh-CN.md) 及配对因子优化器（`LoRA-Muon`、`LoRA-RITE`），建议作为默认起点 |
| LoHa | 两组低秩乘积再逐元素相乘（Hadamard 积） | 相同 Rank 下有效秩上限更高，但**可训练参数量约为标准 LoRA 的 2 倍**；对齐文件体积时通常将 Rank 减半，适合多概念或复杂画风测试 |
| LoKr | 两个因子做 Kronecker 积 `W1 ⊗ W2`，因子内部可继续低秩分解 | 由 `lokr_factor` 与 Rank 共同控制形状，常用起点为 Rank `8–16`；兼顾小体积压缩与高秩表达，推理端需确认加载器支持 LyCORIS |

各训练类型支持的网络模块如下：

- **Anima、SDXL**：可选 `sd-scripts` 原生模块（`networks.lora_anima` / `networks.lora`、`networks.loha`、`networks.lokr`）或 `lycoris.kohya`（LoCon、LoHa、LoKr）。
- **MOSS-Image**：目标均为线性层，限定使用原生 `networks.lora_generic`、`networks.loha`、`networks.lokr`。三者均支持秩/模块丢弃、[LoRA+](lora-plus.zh-CN.md)、按正则表达式覆盖局部 Rank / 学习率（`network_reg_dims` / `network_reg_lrs`），以及可选的 [DiT 文本投影与细化层](#moss-text-embedder)；Qwen 文本编码器保持冻结。
- **Krea 2**：可选原生 LoRA（`networks.lora_krea2`）或 LyCORIS（LoCon、LoHa、LoKr），覆盖最多 264 个 DiT 线性层，筛选规则见 [Krea 2 训练范围与筛选](#krea-targets)。

对比不同算法时，先在[结构预览](matrix-preview.zh-CN.md)中对齐总可训练参数量，再用相同提示词与种子评估还原度和泛化表现（对照步骤见[时间步指南](timesteps.zh-CN.md#comparison-method)）。

<a name="dimension"></a>
## Rank（网络维度）

`network_dim`（Rank）指定低秩分解的中间维度。Anima、SDXL、Krea 2 默认 `32`，MOSS-Image 默认 `16`。

| 典型场景与现象 | 标准 LoRA 参考范围 | 说明与排查 |
| --- | --- | --- |
| 单一角色、面部特征或简单物件 | `16–32`（LoKr 常用 `8–16`） | 足以学习五官、发型与单套服饰特征，兼顾泛化与较小文件体积 |
| 多套服装、复杂画风或大中型数据集 | `32–64`（LoHa 常用 `16–32`） | 容纳更丰富的材质、光影和笔触变化 |
| Rank 偏低（复杂目标设为 `4–8`） | 按需上调至 `16–32` | Loss 趋平后五官细节、服装纹样或笔触质感仍模糊、欠拟合 |
| Rank 偏高（15–30 张小图集设为 `64–128+`） | 下调至 `16–32` | 文件与优化器状态显著增大，更容易把训练集背景、固定姿势和噪点一并背下 |

<a name="alpha"></a>
## Alpha 与 rsLoRA

标准 LoRA 在前向与保存应用时按 `Alpha / Rank` 缩放矩阵乘积，参数量与文件体积保持不变：

```text
ΔW = (Alpha / Rank) × B × A
```

固定 Rank 与学习率时，调小 Alpha 会按比例缩小单步有效更新幅度与反传梯度，同时让内部权重以更大的数值表达相同的 `ΔW`（早期 Kohya 引入该参数也用于减轻 FP16 / BF16 保存时极小权重下溢舍入为 `0` 的损失）；调大 Alpha 则放大有效更新强度。

<a name="alpha-choice"></a>
### 常用取值与快捷按钮

初次训练保留默认值即可（Anima、SDXL、Krea 2 为 `32 / 32`，MOSS-Image 为 `16 / 1`）；套用现成配方时，须将 Rank、Alpha 与学习率成套沿用。以 Rank `32`、标准 LoRA 为例：

| 快捷按钮 | Alpha | `Alpha / Rank` 倍率 | 适用场景 |
| --- | --- | --- | --- |
| `= dim` | `32` | `1.0` | 无额外缩放，适合大多数常规训练起点 |
| `½ dim` | `16` | `0.5` | 温和压低前期更新冲劲、平滑收敛时优先尝试 |
| `1` | `1` | `1/32`（`0.03125`） | 沿用 MOSS-Image 等小 Alpha 配方，或搭配较高学习率做细粒度微调 |

快捷按钮仅在点击时计算一次数值，后续修改 Rank 时 Alpha 保持原值。部分原生实现会将 `Alpha = 0` 视为等于 Rank（倍率为 `1.0`）。

<a name="alpha-lr"></a>
### 与学习率联动

AdamW 等自适应优化器会根据梯度一阶、二阶统计量归一化步长，实际更新速度不会随 `Alpha / Rank` 呈线性变化——把 Alpha 从 `32` 改到 `1` 时，切勿直接将学习率乘以 32 倍。调整时先固定其余参数并保存多轮存档：若收敛明显迟缓再小幅上调学习率；若前期色彩过曝或迅速锁死姿势，则优先下调学习率。

<a name="rslora"></a>
### rsLoRA（秩稳定缩放）

开启 `rs_lora` 后，缩放分母由 `Rank` 改为 `√Rank`（`ΔW = (Alpha / √Rank) × B × A`），用于缓解高 Rank 下有效更新衰减。

切换开关会大幅改变实际缩放倍率：以 Rank `32` 为例，保持 `Alpha = 32` 时倍率会从 `1.0` 跳升至 **`√32 ≈ 5.66`**；`Alpha = 1` 时倍率也会从 `0.03125` 升至 **`≈ 0.177`**。开启 `rs_lora` 后务必同步调低 Alpha（如设为 `1` 或 `4–8`）或下调学习率，否则极易引发前期梯度爆炸或过早过拟合。LoHa、LoKr 的具体缩放可在[结构预览](matrix-preview.zh-CN.md)中核对，LoKr 完整因子的缩放见[完整矩阵与双因子分解](#full-matrix)。

参考：[Kohya 参数说明](https://github.com/bmaltais/kohya_ss/wiki/LoRA-training-parameters#network-alpha) · [LoRA 原论文 §4.1](https://arxiv.org/html/2106.09685v2#S4.SS1) · [rsLoRA 论文](https://arxiv.org/html/2312.03732v1)

<a name="lokr-factor"></a>
## LoKr 分解因子

LoKr 通过两个因子的 Kronecker 积表示权重增量：`ΔW = scale × (W1 ⊗ W2)`。界面字段 `lokr_factor`（传入网络参数 `factor`）控制两个因子的长宽拆分，在完整矩阵模式下同样生效；`Rank`（`dim`）控制因子内部继续低秩分解的中间维度。

默认 `-1` 自动取最接近均衡的因数拆分。以单个 `2048×2048` 线性层在完整因子模式下的均衡拆分为例：

| `lokr_factor` | `W1` 形状 | `W2` 形状 | 该层参数量 |
| --- | --- | --- | --- |
| `4` | `4×4` | `512×512` | `262,160` |
| `8` | `8×8` | `256×256` | `65,600` |

此例中将因子从 `4` 增至 `8` 反而显著减小参数量。模型各层维度不同，调整后请在[结构预览](matrix-preview.zh-CN.md)中检查整体参数量。

<a name="full-matrix"></a>
## 完整矩阵与双因子分解

LyCORIS LoKr 的 `full_matrix` 与 `decompose_both` 默认关闭。显式开启 `full_matrix` 时，`W1` 和 `W2` 均直接存为完整矩阵并忽略 `decompose_both`；未开启时，只要某层的 `Rank ≥ max(dim1, dim2) / 2`（对应结构预览中的“W2 完整存储阈值”），该因子也会自动转为完整矩阵存储。

| 配置组合 | `W1` 存储方式 | `W2` 存储方式 |
| --- | --- | --- |
| 关闭 `full_matrix`、关闭 `decompose_both` | 完整矩阵 | 低于阈值时低秩分解，达到阈值时完整矩阵 |
| 关闭 `full_matrix`、开启 `decompose_both` | 满足条件时低秩分解 | 低于阈值时低秩分解，达到阈值时完整矩阵 |
| 开启 `full_matrix` | 完整矩阵 | 完整矩阵 |

当 `W1`、`W2` 均为完整矩阵时，继续调高 Rank 不会增加这两个因子的参数量，但 LyCORIS LoKr 的缩放规则仍区分 `rs_lora`：

| 两因子均为完整矩阵 | 内部 Alpha | 模块实际 `scale` |
| --- | --- | --- |
| `rs_lora=false` | 取 `dim` | `1` |
| `rs_lora=true` | 取 `dim` | `√dim` |

<div id="preview"></div>

修改上述分解选项后，可在[矩阵结构与文件大小](matrix-preview.zh-CN.md)中逐层查看 `W2` 完整存储层数与实际 `scale`。

<a name="unbalanced"></a>
## 不平衡分解

`unbalanced_factorization` 默认关闭。开启后将交换输出维度两个因数的分配顺序，改变 `W1` 与 `W2` 的长宽比例。仅在测试特定矩阵形状或体积压缩方案时切换，并在[结构预览](matrix-preview.zh-CN.md)中同时核对参数量与缩放倍率。

<a name="dora-bypass"></a>
## DoRA（权重分解）与旁路模式

LyCORIS 提供 `dora_wd`（DoRA 权重分解）与 `bypass_mode`（旁路前向计算）两项底层路径控制：

- **DoRA（`dora_wd`）**：将更新后的权重拆分为方向与可训练的输出通道幅度（范数），需要在前向计算中先合并重建 `W + ΔW` 再做方向归一化。因此开启 DoRA 时必须**关闭 `bypass_mode`**，且该重建路径下普通特征丢弃（`dropout`）不生效。
- **旁路模式（`bypass_mode`）**：不合并底模权重，改为单独计算适配器分支输出 `W(x) + ΔW(x)`。底模处于无法直接合并的低精度量化状态时必须启用旁路模式。
- **量化与算法限制**：
  - **Anima（LyCORIS）**：线性层与卷积层的 LoCon、LoHa、LoKr 在关闭 `bypass_mode` 时均可启用 DoRA。
  - **Krea 2（LyCORIS）**：开启 `DiT FP8 动态量化`（`fp8_base`）或 `ConvRot INT8`（`convrot_int8`）会强制启用 `bypass_mode`。若要使用 DoRA，须同时关闭这两种底模量化与 `bypass_mode`；LyCORIS LoCon 还需将普通 `dropout` 保持为 `0`（正数普通丢弃会自动切回旁路模式）。

<a name="dropout"></a>
## 网络丢弃与标注丢弃

丢弃（Dropout）在训练前向传播中随机屏蔽部分特征、通道或条件，默认均为 `0`（保存的权重文件不会减少参数）。出现构图或姿势僵化时，优先对比更早轮次的模型存档；确需正则化时，通常在 **`0.05–0.1`** 范围内小幅测试，过高（`> 0.2`）会拖慢收敛或冲淡主体细节。

| 类型与配置键 | 屏蔽对象 | 适用目的与注意事项 |
| --- | --- | --- |
| 特征丢弃 `network_dropout` | 适配器中间特征元素 | 缓解对固定局部特征组合的依赖 |
| 秩丢弃 `rank_dropout` | 部分低秩通道 | 避免少数通道独占表达 |
| 模块丢弃 `module_dropout` | 整层适配器分支 | 被屏蔽层在该步直接使用底模原输出 |
| 整段标注丢弃 `caption_dropout_rate` | 整条文本提示词（SDXL） | 混入无条件训练样本；`keep_tokens` 无法阻止整段丢弃 |
| 标签丢弃 `caption_tag_dropout_rate` | 逗号分隔的单个标签 | 减弱角色触发词与背景/服装标签的死绑；受 `keep_tokens`（保留前 N 个标签）保护 |

**与文本编码器缓存的互斥限制**：只要 `caption_tag_dropout_rate > 0`（或 SDXL 中 `caption_dropout_rate > 0`），每步都需要实时随机抽样标签并重新编码文本，界面会**自动关闭并锁定“缓存文本编码”**，显存占用和单步耗时都会上升。

Anima / SDXL 的 LyCORIS LoKr 中，不同前向路径支持的丢弃类型也不同（Krea 2 的 LyCORIS LoKr 界面仅开放 `module_dropout`）：

| LyCORIS LoKr 计算路径 | 普通特征 `dropout` | `rank_dropout` | `module_dropout` |
| --- | --- | --- | --- |
| 旁路计算（`bypass_mode=true`） | 生效（作用于分支输出） | 不使用 | 生效 |
| 重建权重（`bypass_mode=false`） | 不使用 | 生效（按输出通道屏蔽增量权重） | 生效 |

<a name="krea-targets"></a>
## Krea 2：默认训练范围与筛选

Krea 2 默认 Rank / Alpha 为 `32 / 32`，覆盖 DiT 全部 264 个线性层（主干注意力、MLP、文本融合 Transformer 与各类投影 MLP）。文本融合层位于 DiT 内部，Qwen 文本编码器始终冻结并使用文本缓存；调制与 RMSNorm 使用原始张量，不在 Linear LoRA 覆盖范围内。

原生 LoRA 与 LyCORIS（LoCon、LoKr、LoHa）共用“训练目标层”预设：

- **全部 Linear（264 层）**：包含主干、输入/输出、时间步投影及文本融合层。
- **主干 Attention（140 层）**：仅训练主干块的注意力投影层，体积最小。
- **主干 Attention + MLP（224 层）**：覆盖主干核心变换层，排除外围与文本融合投影。
- **自定义正则表达式**：每行一条，对原始 Linear 层名做完整匹配，**排除规则优先于包含规则**。例如包含 `blocks\.[0-9]+\.attn\..*` 等效于主干注意力；包含 `.*` 同时排除 `txtfusion\..*` 可单独剔除文本融合层。匹配结果为空时会在启动前直接报错。

| Krea 2 网络方式 | 丢弃与 LoRA+ 支持 |
| --- | --- |
| 原生 LoRA | 支持 `rank_dropout`、`module_dropout` 与 [LoRA+](lora-plus.zh-CN.md) |
| LyCORIS LoCon | 支持普通 `dropout`、`rank_dropout`、`module_dropout` 与 [LoRA+](lora-plus.zh-CN.md)；开启 [DoRA](#dora-bypass) 时普通 `dropout` 须设为 `0` |
| LyCORIS LoHa | 支持 `rank_dropout`、`module_dropout` |
| LyCORIS LoKr | 当前仅开放 `module_dropout` |

保存或迁移配置请使用导出的 `training.yaml`（运行目录中的目标预设文件会在启动时自动生成）。旧版原生 LoRA 在“全部 Linear（264 层）”下仍兼容在“自定义网络参数”中填写 `exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']`（`include_patterns` 仅用于加回被排除层）；新建配置请直接使用“训练目标层”选择器，切勿将原生参数混入 LyCORIS。参见 [Krea 2 上游目标层文档](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー)。

<a name="moss-text-embedder"></a>
## MOSS 文本投影与细化层

MOSS-Image 的 `train_text_embedder` 默认关闭。开启后会按所选 LoRA / LoHa / LoKr 算法，为 DiT 内部的文本输入投影层与 2 个文本细化块额外增加 **11 个适配器模块**（覆盖层数由 `252` 增至 `263`，以标准 LoRA Rank 16 `bf16` 为例预计文件由约 `71.0 MiB` 增至 `74.4 MiB`）。由于 Qwen 文本编码器本身仍冻结，文本编码缓存可正常开启。

这 11 个模块默认沿用主干学习率。若需单独压低学习率，可在“自定义网络参数”中填写 `network_reg_lrs=.*text_embedder.*=5e-5`（`EmoSens` 对所有参数强制同步单一学习率，该正则覆盖对它不生效）。Anima 若需在不解冻 Qwen3 的前提下扩展条件适配范围，可查看界面的“训练 LLM Adapter 模块”开关及 [AdaLN 调制层指南](adaln.zh-CN.md)。
