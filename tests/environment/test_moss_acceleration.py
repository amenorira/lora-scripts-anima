import copy
import hashlib
import json
import os
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


class WheelSelectionTests(unittest.TestCase):
    def test_windows_and_linux_select_two_pure_wheels_and_exact_native_wheel(self):
        for platform, machine, suffix in (("win32", "x86_64", "win_amd64"),
                                          ("linux", "x86_64", "linux_x86_64"),
                                          ("linux", "aarch64", "linux_aarch64")):
            with self.subTest(platform=platform, machine=machine):
                wheels = accel.selected_wheels(runtime(platform, machine))
                self.assertEqual(len(wheels), 3)
                self.assertEqual(sum(item["name"].endswith("-any.whl") for item in wheels), 2)
                native = next(item for item in wheels if item["name"].startswith("causal_"))
                self.assertTrue(native["name"].endswith(f"cp312-cp312-{suffix}.whl"))
                for item in wheels:
                    self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
                    self.assertGreater(item["size"], 0)

    def test_environment_mismatch_never_installs_or_changes_dependencies(self):
        for key, value, reason in (("python", "3.13", "python"), ("bits", 32, "python"),
                                   ("machine", "aarch64", "platform")):
            env = runtime()
            env[key] = value
            self.assertEqual(accel.incompatibility(env), reason)
        for package, value, reason in (("torch", "2.10.0+cu130", "baseline"),
                                       ("transformers", "5.20.0", "baseline"),
                                       ("triton-windows", "3.6.0", "triton")):
            env = runtime()
            env["packages"][package] = value
            with patch.object(accel, "runtime_signature", return_value=env), patch.object(accel, "_run") as run:
                with self.assertRaises(RuntimeError):
                    accel.install(lambda **event: None)
                run.assert_not_called()


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

    def test_disabled_stale_and_corrupt_bundles_fall_back(self):
        site = self.activate()
        self.assertEqual(accel.training_pythonpath(), str(site))
        accel.set_enabled(False)
        self.assertIsNone(accel.training_pythonpath())
        accel.set_enabled(True)
        self.signature["packages"]["triton-windows"] = "3.7.2"
        self.assertIsNone(accel.training_pythonpath())
        self.assertEqual(accel.current_status()["reason"], "changed")
        with self.assertRaises(RuntimeError):
            accel.set_enabled(True)
        (self.cache / "active.json").write_text("broken", encoding="utf-8")
        self.assertIsNone(accel.training_pythonpath())
        accel._write_state({"enabled": True, "bundle": "../outside"})
        self.assertIsNone(accel.training_pythonpath())

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

    def test_success_atomically_publishes_only_after_verification(self):
        def installed(command, env, **kwargs):
            site = Path(command[command.index("--target") + 1])
            for relative in ("fla/__init__.py", "causal_conv1d/__init__.py"):
                path = site / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            return subprocess.CompletedProcess(command, 0, "installed")

        def verified(site, emit):
            self.assertFalse((self.cache / "active.json").exists())
            return {"ok": True, "gpu": "test"}

        with patch.object(accel, "download_wheel", side_effect=lambda entry, emit: self.cache / entry["name"]), \
             patch.object(accel, "_run", side_effect=installed), patch.object(accel, "verify", side_effect=verified):
            accel.install(lambda **event: None)
        self.assertTrue(accel.current_status()["enabled"])
        self.assertTrue(Path(accel.training_pythonpath()).is_relative_to(self.cache))

    def test_checksum_mismatch_is_rejected(self):
        file = self.cache / "wheel.whl"
        file.write_bytes(b"bad")
        self.assertFalse(accel._verified_file(file, {"size": 3, "sha256": hashlib.sha256(b"new").hexdigest()}))

    def test_only_moss_child_receives_optional_import_path(self):
        from backend.training.supervisor import _build_train_env

        site = self.activate()
        with patch.dict(os.environ, {"PYTHONPATH": ""}):
            for script, engine, expected in (("vendor/sd-scripts/moss_image_train_network.py", "sd_scripts", True),
                                              ("vendor/sd-scripts/anima_train_network.py", "sd_scripts", False),
                                              ("vendor/sd-scripts/sdxl_train_network.py", "sd_scripts", False),
                                              ("krea2_train_network.py", "musubi_tuner", False)):
                env = _build_train_env(str(self.cache), "test", engine_id=engine, trainer_file=script)
                self.assertEqual(str(site) in env["PYTHONPATH"].split(os.pathsep), expected)


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_active_gpu_task_blocks_installation(self):
        from backend.core import install_jobs
        from backend.server.routes import moss_acceleration as routes

        with patch.object(install_jobs.tm, "claim_external", return_value=False), \
             patch.object(routes.moss_acceleration, "install") as install:
            result = await routes.install()
        self.assertFalse(result["success"])
        install.assert_not_called()

    async def test_worker_failure_releases_gpu_task_and_reports_failure(self):
        from unittest.mock import AsyncMock
        from backend.core import install_jobs
        from backend.server.routes import moss_acceleration as routes

        class ImmediateThread:
            def __init__(self, target, **kwargs):
                self.target = target

            def start(self):
                self.target()

        with patch.object(install_jobs.tm, "claim_external", return_value=True), \
             patch.object(install_jobs.tm, "release_external") as release, \
             patch.object(install_jobs.realtime_tasks, "register", new_callable=AsyncMock), \
             patch.object(install_jobs.threading, "Thread", ImmediateThread), \
             patch.object(routes.moss_acceleration, "install", side_effect=RuntimeError("GPU failed")), \
             patch.object(routes, "install_jobs", install_jobs.InstallJobs("moss-acceleration")):
            result = await routes.install()
            snapshot = routes.install_jobs.snapshot(result["job_id"])
            self.assertTrue(snapshot["done"])
            self.assertFalse(snapshot["success"])
            self.assertEqual(snapshot["error"], "GPU failed")
            release.assert_called_once_with("moss-acceleration:" + result["job_id"])

    async def test_http_status_and_next_run_toggle(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from backend.server.routes.moss_acceleration import router

        app = FastAPI()
        app.include_router(router, prefix="/api")
        with TestClient(app) as client, patch.object(accel, "current_status", return_value={"enabled": False}), \
             patch.object(accel, "set_enabled", return_value={"enabled": False}) as setting:
            self.assertEqual(client.get("/api/moss-acceleration/status").json(), {"enabled": False})
            invalid = client.post("/api/moss-acceleration/enabled", json={"enabled": "false"}).json()
            self.assertFalse(invalid["success"])
            setting.assert_not_called()
            response = client.post("/api/moss-acceleration/enabled", json={"enabled": False}).json()
            self.assertTrue(response["success"])
            setting.assert_called_once_with(False)


if __name__ == "__main__":
    unittest.main()
