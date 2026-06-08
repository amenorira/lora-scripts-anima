"""
Anima Backend — 集中路径常量

避免在多个文件中重复 `Path(__file__).parents[2]` 等模式。
所有路径均为绝对路径，基于本文件所在位置自动推导。
"""
from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_ROOT = REPO_ROOT / "vendor"
OUTPUT_DIR = REPO_ROOT / "output"
CONFIG_DIR = REPO_ROOT / "config"
LOGS_DIR = REPO_ROOT / "logs"
TOOLS_DIR = REPO_ROOT / "tools"
SD_SCRIPTS_DIR = VENDOR_ROOT / "sd-scripts"

EMO_OPTIMIZER_DIR = VENDOR_ROOT / "emo_optimizer"
CACHE_DIR = REPO_ROOT / "cache"
HF_CACHE_DIR = REPO_ROOT / "huggingface"
TRAIN_DIR = REPO_ROOT / "train"
FRONTEND_DIR = REPO_ROOT / "frontend"
AUTOSAVE_DIR = CONFIG_DIR / "autosave"
PRESETS_DIR = CONFIG_DIR / "presets"
