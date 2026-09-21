# AdaLN Modulation Layers

<!-- doc-anchor: overview -->
## What the modulation layers are

AdaLN adjusts feature processing according to the current noise level. It can be viewed as a set of controls for the model’s processing branches: global reconstruction at high noise and local refinement at low noise need different feature scales, offsets, and branch strengths.

Enabling AdaLN training lets the LoRA modify these controls as well as attention and MLP layers. It changes internal features, not image brightness or contrast directly, and its effects are not limited to color.

| Setting | Training scope | Effect |
| --- | --- | --- |
| Off | The attention, MLP, and other modules already selected | AdaLN parameters retain their base-model values |
| On | Adds AdaLN modulation modules to that scope | More pathways can change, increasing parameters and file size |

<!-- doc-anchor: default-behavior -->
## Upstream default behavior

When creating the LoRA network, sd-scripts applies a built-in exclusion regex — `.*(_modulation|_norm|_embedder|final_layer).*` — which excludes the modulation, norm, embedder, and final layers (`vendor/sd-scripts/networks/lora_anima.py`; LoHa/LoKr use the same Anima configuration through `network_base.py`). So a default LoRA touches attention and MLP only, and the timestep → scale/shift/gate mapping stays exactly as in the base model.

Enabling the toggle injects this into `network_args`:

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

which exempts exactly these three modulation branches. An existing `include_patterns` in the custom network arguments is merged into that single entry. The norm, embedder, and final layers stay excluded.

The cost is file size: about 50% larger at rank 32. For comparison, diffusion-pipe lists every Linear inside the blocks as a training target by default — modulation layers included, plus the DiT's LLM adapter — while its embedders and final layer are likewise not targeted. The size gap between its outputs and default sd-scripts outputs comes mainly from the modulation layers.

<!-- doc-anchor: effects -->
## What training them changes

For style training, this is a way to compare a wider training scope. Inspect shape, linework, color, and prompt response. Character training is not theoretically excluded either; use the reference run to decide whether the extra scope is useful.

Channel-wise modulation does not imply a color-only role, nor does it by itself establish that AdaLN is less stable than attention or MLP training.

<!-- doc-anchor: usage -->
## Recommendations

- Character and concept LoRAs: identity is carried mostly by attention and MLP; usually leave the toggle off.
- Style LoRAs: worth enabling — train one run with it on and one with it off at the same seed, and judge by the renders.

<!-- doc-anchor: settings -->
## Relation to other settings

Each network path has its own AdaLN control.

| Network | Control | Conditions |
| --- | --- | --- |
| Native Anima networks | Train AdaLN layers in the main form | Subject to the selected native network’s supported scope |
| LyCORIS | The AdaLN option in LyCORIS settings | Uses the `attn-mlp` preset aligned with the sd-scripts default scope |

File-size growth depends on the algorithm, rank, and training scope. Use the structure preview for the current configuration rather than applying one standard-LoRA percentage to every network.
