# AdaLN Modulation Layers

<!-- doc-anchor: overview -->
## What the modulation layers are

AdaLN adjusts feature scales, offsets, and branch strengths for the current noise level, adapting the model to each stage of denoising.

Enabling AdaLN training extends the adapter to these modulation layers, which can affect shape, linework, color, and prompt response. Native Anima networks leave it off by default. Keep that default for character and concept LoRAs; test it for style training when the baseline needs a wider training scope.

| Setting | Training scope | Effect |
| --- | --- | --- |
| Off | The attention, MLP, and other modules already selected | AdaLN parameters retain their base-model values |
| On | Adds AdaLN modulation modules to that scope | More pathways can change, increasing parameters and file size |

<!-- doc-anchor: effects -->
## What training them changes

AdaLN adds trainable modulation paths while leaving timestep sampling unchanged. Compare shape, linework, and overall style, and check that prompt control is preserved.

<!-- doc-anchor: usage -->
## Recommendations

- Character and concept LoRAs: start with the default scope. Leave AdaLN off when target features are already learned well.
- Style LoRAs: test a wider scope with the same data, learning rate, and seed, comparing runs with AdaLN on and off.

<!-- doc-anchor: default-behavior -->
## Upstream default behavior

When creating the LoRA network, sd-scripts applies a built-in exclusion regex — `.*(_modulation|_norm|_embedder|final_layer).*` — which excludes the modulation, norm, embedder, and final layers (`vendor/sd-scripts/networks/lora_anima.py`; LoHa/LoKr use the same Anima configuration through `network_base.py`). So a default LoRA touches attention and MLP only, and the timestep → scale/shift/gate mapping stays exactly as in the base model.

Enabling the toggle injects this into `network_args`:

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

which exempts exactly these three modulation branches. An existing `include_patterns` in the custom network arguments is merged into that single entry. The norm, embedder, and final layers stay excluded.

The structure preview shows the added parameters and estimated file size for the selected algorithm, rank, and training scope.

<!-- doc-anchor: settings -->
## Relation to other settings

Each network path has its own AdaLN control.

| Network | Control | Conditions |
| --- | --- | --- |
| Native Anima networks | Train AdaLN layers in the main form | Supports `networks.lora_anima`, `networks.loha`, and `networks.lokr` |
| LyCORIS | The AdaLN option in LyCORIS settings | Uses the `attn-mlp` preset aligned with the sd-scripts default scope |

LyCORIS leaves sd-scripts scope alignment off by default for `attn-mlp`. In that mode, check the LyCORIS scope settings and structure preview to see whether AdaLN is trained; the main-form toggle does not control it.
