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


if __name__ == "__main__":
    unittest.main()
