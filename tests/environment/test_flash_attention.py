import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from tools import flash_attention as fa
from backend.training.attention_config import normalize_attention_config
from backend.training.supervisor import detect_attention_backend


ENV = {"cuda": "13.0", "torch_tag": "2.12", "tags": ["cp312-cp312-win_amd64"]}
NAME = "flash_attn-2.8.3+cu130torch2.12-cp312-cp312-win_amd64.whl"
URL = json.loads(fa.CATALOG.read_text())[0]["url"]
CONTENT = b"test wheel content" * 20


class WheelMatchingTests(unittest.TestCase):
    def test_only_exact_runtime_and_fa2_api_are_accepted(self):
        self.assertEqual(fa.matching_wheel_name(URL, ENV), NAME)
        for url in (URL.replace("torch2.12", "torch2.10"), URL.replace("cu130", "cu128"),
                    URL.replace("cp312", "cp311"), URL.replace("win_amd64", "linux_x86_64"),
                    URL.replace("flash_attn-2.8.3", "flash_attn_3-3.0.0")):
            with self.subTest(url=url):
                self.assertIsNone(fa.matching_wheel_name(url, ENV))

    def test_baseline_resolves_without_network(self):
        with patch.object(fa.urllib.request, "urlopen", side_effect=AssertionError("network")):
            wheel = fa.resolve_wheel(ENV)
        self.assertEqual(wheel["name"], NAME)
        self.assertEqual(len(wheel["sha256"]), 64)

    def test_corrupt_cache_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / NAME
            path.write_bytes(CONTENT)
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                fa.validate_download(path, {"size": len(CONTENT), "sha256": "0" * 64})

    def test_unsupported_runtime_does_not_search_online(self):
        with patch.object(fa.urllib.request, "urlopen", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(RuntimeError, "No matching"):
                fa.resolve_wheel({**ENV, "torch_tag": "2.11"})


class DownloadTests(unittest.TestCase):
    def download(self, response_status, content_range=None):
        content = CONTENT
        wheel = {"name": NAME, "url": URL, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        resume_at = 20
        response = io.BytesIO(content[resume_at:] if response_status == 206 else content)
        response.status = response_status
        response.headers = {"Content-Range": content_range or f"bytes {resume_at}-{len(content)-1}/{len(content)}"}
        with tempfile.TemporaryDirectory() as directory, patch.object(fa, "CACHE", Path(directory)):
            (Path(directory) / (NAME + ".part")).write_bytes(content[:resume_at])
            with patch.object(fa.urllib.request, "urlopen", return_value=response):
                result = fa.download_wheel(wheel, lambda **_: None, source="direct")
            self.assertEqual(result.read_bytes(), content)

    def test_valid_resume_keeps_prefix(self):
        self.download(206)

    def test_server_ignoring_range_restarts_cleanly(self):
        self.download(200)

    def test_incorrect_range_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "resume"):
            self.download(206, "bytes 0-100/101")

    def test_short_response_is_kept_for_resume(self):
        content = CONTENT
        wheel = {"name": NAME, "url": URL, "size": len(content)}
        response = io.BytesIO(content[:20])
        response.status, response.headers = 200, {}
        with tempfile.TemporaryDirectory() as directory, patch.object(fa, "CACHE", Path(directory)), \
             patch.object(fa.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                fa.download_wheel(wheel, lambda **_: None, source="direct")
            self.assertEqual((Path(directory) / (NAME + ".part")).read_bytes(), content[:20])
            self.assertFalse((Path(directory) / NAME).exists())

    def test_complete_partial_is_verified_and_reused_without_network(self):
        wheel = {"name": NAME, "url": URL, "size": len(CONTENT), "sha256": hashlib.sha256(CONTENT).hexdigest()}
        with tempfile.TemporaryDirectory() as directory, patch.object(fa, "CACHE", Path(directory)), \
             patch.object(fa.urllib.request, "urlopen", side_effect=AssertionError("network")):
            (Path(directory) / (NAME + ".part")).write_bytes(CONTENT)
            result = fa.download_wheel(wheel, lambda **_: None)
            self.assertEqual(result.read_bytes(), CONTENT)
            self.assertFalse((Path(directory) / (NAME + ".part")).exists())


class InstallationTests(unittest.TestCase):
    def test_installs_once_and_reports_failed_cuda_validation(self):
        with patch.object(fa, "detect_environment", return_value=ENV), \
             patch.object(fa, "download_wheel", return_value=Path(NAME)), patch.object(fa, "_pip") as pip, \
             patch.object(fa, "verify_installation", return_value={"ok": False, "message": "backward failed"}) as verify:
            with self.assertRaisesRegex(RuntimeError, "backward failed"):
                fa.install(lambda **_: None)
            pip.assert_called_once()
            verify.assert_called_once()

    def test_pip_cannot_resolve_or_replace_runtime_dependencies(self):
        result = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        with patch.object(fa.subprocess, "run", return_value=result) as run:
            fa._pip(Path(NAME), lambda **_: None)
        command = run.call_args.args[0]
        self.assertIn("--no-deps", command)
        self.assertIn("--no-index", command)
        self.assertEqual(command[0], fa.sys.executable)

    def test_probe_crash_or_timeout_is_failure(self):
        for outcome in (subprocess.CompletedProcess([], 1, stdout='FLASH_ATTN_RESULT={"ok":true}', stderr="crashed"),
                        subprocess.TimeoutExpired("probe", 120)):
            with self.subTest(outcome=outcome):
                kwargs = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                with patch.object(fa.subprocess, "run", **kwargs):
                    self.assertFalse(fa.verify_installation()["ok"])


class TrainingIntegrationTests(unittest.TestCase):
    def test_flash_selection_survives_config_normalization(self):
        config = {"attn_mode": "flash", "krea_attention_backend": "flash_attn"}
        normalize_attention_config(config)
        self.assertEqual(config["attn_mode"], "flash")
        self.assertEqual(config["krea_attention_backend"], "sdpa")
        normalize_attention_config(config := {"attn_mode": "sdpa"})
        self.assertEqual(config["attn_mode"], "torch")

    def test_missing_flash_reports_installation_instruction(self):
        with patch.object(fa, "package_version", return_value=None):
            actual, reason = detect_attention_backend("flash")
            self.assertEqual(actual, "torch")
            self.assertIn("not installed", reason)

    def test_installed_extension_is_not_retested_on_training_start(self):
        with patch.object(fa, "package_version", return_value="2.8.3"), \
             patch.object(fa, "verify_installation", side_effect=AssertionError("redundant verification")):
            self.assertEqual(detect_attention_backend("flash"), ("flash", ""))

    def test_sdpa_does_not_import_or_probe_optional_extension(self):
        with patch.object(fa, "verify_installation", side_effect=AssertionError("probe")):
            self.assertEqual(detect_attention_backend("torch"), ("torch", ""))


class ManagementRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_running_training_blocks_installation(self):
        from backend.server.routes import flash_attention as route
        with patch.object(route.tm, "claim_external", return_value=False):
            result = await route._start()
        self.assertFalse(result["success"])

    async def test_failed_install_releases_training_slot_and_exposes_error(self):
        from backend.server.routes import flash_attention as route
        from types import SimpleNamespace
        with patch.object(route.tm, "claim_external", return_value=True), \
             patch.object(route.tm, "release_external") as release, \
             patch.object(route.realtime_tasks, "register", new_callable=AsyncMock), \
             patch.object(route.threading, "Thread", side_effect=lambda target, **_: SimpleNamespace(start=target)), \
             patch.object(fa, "install", side_effect=RuntimeError("CUDA failed")):
            result = await route._start()
        snapshot = route._snapshot(result["job_id"])
        self.assertTrue(snapshot["done"])
        self.assertFalse(snapshot["success"])
        self.assertEqual(snapshot["error"], "CUDA failed")
        release.assert_called_once()


if __name__ == "__main__":
    unittest.main()
