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


def test_source_configs_contains_required_sources():
    """确认三个源都已配置（防止漏改）。"""
    assert set(SOURCE_CONFIGS.keys()) >= {"default", "mirror", "fallback"}


def test_cache_paths_isolated_per_source():
    """不同 source 的缓存路径必须不同。"""
    from install_flash_attn import _cache_paths

    a_cache, a_etag = _cache_paths("default")
    b_cache, b_etag = _cache_paths("mirror")
    assert a_cache != b_cache
    assert a_etag != b_etag
    assert a_cache.name == ".fa_wheels_default.json"
    assert a_etag.name == ".fa_etag_default.txt"
    assert b_cache.name == ".fa_wheels_mirror.json"
    assert b_etag.name == ".fa_etag_mirror.txt"


def test_cache_io_isolated_per_source(tmp_path, monkeypatch):
    """验证 _save_disk_cache 写到 source 专属文件，_load_disk_cache 只读对应 source。"""
    from install_flash_attn import (
        _save_disk_cache, _load_disk_cache, _cache_paths,
    )

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)

    _save_disk_cache([{"url": "u1", "name": "n1", "notes": [], "usable": True, "score": 50}],
                     source="default")
    _save_disk_cache([{"url": "u2", "name": "n2", "notes": [], "usable": True, "score": 60}],
                     source="mirror")

    default_cache, _ = _cache_paths("default")
    mirror_cache, _ = _cache_paths("mirror")
    assert default_cache.exists()
    assert mirror_cache.exists()
    assert default_cache != mirror_cache

    loaded_default = _load_disk_cache("default")
    loaded_mirror = _load_disk_cache("mirror")
    assert loaded_default[0]["url"] == "u1"
    assert loaded_mirror[0]["url"] == "u2"


def test_etag_io_isolated_per_source(tmp_path, monkeypatch):
    """验证 _save_etag 写到 source 专属文件，_load_etag 只读对应 source。"""
    from install_flash_attn import _save_etag, _load_etag

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)

    _save_etag("etag-default-abc", source="default")
    _save_etag("etag-mirror-xyz", source="mirror")

    assert _load_etag("default") == "etag-default-abc"
    assert _load_etag("mirror") == "etag-mirror-xyz"


def test_legacy_cache_files_not_read(tmp_path, monkeypatch):
    """旧路径 .fa_wheels_cache.json / .fa_etag.txt 不再被读取。"""
    from install_flash_attn import _load_disk_cache, _load_etag

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)

    (tmp_path / ".fa_wheels_cache.json").write_text(
        '[{"url": "old", "name": "old", "notes": [], "usable": true, "score": 0}]',
        encoding="utf-8",
    )
    (tmp_path / ".fa_etag.txt").write_text("old-etag", encoding="utf-8")

    assert _load_disk_cache("default") is None
    assert _load_etag("default") is None


def test_fetch_candidates_threads_source_to_try_fetch(monkeypatch, tmp_path):
    """验证 fetch_candidates(source='mirror') 调用 _try_fetch_api 时 source='mirror'。"""
    from install_flash_attn import fetch_candidates

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)

    captured = []

    def fake_try_fetch(url, source):
        captured.append((url, source))
        return [], None, False

    monkeypatch.setattr("install_flash_attn._try_fetch_api", fake_try_fetch)
    monkeypatch.setattr("install_flash_attn._save_disk_cache", lambda *a, **k: None)

    env = {
        "platform": "linux_x86_64",
        "torch_tag": "torch2.10",
        "cuda_tag": "cu128",
        "python_tag": "cp312",
    }
    fetch_candidates(env, source="mirror")

    # _try_fetch_api 至少被调用一次，且 source='mirror'
    assert len(captured) >= 1
    for url, src in captured:
        assert src == "mirror"


def test_fetch_candidates_uses_correct_source_urls(monkeypatch, tmp_path):
    """验证 fetch_candidates(source='mirror') 使用 ghproxy URL，default 用 GitHub 直连。"""
    from install_flash_attn import fetch_candidates

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)
    monkeypatch.setattr("install_flash_attn._save_disk_cache", lambda *a, **k: None)

    captured_urls = []

    def fake_try_fetch(url, source):
        captured_urls.append(url)
        return [], None, False

    monkeypatch.setattr("install_flash_attn._try_fetch_api", fake_try_fetch)

    env = {
        "platform": "linux_x86_64",
        "torch_tag": "torch2.10",
        "cuda_tag": "cu128",
        "python_tag": "cp312",
    }

    captured_urls.clear()
    fetch_candidates(env, source="default")
    assert all("ghproxy.com" not in u for u in captured_urls)
    assert any("mjun0812" in u for u in captured_urls)

    captured_urls.clear()
    fetch_candidates(env, source="mirror")
    assert all(u.startswith("https://ghproxy.com/") for u in captured_urls)
