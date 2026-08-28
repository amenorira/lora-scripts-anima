# AdaLN Modulation Layers

> Each Anima DiT block holds, besides self-attention, cross-attention and an MLP, one set of AdaLN modulation layers that adjust the features' overall tone according to the noise level. sd-scripts does not train them by default; the "Train AdaLN modulation layers" toggle on the parameter page adds them to the training targets. Worth trying for style LoRAs; character and concept LoRAs usually don't need it.

<!-- doc-anchor: overview -->
## What the modulation layers are

Before each denoising step, Anima adjusts the features according to how noisy the current step is: every channel is multiplied by a coefficient and shifted by an offset, and the output of each branch (self-attention, cross-attention, MLP) is gated per channel. These coefficients are not fixed parameters of the model; three small networks per block compute them on the fly from the timestep. AdaLN (adaptive normalization) is this mechanism, and the modules computing the coefficients are the modulation layers.

Each block has three modulation modules, one per branch: `adaln_modulation_self_attn`, `adaln_modulation_cross_attn`, `adaln_modulation_mlp`. The three sublayers consume them as `x + gate × sublayer(norm(x) × (1 + scale) + shift)`. Each module is two bias-free linears, SiLU → 2048→256 → 256→6144, where 6144 = 3 × 2048 covers the three output groups: scale, shift, and gate. The modulation modules read only the timestep embedding, not text.

The modulation layers change the per-channel tone of whole feature maps — overall brightness, contrast — rather than what content is generated where. That different axis of effect is why they get a toggle of their own.

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

Without them, LoRA modifies only the attention and MLP weights; feature scale, shift, and gate stay as in the base model. Training them lets LoRA also modify the timestep → (scale/shift/gate) mapping, i.e. the overall tone of features at each denoising step.

Two limitations:

1. **Stability.** One modulation update affects every channel in a block — a wider sweep than attention/MLP — so training is more easily destabilized (typically as color drift).
2. **Evidence.** SVD analysis of the official turbo↔base weight delta shows the modulation up-projections among the largest changes (see the [anima_lora AdaLN write-up](https://github.com/sorryhyun/anima_lora/blob/v1.14.3/docs/methods/adaln.md), checked 2026-08), so official distillation did modify this pathway significantly. As of that date, no public side-by-side render comparison supported the claim that training modulation layers improves style LoRAs.

<!-- doc-anchor: usage -->
## Recommendations

- Character and concept LoRAs: identity is carried mostly by attention and MLP; usually leave the toggle off.
- Style LoRAs: worth enabling — train one run with it on and one with it off at the same seed, and judge by the renders.

<!-- doc-anchor: settings -->
## Relation to other settings

- **rank and alpha**: same as the main network, not separately configurable. Upstream has no per-module alpha (modules matched by rank regexes are forced to the global `network_alpha` in `lora_anima.py`); lowering the modulation rank without changing alpha makes that branch's scale coefficient alpha/rank larger than the main network's.
- **Separate learning rate**: write `network_reg_lrs=.*adaln_modulation.*=5e-5` in the custom network arguments.
- **Trainable modules outside the blocks**: the DiT also contains an adapter that translates Qwen3 output into cross-attention context (6 layers, 60 linears in total), controlled solely by the custom network argument `train_llm_adapter=true`; off by default and unrelated to this toggle. The text encoder (Qwen3) is likewise not trained by default.
- **ComfyUI**: the output loads directly. ComfyUI builds a `lora_unet_` key mapping for every model weight, which the modulation keys match ([comfy/lora.py](https://github.com/comfyanonymous/ComfyUI/blob/2a610155821d670a2d8047e654e5fce96b790eb5/comfy/lora.py), commit 2a61015, checked 2026-08). The bundled `convert_anima_lora_to_comfy.py` is needed only for external distribution or for mixing with diffusion-pipe outputs.
- **Scope**: `networks.lora_anima`, `networks.loha`, `networks.lokr`. `lycoris.kohya`'s Anima training path is unverified and unaffected by this toggle.
