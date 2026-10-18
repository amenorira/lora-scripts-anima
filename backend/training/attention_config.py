"""Normalize attention aliases without changing saved source files."""


def normalize_attention_config(config: dict) -> None:
    if config.get("attn_mode") == "sdpa":
        config["attn_mode"] = "torch"
    if config.get("krea_attention_backend") == "flash_attn":
        config["krea_attention_backend"] = "sdpa"
