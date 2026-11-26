<a name="guide-title"></a>
# LoRA+

> LoRA+ 为适配器的两组低秩参数分配不同学习率，不增加参数量与文件大小。默认关闭，开启后的默认倍率为 `2.0`。

支持 SDXL、Anima、MOSS-Image 的[适用网络模块](#support)，以及 Krea 2 的原生 LoRA 和 LyCORIS LoCon；启用前请核对[优化器兼容性](#optimizer-compatibility)。

<a name="overview"></a>
## 原理、适用场景与推荐倍率

<div id="mechanism"></div>

标准 LoRA 将权重增量拆为 `ΔW = (Alpha / Rank) × B × A`：`lora_down`（`A`）使用随机初始化，将输入降维至 Rank；`lora_up`（`B`）初始化为零，再映射回输出维度。训练起步时因 `lora_up` 为零，`lora_down` 首步梯度为零，两矩阵在训练早期的更新尺度并不对称。LoRA+ 让 `lora_down` 保持基础学习率，对 `lora_up`（原生 LoHa / LoKr 对应各自的扩展参数组）乘上指定倍率：

<div class="doc-equation doc-equation-compact" role="group" aria-label="LoRA+ 学习率计算公式">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>down</sub> = <span class="doc-math-var">LR</span><sub>base</sub></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>up</sub> = <span class="doc-math-var">LR</span><sub>base</sub> · <span class="doc-math-var">ratio</span></div>
</div>

以基础学习率 `2e-5` 为例（直接调高基础学习率会同时放大两组更新，调高倍率仅加速 `lora_up`）：

| 倍率（`ratio`） | `lora_down` 学习率 | `lora_up` 学习率 |
| --- | --- | --- |
| `1.0`（等学习率基准） | `2e-5` | `2e-5` |
| `2.0`（默认起点） | `2e-5` | `4e-5` |
| `4.0` | `2e-5` | `8e-5` |

<div id="good-cases"></div>
<div id="ratio-guidance"></div>

- **何时开启**：在稳妥的基础学习率（如 `2e-5–1e-4`）下角色五官、服饰细节或画风收敛偏慢，而直接拉高全局学习率又容易破坏底模结构或引发画面崩坏时，可固定基础学习率开启 LoRA+ 加速目标特征成型。
- **推荐倍率（`2.0–4.0`）**：优先从默认 `2.0` 与关闭基准（等效 `1.0`）做对照；Krea 2 还允许填写 `0.01–1.0` 的正倍率以单独压低 `lora_up` 学习率。
- **慎用高倍率（如论文中的 `16`）**：原论文与 `sd-scripts` 示例中的 `16` 基于语言模型或极低基础学习率（`~1e-5`）。在常规图像 LoRA 学习率（`5e-5–1e-4`）下套用 `16` 会把 `lora_up` 推高至 `8e-4–1.6e-3`，极易在早期出现色彩过曝、姿势与背景锁死，或丢失对其他提示词的响应。

<a name="parameters"></a>
## 训练器参数与实际学习率

“启用 LoRA+”关闭时不导出任何倍率；开启后以界面倍率字段为准（SDXL、Anima、MOSS-Image 会自动清理“自定义网络参数”中的同名 `loraplus_*` 项；Krea 2 导入旧配置时会将附加参数中的全局倍率迁移至表单字段）。Krea 2 仅设全局倍率，启用时须手动填写 Rank 与 Alpha，并关闭“从已有权重推断 LoRA Rank”。

<a name="loraplus-lr-ratio"></a>
### `loraplus_lr_ratio`

全局倍率，默认 `2.0`。主干或文本编码器的独立倍率留空时自动继承该值。

| 训练类型 | 界面最小值 | 步进 |
| --- | --- | --- |
| SDXL、Anima、MOSS-Image | `1.0` | `0.5` |
| Krea 2 | `0.01` | `0.1` |

<a name="loraplus-unet-lr-ratio"></a>
### `loraplus_unet_lr_ratio`

仅覆盖 UNet / DiT 主干的倍率，留空时回退到 `loraplus_lr_ratio`。该字段仅用于 `sd-scripts` 训练路径（Anima、MOSS-Image 沿用 `unet` 参数名指代 DiT 主干）；仅训练文本编码器时无效。

<a name="loraplus-text-encoder-lr-ratio"></a>
### `loraplus_text_encoder_lr_ratio`

仅覆盖文本编码器 LoRA 的倍率，留空时回退到 `loraplus_lr_ratio`。仅在文本编码器参与训练时生效：开启“仅训练 UNet / DiT”或“缓存文本编码”后不生效，MOSS-Image 与 Krea 2 的文本编码器始终冻结。调整后请重点抽检触发词响应强度与常规提示词控制力。

<a name="effective-lr"></a>
### 倍率回退与实际学习率计算

`sd-scripts` 路径先按组件读取基础学习率（`unet_lr` / `text_encoder_lr` 留空时回退到 `learning_rate`；Krea 2 直接使用 `learning_rate` 作为 DiT 基础学习率），再按“组件倍率 → 全局倍率”应用缩放：

| 训练组件 | 基础学习率来源 | 倍率优先级 |
| --- | --- | --- |
| UNet / DiT 主干 | `unet_lr`（留空取 `learning_rate`） | `loraplus_unet_lr_ratio` → `loraplus_lr_ratio` |
| 文本编码器 | `text_encoder_lr`（留空取 `learning_rate`） | `loraplus_text_encoder_lr_ratio` → `loraplus_lr_ratio` |

应用下载的配置文件为 YAML，运行时生成的 `sd-scripts` TOML 会将多项倍率合并写入同一个 `network_args` 列表：

```toml
network_args = [
  "loraplus_lr_ratio=2.0",
  "loraplus_unet_lr_ratio=3.0",
  "loraplus_text_encoder_lr_ratio=1.5",
]
```

例如设置 `learning_rate=1e-4`、`unet_lr=8e-5`、主干倍率 `2.0` 时，主干按自身的 `8e-5` 计算：

<div class="doc-equation doc-equation-compact" role="group" aria-label="UNet LoRA+ 实际学习率示例">
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>base</sub> = 8 × 10<sup>−5</sup></div>
  <div class="doc-equation-expression"><span class="doc-math-var">LR</span><sub>plus</sub> = 8 × 10<sup>−5</sup> · 2 = 1.6 × 10<sup>−4</sup></div>
</div>

<a name="optimizer-compatibility"></a>
## 优化器与网络模块支持

切换到不兼容的优化器或自适应模式时，界面会自动关闭 LoRA+ 并提示原因，后端也会拦截旧预设或 API 传入的冲突组合：

| 优化器 | LoRA+ 状态 | 说明 |
| --- | --- | --- |
| AdamW、AdamW8bit、PagedAdamW8bit | 支持 | 保留各参数组的独立学习率 |
| Lion、Lion8bit、PagedLion8bit、CAME | 支持 | 保留各参数组的独立学习率 |
| StableAdamW、Muon、Adan、AdEMAMix、AdEMAMix8bit、SOAP | 支持 | 保留各参数组的独立学习率 |
| AdamWScheduleFree | 支持 | 保留参数组划分，内部调度会随步数调整实际更新幅度 |
| Automagic3 / Automagic4 | 条件支持 | 所有参数组的初始学习率（含乘倍率后的 `plus` 组）都须落在 `min_lr`～`max_lr` 内；训练中各组独立自适应，初始倍率会动态变化 |
| AdaFactor | 仅手动学习率模式 | 必须同时关闭 `relative_step` 与 `warmup_init`；默认相对步长会忽略分组学习率，界面自动锁定关闭 LoRA+ |
| Prodigy、ProdigyPlusScheduleFree | 不支持 | 当前训练路径无法可靠维持各参数组的独立倍率，界面与后端在所有训练类型（含 Krea 2）中均禁止混用 |
| EmoSens | 不支持 | 使用单一全局 `emoPulse` 并在每步后把所有参数组重置为同一学习率，倍率会失效 |
| LoRA-Muon、LoRA-RITE | 不支持 | 配对因子联合更新要求成对读取完整低秩矩阵，与 LoRA+ 拆分参数组不兼容 |

使用 Automagic 时需留意上限校验：例如起始学习率 `2e-5` 搭配倍率 `12` 会使 `plus` 组达到 `2.4e-4`，超出默认 `max_lr`（`2e-4`），须先调低倍率或上调 `max_lr`。常规外部调度器与 Warmup 对所有参数组施加相同缩放因子，不会破坏设定倍率。

<a name="support"></a>
### 支持的网络模块

| 网络模块 | 乘倍率的参数组 | 适用范围与说明 |
| --- | --- | --- |
| `networks.lora` | `lora_up` | SDXL 标准 LoRA |
| `networks.lora_anima` | `lora_up` | Anima 原生 LoRA |
| `networks.lora_generic` | `lora_up` | MOSS-Image 原生 LoRA |
| `networks.lora_krea2` | `lora_up` | Krea 2 原生 LoRA |
| `networks.loha` | `hada_w2_a` | `sd-scripts` 原生 LoHa 扩展分组 |
| `networks.lokr` | `lokr_w1` | `sd-scripts` 原生 LoKr 扩展分组 |
| `lycoris.kohya`（仅 LoCon / `lora`） | `lora_up` 等 | Anima、Krea 2 的 LyCORIS 仅在 LoCon 模式下支持 LoRA+ |

<a name="testing"></a>
## 效果评估、日志核对与排障

<div id="cautions"></div>
<div id="effects"></div>

测试 `2.0` 以上倍率时建议加密模型保存间隔，区分“收敛提速”与“峰值质量提升”：

| 对照维度 | 判断重点 |
| --- | --- |
| 相同步数的存档对比 | 角色特征、画风或概念是否更早成型 |
| 各自最佳存档对比 | 整轮训练所能达到的最佳画面质量是否有提升 |
| 新姿势、新背景与未见主体 | 目标特征提速的同时，是否过早背下训练集构图或削弱提示词控制 |

<div id="faq"></div>

若开启后过拟合提前或画面发焦，优先取更早轮次的存档对比，或将倍率降回 `1.0–2.0` 并复查基础学习率与样本重复次数。

<a name="tensorboard"></a>
### TensorBoard 验证

开启日志记录后，`plus` 后缀代表应用了 LoRA+ 倍率的参数组：

- **SDXL（主干 + 文本编码器）**：记录 `lr/unet`、`lr/unet plus`、`lr/textencoder`、`lr/textencoder plus`。
- **Krea 2 / 仅训练 DiT**：记录 `lr/unet` 与 `lr/unet plus`。
- **Anima（含文本编码器）**：文本编码器带编号，记录 `lr/textencoder 1` 与 `lr/textencoder 1 plus`（启用分块学习率等配置时曲线还会细分）。

使用常规优化器时，在非零学习率区间核对 `plus` 曲线与对应基础曲线的比值即可确认倍率生效；自适应优化器按各组状态独立演化，需结合生成样图综合评估。

<div id="references"></div>

参考：[LoRA+ 原论文（arXiv:2402.12354）](https://arxiv.org/abs/2402.12354) · [sd-scripts `train_network_advanced.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/train_network_advanced.md) · [sd-scripts `loha_lokr.md`](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/docs/loha_lokr.md)
