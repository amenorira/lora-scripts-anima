import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools import moss_acceleration as accel


def runtime(platform="win32", machine="x86_64"):
    return {"python": "3.12", "bits": 64, "platform": platform, "machine": machine,
            "packages": {**accel.BASELINE, "triton": "3.7.1" if platform == "linux" else None,
                         "triton-windows": "3.7.1.post27" if platform == "win32" else None}}


class IsolatedBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name)
        self.signature = runtime()
        self.enterContext(patch.object(accel, "CACHE", self.cache))
        self.enterContext(patch.object(accel, "runtime_signature", side_effect=lambda: copy.deepcopy(self.signature)))

    def activate(self):
        bundle = "a" * 32
        site = self.cache / "installs" / bundle / "site"
        for relative in ("fla/__init__.py", "causal_conv1d/__init__.py"):
            path = site / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        accel._write_state({"bundle": bundle, "enabled": True, "signature": copy.deepcopy(self.signature),
                            "catalog": accel._catalog_digest(), "verification": {"ok": True}})
        return site

    def test_verification_failure_preserves_active_bundle_and_venv(self):
        self.activate()
        original = (self.cache / "active.json").read_bytes()
        with patch.object(accel, "download_wheel", side_effect=lambda entry, emit: self.cache / entry["name"]), \
             patch.object(accel, "_run", return_value=subprocess.CompletedProcess([], 0, "ok")) as run, \
             patch.object(accel, "verify", side_effect=RuntimeError("GPU check failed")):
            with self.assertRaisesRegex(RuntimeError, "GPU check failed"):
                accel.install(lambda **event: None)
        self.assertEqual((self.cache / "active.json").read_bytes(), original)
        command = run.call_args.args[0]
        for flag in ("--no-deps", "--no-index", "--only-binary=:all:", "--no-compile", "--target"):
            self.assertIn(flag, command)
        target = Path(command[command.index("--target") + 1])
        self.assertTrue(target.is_relative_to(self.cache))
        self.assertFalse(target.exists())
        self.assertNotIn("--upgrade", command)


def _run_inline_coro(coro):
    try:
        coro.send(None)
    except StopIteration as stop:
        return stop.value
    finally:
        coro.close()
    raise AssertionError("Coroutine yielded unexpectedly")


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


class EnvironmentErrorCodeRouteTests(unittest.TestCase):
    def test_moss_enabled_route_returns_structured_error_codes(self):
        from backend.server.routes import moss_acceleration as moss_route

        class DummyRequest:
            def __init__(self, payload):
                self._payload = payload

            async def json(self):
                return self._payload

        with patch.object(moss_route.asyncio, "to_thread", side_effect=_inline_to_thread):
            invalid = _run_inline_coro(moss_route.enabled(DummyRequest({"enabled": "yes"})))
            self.assertFalse(invalid["success"])
            self.assertEqual(invalid["error_code"], "environmentInvalidToggleRequest")

            with patch.object(moss_route.moss_acceleration, "set_enabled", side_effect=OSError("disk full")):
                failed = _run_inline_coro(moss_route.enabled(DummyRequest({"enabled": True})))
            self.assertFalse(failed["success"])
            self.assertEqual(failed["error_code"], "environmentMossToggleFailed")
            self.assertEqual(failed["error_details"], "disk full")

    def test_environment_route_snapshots_and_download_validation_include_error_codes(self):
        from backend.server.routes import environment as env_route

        missing_install = env_route._install_job_snapshot("missing-job-id")
        self.assertEqual(missing_install["error_code"], "environmentJobNotFound")

        missing_dl = env_route._download_job_snapshot("missing-dl-id")
        self.assertEqual(missing_dl["error_code"], "environmentJobNotFound")
        self.assertEqual(missing_dl["progress"]["error_code"], "environmentJobNotFound")

        triton_info = env_route._triton_status_sync()
        if triton_info.get("platform_note"):
            self.assertNotIn("一键安装", triton_info["platform_note"])
            self.assertNotIn("one-click install", triton_info["platform_note"])

        class DummyRequest:
            async def json(self):
                return {"group": "nonexistent-group", "file": "missing.safetensors"}

        with patch.object(env_route.asyncio, "to_thread", side_effect=_inline_to_thread):
            unknown = _run_inline_coro(env_route.anima_model_download(DummyRequest()))
        self.assertFalse(unknown["success"])
        self.assertEqual(unknown["error_code"], "environmentUnknownModel")
        self.assertEqual(unknown["error_params"], {"group": "nonexistent-group", "file": "missing.safetensors"})


if __name__ == "__main__":
    unittest.main()
