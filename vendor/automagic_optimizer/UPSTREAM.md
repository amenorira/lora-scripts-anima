# Automagic Optimizer

Vendored from `ostris/ai-toolkit` under the MIT license.

- Repository: https://github.com/ostris/ai-toolkit
- Source: `toolkit/optimizers/automagic3.py`
- Repository commit: `c2864bba48a6f94ab1171d9df47b1335f8306355`
- Automagic3 source commit: `cfdc9033`
- Imported: 2026-07-21

`automagic3.py` is kept as upstream source. Project-specific optimizer
compatibility and configuration safety checks live outside that file.

## Automagic4

- Source: `toolkit/optimizers/automagic4.py`
- Source commit: `534d462ff622e334e1a65b42884d96d98315d75a`
- Upstream blob: `aa3c820effa3e44c35ac9ce4639317682754a4d0`
- Imported: 2026-11-11
- Only source adaptation: use the local relative import `.automagic3`.

Automagic4 inherits the vendored Automagic3 implementation. Its algorithm and
state restoration follow upstream; the project wrapper supplies the same
FP32 and validated fused-update constraints for both versions.
