"""Shared conversion of native trainer snapshots to editable application forms."""
from pathlib import PurePosixPath

from backend.training.core_registry import PROFILES


def infer_training_profile(params: dict, metadata: dict | None = None) -> str | None:
    extra = (metadata or {}).get("extra")
    extra = extra if isinstance(extra, dict) else {}
    explicit = params.get("model_train_type") or extra.get("profile_id")
    if explicit:
        if not isinstance(explicit, str) or explicit not in PROFILES:
            raise ValueError(f"Unknown training profile / 未知训练类型: {explicit}")
        return explicit
    trainer = PurePosixPath(str(extra.get("trainer_file", "")).replace("\\", "/")).name
    if trainer == "krea2_train_network.py":
        return "krea2-lora"
    for profile_id, profile in PROFILES.items():
        if trainer and trainer == PurePosixPath(profile.trainer_file).name:
            return profile_id
    if params.get("network_module") == "networks.lora_generic" or "moss_max_token_length" in params:
        return "moss-image-lora"
    if "qwen3" in params or "qwen3_max_token_length" in params:
        return "anima-lora"
    return None


def import_native_training_form(params: dict, *, profile_id: str | None = None) -> dict:
    from backend.training.config.network_config import extract_network_form
    from backend.training.config.optimizer_contracts import extract_optimizer_form
    from backend.training.config.scheduler_config import extract_scheduler_form

    imported_type = infer_training_profile(params) or profile_id
    if not imported_type:
        raise ValueError("Cannot identify this run's training type / 无法识别此记录的训练类型，请从训练页手动导入配置")
    form = extract_scheduler_form({**params, "model_train_type": imported_type})
    if imported_type == "moss-image-lora":
        # Native TOML omissions mean argparse defaults, independent of our recommended preset.
        for key, value in {"timestep_sampling": "sigmoid", "weighting_scheme": "uniform",
                           "logit_mean": 0.0, "logit_std": 1.0}.items():
            form.setdefault(key, value)
    if imported_type == "krea2-lora":
        from backend.training.config.musubi_krea2 import extract_krea2_optimizer_form
        form = extract_krea2_optimizer_form(form)
        if "split_attn" in form:
            form.setdefault("krea_split_attn", "true" if form.pop("split_attn") else "false")
    else:
        form = extract_optimizer_form(form)
    form = extract_network_form(form, model_train_type=imported_type)
    from backend.training.preview.config import sampling_options

    options = sampling_options(form.get("preview_sampler"), form.get("preview_scheduler"))
    for name, value in options.items():
        if "preview_" + name in form:
            form["preview_" + name] = value
    if "preview_loras" in form:
        from backend.training.preview.config import normalize_loras

        form["preview_loras"] = normalize_loras(form["preview_loras"], allow_incomplete=True)
    return form
