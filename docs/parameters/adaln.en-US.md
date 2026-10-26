# AdaLN Modulation Layers

<!-- doc-anchor: overview -->
## What the modulation layers are

AdaLN adjusts feature scales, offsets, and branch strengths for the current noise level, adapting the model to each stage of denoising.

Enabling this option adds adapters for AdaLN modulation layers to the existing training scope, increasing the parameter count and weight-file size. Native Anima networks leave it off by default.

<!-- doc-anchor: effects -->
## Changes to the training scope

| Setting | Training scope | Effect |
| --- | --- | --- |
| Off | The attention, MLP, and other modules already selected | The native default scope excludes AdaLN modulation layers |
| On | Adds AdaLN modulation modules to that scope | Adds modulation-branch adapters, parameters, and file size |

Custom inclusion patterns can also add modulation layers. Check the structure preview for the resulting training scope.

<!-- doc-anchor: usage -->
## Comparing on and off

To test the wider scope, keep data, learning rate, rank, seed, and total steps fixed and change only the AdaLN switch. Compare both target features and prompt control.

<!-- doc-anchor: default-behavior -->
## Upstream default behavior

Native Anima networks exclude layers matching `.*(_modulation|_norm|_embedder|final_layer).*` by default, including modulation, normalization, embedding, and output layers (`networks/lora_anima.py`; native LoHa / LoKr use the same configuration through `network_base.py`).

Enabling the toggle injects this into `network_args`:

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

which exempts exactly these three modulation branches. An existing `include_patterns` in the custom network arguments is merged into that single entry. The norm, embedder, and final layers stay excluded.

The structure preview shows the added parameters and estimated file size for the selected algorithm, rank, and training scope.

<!-- doc-anchor: settings -->
## Relation to other settings

| Network | Control | Conditions |
| --- | --- | --- |
| Native Anima networks | Train AdaLN layers in the main form | Supports `networks.lora_anima`, `networks.loha`, and `networks.lokr` |
| LyCORIS | The AdaLN option in LyCORIS settings | Uses the `attn-mlp` preset aligned with the sd-scripts default scope |

LyCORIS leaves sd-scripts scope alignment off by default for `attn-mlp`. In that mode, its scope settings determine whether AdaLN is trained. Check the structure preview to confirm the selected layers.
