# Network parameters

Network settings determine the adapter's matrix structure, training scope, and weight-file size. Standard LoRA defaults to rank/Alpha `32/32` and dropout `0`. LoRA-Muon does not automatically change these to `16/16`; enter that combination manually if you want to use it.

MOSS-Image defaults to rank/Alpha `16/1` and offers native `networks.lora_generic`, `networks.loha`, and `networks.lokr`. All three support rank/module dropout, LoRA+, regex rank/learning-rate settings, and optional DiT text projection and refiner training; Qwen stays frozen. LoKr also exposes `lokr_factor`. MOSS targets linear layers, so convolution rank/alpha and Tucker controls are hidden; `lycoris.kohya` is unavailable. Equal ranks across algorithms do not imply equal parameter counts: inspect the matrices and scaling in the structure preview and tune learning rates separately.

<!-- doc-anchor: moss-text-embedder -->
## MOSS text projection and refiner blocks

`train_text_embedder` defaults to off. Enabling it adds adapters using the selected LoRA / LoHa / LoKr algorithm to the DiT text input projection and two refiner blocks. Qwen stays frozen, so text caching remains available.

These modules inherit the backbone learning rate. To set a separate rate, enter `network_reg_lrs=.*text_embedder.*=5e-5` in custom network arguments. `5e-5` is a syntax example; whether it lowers the rate depends on the current backbone value. EmoSens does not use group-specific learning rates, so this override does not change its actual step size.

<!-- doc-anchor: dimension -->
## Network dimension

`network_dim` (default `32`), also called rank, sets the intermediate dimension between standard LoRA's two matrices. Higher ranks represent a wider range of weight changes and produce larger files.

| Adjustment | What it provides | Cost or limitation |
| --- | --- | --- |
| Higher rank | A wider range of weight changes | More parameters, larger files, and more optimizer state |
| Lower rank | Fewer parameters and smaller files | Lower maximum rank of the represented weight change |

For standard LoRA, increasing rank increases the parameter count of both factors. Lower rank to reduce file size. When comparing algorithms, inspect actual parameter counts in the structure preview rather than comparing rank values directly.

<!-- doc-anchor: alpha -->
## Alpha

`network_alpha` (default `32`) controls branch scaling. Standard LoRA uses:

```text
ΔW = (Alpha / rank) × B × A
```

With rank and A/B weights fixed, higher Alpha strengthens the branch output and lower Alpha weakens it. Keep the default for an initial run. Alpha also scales training gradients, so reassess the learning rate after changing it.

| Configuration | Standard branch scale | Meaning |
| --- | --- | --- |
| Rank 32, Alpha 32 | 1 | No additional reduction of the matrix product |
| Rank 32, Alpha 16 | 0.5 | Half the contribution from the same matrix product |
| Rank 16, Alpha 16 | 1 | The same scale of 1, but a different intermediate dimension and parameter count |

`rs_lora` is off by default. On supported low-rank paths, it changes the denominator to √rank, reducing scale attenuation at high ranks. It is useful to compare when testing higher ranks; reassess the learning rate as well.

These formulas describe standard LoRA. LoKr has additional handling when factors are stored as full matrices, described below.

<!-- doc-anchor: algorithms -->
## LoRA, LoHa, and LoKr

| Algorithm | Representation | Configuration implication |
| --- | --- | --- |
| LoRA | Product of two low-rank matrices | Rank directly sets the intermediate dimension |
| LoHa | Elementwise product of two low-rank products | The same dimension does not give the same representation space as LoRA |
| LoKr | Kronecker product of two factors, which may themselves be low-rank | Factor and dimension control different levels of decomposition |

Standard LoRA is the default starting point. When comparing LoHa or LoKr, check parameter counts in the structure preview, then evaluate fidelity and new scenarios with matching prompts and seeds.

<!-- doc-anchor: lokr-factor -->
## LoKr factor

The basic form is `ΔW = scale × (W1 ⊗ W2)`. W1 and W2 jointly form the weight change; they are not separate input and output matrices.

`factor` determines their shape allocation. `dim` sets the intermediate rank when a factor is decomposed further. Factor is therefore not the standard LoRA rank, and it still matters in full-matrix mode.

The UI field is `lokr_factor`; the network receives it as `factor`. `-1` selects a near-balanced dimension split automatically. An explicit value changes the dimensions of the two Kronecker factors; inspect their shapes and parameter counts after changing it.

For illustration, consider one 2048×2048 weight layer with direct matrix factors, balanced factorization, and unbalanced factorization disabled:

| Factor | W1 shape | W2 shape | Parameters in the two factors |
| --- | --- | --- | --- |
| 4 | 4×4 | 512×512 | 262,160 |
| 8 | 8×8 | 256×256 | 65,600 |

Increasing factor from 4 to 8 reduces the parameter count in this example. Other layers use their own dimension splits; check the structure preview for the complete adapter size.

<!-- doc-anchor: full-matrix -->
## Full matrices and decomposition of both factors

LyCORIS LoKr defaults to `full_matrix=false` and `decompose_both=false`. Enabling `full_matrix` stores W1 and W2 directly and ignores `decompose_both`. With it off, factors also switch to direct storage when dim reaches their shape-dependent threshold. Test `decompose_both` to compress factors; enable `full_matrix` when direct training of both full factors is intended.

| Setting | W1 | W2 |
| --- | --- | --- |
| Full-matrix mode off, both-factor decomposition off | Direct matrix | Low-rank or direct, depending on dim and shape |
| Full-matrix mode off, both-factor decomposition on | Low-rank when eligible | Low-rank or direct, depending on dim and shape |
| Explicit full-matrix mode | Direct matrix | Direct matrix |

When both factors are stored directly, increasing dim no longer adds parameters to those factors. The current implementation still distinguishes these scales:

| Both factors are full matrices | Internal Alpha | Module scale |
| --- | --- | --- |
| `rs_lora=false` | Set to dim | 1 |
| `rs_lora=true` | Set to dim | √dim |

When both factors are full matrices, dim overrides the entered Alpha. With `rs_lora` enabled, dim still changes the scale. These rules apply to this project's LyCORIS LoKr; the structure preview shows the resulting values.

<!-- doc-anchor: unbalanced -->
## Unbalanced factorization

Unbalanced factorization swaps the two parts of the output dimension between factors, changing the aspect ratios of W1 and W2. Parameter count depends on the layer dimensions and decomposition mode; compare the actual counts before and after switching in the structure preview.

`unbalanced_factorization` is off by default. Change it when comparing matrix shapes or compression options, and check both parameter count and scale.

<!-- doc-anchor: dropout -->
## Network and caption dropout

Network dropout randomly masks features or branches during training and defaults to probability `0`. Higher probabilities omit more elements, channels, or branches from forward passes. If generated poses or backgrounds become fixed, compare earlier checkpoints before testing dropout separately.

| Type and key | What is omitted | Main purpose |
| --- | --- | --- |
| Standard LoRA feature dropout `network_dropout` | Elements of intermediate features | Reduce reliance on fixed feature combinations |
| Standard LoRA rank dropout `rank_dropout` | Low-rank channels | Reduce reliance on a few channels |
| Module dropout `module_dropout` | A layer's entire adapter branch | That layer uses its base-model output when the branch is omitted |
| Full-caption dropout `caption_dropout_rate` | All text conditioning | Include training without text; the image is still used |
| Tag dropout `caption_tag_dropout_rate` | Individual tags | Reduce reliance on complete tag combinations |

Dropout does not remove parameters from the saved file. Leading tags marked for retention are protected from individual tag dropout, but not from full-caption dropout.

For this project’s current LyCORIS LoKr, behavior also depends on the actual forward path:

| Actual LoKr path | Ordinary feature dropout | Rank dropout |
| --- | --- | --- |
| Direct bypass output | Applied to adapter outputs | Not used by this path |
| Weight reconstruction | Not used by this path | Masks output channels of the combined weight update |

Module dropout works in both paths. Quantization and weight decomposition affect which path is selected; check the active path before adjusting feature or rank dropout.

DoRA (`dora_wd`) requires applying its trainable magnitude. For ordinary Linear/Conv layers, the current LyCORIS LoCon, LoHa, and LoKr bypass paths do not apply that magnitude. Turn off `bypass_mode` when using DoRA so these layers reconstruct weights; feature dropout is not used in that path. FP8 weight-only LoKr is an exception: DoRA forces weight reconstruction even when Bypass is enabled. For the current FP8 weight-only layers, only LoKr supports DoRA; LoCon and LoHa do not create DoRA adapters on those layers.

<!-- doc-anchor: preview -->
## Check the actual structure

After changing dimension, factor, full-matrix mode, or unbalanced factorization, inspect the matrices, parameter count, and scale in the structure preview. To compare results, keep generation prompts and seeds fixed and check both fidelity and behavior in new settings.

<!-- doc-anchor: krea-targets -->
## Krea 2: default targets and filtering

Upstream defaults to rank/alpha 32 and all 264 DiT Linear layers: main-block attention, MLPs, the text-fusion transformer, and projection MLPs. Text fusion belongs to the DiT; the Qwen text encoder stays frozen and cached. Modulation and RMSNorm parameters are raw tensors, not Linear modules, so LoRA never wraps them and no exclusion is needed.

The upstream long-run example narrows training to main-block attention (140 Linear layers) and suggests a higher rank. To use that scope, enter this line in Network arguments:

```text
exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']
```

For an arbitrary subset, start with `exclude_patterns=['.*']`, then add targets back with `include_patterns=[...]`. Use one parameter per line. Adding include rules alone does not remove layers already included by default.

[Krea 2 upstream guide](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー)
