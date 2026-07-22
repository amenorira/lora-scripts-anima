# EmoSens source

- Upstream: https://github.com/muooon/EmoSens
- Branch: `v3.9.0_ecc`
- Commit: `2afff7a9a709e287e487dcd130b1e70a375ae4b2`
- License: Apache-2.0, included in `LICENSE`

## Vendored files

- `emosens.py` comes from `optimizer/emosens.py`.

## Local adaptations

- Package paths use `vendor.emo_optimizer`.
- Console messages use encoding-safe output for Windows code pages.
- EmoSens owns its dynamic learning rate. The project uses sd-scripts' no-op
  scheduler interface and reports the optimizer's current rate directly.
