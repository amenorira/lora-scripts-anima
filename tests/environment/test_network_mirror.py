"""Tests for automatic network endpoint detection and mirror fallback."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tools import network_mirror as nm
from tools.pip_index_config import read_indexes

ROOT = Path(__file__).resolve().parents[2]


class NetworkMirrorTests(unittest.TestCase):
    def setUp(self):
        self._env_backup = os.environ.copy()
        for key in ("HF_ENDPOINT", "PIP_INDEX_URL"):
            os.environ.pop(key, None)
        nm.invalidate_hf_cache()
        nm._auto_applied_hf_endpoint = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)
        nm.invalidate_hf_cache()
        nm._auto_applied_hf_endpoint = None

    def test_official_fast_selected_first(self):
        with patch.object(nm, "_probe_url", return_value=(True, 0.15)):
            eps = nm.resolve_hf_endpoints()

        self.assertEqual(eps, [nm.HF_OFFICIAL, nm.HF_MIRROR])
        self.assertEqual(os.environ.get("HF_ENDPOINT"), nm.HF_OFFICIAL)

    def test_official_blocked_selects_mirror_first(self):
        def fake_probe(url, *, timeout=2.0, **kwargs):
            return (url.startswith(nm.HF_MIRROR), 0.08 if url.startswith(nm.HF_MIRROR) else timeout)

        with patch.object(nm, "_probe_url", side_effect=fake_probe):
            eps = nm.resolve_hf_endpoints()

        self.assertEqual(eps, [nm.HF_MIRROR, nm.HF_OFFICIAL])
        self.assertEqual(os.environ.get("HF_ENDPOINT"), nm.HF_MIRROR)

    def test_explicit_user_hf_endpoint_preserved_and_auto_cache_reprobes(self):
        os.environ["HF_ENDPOINT"] = "https://custom-hf.example"
        with patch.object(nm, "_probe_url") as probe:
            eps = nm.resolve_hf_endpoints()
        probe.assert_not_called()
        self.assertEqual(eps[0], "https://custom-hf.example")
        self.assertEqual(os.environ["HF_ENDPOINT"], "https://custom-hf.example")

        os.environ.pop("HF_ENDPOINT")
        calls = []

        def fake_probe(url, *, timeout=2.0, **kwargs):
            calls.append(url)
            return (url.startswith(nm.HF_OFFICIAL), 0.1)

        with patch.object(nm, "_probe_url", side_effect=fake_probe):
            first = nm.resolve_hf_endpoints()
            second = nm.resolve_hf_endpoints()
        self.assertEqual(first[0], nm.HF_OFFICIAL)
        self.assertEqual(second[0], nm.HF_OFFICIAL)
        self.assertEqual(len(calls), 2)

        nm.invalidate_hf_cache()
        with patch.object(
            nm,
            "_probe_url",
            side_effect=lambda url, **kw: (url.startswith(nm.HF_MIRROR), 0.05 if url.startswith(nm.HF_MIRROR) else 2.0),
        ):
            third = nm.resolve_hf_endpoints()
        self.assertEqual(third[0], nm.HF_MIRROR)
        self.assertEqual(os.environ["HF_ENDPOINT"], nm.HF_MIRROR)

    def test_wheel_download_urls_always_prefer_hf_then_upstream_fallback(self):
        fa_entries = json.loads((ROOT / "tools" / "flash_attention_wheels.json").read_text(encoding="utf-8"))
        moss_entries = json.loads((ROOT / "tools" / "moss_acceleration_wheels.json").read_text(encoding="utf-8"))

        with patch.object(nm, "resolve_hf_endpoints", return_value=[nm.HF_OFFICIAL, nm.HF_MIRROR]):
            fa_urls = nm.wheel_download_urls(fa_entries[0])
            moss_urls = nm.wheel_download_urls(moss_entries[-1])

        self.assertTrue(fa_urls[0].startswith("https://huggingface.co/datasets/ame-la/lora-scripts-anima-wheels/resolve/main/flash_attn/"))
        self.assertTrue(fa_urls[1].startswith("https://hf-mirror.com/datasets/ame-la/lora-scripts-anima-wheels/resolve/main/flash_attn/"))
        self.assertEqual(fa_urls[2], fa_entries[0]["url"])
        self.assertFalse(any("ghfast.top" in u or "gh-proxy.com" in u for u in fa_urls))

        self.assertTrue(moss_urls[0].startswith("https://huggingface.co/datasets/ame-la/lora-scripts-anima-wheels/resolve/main/moss_acceleration/"))
        self.assertTrue(moss_urls[1].startswith("https://hf-mirror.com/datasets/ame-la/lora-scripts-anima-wheels/resolve/main/moss_acceleration/"))
        self.assertEqual(moss_urls[2], moss_entries[-1]["url"])

    def test_select_pip_index_respects_existing_and_picks_fastest_mirror(self):
        self.assertIsNone(nm.select_pip_index(env={"PIP_INDEX_URL": "https://custom.example/simple"}))

        os.environ["PIP_INDEX_URL"] = "https://env.example/simple"
        self.assertIsNone(nm.select_pip_index())
        os.environ.pop("PIP_INDEX_URL")

        with patch.object(nm, "_skip_pip_probe", return_value=False), \
             patch.object(nm, "_probe_url", return_value=(True, 0.2)):
            self.assertIsNone(nm.select_pip_index())

        def slow_official(url, *, timeout=1.5, **kwargs):
            if url.startswith(nm.PYPI_OFFICIAL):
                return (False, 1.5)
            if "mirrors.aliyun.com" in url:
                return (True, 0.04)
            return (True, 0.18)

        with patch.object(nm, "_skip_pip_probe", return_value=False), \
             patch.object(nm, "_probe_url", side_effect=slow_official):
            selected = nm.select_pip_index()
            applied = nm.apply_pip_index_env(env={})
        self.assertEqual(selected, "https://mirrors.aliyun.com/pypi/simple")
        self.assertEqual(applied["PIP_INDEX_URL"], selected)

    def test_pip_auto_selection_preserves_effective_install_config(self):
        from pip._internal.configuration import kinds

        with tempfile.TemporaryDirectory() as tmp:
            system = Path(tmp) / "system.ini"
            custom = Path(tmp) / "custom.ini"
            system.write_text("[global]\nindex-url=https://system.invalid/simple\n", encoding="utf-8")
            custom.write_text("[global]\nindex-url=https://custom.invalid/simple\n"
                              "[install]\nindex-url=https://install.invalid/simple\n", encoding="utf-8")
            files = {kinds.GLOBAL: [str(system)], kinds.USER: [], kinds.SITE: []}
            os.environ.pop("PIP_CONFIG_FILE", None)
            with patch("pip._internal.configuration.get_configuration_files", return_value=files), \
                 patch.object(nm, "_probe_many") as probe:
                self.assertEqual(read_indexes()["global.index-url"], "https://system.invalid/simple")
                self.assertIsNone(nm.select_pip_index())
                child_env = {**os.environ, "PIP_CONFIG_FILE": str(custom)}
                self.assertIsNone(nm.select_pip_index(env=child_env))
                os.environ["PIP_CONFIG_FILE"] = str(custom)
                self.assertEqual(read_indexes()["global.index-url"], "https://install.invalid/simple")
                self.assertIsNone(nm.select_pip_index())
                os.environ["PIP_INDEX_URL"] = "https://environment.invalid/simple"
                self.assertEqual(read_indexes()["global.index-url"], os.environ["PIP_INDEX_URL"])
                probe.assert_not_called()

    def test_offline_install_skips_probes_with_pip_precedence(self):
        from pip._internal.configuration import kinds

        with tempfile.TemporaryDirectory() as tmp:
            ini = Path(tmp) / "pip.ini"
            ini.write_text("[global]\nno-index=false\n[install]\nno-index=yes\nfind-links=" + tmp, encoding="utf-8")
            files = {kinds.GLOBAL: [], kinds.USER: [], kinds.SITE: []}
            env = {k: v for k, v in os.environ.items() if not k.startswith("PIP_")}
            with patch.dict(os.environ, env, clear=True), \
                 patch("pip._internal.configuration.get_configuration_files", return_value=files), \
                 patch.object(nm, "_probe_many", return_value={}) as probe:
                os.environ["PIP_CONFIG_FILE"] = str(ini)
                nm.select_pip_index()
                nm.select_pip_index(env={**os.environ, "PIP_FIND_LINKS": tmp})
                os.environ.update(PIP_CONFIG_FILE=os.devnull, PIP_NO_INDEX="on")
                nm.select_pip_index()
                probe.assert_not_called()
                os.environ.update(PIP_CONFIG_FILE=str(ini), PIP_NO_INDEX="0")
                nm.select_pip_index()
                probe.assert_called_once()

    def test_pip_index_alias_respects_install_precedence_and_skips_probe(self):
        from pip._internal.commands import create_command

        env = {k: v for k, v in os.environ.items() if not k.startswith("PIP_")}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, env, clear=True), \
             patch.object(nm, "_probe_many") as probe:
            ini = Path(tmp) / "pip.ini"
            os.environ["PIP_CONFIG_FILE"] = str(ini)
            for first, last in (("index-url", "pypi-url"), ("pypi-url", "index-url")):
                ini.write_text(f"[install]\n{first}=https://one.invalid\n{last}=https://two.invalid\n", encoding="utf-8")
                with self.subTest(last=last):
                    opts, _ = create_command("install").parse_args([])
                    self.assertEqual(read_indexes()["global.index-url"], opts.index_url)
                    self.assertIsNone(nm.select_pip_index())
            os.environ.update(PIP_CONFIG_FILE=os.devnull, PIP_PYPI_URL="https://user.invalid")
            self.assertIsNone(nm.select_pip_index())
            os.environ.pop("PIP_PYPI_URL")
            with patch("tools.pip_index_config.read_indexes", side_effect=ImportError("pip")):
                self.assertIsNone(nm.select_pip_index())
            probe.assert_not_called()

    def test_install_retry_only_falls_back_for_auto_selected_mirrors(self):
        from backend.server.routes import environment as route

        mirror = nm.PYPI_MIRRORS[0]
        manual = "https://custom.invalid/simple"
        for env, selected, flags, expected in (
            ({}, mirror, [], [mirror, None, None]),
            ({"PIP_INDEX_URL": mirror, "ANIMA_AUTO_PIP_INDEX_URL": mirror}, None, [], [mirror, None, None]),
            ({"PIP_INDEX_URL": manual}, None, [], [manual] * 3),
            ({"PIP_INDEX_URL": manual, "ANIMA_AUTO_PIP_INDEX_URL": mirror}, None, [], [manual] * 3),
            ({}, None, ["--index-url", manual], [None] * 3),
            ({}, None, ["--pypi-url", manual], [None] * 3),
            ({"PIP_NO_INDEX": "1"}, None, ["--no-index"], [None] * 3),
        ):
            with self.subTest(env=env, flags=flags), tempfile.TemporaryDirectory() as tmp:
                attempts = []

                def fake_pip(cmd, *, env, **kwargs):
                    attempts.append(env.get("PIP_INDEX_URL"))
                    return Mock(returncode=0 if len(attempts) == 3 else 1)

                with patch.dict(os.environ, env, clear=True), \
                     patch.object(route, "runtime_cache_dir", return_value=tmp), \
                     patch.object(route.threading, "Thread", side_effect=lambda target, daemon: Mock(start=target)), \
                     patch.object(route.time, "sleep"), patch.object(route.subprocess, "Popen", side_effect=fake_pip), \
                     patch.object(nm, "select_pip_index", return_value=selected) as select:
                    job = route._start_install_job(["pip", "install", *flags, "example"])
                    try:
                        self.assertEqual(attempts, expected)
                        self.assertEqual(route._install_jobs[job]["returncode"], 0)
                        if flags:
                            select.assert_not_called()
                    finally:
                        route._remove_install_job(job)

    def test_probe_url_rejects_html_and_wrong_prefix_accepts_json_byte(self):
        class FakeResp:
            def __init__(self, status, content_type, body):
                self.status = status
                self.headers = {"Content-Type": content_type}
                self._body = body

            def read(self, n=-1):
                return self._body[:n] if n >= 0 else self._body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with patch.object(nm.urllib.request, "urlopen", return_value=FakeResp(200, "text/html; charset=utf-8", b"<html>blocked</html>")):
            ok, _ = nm._probe_url("https://hf-mirror.com/gpt2/resolve/main/config.json", expect_prefix=b"{", reject_html=True)
            self.assertFalse(ok)

        with patch.object(nm.urllib.request, "urlopen", return_value=FakeResp(200, "text/plain", b"not-json")):
            ok, _ = nm._probe_url("https://hf-mirror.com/gpt2/resolve/main/config.json", expect_prefix=b"{", reject_html=True)
            self.assertFalse(ok)

        with patch.object(nm.urllib.request, "urlopen", return_value=FakeResp(206, "text/plain; charset=utf-8", b"{")):
            ok, _ = nm._probe_url("https://huggingface.co/gpt2/resolve/main/config.json", expect_prefix=b"{", reject_html=True)
            self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()
