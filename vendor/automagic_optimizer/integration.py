"""Project-safe wrapper around the vendored Automagic3 implementation."""
from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

import torch

from .automagic3 import Automagic3 as _UpstreamAutomagic3


def _materialize_params(params: Iterable[Any]) -> list[Any]:
    materialized: list[Any] = []
    for item in params:
        if isinstance(item, dict):
            group = dict(item)
            group["params"] = list(group.get("params", []))
            materialized.append(group)
        else:
            materialized.append(item)
    return materialized


def _iter_params(params: list[Any]):
    for item in params:
        if isinstance(item, dict):
            yield from item.get("params", [])
        else:
            yield item


class Automagic3(_UpstreamAutomagic3):
    """Automagic3 with sd-scripts-compatible execution constraints."""

    def __init__(
        self,
        params,
        lr: float = 1e-4,
        min_lr: float = 1e-8,
        max_lr: float = 1e-3,
        beta2: float = 0.999,
        eps: float = 1e-30,
        clip_threshold: float = 1.0,
        weight_decay: float = 0.0,
        polarity_history: int = 8,
        fused: bool = False,
        fused_guard: bool = False,
    ):
        if not isinstance(fused, bool):
            raise ValueError("Automagic3 fused must be a boolean")
        if fused and fused_guard is not True:
            raise ValueError(
                "Automagic3 fused mode requires the project's validated fused_guard."
            )

        values = {
            "lr": lr,
            "min_lr": min_lr,
            "max_lr": max_lr,
            "beta2": beta2,
            "eps": eps,
            "clip_threshold": clip_threshold,
            "weight_decay": weight_decay,
        }
        for name, value in values.items():
            try:
                values[name] = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Automagic3 {name} must be numeric, got {value!r}") from exc
            if not math.isfinite(values[name]):
                raise ValueError(f"Automagic3 {name} must be finite, got {value!r}")

        lr = values["lr"]
        min_lr = values["min_lr"]
        max_lr = values["max_lr"]
        beta2 = values["beta2"]
        eps = values["eps"]
        clip_threshold = values["clip_threshold"]
        weight_decay = values["weight_decay"]
        if min_lr <= 0 or max_lr <= 0 or lr <= 0:
            raise ValueError("Automagic3 lr, min_lr, and max_lr must be positive")
        if not min_lr <= lr <= max_lr:
            raise ValueError(
                f"Automagic3 requires min_lr <= lr <= max_lr, got {min_lr} <= {lr} <= {max_lr}"
            )
        if not 0 <= beta2 < 1:
            raise ValueError(f"Automagic3 beta2 must be in [0, 1), got {beta2}")
        if eps <= 0 or clip_threshold <= 0:
            raise ValueError("Automagic3 eps and clip_threshold must be positive")
        if weight_decay < 0:
            raise ValueError(f"Automagic3 weight_decay must be non-negative, got {weight_decay}")
        if isinstance(polarity_history, bool):
            raise ValueError("Automagic3 polarity_history must be an integer from 2 to 64")
        try:
            polarity_history = int(polarity_history)
        except (TypeError, ValueError) as exc:
            raise ValueError("Automagic3 polarity_history must be an integer from 2 to 64") from exc
        if not 2 <= polarity_history <= 64:
            raise ValueError("Automagic3 polarity_history must be an integer from 2 to 64")

        materialized = _materialize_params(params)
        low_precision = [
            str(param.dtype)
            for param in _iter_params(materialized)
            if getattr(param, "requires_grad", False) and param.dtype != torch.float32
        ]
        if low_precision:
            dtypes = ", ".join(sorted(set(low_precision)))
            raise ValueError(
                "Automagic3 requires FP32 trainable parameters in this project "
                f"(disable full_bf16); found {dtypes}."
            )

        for item in materialized:
            if not isinstance(item, dict) or "lr" not in item:
                continue
            group_lr = float(item["lr"])
            if not math.isfinite(group_lr) or not min_lr <= group_lr <= max_lr:
                raise ValueError(
                    "Automagic3 parameter-group lr must be within "
                    f"[{min_lr}, {max_lr}], got {group_lr}"
                )

        super().__init__(
            materialized,
            lr=lr,
            min_lr=min_lr,
            max_lr=max_lr,
            beta2=beta2,
            eps=eps,
            clip_threshold=clip_threshold,
            weight_decay=weight_decay,
            polarity_history=polarity_history,
            fused=fused,
        )
