# EmoSens source

- Upstream: https://github.com/muooon/EmoSens
- Branch: `v3.9.0_ecc`
- Commit: `e2c7bb3293baeb339a2d4a21f21ccbdc0260d3be` (`update3.9.3+`)
- EmoSens version: `v3.9.3 (260830)`
- License: Apache-2.0, included in `LICENSE`

## Vendored files

- `emosens.py` is an unmodified copy of `optimizer/emosens.py`.

## External integration

- Package paths use `vendor.emo_optimizer`.
- No algorithm or console patches are applied to the upstream file.
- The training subprocess uses UTF-8 for upstream console messages.
- EmoSens owns its dynamic learning rate. The project uses sd-scripts' no-op
  scheduler interface and reports the optimizer's current rate directly.
- Resume with the same constructor LR: upstream restores `emoScope` but does
  not serialize the LR-derived `max_lim`, `notify`, or `use_shadow` settings.
