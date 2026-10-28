"""Normalize a training request and dispatch it to its engine preparation."""
from datetime import datetime

from backend.training.execution import launch_krea2, launch_sd_scripts
from backend.training.core_registry import TrainingProfileError, resolve_training_profile
from backend.training.config.krea2_options import KREA2_PROFILE_ID
from backend.training.execution.preparation import training_error as _training_error


async def prepare_run(config: dict, reserved_task):
    from backend.training.config.attention_config import normalize_attention_config

    normalize_attention_config(config)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    form_snapshot = config.pop("_form_state", None)
    if not isinstance(form_snapshot, dict):
        form_snapshot = {key: value for key, value in config.items() if not key.startswith("_")}
    normalize_attention_config(form_snapshot)
    gpu_ids = config.pop("gpu_ids", None)

    try:
        profile = resolve_training_profile(config)
    except TrainingProfileError as exc:
        return _training_error(message=str(exc))
    form_snapshot["model_train_type"] = profile.id
    if profile.id == KREA2_PROFILE_ID:
        return await launch_krea2.prepare_run(config, gpu_ids, timestamp, form_snapshot, reserved_task)

    return await launch_sd_scripts.prepare_run(config, gpu_ids, timestamp, form_snapshot, reserved_task, profile)
