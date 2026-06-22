"""Tests for source isolation in tools/install_flash_attn.py."""
import sys
from pathlib import Path

# Ensure tools/ is importable
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "tools"))

from install_flash_attn import (  # noqa: E402
    SOURCE_CONFIGS,
    get_source_config,
    _urls_for,
)
from install_flash_attn import _FA_REPO_APIS  # noqa: E402


def test_source_configs_contains_required_sources():
    """确认三个源都已配置（防止漏改）。"""
    assert set(SOURCE_CONFIGS.keys()) >= {"default", "mirror", "fallback"}


def test_get_source_config_unknown_falls_back_to_default():
    """未知 source 降级为 default，且返回的是同一个 dict 引用（行为一致）。"""
    assert get_source_config("nonexistent") is SOURCE_CONFIGS["default"]


def test_get_source_config_has_required_keys():
    """每个 source 配置必须含 proxies 和 repo_apis 两个键。"""
    for src in ("default", "mirror", "fallback"):
        cfg = get_source_config(src)
        assert "proxies" in cfg and "repo_apis" in cfg
        assert isinstance(cfg["proxies"], list) and len(cfg["proxies"]) >= 1
        assert isinstance(cfg["repo_apis"], list) and len(cfg["repo_apis"]) >= 1


def test_default_source_direct_first():
    """default 源代理列表首项为 ''（直连优先，失败自动回退镜像）。"""
    proxies = get_source_config("default")["proxies"]
    assert proxies[0] == ""


def test_mirror_source_ghproxy_first():
    """mirror 源代理列表首项为 ghproxy（镜像优先）。"""
    proxies = get_source_config("mirror")["proxies"]
    assert proxies[0].startswith("https://ghproxy.com/")
    assert all(p.startswith("https://") or p == "" for p in proxies)


def test_fallback_source_swaps_repo_priority():
    """fallback 源 repo_apis 翻转，bdashore3 优先于 mjun0812。"""
    repo_apis = get_source_config("fallback")["repo_apis"]
    assert repo_apis[0] == _FA_REPO_APIS[-1]
    assert "bdashore3" in repo_apis[0]


def test_urls_for_default_starts_with_direct_github():
    """default 源展开后首个 URL 为直连 GitHub API（无代理前缀）。"""
    urls = _urls_for("default")
    assert urls[0] == _FA_REPO_APIS[0]
    assert "ghproxy.com" not in urls[0]


def test_urls_for_mirror_all_via_ghproxy():
    """mirror 源镜像优先：首个 URL 带 ghproxy 前缀，且 mjun0812 直连不会排在镜像之前。

    mirror 代理列表末尾保留 ''（直连兜底），故展开后会含少量直连 URL，
    这里只验证镜像优先序：首个 URL 必须走 ghproxy。
    """
    urls = _urls_for("mirror")
    assert urls[0].startswith("https://ghproxy.com/")
    assert any("mjun0812" in u for u in urls)
    # 镜像 URL 数量 >= 直连 URL 数量（mirror 应以镜像为主）
    # 直连 URL = 无代理前缀，即等于原始 repo_api URL
    direct = [u for u in urls if u in _FA_REPO_APIS]
    via_mirror = [u for u in urls if u not in _FA_REPO_APIS]
    assert len(via_mirror) >= len(direct)


def test_urls_for_dedup_preserves_order():
    """_urls_for 去重保序：proxy × repo_api 组合去重，但首次出现顺序保留。"""
    urls = _urls_for("default")
    # 去重：长度等于唯一组合数
    assert len(urls) == len(set(urls))
    # 保序：直连 mjun0812 排在 bdashore3 直连之前
    direct_mjun = _FA_REPO_APIS[0]
    direct_bdash = _FA_REPO_APIS[1]
    assert urls.index(direct_mjun) < urls.index(direct_bdash)


def test_urls_for_fallback_puts_bdashore3_first():
    """fallback 源首个 URL 为直连 bdashore3（翻转后的首位 repo_api）。"""
    urls = _urls_for("fallback")
    assert urls[0] == _FA_REPO_APIS[-1]
    assert "bdashore3" in urls[0]



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


def test_fetch_candidates_no_duplicate_api_calls(monkeypatch, tmp_path):
    """回归测试：T3m 95e8720 曾引入 fetch_candidates 内部重复代码段（pre-existing 旧 body 未删），
    导致 _try_fetch_api 被调用 2-4 次。修复后每次请求只调用 1 次（无 cached fallback）。
    """
    from install_flash_attn import fetch_candidates

    monkeypatch.setattr("install_flash_attn._FA_CACHE_DIR", tmp_path)
    monkeypatch.setattr("install_flash_attn._save_disk_cache", lambda *a, **k: None)

    call_count = {"n": 0}

    def fake_try_fetch(url, source):
        call_count["n"] += 1
        return [], None, False

    monkeypatch.setattr("install_flash_attn._try_fetch_api", fake_try_fetch)

    env = {
        "platform": "linux_x86_64",
        "torch_tag": "torch2.10",
        "cuda_tag": "cu128",
        "python_tag": "cp312",
    }

    call_count["n"] = 0
    fetch_candidates(env, source="default")
    assert call_count["n"] == 1, (
        f"fetch_candidates 应只调 1 次 _try_fetch_api，实际调 {call_count['n']} 次（重复段残留）"
    )
