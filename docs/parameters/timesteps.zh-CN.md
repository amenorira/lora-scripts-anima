# 时间步

> 训练时，系统会为图片加入随机噪声，再让模型学习如何处理它。时间步表示当前输入的噪声强度，它决定了训练更关注细节、整体结构，还是两者之间的平衡。

本指南讲解本训练器中 **Anima** 和 **Krea 2** 使用的 flow matching（流匹配）时间步。SDXL 采用另一套扩散训练方式，其时间步范围参数在文末单独说明。

<!-- doc-anchor: quick-start -->
## 基础设置

尚未进行基准训练时，当前训练类型的默认值可以直接作为基准配置。时间步属于高级调优项；在多数训练问题中，数据质量、标注、学习率和停止时机的影响更直接。

Anima LoRA 的默认基准为：

```toml
timestep_sampling = "sigmoid"
sigmoid_scale = 1.0
weighting_scheme = "uniform"
```

Krea 2 的默认值是 `shift`、`sigmoid_scale=1.0`、`discrete_flow_shift=2.5` 和 `weighting_scheme=none`，这组参数同样适合作为基准。

两组默认值都会覆盖不同强度的噪声，而不是只集中于细节或整体结构，适用于人物、画风和普通概念训练的初始实验。

> **配置说明：** 时间步不是“画质开关”。没有基准结果时，同时修改多个时间步参数会让结果难以归因。先用默认配置跑一次，后续才有对照依据。

<!-- doc-anchor: terminology -->
## 三种“步”的区别

训练界面里有三种名字相近、含义完全不同的“步”：

| 名称 | 实际含义 | 常见参数 |
| --- | --- | --- |
| 训练步数 | LoRA 参数被更新了多少次 | `max_train_steps` |
| 训练时间步 | 当前图片被加入了多少噪声 | `timestep_sampling` |
| 生成采样步数 | 生成图片时执行多少次去噪计算 | `sample_steps` |

例如，日志中的“训练到第 500 步”表示 LoRA 已经更新了 500 次，和噪声时间步 `t≈500` 并没有“都进行到一半”的关系。同一次训练更新中，不同图片也可以抽到不同的噪声时间步。

<!-- doc-anchor: visualizer -->
## 分布预览说明

<div data-doc-widget="timestep-preview"></div>

分布预览包含三个主要部分：

1. **蓝色柱子。** 柱子越高，代表对应的噪声区域越常被抽到。
2. **橙色曲线。** Loss 表示模型预测与训练目标之间的误差。橙线显示样本被抽到以后，这个误差还会乘上多大的额外权重。
3. **低、中、高噪声占比。** 这三个数值概括当前设置更偏向细节、平衡区域还是整体结构。

32 根蓝柱只是把完整时间范围分成 32 个区间方便观察，并不表示训练器只有 32 个时间步。柱高以最高的一根为基准缩放，因此不能直接当作纵轴概率读取。

橙线使用对数刻度，只用来比较权重变化的趋势。它不是训练日志中的实际 Loss，也不能和蓝柱的高度直接比较。橙线保持水平，表示没有对不同时间步额外加权，不代表 Loss 本身保持不变。

<div class="doc-equation doc-equation-compact" role="group" aria-label="某个噪声区域对训练影响的近似关系">
  <div class="doc-equation-kicker">帮助理解，不是精确预测</div>
  <div class="doc-equation-expression">实际影响 ≈ 抽到的频率 × Loss 权重 × 当前误差</div>
  <p>图片、标注和训练阶段都会改变“当前误差”，所以分布图只能说明训练如何分配抽样与权重。</p>
</div>

预览会在本地进行 32,768 次固定随机种子的模拟，参数相同，图形就相同。三个区域的百分比经过四舍五入，合计偶尔会显示为 `99.9%` 或 `100.1%`。打开或刷新预览不会启动训练，也不会修改 TOML 配置。

<!-- doc-anchor: dataset-guidance -->
## 数据集规模与时间步选择

图片越少，模型能参考的角度、姿势、背景和构图变化就越少。时间步不能补出这些缺失的信息，它只能决定现有图片更常在哪种噪声强度下参与训练。

因此，少图或高度重复的数据集通常更适合保留稳定的中噪声倾向；图片足够多且内容真正多样时，才更有条件增加低噪声和高噪声两端的覆盖。

下面的数值是经验起点，不是固定配方：

| 训练情况 | 经验起点 | 主要考虑 |
| --- | --- | --- |
| 5～12 张人物图 | `sigmoid`、`sigmoid_scale=0.8～1.0`、`uniform` | 学习多张图共有的身份特征，降低重复输出姿势和背景的风险 |
| 15～40 张人物图 | `sigmoid`、`sigmoid_scale=1.0～1.2`、`uniform` | 兼顾身份、细节和整体结构 |
| 40～100 张多样人物图 | `sigmoid`、`sigmoid_scale=1.1～1.4`、`uniform` | 角度和构图足够丰富时，逐步扩大两端覆盖 |
| 15～30 张画风图 | `sigmoid`、`sigmoid_scale=0.8～1.0`、`uniform` | 降低固定人物、背景或构图被误学为画风的风险 |
| 60～200 张多样画风图 | `sigmoid`、`sigmoid_scale=1.1～1.4`、`uniform` | 数据足够多样时，同时学习笔触、形体和构图习惯 |
| 物体或结构概念 | `sigmoid`、`sigmoid_scale=1.0～1.2`、`uniform` | 保持初始平衡，确认整体轮廓不足后再增加高噪声训练 |

这里说的数量是 **有效独立图片数**。连续视频帧、同一张图的多个裁剪，以及高度相似的卡面，都无法提供等量的新信息。

例如，10 张图片重复 20 次和 100 张不同图片重复 2 次，样本曝光次数可能相近，但前者仍然只有 10 张图提供的角度和构图。`repeats`（重复次数）可以增加训练次数，不能增加数据多样性。

<div class="doc-equation doc-equation-compact" role="group" aria-label="每轮训练更新数的近似估算">
  <div class="doc-equation-kicker">单卡训练的粗略估算</div>
  <div class="doc-equation-expression doc-equation-expression-small">每轮更新数 ≈ <span class="doc-frac"><span>图片数 × repeats</span><span>batch size × gradient accumulation</span></span></div>
  <p>这是帮助规划训练长度的近似关系，不会改变时间步分布本身。</p>
</div>

<!-- doc-anchor: scenarios -->
## 不同训练目标的设置参考

### 少图人物

少图人物更容易把脸、姿势、背景和构图一起记住。`sigmoid 0.8～1.0 + uniform` 可作为基准；`sigma_sqrt` 或明显偏向高噪声的 shift 会增加局部记忆和构图绑定风险，因此不在初始默认配置中。

角色身份没有学出来时，还需要检查触发词、标注、学习率和训练步数，时间步调整本身不能修复这些基础问题。

### 多图人物与高还原度

一个角色要在新姿势、新镜头下仍然保持身份，不能只靠低噪声训练。低噪声有助于保留五官和服装细节，中噪声负责身份与结构的平衡，高噪声影响模型如何从模糊信息中建立整体角色。

当数据确实包含不同角度、姿势和构图时，`sigmoid_scale` 可从 `1.0` 逐步测试到 `1.1～1.4`。保留默认版本作为对照，有助于判断扩大分布后的实际变化。

### 少图画风

颜色、线条和笔触主要会在低噪声与中噪声区域体现；人物比例、形状设计、光影布局和构图习惯还会涉及高噪声。

少图画风的主要风险之一，是把固定主体和固定构图一起学成风格。图片较少时，中噪声倾向可作为经验起点；训练图主体和构图的多样性仍然是重要条件。

### 多图、高还原画风

追求高还原画风，并不等于把训练全部推向低噪声。低、中噪声有助于复现线条、配色和材质，高噪声同样参与学习形体、光影和构图语言。

对于约 60 张以上、主体和镜头真正多样的数据，可以逐步测试 `sigmoid_scale=1.1～1.4`。颜色和笔触已经正确、但整体形体仍不像时，再单独尝试轻微的高噪声 shift。`sigma_sqrt` 不是通用的“画风增强”选项。

画风质量不能只根据生成结果与训练图的相似程度判断，还要评估它能否把相同的视觉语言应用到训练集中没有出现过的主体和构图上。

### 物体、服装与结构概念

特殊服装、道具和机械结构往往需要中噪声和高噪声来建立整体轮廓。局部纹理正确但整体结构不稳定时，可以在确认数据角度足够后，测试 `sigmoid_scale=1.2～1.4` 或轻微的 `shift>1`。

只有正面图时，时间步无法推断物体背面的样子，缺少的视角仍然需要通过数据补充。

<!-- doc-anchor: diagnosis -->
## 训练结果与调整方向

| 看到的现象 | 可以测试的时间步调整 | 还要同时检查 |
| --- | --- | --- |
| 熟悉姿势很像，换姿势后身份消失 | 适度提高 `sigmoid_scale` | 角度是否足够、标注是否合理、是否已经过拟合 |
| 小细节一直出不来 | 小幅提高 `sigmoid_scale`，增加两端覆盖 | 原图是否真的包含清晰细节 |
| 总是生成同一姿势或背景 | 减少高噪声偏移，回到 sigmoid 基线 | 数据是否重复、背景是否正确标注 |
| 轮廓或身体结构不稳定 | 数据充分时测试轻微 `shift>1` | 是否有全身图和多角度图片 |
| 纹理过锐、脏点多、重复输出训练图 | 停用 `sigma_sqrt` 或回到均匀权重 | 学习率、总步数和推理 LoRA 权重 |
| 画风只有颜色，缺少形体特点 | 适度扩大 sigmoid，或单独测试轻微高噪声 shift | 主体类型和构图是否足够多样 |
| 画风压制提示词，总把构图带回训练集 | 减少高噪声偏移 | 总训练强度是否过高 |

同一种现象可能有多个原因。时间步分布只是排查的一部分，不能代替对数据、标注、学习率和固定提示词采样图的检查。

<!-- doc-anchor: flow-matching -->
## 时间步的工作原理

本节说明时间步在 flow matching 训练中的工作方式。初次训练无需掌握全部公式，需要进一步调参时再回来看即可。

图片进入模型之前，会先由 VAE 压缩成 latent，也就是模型实际处理的图像特征。设原图 latent 为 <var>x</var>，随机噪声为 <var>ε</var>，归一化时间步为 <var>t</var>，加入噪声后的输入可以写成：

<div class="doc-equation" role="group" aria-label="Flow matching 加噪公式">
  <div class="doc-equation-kicker">加入噪声后的训练输入</div>
  <div class="doc-equation-expression"><var>x</var><sub>t</sub> = (1 − <var>t</var><span class="doc-math-close">)</span> · <var>x</var> + <var>t</var> · <var>ε</var></div>
  <p><var>t</var> 越小，输入越接近原图；<var>t</var> 越大，输入越接近纯噪声。</p>
</div>

| 时间步位置 | 模型看到的输入 | 更容易体现的内容 |
| --- | --- | --- |
| 低噪声，`t≈0` | 原图信息大部分仍然可见 | 线条、纹理、颜色、五官和服装细节 |
| 中噪声，`t≈0.5` | 原图与噪声充分混合 | 身份、风格、形态与细节之间的平衡 |
| 高噪声，`t≈1` | 输入已经接近纯噪声 | 主体语义、轮廓、姿势、构图和整体结构 |

这张表只是帮助建立直觉，并不是严格的能力分区。身份、细节和构图都会跨越多个时间步，最终结果仍然取决于数据、标注和基础模型。

当前 Anima 和 Krea 2 的训练目标都是预测从原图指向噪声的流动方向：

<div class="doc-equation doc-equation-compact" role="group" aria-label="Flow matching 训练目标">
  <div class="doc-equation-kicker">模型需要预测的方向</div>
  <div class="doc-equation-expression"><var>v</var> = <var>ε</var> − <var>x</var></div>
  <p>生成图片时过程反过来：模型从高噪声出发，逐步走向清晰图像。</p>
</div>

训练代码里还经常使用 <var>σ</var>（界面参数中写作 `sigma`）表示噪声混合比例。在本文讨论的 flow matching 路径中，它的方向与 <var>t</var> 一致：越接近 `0` 越干净，越接近 `1` 越接近纯噪声。界面会把这个范围显示为大约 `0～1000` 的时间步。

<!-- doc-anchor: defaults -->
## 当前训练类型的默认值

| 训练类型 | 默认采样方式 | 默认分布参数 | 默认 Loss 权重 |
| --- | --- | --- | --- |
| Anima | `sigmoid` | `sigmoid_scale=1.0` | `uniform` |
| Krea 2 | `shift` | `sigmoid_scale=1.0`、`discrete_flow_shift=2.5` | `none` |

在当前实现中，`uniform` 和 `none` 都表示不额外改变不同时间步的 Loss 权重。Krea 2 使用 `none`，还为了兼容训练后端和旧配置。导入旧预设后，以界面实际显示的参数和分布图为准。

<!-- doc-anchor: sampling -->
## `timestep_sampling`：决定哪些时间步更常出现

`timestep_sampling` 决定蓝色柱子的基本形状，也就是训练更常抽到哪些噪声强度。

| 选项 | 它会怎样抽取时间步 | 可用训练类型 |
| --- | --- | --- |
| `sigmoid` | 以中噪声为主，同时保留两端 | Anima、Krea 2 |
| `uniform` | 在完整范围内均匀抽取 | Anima、Krea 2 |
| `shift` | 基于 sigmoid 分布，再整体向一侧移动 | Anima、Krea 2 |
| `sigma` | 按训练 scheduler 的离散噪声表抽取 | Anima、Krea 2 |
| `flux_shift` | 根据当前分辨率计算 FLUX 风格的 shift | Anima |
| `krea2_shift` | 根据当前分辨率计算 Krea 2 的 shift | Krea 2 |
| `logsnr` | 从 LogSNR 分布转换出时间步 | Krea 2 |

### `sigmoid`

`sigmoid` 先取得一个服从标准正态分布的随机数，再把它转换到 `0～1`：

<div class="doc-equation" role="group" aria-label="Sigmoid 时间步采样公式">
  <div class="doc-equation-kicker">sigmoid 采样</div>
  <div class="doc-equation-expression"><var>z</var> ∼ N(0, 1)<br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(<var>s</var> · <var>z</var><span class="doc-math-close">)</span></div>
  <p><var>s</var> 对应 <code>sigmoid_scale</code>。默认值为 1.0。</p>
</div>

默认 `sigmoid_scale=1.0` 时，分布左右对称，明显集中在中噪声。以 1024×1024 的默认预览为例，低、中、高噪声占比大约是 21%、57% 和 21%（按 32 根柱子的平均三等分统计，即低、中、高分别对应 10、12、10 根柱子）；具体数值会随参数和统计区间略有变化。

### `uniform`

`uniform` 在完整时间范围内均匀抽取。和默认 sigmoid 相比，它会明显增加低噪声与高噪声两端的训练次数。

均匀分布不代表结果必然更好。数据较少或构图重复时，两端增加的训练次数也可能加快背景、固定姿势和图片瑕疵的记忆。

### `shift`

`shift` 先生成 sigmoid 分布，再通过 `discrete_flow_shift` 把整组分布向低噪声或高噪声移动。它适用于已有基准结果、且对照图显示整体分布方向需要调整的情况。

### `sigma`

`sigma` 从训练 scheduler（预先定义的离散噪声表）中选择时间步，`discrete_flow_shift` 会改变这张噪声表。

当 `weighting_scheme` 选择 `logit_normal` 或 `mode` 时，它还会改变抽取位置的分布；选择 `sigma_sqrt` 或 `cosmap` 时，抽取分布保持普通密度，只在计算 Loss 时改变权重。

### `flux_shift` 与 `krea2_shift`

这两种方式根据当前 latent 网格大小计算 shift。通常分辨率越高，最终分布越可能向高噪声移动，它们不读取固定的 `discrete_flow_shift`。

开启 bucket 后，相近分辨率和宽高比的图片会分组训练。每个 bucket 都按自己的 latent 尺寸计算分布，因此文档图表中的参考分辨率不能代表数据集里的所有 bucket。

### `logsnr`

SNR 表示信号与噪声的强度比，LogSNR 是它的对数形式。LogSNR 越高，代表原图信号越强、噪声越少。

Krea 2 的 `logsnr` 先根据 `logit_mean` 和 `logit_std` 生成 LogSNR，再转换成时间步：

<div class="doc-equation" role="group" aria-label="LogSNR 时间步转换公式">
  <div class="doc-equation-kicker">Krea 2 logsnr 采样</div>
  <div class="doc-equation-expression">LogSNR ∼ N(<var>μ</var>, <var>σ</var><span class="doc-math-close">)</span><br><var>t</var> = <span class="doc-math-fn">sigmoid</span>(−LogSNR / 2)</div>
  <p><var>μ</var> 对应 <code>logit_mean</code>，<var>σ</var> 对应 <code>logit_std</code>。</p>
</div>

它和 `sigma + logit_normal` 使用相同的两个参数名，但转换过程不同。参数正负无法完整表示最终方向，分布预览会直接显示转换后的结果。

<!-- doc-anchor: sigmoid-scale -->
## `sigmoid_scale`：控制分布向两端展开多少

`sigmoid_scale` 会在 `sigmoid`、`shift`、`flux_shift` 和 `krea2_shift` 中生效。

- 接近 `0`：样本几乎都集中在 `t≈0.5`。
- `1.0`：以中噪声为主，同时保留低噪声和高噪声。
- `1.2～1.5`：低噪声与高噪声两端都会增加。
- 数值过大：样本可能过度集中到两个端点。

提高 `sigmoid_scale` 不是单纯提高质量。它可能补充细节和整体结构，也可能让背景、固定构图、压缩痕迹和错误标注更快被学进去。

<!-- doc-anchor: flow-shift -->
## `discrete_flow_shift`：把整组分布向一侧移动

设 shift 为 <var>s</var>，它对时间步的变换为：

<div class="doc-equation" role="group" aria-label="Discrete flow shift 公式">
  <div class="doc-equation-kicker">固定 flow shift</div>
  <div class="doc-equation-expression"><var>t</var><sub>shifted</sub> = <span class="doc-frac"><span><var>s</var> · <var>t</var></span><span>1 + (<var>s</var> − 1) · <var>t</var></span></span></div>
  <p><var>s</var> 对应 <code>discrete_flow_shift</code>。</p>
</div>

- `1.0`：不移动。
- 大于 `1.0`：整体向高噪声移动。
- 小于 `1.0`：整体向低噪声移动。

这个参数在 `shift` 中直接生效，在 `sigma` 中通过 scheduler 生效；`sigmoid`、`uniform`、`flux_shift`、`krea2_shift` 和 `logsnr` 不会使用这个固定值。

<!-- doc-anchor: weighting -->
## 采样频率与 Loss 权重

时间步对训练的影响有两个独立环节：

1. **抽样位置。** 由 `timestep_sampling` 和相关分布参数控制，对应图中的蓝柱。
2. **Loss 权重。** 表示样本被抽到后对误差施加的额外权重，对应图中的橙线。

`weighting_scheme` 这个名称容易误导：其中有些选项改变 Loss 权重，有些选项只在 `timestep_sampling=sigma` 时改变抽样分布。

| 选项 | 会改变抽样分布吗 | 会改变 Loss 权重吗 |
| --- | --- | --- |
| `uniform` / `none` | 不会 | 不会 |
| `sigma_sqrt` | 不会 | 会，强烈提高低噪声权重 |
| `cosmap` | 不会 | 会，平滑提高中噪声权重 |
| `logit_normal` | 仅在 `sigma` 采样时 | 不会 |
| `mode` | 仅在 `sigma` 采样时 | 不会 |

### `uniform` / `none`

不对不同时间步添加额外 Loss 权重，图中的橙线保持水平，便于作为对照基准。

### `sigma_sqrt`

<div class="doc-equation" role="group" aria-label="Sigma sqrt Loss 权重公式">
  <div class="doc-equation-kicker">低噪声权重</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>1</span><span><var>σ</var><sup>2</sup></span></span></div>
  <p><var>σ</var> 越接近 0，权重增长越快。</p>
</div>

它会显著放大低噪声样本的影响。少图训练中，这可能加重局部记忆、过锐纹理和梯度不稳定；本训练器的默认配置不使用该权重。

### `cosmap`

<div class="doc-equation" role="group" aria-label="Cosmap Loss 权重公式">
  <div class="doc-equation-kicker">中噪声权重</div>
  <div class="doc-equation-expression"><var>w</var> = <span class="doc-frac"><span>2</span><span><var>π</var> · (1 − 2 · <var>σ</var> + 2 · <var>σ</var><sup>2</sup><span class="doc-math-close">)</span></span></span></div>
  <p>它会相对降低两个端点的影响，并平滑强调中噪声。</p>
</div>

`cosmap` 只改变橙色权重曲线，不会改变蓝色采样柱。

<!-- doc-anchor: logit-normal -->
### `logit_normal`、`logit_mean` 与 `logit_std`

这组设置只有在 `timestep_sampling=sigma` 时才会改变抽样分布。

- `logit_mean=0`：分布大致对称。
- 在当前 sigma scheduler 的索引方向下，正值通常使最终 sigma 偏向低噪声，负值通常偏向高噪声。
- `logit_std` 越小，样本越集中；越大，样本越向两端展开。

scheduler shift 还会参与最后的映射，所以应以预览结果判断实际方向和幅度。选择 `sigmoid + logit_normal` 时，`logit_normal` 不会改变采样，也不会增加 Loss 权重。

<!-- doc-anchor: mode -->
### `mode` 与 `mode_scale`

`mode` 只会在 `timestep_sampling=sigma` 时改变抽样分布，不会增加 Loss 权重。

- `mode_scale=0`：接近均匀分布。
- 数值增大：样本更集中在中噪声。
- 默认 `1.29`：已经有明显的中噪声倾向。

<!-- doc-anchor: compatibility -->
## 参数生效关系

| 参数 | sigmoid | uniform | shift | sigma | flux/krea shift | logsnr |
| --- | --- | --- | --- | --- | --- | --- |
| `sigmoid_scale` | 生效 | 忽略 | 生效 | 忽略 | 生效 | 忽略 |
| `discrete_flow_shift` | 忽略 | 忽略 | 生效 | 生效 | 忽略 | 忽略 |
| `logit_mean/std` | 忽略 | 忽略 | 忽略 | 仅影响 `logit_normal` 分布 | 忽略 | 直接生效 |
| `mode_scale` | 忽略 | 忽略 | 忽略 | 仅影响 `mode` 分布 | 忽略 | 忽略 |
| `sigma_sqrt/cosmap` 权重 | 生效 | 生效 | 生效 | 生效 | 生效 | 生效 |

“忽略”表示训练代码不会读取这个参数，配置文件里即使保留了数值也不会产生隐藏效果。界面会尽量隐藏当前组合中无效的字段，分布预览也会提示被忽略的设置。

<!-- doc-anchor: sdxl-range -->
## SDXL 的 `min_timestep` 与 `max_timestep`

SDXL 不使用前面介绍的 Anima/Krea 2 flow matching 采样选项，本训练器为 SDXL 提供两个独立的范围参数：

- `min_timestep`：允许抽取的最低噪声时间步，留空时使用 `0`。
- `max_timestep`：允许抽取的最高噪声时间步，留空时使用 `1000`。
- 提高 `min_timestep`：排除最干净的低噪声样本。
- 降低 `max_timestep`：排除噪声最高的样本。

它们只是裁剪允许抽取的范围，不等同于 `sigmoid_scale` 或 flow shift。默认配置使用完整范围，只有需要排除特定噪声端点的实验才需要调整。

`min_snr_gamma`、`v_parameterization` 和 `zero_terminal_snr` 也与 SDXL 的噪声训练有关，但分别控制 Loss 重加权、预测目标和 scheduler 行为，不属于本文介绍的 flow matching 分布参数。

<!-- doc-anchor: common-mistakes -->
## 常见误区

1. `sigmoid + logit_normal` 不会启用 logit-normal 抽样；它只在 `sigma` 模式下生效。
2. `discrete_flow_shift` 并不是所有采样方式都会使用。
3. 高噪声不代表质量更高，低噪声也不保证细节一定更好。
4. 时间步无法创造训练集中没有的角度、结构和绘画规律。
5. `sample_flow_shift` 是生成预览参数，不会改变训练时间步分布。
6. 训练随机种子（seed）会改变实际抽取时间步的随机顺序，但不会改变长时间训练下的理论分布。文档预览使用固定模拟种子，因此修改训练随机种子不会让图形变化。
7. batch size 和多卡数量不会改变理论分布，但会影响短训练中实际抽样的波动大小。
8. 时间步设置不会改变导出的 LoRA 文件格式，推理时也不要求使用同名采样方式。

<!-- doc-anchor: testing -->
## 对照实验方法

1. **基准组：** 采用当前训练类型的默认值。
2. **固定条件：** 数据集、随机种子、Rank、Alpha、学习率和总训练步数保持一致。
3. **单一变量：** 每组实验仅改变一个参数，例如将 `sigmoid_scale` 从 `1.0` 改为 `1.25`。
4. **同条件对比：** 检查点（checkpoint）处于相同训练步数，并采用相同的提示词、生成种子、分辨率和推理 LoRA 权重。
5. **评估维度：** 身份或画风还原、背景泄漏、构图僵化、提示词服从度，以及在未见场景中的表现。

训练 Loss 只能作为辅助信息。某组时间步设置是否更好，最终应由固定条件下的多组生成图和你的实际使用目标决定。

<!-- doc-anchor: evidence -->
## 依据与参考资料

事实核查日期：**2026-08-05**。下列代码链接固定到核查时的提交。

**实现事实：** 本文公式与参数生效关系，以本项目 vendor 中实际加载的训练代码为准：

- sd-scripts fork 的 `library/flux_train_utils.py`：`sigmoid`、`shift`、`flux_shift` 采样，`sigma_sqrt` 与 `cosmap` 权重公式，`discrete_flow_shift` 变换。
- `library/anima_train_utils.py`：Anima 的采样与损失权重分发。
- musubi-tuner fork 的 `src/musubi_tuner/training/timesteps.py` 与 `training/trainer_base.py`：Krea 2 的 `krea2_shift`、`logsnr` 及共享公式。
- 前端分布预览的模拟实现见 `frontend/js/training-core.js`（32 根柱子、32,768 次固定随机种子模拟）。

**模型与上游依据：** Anima 与 Krea 2 的训练路径使用 flow matching（流匹配）加噪方式与目标公式 `v = ε − x`；`sigmoid` 采样与 `discrete_flow_shift` 的变换形式出自 [Scaling Rectified Flow Transformers for High-Resolution Image Synthesis（SD3 论文）](https://arxiv.org/abs/2403.03206)。本文数据集规模对应的经验起点不属于任何官方推荐。

**需要实测的经验判断：** 各数据集规模对应的 `sigmoid_scale` 范围、少图人物与画风的倾向性建议，以及“低噪声负责细节、高噪声负责结构”的直觉分区，都属于社区与工程经验，应通过固定条件的 A/B 测试确认是否适用于当前数据集。

参考资料：

- [本项目 sd-scripts fork：`library/flux_train_utils.py`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/library/flux_train_utils.py)
- [本项目 sd-scripts fork：`library/anima_train_utils.py`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/sd-scripts/library/anima_train_utils.py)
- [本项目 musubi-tuner fork：`src/musubi_tuner/training/timesteps.py`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/musubi-tuner/src/musubi_tuner/training/timesteps.py)
- [本项目 musubi-tuner fork：`training/trainer_base.py`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/vendor/musubi-tuner/src/musubi_tuner/training/trainer_base.py)
- [本项目前端：`frontend/js/training-core.js`（固定提交）](https://github.com/amenorira/lora-scripts-anima/blob/85b6582dd4fb202bd5a6a7e301874c901fbc7e48/frontend/js/training-core.js)
- [Anima 官方模型卡（固定提交）](https://huggingface.co/circlestone-labs/Anima/blob/f7382c4bf9d7ffe4ceea593a0adbb470c56dd79b/README.md)
- [Scaling Rectified Flow Transformers for High-Resolution Image Synthesis](https://arxiv.org/abs/2403.03206)
- [Flow Matching for Generative Modeling](https://arxiv.org/abs/2210.02747)
