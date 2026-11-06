# Network parameters

Network settings determine the adapter's matrix structure, training scope, and weight-file size. New configurations use dropout `0` and the following rank/Alpha defaults:

| Training profile | Default rank / Alpha |
| --- | --- |
| Anima, SDXL, Krea 2 | `32/32` |
| MOSS-Image | `16/1` |

MOSS-Image offers native `networks.lora_generic`, `networks.loha`, and `networks.lokr`. All three support rank/module dropout, LoRA+, regex rank/learning-rate settings, and optional DiT text projection and refiner training; Qwen stays frozen. LoKr also exposes `lokr_factor`.

MOSS targets linear layers, so the UI provides linear-layer controls and the three native modules listed above. Parameter counts and scaling can vary between algorithms at the same rank; check the structure preview.

<!-- doc-anchor: moss-text-embedder -->
## MOSS text projection and refiner blocks

`train_text_embedder` defaults to off. Enabling it adds adapters using the selected LoRA / LoHa / LoKr algorithm to the DiT text input projection and two refiner blocks. Qwen stays frozen, so text caching remains available.

These modules inherit the backbone learning rate. To set matched layers to `5e-5`, enter `network_reg_lrs=.*text_embedder.*=5e-5` in custom network arguments. EmoSens uses one learning rate for all parameters, so this override is inactive with EmoSens.

<!-- doc-anchor: dimension -->
## Network dimension

`network_dim`, also called rank, sets the intermediate dimension between standard LoRA's two matrices. It defaults to `32` for Anima, SDXL, and Krea 2, and `16` for MOSS-Image.

| Adjustment | What it provides | Cost or limitation |
| --- | --- | --- |
| Higher rank | A wider range of weight changes | More parameters, larger files, and more optimizer state |
| Lower rank | Fewer parameters and smaller files | Lower maximum rank of the represented weight change |

When comparing algorithms, use the actual parameter counts in the structure preview to compare configuration sizes.

<!-- doc-anchor: alpha -->
## Alpha

LoRA stores two small matrices, A and B. During training and use, their product is multiplied by `Alpha / Rank` to produce the weight change added to the base model:

```text
ΔW = (Alpha / Rank) × B × A
```

Very small LoRA weights can round to zero when saved at low precision, losing some of the learned changes. One reason Kohya introduced Network Alpha was to reduce this risk: a smaller `Alpha / Rank` multiplier allows larger internal weights to represent the desired weight change. With Rank fixed, a smaller Alpha requires a larger matrix product B × A to represent the same ΔW. To reduce the risk of losing small weights when saving, you can lower Alpha before your next training run, for example to half the Rank or to 1.

For example, at Rank 32, lowering Alpha from 32 to 1 changes the multiplier from 1 to `1/32`, so representing the same ΔW requires a matrix product 32 times as large. The values actually learned still depend on training.

### Choosing a value

For a first run, keep the defaults: Rank 32 / Alpha 32 for Anima, SDXL, and Krea 2; Rank 16 / Alpha 1 for MOSS-Image. When following an existing training recipe, keep its Rank, Alpha, and learning rate together.

To try a smaller Alpha, click `½ dim` to set it to half the Rank, or click `1` to set it to 1. If the default is already 1, there is no need to lower it further for this purpose.

For standard LoRA at Rank 32:

| Shortcut | Alpha | Multiplier | When to use it |
| --- | --- | --- | --- |
| `= dim` | 32 | 1 | A starting point with no extra reduction of the matrix product |
| `½ dim` | 16 | 0.5 | A first step when trying a smaller Alpha |
| `1` | 1 | 1/32 | Follow an Alpha-1 recipe or explore much smaller scaling |

Alpha 1 is not necessarily better; training results also depend on the learning rate, optimizer, and data.

Alpha does not change parameter count or file size. Each shortcut sets the value once; changing Rank afterward does not update Alpha.

### How it relates to learning rate

Alpha is applied during training and affects gradients, so consider the learning rate when changing it. The Kohya Wiki describes halving Alpha as halving the effect of the learning rate, but optimizers such as AdamW also transform the gradients, so actual updates do not follow that ratio exactly. Halving Alpha and doubling the learning rate may produce different training results.

In practice, keep Rank and other settings fixed, change Alpha alone, and compare several checkpoints using the same prompts and seeds. If learning becomes noticeably slower, try increasing the learning rate. If training becomes unstable or overfits quickly, lower it first. Avoid jumping to a learning rate tens of times larger based on the multiplier alone.

### Other settings

Start within `1–Rank` in most cases. Alpha equal to Rank gives a multiplier of 1. Alpha above Rank amplifies the matrix product and is allowed by the current standard LoRA implementations. Some native implementations treat Alpha 0 as Rank, so do not rely on 0 to disable LoRA.

With `rs_lora` enabled, the denominator becomes √Rank. At Rank 32 and Alpha 1, the multiplier changes from `0.03125` to about `0.177`; Alpha equal to Rank no longer gives a multiplier of 1 either. Revisit Alpha and the learning rate after switching. rsLoRA addresses diminishing scaling at high ranks; the paper's experiments primarily use language models.

LoHa and LoKr also depend on their matrix structures. Check their scale in the structure preview, and see [full matrices](#full-matrix) for LoKr's full-factor behavior.

References: [Kohya parameter guide](https://github.com/bmaltais/kohya_ss/wiki/LoRA-training-parameters#network-alpha) · [LoRA §4.1](https://arxiv.org/html/2106.09685v2#S4.SS1) · [rsLoRA](https://arxiv.org/html/2312.03732v1)

<!-- doc-anchor: algorithms -->
## LoRA, LoHa, and LoKr

| Algorithm | Representation | Configuration implication |
| --- | --- | --- |
| LoRA | Product of two low-rank matrices | Rank directly sets the intermediate dimension |
| LoHa | Elementwise product of two low-rank products | Dimension sets the intermediate size of each low-rank product |
| LoKr | Kronecker product of two factors, which may themselves be low-rank | Factor and dimension control different levels of decomposition |

Standard LoRA is the default starting point. When comparing LoHa or LoKr, check parameter counts in the structure preview, then evaluate fidelity and new scenarios with matching prompts and seeds.

<!-- doc-anchor: lokr-factor -->
## LoKr factor

The basic form is `ΔW = scale × (W1 ⊗ W2)`. W1 and W2 jointly represent the weight change through their Kronecker product.

`factor` determines their shape allocation and remains active in full-matrix mode. `dim` sets the intermediate rank when a factor is decomposed further.

The UI field is `lokr_factor`; the network receives it as `factor`. `-1` selects a near-balanced dimension split automatically. An explicit value changes the dimensions of the two Kronecker factors; inspect their shapes and parameter counts after changing it.

For illustration, consider one 2048×2048 weight layer with direct matrix factors and balanced factorization:

| Factor | W1 shape | W2 shape | Parameters in the two factors |
| --- | --- | --- | --- |
| 4 | 4×4 | 512×512 | 262,160 |
| 8 | 8×8 | 256×256 | 65,600 |

Increasing factor from 4 to 8 reduces the parameter count in this example. Other layers use their own dimension splits; check the structure preview for the complete adapter size.

<!-- doc-anchor: full-matrix -->
## Full matrices and decomposition of both factors

LyCORIS LoKr defaults to `full_matrix=false` and `decompose_both=false`. Enabling `full_matrix` stores W1 and W2 directly and ignores `decompose_both`. With it off, factors also switch to direct storage when dim reaches their shape-dependent threshold.

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

These scaling rules apply to this project's LyCORIS LoKr; check the structure preview for the resulting values.

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

Anima's LyCORIS DoRA (`dora_wd`) uses the following paths:

| Layer type | DoRA requirements |
| --- | --- |
| Ordinary Linear/Conv: LoCon, LoHa, LoKr | Turn off `bypass_mode` to apply the trainable magnitude through weight reconstruction; feature dropout is inactive on this path |
| FP8 weight-only: LoKr | Enabling DoRA forces weight reconstruction, overriding Bypass |
| FP8 weight-only: LoCon, LoHa | Creating DoRA adapters on these layers is currently unsupported |

See [Krea 2 targets](#krea-targets) for its quantization and bypass restrictions.

<!-- doc-anchor: preview -->
## Check the actual structure

After changing dimension, factor, full-matrix mode, or unbalanced factorization, inspect the matrices, parameter count, and scale in the structure preview. When comparing algorithms, record the actual trainable parameter count; see the [controlled comparison steps](timesteps.en-US.md#comparison-method).

<!-- doc-anchor: krea-targets -->
## Krea 2: default targets and filtering

Rank/Alpha defaults to `32/32`, targeting all 264 DiT Linear layers: main-block attention, MLPs, the text-fusion transformer, and projection MLPs. Text fusion belongs to the DiT; the Qwen text encoder stays frozen and cached. Modulation and RMSNorm use raw tensors, which are automatically outside the Linear LoRA target scope.

Krea 2 offers native LoRA and LyCORIS LoCon / LoKr / LoHa, all using the same target selector: All Linear (264), Main Attention (140), Main Attention + MLP (224), or custom regexes. All Linear includes input/output, time, and text-fusion projections.

Custom regexes fully match original Linear layer names, one per line; exclusions take precedence. Include `blocks\.[0-9]+\.attn\..*` for main attention, or include `.*` and exclude `txtfusion\..*` to omit text fusion. Empty selections fail before launch.

The LyCORIS panel shows the applicable factor, full-matrix, decompose-both, unbalanced factorization, scalar, rsLoRA, DoRA, bypass, and kernel controls for each algorithm. Krea 2 targets linear layers.

| Algorithm | Dropout and LoRA+ support |
| --- | --- |
| Native LoRA | Rank/module dropout and LoRA+ |
| LyCORIS LoCon | Ordinary dropout, rank/module dropout, and LoRA+; positive ordinary dropout enables bypass, and DoRA requires ordinary dropout `0` |
| LyCORIS LoHa | Rank/module dropout |
| LyCORIS LoKr | Module dropout only on the current path |

FP8 or ConvRot INT8 base weights force LyCORIS bypass mode. DoRA requires both quantization modes and `bypass_mode` to be off.

Save portable settings as `training.yaml`; the per-run target preset is generated automatically.

Legacy native LoRA Network arguments remain supported under All Linear. New configurations should use the target selector:

```text
exclude_patterns=['.*\.mlp\..*','first','last\.linear','tmlp\..*','txtmlp\..*','tproj\.1','txtfusion\..*']
```

In legacy native arguments, `include_patterns` adds matching layers back and does not remove default targets. For LyCORIS, use the target selector and guided controls.

[Krea 2 upstream guide](https://github.com/kohya-ss/musubi-tuner/blob/f8a1b03794a49239a3539015075f5123d6c07d66/docs/krea2.md#lora-target-layers--loraの対象レイヤー)
