"""
Training — 训练引擎封装（参数适配 + 进程管理）
"""
from importlib import import_module

# Metadata-only startup checks must not load the training supervisor or API stack.
_EXPORTS = {
    **dict.fromkeys(("adapt_config", "SUPPORTED_FIELDS", "UI_ONLY_FIELDS", "MERGED_FIELDS"), "adapter"),
    **dict.fromkeys(("get_automagic_fused_conflicts", "get_emosens_conflicts", "validate_training_config"), "validation"),
    **dict.fromkeys(("run_train", "detect_attention_backend"), "supervisor"),
}
__all__ = list(_EXPORTS)


def __getattr__(name):
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module}"), name)
    globals()[name] = value
    return value
