"""
Training — 训练引擎封装（参数适配 + 进程管理）
"""
from backend.training.adapter import adapt_config, SUPPORTED_FIELDS, UI_ONLY_FIELDS, MERGED_FIELDS
from backend.training.validation import (
    get_automagic_fused_conflicts,
    get_emosens_conflicts,
    validate_training_config,
)
from backend.training.supervisor import (
    run_train,
    terminate_train,
    get_train_status,
    detect_attention_backend,
)

__all__ = [
    "adapt_config",
    "validate_training_config",
    "get_automagic_fused_conflicts",
    "get_emosens_conflicts",
    "SUPPORTED_FIELDS",
    "UI_ONLY_FIELDS",
    "MERGED_FIELDS",
    "run_train",
    "terminate_train",
    "get_train_status",
    "detect_attention_backend",
]
