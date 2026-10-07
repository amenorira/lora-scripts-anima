# Network parameters

Network settings control adapter capacity, training scope, and file size. For standard LoRA, start with `network_dim=32`, `network_alpha=32`, and zero dropout. Adjust rank when more capacity or a smaller file is needed. LoRA-Muon recommends `16/16` for dimension and Alpha when those fields have not been edited.

<!-- doc-anchor: dimension -->
## Network dimension

`network_dim` (default `32`), also called rank, sets the intermediate dimension between standard LoRA's two matrices. Higher ranks represent a wider range of weight changes and produce larger files.

| Adjustment | What it provides | Cost or limitation |
| --- | --- | --- |
| Higher rank | A wider range of weight changes | More parameters, larger files, and more optimizer state |
| Lower rank | Fewer parameters and smaller files | Less capacity to represent several complex features at once |

The default is a useful starting point for characters, styles, and concepts. Raise rank when complex features remain underlearned after checking learning rate, duration, and captions. Dimensions have different meanings across algorithms; compare LoKr and LoRA by their actual parameter counts and matrix structures.

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

The UI field is `lokr_factor`; the network receives it as `factor`. The default, `-1`, automatically chooses a near-balanced dimension split. Leave it unchanged for an initial run, then compare explicit values when tuning file size.

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

Unbalanced factorization swaps how the two parts of the output dimension are allocated to the factors. This gives W1 and W2 different aspect ratios and can substantially change the parameter count.

`unbalanced_factorization` is off by default. Change it when comparing matrix shapes or compression options, and check both parameter count and scale.

<!-- doc-anchor: dropout -->
## Network and caption dropout

Network dropout randomly masks features or branches during training to reduce reliance on fixed combinations. Dropout rates default to `0`. If overfitting persists after checking training duration and repeated data, test a small rate. Higher rates strengthen regularization but slow learning; lower rates retain more training signal.

| Type and key | What is omitted | Main purpose |
| --- | --- | --- |
| Standard LoRA feature dropout `network_dropout` | Elements of intermediate features | Reduce reliance on fixed feature combinations |
| Standard LoRA rank dropout `rank_dropout` | Low-rank channels | Reduce reliance on a few channels |
| Module dropout `module_dropout` | An entire adapter branch | Use the base-model output for some training passes |
| Full-caption dropout `caption_dropout_rate` | All text conditioning | Include training without text; the image is still used |
| Tag dropout `caption_tag_dropout_rate` | Individual tags | Reduce reliance on complete tag combinations |

Dropout does not remove parameters from the saved file. Leading tags marked for retention are protected from individual tag dropout, but not from full-caption dropout.

For this project’s current LyCORIS LoKr, behavior also depends on the actual forward path:

| Actual LoKr path | Ordinary feature dropout | Rank dropout |
| --- | --- | --- |
| Direct bypass output | Applied to adapter outputs | Not used by this path |
| Weight reconstruction | Not used by this path | Masks output channels of the combined weight update |

Module dropout works in both paths. Quantization and weight decomposition affect which path is selected; check the active path before adjusting feature or rank dropout.

<!-- doc-anchor: preview -->
## Check the actual structure

After changing dimension, factor, full-matrix mode, or unbalanced factorization, inspect the matrices, parameter count, and scale in the structure preview. To compare results, keep generation prompts and seeds fixed and check both fidelity and behavior in new settings.
