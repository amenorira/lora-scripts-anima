"""Application-owned TensorBoard switches; never pass them to engine TOML."""
from __future__ import annotations

from typing import Any, Mapping


def training_metric_fields(*, profiles: list[str] | None = None) -> list[dict]:
    fields = []
    for key, parent in (
        ("log_grad_norm", None),
        ("log_grad_clipped", "log_grad_norm"),
        ("log_timestep_loss", None),
        ("log_timestep_count", None),
    ):
        field = {
            "key": key, "type": "toggle", "default": False, "section": "save",
            "desc_key": f"field.{key}", "hint_key": f"field.{key}Hint", "target": "ui",
        }
        if parent:
            field["show_if"] = {"key": parent, "eq": True}
        if profiles is not None:
            field["profiles"] = list(profiles)
        fields.append(field)
    return fields


def training_metrics_environment(config: Mapping[str, Any]) -> dict[str, str]:
    grad = config.get("log_grad_norm") is True
    timestep = config.get("log_timestep_loss") is True
    count = config.get("log_timestep_count") is True
    flags = {
        "ANIMA_TRAIN_METRICS": grad or timestep or count,
        "ANIMA_TRAIN_METRICS_GRAD_NORM": grad,
        "ANIMA_TRAIN_METRICS_GRAD_CLIPPED": grad and config.get("log_grad_clipped") is True,
        "ANIMA_TRAIN_METRICS_TIMESTEP_LOSS": timestep,
        "ANIMA_TRAIN_METRICS_TIMESTEP_COUNT": count,
    }
    return {key: "1" if enabled else "0" for key, enabled in flags.items()}
