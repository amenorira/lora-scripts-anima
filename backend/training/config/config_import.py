"""Shared conversion of native trainer snapshots to editable application forms."""
from pathlib import PurePosixPath

from backend.training.core_registry import PROFILES
from backend.training.config.training_config import TrainingConfigError


def infer_training_profile(params: dict, metadata: dict | None = None) -> str | None:
    extra = (metadata or {}).get("extra")
    extra = extra if isinstance(extra, dict) else {}
    explicit = params.get("model_train_type") or extra.get("profile_id")
    if explicit:
        if not isinstance(explicit, str) or explicit not in PROFILES:
            raise TrainingConfigError(
                f"Unknown training profile / 未知训练类型: {explicit}",
                code="configUnknownProfile",
                profile=str(explicit),
            )
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
        raise TrainingConfigError(
            "Cannot identify this run's training type / 无法识别此记录的训练类型，请从训练页手动导入配置",
            code="configCannotIdentifyProfile",
        )
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
        # Native TOML carries the schedule directly, without the desktop preview toggle.
        if (form.get("sample_prompts") or form.get("prompt_file")) and "enable_preview" not in form:
            from backend.training.config.option_contracts import sample_interval_mode

            interval = sample_interval_mode(form)
            form["enable_preview"] = bool(form.get("sample_at_first") or interval != "none")
            form["sample_interval_mode"] = interval
        if (imported_type in ("anima-lora", "moss-image-lora") and not form.get("enable_preview")
                and (form.get("cache_text_encoder_outputs") or form.get("cache_text_encoder_outputs_to_disk"))
                and form.get("sample_prompts") and form.get("logging_dir")):
            log = PurePosixPath(str(form["logging_dir"]).replace("\\", "/"))
            prompt = PurePosixPath(str(form["sample_prompts"]).replace("\\", "/"))
            if prompt == log / ".run-control" / "manual-preview.json":
                # A cached run without scheduled prompts creates its own reference embedding.
                form.pop("sample_prompts")
    form = extract_network_form(form, model_train_type=imported_type)
    from backend.training.preview.config import normalize_form

    try:
        normalize_form(form)
    except ValueError as exc:
        code = getattr(exc, "code", None)
        if code:
            raise TrainingConfigError(str(exc), code=code, **(getattr(exc, "params", None) or {})) from exc
        raise
    return form
