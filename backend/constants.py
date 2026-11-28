"""
Anima Backend — 集中路径常量与存储根目录解析

避免在多个文件中重复 `Path(__file__).parents[2]` 等模式。
支持通过环境变量将持久化数据目录（models / train / output / config / logs）
指向外部挂载盘，同时保持本地缓存目录（cache / huggingface）留在本地磁盘。
"""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_ROOT = REPO_ROOT / "vendor"
SD_SCRIPTS_DIR = VENDOR_ROOT / "sd-scripts"
DOCS_DIR = REPO_ROOT / "docs"
DEFAULT_ANIMA_DIT = "./models/anima-base-v1.0.safetensors"

# 以下存储根目录由 refresh_storage_paths() 根据环境变量初始化。
DATA_DIR: Path = REPO_ROOT
SD_MODELS_DIR: Path = REPO_ROOT / "models"
TRAIN_DIR: Path = REPO_ROOT / "train"
OUTPUT_DIR: Path = REPO_ROOT / "output"
CONFIG_DIR: Path = REPO_ROOT / "config"
LOGS_DIR: Path = REPO_ROOT / "logs"
CACHE_DIR: Path = REPO_ROOT / "cache"
HF_CACHE_DIR: Path = REPO_ROOT / "huggingface"
TAGGER_CACHE_DIR: Path = CACHE_DIR / "tagger"
AUTOSAVE_DIR: Path = CONFIG_DIR / "autosave"


def _env_path(env_var: str, default: Path) -> Path:
    raw = os.environ.get(env_var, "").strip()
    if not raw:
        return default
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    return Path(os.path.normpath(str(candidate)))


def get_storage_roots() -> dict[str, Path]:
    """返回当前生效的存储根目录映射。"""
    return {
        "repo_root": REPO_ROOT,
        "data_dir": DATA_DIR,
        "models_dir": SD_MODELS_DIR,
        "train_dir": TRAIN_DIR,
        "output_dir": OUTPUT_DIR,
        "config_dir": CONFIG_DIR,
        "logs_dir": LOGS_DIR,
        "cache_dir": CACHE_DIR,
        "hf_cache_dir": HF_CACHE_DIR,
        "tagger_cache_dir": TAGGER_CACHE_DIR,
        "autosave_dir": AUTOSAVE_DIR,
        "docs_dir": DOCS_DIR,
    }


def refresh_storage_paths() -> dict[str, Path]:
    """从环境变量重新计算存储目录常量。

    - ANIMA_DATA_DIR: 设置后作为持久化目录（models/train/output/config/logs）的基准；
      CACHE_DIR 与 HF_CACHE_DIR 默认仍保持在本地 REPO_ROOT 下，避免 FUSE/网络盘开销。
    - 单目录覆写: ANIMA_MODELS_DIR, ANIMA_TRAIN_DIR, ANIMA_OUTPUT_DIR, ANIMA_CONFIG_DIR,
      ANIMA_LOGS_DIR, ANIMA_CACHE_DIR, ANIMA_HF_CACHE_DIR。
    """
    global DATA_DIR, SD_MODELS_DIR, TRAIN_DIR, OUTPUT_DIR, CONFIG_DIR, LOGS_DIR
    global CACHE_DIR, HF_CACHE_DIR, TAGGER_CACHE_DIR, AUTOSAVE_DIR

    DATA_DIR = _env_path("ANIMA_DATA_DIR", REPO_ROOT)
    SD_MODELS_DIR = _env_path("ANIMA_MODELS_DIR", DATA_DIR / "models")
    TRAIN_DIR = _env_path("ANIMA_TRAIN_DIR", DATA_DIR / "train")
    OUTPUT_DIR = _env_path("ANIMA_OUTPUT_DIR", DATA_DIR / "output")
    CONFIG_DIR = _env_path("ANIMA_CONFIG_DIR", DATA_DIR / "config")
    LOGS_DIR = _env_path("ANIMA_LOGS_DIR", DATA_DIR / "logs")
    CACHE_DIR = _env_path("ANIMA_CACHE_DIR", REPO_ROOT / "cache")
    if os.environ.get("ANIMA_HF_CACHE_DIR", "").strip():
        HF_CACHE_DIR = _env_path("ANIMA_HF_CACHE_DIR", REPO_ROOT / "huggingface")
        os.environ["HF_HOME"] = str(HF_CACHE_DIR)
    else:
        HF_CACHE_DIR = _env_path("HF_HOME", REPO_ROOT / "huggingface")
    TAGGER_CACHE_DIR = CACHE_DIR / "tagger"
    AUTOSAVE_DIR = CONFIG_DIR / "autosave"
    return get_storage_roots()


def resolve_project_path(raw: str | Path, default_root: Path | None = None) -> Path:
    """解析项目内或用户路径（展开 ~，并在未指定 default_root 时映射逻辑存储根目录）。"""
    value = Path(raw).expanduser()
    if value.is_absolute():
        return value.resolve()
    if default_root is None:
        parts = value.parts
        logical_roots = {
            "models": SD_MODELS_DIR,
            "train": TRAIN_DIR,
            "output": OUTPUT_DIR,
            "config": CONFIG_DIR,
            "logs": LOGS_DIR,
            "cache": CACHE_DIR,
        }
        if parts and parts[0] in logical_roots:
            return logical_roots[parts[0]].joinpath(*parts[1:]).resolve()
        return (REPO_ROOT / value).resolve()
    return (Path(default_root) / value).resolve()


refresh_storage_paths()
