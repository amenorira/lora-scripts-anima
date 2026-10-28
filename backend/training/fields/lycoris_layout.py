"""Shared LyCORIS editor groups and ordering across training profiles.

Profiles own their supported fields, defaults and argument semantics. This
layout only annotates fields they already expose, so shared controls keep the
same position without introducing unsupported options.
"""
from __future__ import annotations

from typing import Any


_PANEL_LAYOUT = {
    "lycoris_algo": ("basic", 10),
    "lycoris_preset": ("basic", 20),
    "lycoris_anima_sd_default": ("basic", 22),
    "lycoris_anima_train_adaln": ("basic", 23),
    "lycoris_kernel_backend": ("basic", 25),
    "conv_dim": ("basic", 30),
    "conv_alpha": ("basic", 40),
    "dropout": ("regularization", 10),
    "rank_dropout": ("regularization", 20),
    "module_dropout": ("regularization", 30),
    "lokr_factor": ("algorithm", 10),
    "decompose_both": ("algorithm", 20),
    "full_matrix": ("algorithm", 30),
    "unbalanced_factorization": ("algorithm", 40),
    "use_tucker": ("advanced", 10),
    "use_scalar": ("advanced", 20),
    "dora_wd": ("advanced", 30),
    "wd_on_output": ("advanced", 40),
    "rs_lora": ("advanced", 50),
    "bypass_mode": ("advanced", 60),
    "train_norm": ("advanced", 70),
    "train_llm_adapter": ("advanced", 80),
}


def apply_lycoris_panel_layout(fields: list[dict[str, Any]]) -> None:
    for field in fields:
        layout = _PANEL_LAYOUT.get(field["key"])
        if layout:
            field["lycoris_group"], field["lycoris_order"] = layout
