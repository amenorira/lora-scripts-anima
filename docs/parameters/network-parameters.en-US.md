# Network parameters

Network settings determine how an adapter represents weight changes and which parts can participate in training. They affect capacity, file size, and learning behavior, but do not provide a universal ranking of fidelity or generalization.

<!-- doc-anchor: dimension -->
## Network dimension

Standard LoRA represents a layer’s weight change using two smaller matrices. The network dimension, usually called rank, is the size of the intermediate space. A higher rank allows more independent directions of change; it does not increase image resolution or directly set inference strength.

| Adjustment | What it provides | Cost or limitation |
| --- | --- | --- |
| Higher rank | A wider range of weight changes | More parameters, larger files, and more optimizer state; useful data and sufficient training are still needed |
| Lower rank | Fewer parameters and smaller files | Less capacity to represent several complex features at once |

Weak target features can also come from learning rate, training duration, or captions. Increasing rank is not the only response. Dimension settings are not equivalent across algorithms: LoKr dimension 128 is not directly comparable with standard LoRA rank 128.

<!-- doc-anchor: alpha -->
## Alpha

Standard LoRA uses:

```text
ΔW = (Alpha / rank) × B × A
```

At a fixed rank and with the same A and B weights, a higher Alpha increases the branch’s contribution. During training, however, Alpha also changes gradients. Its ratio alone therefore cannot predict the relative inference strength of two independently trained adapters.

| Configuration | Standard branch scale | Meaning |
| --- | --- | --- |
| Rank 32, Alpha 32 | 1 | No additional reduction of the matrix product |
| Rank 32, Alpha 16 | 0.5 | Half the contribution from the same matrix product |
| Rank 16, Alpha 16 | 1 | The same scale of 1, but a different intermediate dimension and parameter count |

On supported low-rank paths, `rs_lora` changes the denominator from rank to its square root, reducing the scale reduction at higher ranks. This changes training scale; the word “stabilized” does not guarantee a better result.

These formulas describe standard LoRA. LoKr has additional handling when factors are stored as full matrices, described below.

<!-- doc-anchor: algorithms -->
## LoRA, LoHa, and LoKr

| Algorithm | Representation | Configuration implication |
| --- | --- | --- |
| LoRA | Product of two low-rank matrices | Rank directly sets the intermediate dimension |
| LoHa | Elementwise product of two low-rank products | The same dimension does not give the same representation space as LoRA |
| LoKr | Kronecker product of two factors, which may themselves be low-rank | Factor and dimension control different levels of decomposition |

Parameter count measures how many trainable values are stored, not which changes those values can represent. Similar file sizes can have different structural constraints and do not imply identical fidelity, cross-model transfer, or adapter-combination behavior.

<!-- doc-anchor: lokr-factor -->
## LoKr factor

The basic form is `ΔW = scale × (W1 ⊗ W2)`. W1 and W2 jointly form the weight change; they are not separate input and output matrices.

`factor` determines their shape allocation. `dim` sets the intermediate rank when a factor is decomposed further. Factor is therefore not the standard LoRA rank, and it still matters in full-matrix mode.

For illustration, consider one 2048×2048 weight layer with direct matrix factors, balanced factorization, and unbalanced factorization disabled:

| Factor | W1 shape | W2 shape | Parameters in the two factors |
| --- | --- | --- | --- |
| 4 | 4×4 | 512×512 | 262,160 |
| 8 | 8×8 | 256×256 | 65,600 |

This explains why increasing factor can substantially reduce file size for some layer shapes. It is not a rule that larger factors generalize better, and these counts do not describe a complete Anima adapter.

<!-- doc-anchor: full-matrix -->
## Full matrices and decomposition of both factors

In this project’s current LyCORIS LoKr implementation, explicitly enabling `full_matrix` stores both W1 and W2 directly. `decompose_both` does not further decompose them in that mode. With full-matrix mode off, a factor can still switch to direct storage when dim reaches its shape-dependent threshold.

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

It is therefore incorrect to say that dim, Alpha, and rs_lora all become irrelevant in full-matrix mode. This table describes the current constructor’s module scale, not a guaranteed inference strength. Check the actual scale in the structure preview. These details apply to this project’s vendored LyCORIS implementation, not every native or external LoKr implementation.

<!-- doc-anchor: unbalanced -->
## Unbalanced factorization

Unbalanced factorization swaps how the two parts of the output dimension are allocated to the factors. This gives W1 and W2 different aspect ratios and can substantially change the parameter count.

It is an alternative parameter allocation, not a direct quality or generalization control. Compare actual shapes, parameter counts, and scales; the same factor value does not necessarily mean the same adapter size.

<!-- doc-anchor: dropout -->
## Network and caption dropout

Network dropout prevents an adapter from always relying on the same features or branches during training. It is a form of regularization, but increasing the rate also reduces effective learning. A small dataset is not by itself a reason to use high dropout.

| Type | What is omitted | Main purpose |
| --- | --- | --- |
| Standard LoRA feature dropout | Elements of intermediate features | Reduce reliance on fixed feature combinations |
| Standard LoRA rank dropout | Low-rank channels | Reduce reliance on a few channels |
| Module dropout | An entire adapter branch | Sometimes use the original base-model output |
| Full-caption dropout | All text conditioning | Include training without text; the image is still used |
| Tag dropout | Individual tags | Avoid always training with the complete tag combination |

Dropout does not remove parameters from the saved file. Leading tags marked for retention are protected from individual tag dropout, but not from full-caption dropout.

For this project’s current LyCORIS LoKr, behavior also depends on the actual forward path:

| Actual LoKr path | Ordinary feature dropout | Rank dropout |
| --- | --- | --- |
| Direct bypass output | Applied to adapter outputs | Not used by this path |
| Weight reconstruction | Not used by this path | Masks output channels of the combined weight update |

Module dropout is handled before the forward path is selected. Some quantization and weight-decomposition combinations alter which path is used, so judge the actual training path rather than a switch name or an old constructor warning alone.

<!-- doc-anchor: preview -->
## Check the actual structure

After changing dimension, factor, full-matrix mode, or unbalanced factorization, inspect the matrices, parameter count, and scale in the structure preview. To compare results, keep generation prompts and seeds fixed and check both fidelity and behavior in new settings.
