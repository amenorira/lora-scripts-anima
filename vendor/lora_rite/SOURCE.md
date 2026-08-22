# LoRA-RITE source

- Paper: [LoRA Done RITE: Robust Invariant Transformation Equilibration for LoRA Optimization](https://arxiv.org/abs/2410.20625) (ICLR 2025)
- Upstream: https://github.com/gkevinyen5418/LoRA-RITE (authors' PyTorch reimplementation of the original JAX code)
- Commit: `d4186b6fedb39300d23c00ce0334db09719da9fc` (`main`, checked 2026-08-22)
- License: upstream ships no LICENSE file. Its README explicitly invites
  copying: "Please copy lora_rite.py to your directory or install it as a
  module." Attribution is kept here and in the file header. If upstream adds a
  license later, vendored copies should adopt it.

## Vendored files

- `lora_rite.py` is based on upstream `lora_rite.py`.

## Local adaptations

- `betas` defaults to `(0.9, 0.999)`. Upstream makes it a required argument,
  but sd-scripts' generic optimizer loader only passes `lr` plus user-provided
  `optimizer_args`.
- Pairing is validated loudly: each param group must contain an even number of
  tensors in alternating lora_down/lora_up order with matching rank. Upstream
  silently skips an unpaired trailing parameter.
- Linear algebra (QR/eigh/SVD/pinv) and optimizer state run in fp32. Upstream
  computes in parameter dtype, which is unreliable under bf16 mixed precision.
- Parameters with `grad is None` are skipped for that step instead of
  crashing, so `rank_dropout` / `module_dropout` remain usable.
- `maybe_inf_to_nan` is actually forwarded to the helper (upstream drops it).
- `inverse_sqrt`'s `relative_epsilon=True` path referenced an undefined
  `p_new`; it now uses the matrix being inverted. The default
  (`relative_epsilon=False`) is unaffected.
- State initializes lazily per pair, so `load_state_dict` (training resume) is
  not wiped by re-initialization. Upstream re-initializes all state on the
  first `step()` after construction.
- `LoRARite.__name__` is set to `"LoRA-RITE"` so sd-scripts records that exact
  string in the safetensors `ss_optimizer` metadata. Imports still use the
  real attribute name `LoRARite`.
