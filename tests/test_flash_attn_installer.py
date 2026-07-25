from __future__ import annotations

import subprocess
from unittest import TestCase, mock

from tools import install_flash_attn


class FlashAttnInstallerFallbackTests(TestCase):
    def test_sources_exclude_retired_ghproxy_com_and_prefer_working_mirror(self) -> None:
        default_urls = install_flash_attn.download_urls_for(
            "https://github.com/example/releases/download/v1/flash_attn.whl",
            source="default",
        )
        mirror_urls = install_flash_attn.download_urls_for(default_urls[0], source="mirror")

        self.assertFalse(any("https://ghproxy.com/" in url for url in default_urls))
        self.assertTrue(mirror_urls[0].startswith("https://ghproxy.net/"))

    def test_api_and_wheel_use_the_proxy_that_supports_each_workload(self) -> None:
        api_urls = install_flash_attn._urls_for("mirror")
        wheel_urls = install_flash_attn.download_urls_for(
            "https://github.com/example/releases/download/v1/flash_attn.whl",
            source="mirror",
        )

        self.assertTrue(api_urls[0].startswith("https://gh-proxy.com/"))
        self.assertTrue(wheel_urls[0].startswith("https://ghproxy.net/"))
        self.assertFalse(any("ghproxy.net/https://api.github.com" in url for url in api_urls))
        self.assertFalse(any("gh-proxy.com/https://github.com" in url for url in wheel_urls))

    @mock.patch.object(install_flash_attn.importlib.metadata, "version", return_value="2.8.3")
    @mock.patch.object(install_flash_attn.subprocess, "run")
    def test_install_switches_source_after_ten_second_socket_timeout(
        self, run_mock: mock.Mock, _version_mock: mock.Mock
    ) -> None:
        run_mock.side_effect = [
            subprocess.CompletedProcess([], 1, stdout="", stderr="connection timed out"),
            subprocess.CompletedProcess([], 0, stdout="installed", stderr=""),
        ]
        wheel_url = "https://github.com/example/releases/download/v1/flash_attn.whl"

        result = install_flash_attn.install_wheel(wheel_url, source="default")

        self.assertTrue(result["installed"])
        self.assertEqual(run_mock.call_count, 2)
        first_cmd = run_mock.call_args_list[0].args[0]
        second_cmd = run_mock.call_args_list[1].args[0]
        self.assertEqual(first_cmd[first_cmd.index("--timeout") + 1], "10")
        self.assertEqual(first_cmd[first_cmd.index("--retries") + 1], "0")
        self.assertEqual(first_cmd[-1], wheel_url)
        self.assertNotEqual(second_cmd[-1], wheel_url)

    @mock.patch.object(install_flash_attn.urllib.request, "urlopen")
    def test_api_probe_uses_ten_second_timeout_without_same_source_retry(
        self, urlopen_mock: mock.Mock
    ) -> None:
        urlopen_mock.side_effect = TimeoutError("timed out")

        data, error, unchanged = install_flash_attn._try_fetch_api(
            "https://api.github.com/repos/example/releases", "default"
        )

        self.assertIsNone(data)
        self.assertIn("timed out", error or "")
        self.assertFalse(unchanged)
        urlopen_mock.assert_called_once()
        self.assertEqual(urlopen_mock.call_args.kwargs["timeout"], 10)
