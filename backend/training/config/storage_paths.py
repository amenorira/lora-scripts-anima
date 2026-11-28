"""Resolve logical storage paths (models/train/output/config/logs) for training."""
from __future__ import annotations

import os
from pathlib import Path

from backend import constants

TRAINING_PATH_FIELDS: frozenset[str] = frozenset({
    "pretrained_model_name_or_path",
    "dit",
    "vae",
    "qwen3",
    "text_encoder",
    "t5xxl",
    "clip_l",
    "clip_g",
    "turbo_dit",
    "turbo_lora",
    "train_data_dir",
    "reg_data_dir",
    "dataset_cache_dir",
    "dataset_config",
    "output_dir",
    "logging_dir",
    "resume",
    "network_weights",
    "sample_prompts",
    "prompt_file",
    "tokenizer_cache_dir",
})

KREA2_PATH_FIELDS: tuple[str, ...] = (
    "dit",
    "vae",
    "text_encoder",
    "train_data_dir",
    "dataset_cache_dir",
    "output_dir",
    "resume",
    "network_weights",
    "turbo_dit",
    "turbo_lora",
)


def _logical_storage_roots() -> dict[str, tuple[Path, Path]]:
    return {
        "models": (constants.SD_MODELS_DIR, constants.REPO_ROOT / "models"),
        "train": (constants.TRAIN_DIR, constants.REPO_ROOT / "train"),
        "output": (constants.OUTPUT_DIR, constants.REPO_ROOT / "output"),
        "config": (constants.CONFIG_DIR, constants.REPO_ROOT / "config"),
        "logs": (constants.LOGS_DIR, constants.REPO_ROOT / "logs"),
        "cache": (constants.CACHE_DIR, constants.REPO_ROOT / "cache"),
    }


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def _clean_path_value(raw: str | Path) -> Path:
    text = str(raw).strip()
    if "\\" in text and not Path(text).is_absolute():
        text = text.replace("\\", "/")
    return Path(text).expanduser()


def resolve_training_path(raw: str | Path) -> Path:
    """Resolve a logical or user training path to an absolute Path.

    Explicit absolute paths (and ~ paths) remain untouched (resolved).
    Relative paths starting with a logical storage root (models, train, output,
    config, logs, cache — with or without leading ./) are mapped to the active
    storage roots from ``backend.constants``.
    """
    value = _clean_path_value(raw)
    if value.is_absolute():
        return value.resolve()
    return constants.resolve_project_path(value)


def normalize_training_path(raw: str, *, posix: bool = False) -> str:
    """Rewrite relative logical storage paths only when mapped outside REPO_ROOT.

    - Explicit absolute paths are always preserved untouched (except optional
      backslash normalization when ``posix=True``).
    - Relative logical paths (``./models/...``, ``train/...``, etc.) resolve to
      the configured external root when that root differs from ``REPO_ROOT/<name>``.
    - When storage roots remain at default ``REPO_ROOT``, relative strings are
      preserved unchanged.
    """
    if not isinstance(raw, str):
        return raw
    stripped = raw.strip()
    if not stripped:
        return raw
    value = _clean_path_value(stripped)
    if not value.is_absolute():
        parts = value.parts
        roots = _logical_storage_roots()
        if parts and parts[0] in roots:
            active_root, default_root = roots[parts[0]]
            if not _same_path(active_root, default_root):
                resolved = active_root.joinpath(*parts[1:]).resolve()
                return resolved.as_posix() if posix else str(resolved)
    if posix and "\\" in raw:
        return raw.replace("\\", "/")
    return raw
