<a name="guide-title"></a>
# AdaLN Modulation Layers

<a name="overview"></a>
## Role, parameter impact, and when to enable

AdaLN (Adaptive Layer Normalization) adjusts internal feature scales, shifts, and residual gate strengths based on the current noise timestep, shaping how each Transformer block responds across coarse high-noise layout stages and fine low-noise detail stages.

Native Anima networks exclude these layers by default. Enabling **Train AdaLN layers** adds adapters to all three modulation Linear projections in every main block alongside attention and MLPs, increasing parameter count and file size substantially (shown below for 28-block Anima-Preview with standard LoRA at Rank `32` in `bf16`; 40-block Anima-2.9B scales proportionally from `400` to `640` layers):

| Setting | Target Linear layers | Trainable parameters | Estimated file size (`bf16`) |
| --- | --- | --- | --- |
| Off (native default) | `280` layers | `45.88M` | `87.6 MiB` |
| On | `448` layers (`+168` layers) | `69.27M` (**`+51.0%`**) | `132.3 MiB` (`+44.7 MiB`) |

<div id="effects"></div>
<div id="usage"></div>

- **Keep off (default)**: Single characters, facial identity, outfits, props, or small datasets (`< 30` images). Attention and MLP layers already capture subject identity cleanly while avoiding a 51% parameter jump and faster memorization.
- **Worth testing on**: Global art-style, lighting, color-grading, or atmospheric runs that need consistent tonal shifts across high- and low-noise denoising stages.
- **Overuse symptoms and A/B testing**: If enabling AdaLN locks lighting direction and ambient color palettes to the training set or dulls response to scene/lighting prompt changes, modulation layers are memorizing dataset statistics. To verify real gains, hold data, Rank, learning rate, seed, and total steps fixed and toggle **Train AdaLN layers** alone.

<a name="settings"></a>
## Scope differences: native Anima vs. LyCORIS

<div id="default-behavior"></div>

Native Anima networks and LyCORIS presets handle AdaLN in opposite ways by default—check which path is active when switching modules:

| Network implementation | UI control | Default scope and toggle behavior |
| --- | --- | --- |
| Native Anima networks (`networks.lora_anima`, `networks.loha`, `networks.lokr`) | **Train AdaLN layers** in the main form | **Excluded by default**; turning the toggle on adds all three AdaLN modulation branches per block |
| LyCORIS (`full`, `full-lin`, or `attn-mlp` with scope alignment off) | Included automatically | **Included by default** without extra toggles |
| LyCORIS (`attn-mlp` + **Align with sd-scripts default** enabled) | **Train AdaLN modulation** inside LyCORIS settings | Scope alignment excludes AdaLN to match native `sd-scripts`; enable the nested AdaLN toggle to add those modulation layers back |

In native Anima networks, the upstream exclusion pattern `.*(_modulation|_norm|_embedder|final_layer).*` omits modulation, normalization, conditioning embedders, and the output layer (`final_layer`). Enabling **Train AdaLN layers** injects:

```text
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

into `network_args` (merging automatically with any `include_patterns` in **Custom network arguments**), exempting only the self-attention, cross-attention, and MLP modulation branches while keeping normalization, embedder, and output (`final_layer`) layers excluded. After toggling AdaLN or changing LyCORIS presets, inspect the resulting layer count and file size in [Matrix structure and file size](matrix-preview.en-US.md).
