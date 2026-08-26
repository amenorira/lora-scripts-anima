# AdaLN Modulation Layers

Each DiT block in Anima contains three structures LoRA can modify — self-attention, cross-attention, MLP — and a set of AdaLN modulation layers. sd-scripts excludes the modulation layers from LoRA by default; the "Train AdaLN modulation layers" toggle on the parameter page adds them back to the training targets.

<!-- doc-anchor: overview -->
## What the modulation layers are

During denoising, features are rescaled per channel (multiplied by a coefficient), shifted (an offset added), and in places gated. In Anima these coefficients are not fixed parameters; a small network computes them per timestep from the current noise level. AdaLN (adaptive normalization) is exactly this process: the scale and shift used by normalization are generated on the fly, and the modules that compute them are the modulation layers.

Each block has three modulation modules, one per branch (self-attention, cross-attention, MLP): `adaln_modulation_self_attn`, `adaln_modulation_cross_attn`, `adaln_modulation_mlp`. Each is a bottleneck of SiLU → 2048→256 → 256→6144, where 6144 = 3 × 2048 covers three output groups: scale, shift, and gate. The three sublayers consume them as `x + gate × sublayer(norm(x) × (1 + scale) + shift)`. The modulation modules read only the timestep embedding, not text.

The modulation layers change the per-channel statistics of whole feature maps (overall brightness, contrast) rather than what content is generated where, so they operate on a different axis than attention and MLP.

<!-- doc-anchor: default-behavior -->
## Upstream default behavior

When creating the LoRA network, sd-scripts applies a built-in exclusion regex — `.*(_modulation|_norm|_embedder|final_layer).*` — which excludes the modulation, norm, embedder, and final layers (`vendor/sd-scripts/networks/lora_anima.py`; LoHa/LoKr use the same Anima configuration through `network_base.py`). Under the default configuration, LoRA targets attention and MLP only.

Enabling the toggle injects this into `network_args`:

```
include_patterns=['.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*']
```

which exempts exactly these three modulation branches. An existing `include_patterns` in the custom network arguments is merged into that single entry. The norm, embedder, and final layers stay excluded.

File size: about 50% larger at rank 32. For comparison, diffusion-pipe trains all layers by default; the size difference between its outputs and default sd-scripts outputs at the same settings comes mainly from here.

<!-- doc-anchor: effects -->
## What training them changes

Without them, LoRA modifies only the attention and MLP weights; feature scale, shift, and gate stay as in the base model. Training them lets LoRA also modify the timestep → (scale/shift/gate) mapping, i.e. the overall statistics of features at each denoising step.

Two limitations:

1. **Stability.** One modulation update affects the statistics of every channel in a block — a wider sweep than attention/MLP — so training can become less stable (for example, color drift).
2. **Evidence.** SVD analysis of the official turbo↔base weight delta shows the modulation up-projections among the largest changes (see the [anima_lora AdaLN write-up](https://github.com/sorryhyun/anima_lora/blob/v1.14.3/docs/methods/adaln.md), checked 2026-08), so official distillation did modify this pathway significantly. Whether training the modulation layers improves style LoRAs had no public side-by-side render comparison as of that date.

<!-- doc-anchor: usage -->
## Recommendations

- Character and concept LoRAs: identity is carried mostly by attention and MLP, and no consistent difference from the modulation layers has been observed, so enabling it is generally unnecessary.
- Style LoRAs: enable it and compare against an off version with the same seed, keeping whichever renders better.

<!-- doc-anchor: settings -->
## Relation to other settings

- **rank and alpha**: same as the main network, not separately configurable. Upstream has no per-module alpha (modules matched by rank regexes are forced to the global `network_alpha` in `lora_anima.py`); lowering the modulation rank without changing alpha makes that branch's scale coefficient alpha/rank larger than the main network's.
- **Separate learning rate**: write `network_reg_lrs=.*adaln_modulation.*=5e-5` in the custom network arguments.
- **ComfyUI**: the output loads directly. ComfyUI builds a `lora_unet_` key mapping for every model weight, which the modulation keys match ([comfy/lora.py](https://github.com/comfyanonymous/ComfyUI/blob/2a610155821d670a2d8047e654e5fce96b790eb5/comfy/lora.py), commit 2a61015, checked 2026-08). The bundled `convert_anima_lora_to_comfy.py` is needed only for external distribution or for mixing with diffusion-pipe outputs.
- **Scope**: `networks.lora_anima`, `networks.loha`, `networks.lokr`. `lycoris.kohya`'s Anima training path is unverified and unaffected by this toggle.