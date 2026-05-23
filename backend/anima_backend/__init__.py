"""
Anima Backend — 包初始化
"""
from backend.anima_backend.adapter import adapt_config, SUPPORTED_FIELDS, UI_ONLY_FIELDS
from backend.anima_backend.supervisor import (
    run_train,
    terminate_train,
    get_train_status,
    detect_attention_backend,
)

__all__ = [
    "adapt_config",
    "SUPPORTED_FIELDS",
    "UI_ONLY_FIELDS",
    "run_train",
    "terminate_train",
    "get_train_status",
    "detect_attention_backend",
]
