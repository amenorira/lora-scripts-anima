"""Shared sd-scripts option dependencies, including legacy native configs."""
from typing import Any


def _present(value: Any) -> bool:
    return value is not None and value != ""


def sample_interval_mode(config: dict) -> str:
    if _present(config.get("sample_interval_mode")):
        return str(config["sample_interval_mode"])
    if _present(config.get("sample_every_n_epochs")):
        return "epochs"
    if _present(config.get("sample_every_n_steps")):
        return "steps"
    return "none"


def normalize_sd_options(config: dict) -> None:
    """Keep only effective CLI options; selectors themselves remain UI-only."""
    interval = sample_interval_mode(config)
    for key, active in (("sample_every_n_epochs", "epochs"), ("sample_every_n_steps", "steps")):
        if interval != active:
            config.pop(key, None)
    if config.get("cpu_offload_checkpointing") or config.get("unsloth_offload_checkpointing"):
        config["gradient_checkpointing"] = True


def validate_sd_option_dependencies(config: dict) -> list[str]:
    errors = []
    if config.get("enable_preview") and config.get("sample_interval_mode") in ("epochs", "steps"):
        key = "sample_every_n_steps" if sample_interval_mode(config) == "steps" else "sample_every_n_epochs"
        if not _present(config.get(key)):
            errors.append(f"{key}: required for the selected preview interval / 请填写所选模式的预览间隔")
    return errors
