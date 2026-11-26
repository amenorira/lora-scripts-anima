"""Tests for automatic network endpoint detection and mirror fallback."""
import os
import unittest
from unittest.mock import patch

from tools import network_mirror as nm

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
