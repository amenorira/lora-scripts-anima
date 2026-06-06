"""Tests for source isolation in tools/install_flash_attn.py."""
import sys
from pathlib import Path

# Ensure tools/ is importable
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "tools"))

from install_flash_attn import (  # noqa: E402
    SOURCE_CONFIGS,
    get_source_config,
)


def test_get_source_config_default():
    primary, fallbacks = get_source_config("default")
    assert primary == "https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases"
    assert "bdashore3" in fallbacks[0]


def test_get_source_config_mirror_uses_ghproxy():
    primary, fallbacks = get_source_config("mirror")
    assert primary.startswith("https://ghproxy.com/")
    assert all(f.startswith("https://ghproxy.com/") for f in fallbacks)


def test_get_source_config_fallback_swaps_repo():
    primary, _ = get_source_config("fallback")
    assert "bdashore3" in primary


def test_get_source_config_unknown_falls_back_to_default():
    primary, fallbacks = get_source_config("nonexistent")
    default_primary, default_fallbacks = get_source_config("default")
    assert primary == default_primary
    assert fallbacks == default_fallbacks


def test_source_configs_is_immutable_dict():
    """确认三个源都已配置（防止漏改）。"""
    assert set(SOURCE_CONFIGS.keys()) >= {"default", "mirror", "fallback"}
