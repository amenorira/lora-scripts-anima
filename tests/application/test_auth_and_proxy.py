from base64 import b64encode
from contextlib import closing
import hashlib
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import DEFAULT, MagicMock, patch

from fastapi.testclient import TestClient
import httpx
from starlette.datastructures import MutableHeaders, URL
from starlette.websockets import WebSocketDisconnect

from backend import gui, launch_utils
from backend.server import application, auth, proxy
from backend.server.routes import realtime
from tools import ensure_runtime


class RequirementsAndRuntimeSyncTests(unittest.TestCase):
    def test_check_requirements_excludes_onnxruntime_gpu(self):
        installed_calls = []

        def fake_is_installed(req: str) -> bool:
            installed_calls.append(req)
            return not req.startswith(("onnxruntime-gpu", "tqdm"))

        with (
            patch.object(launch_utils, "is_installed", side_effect=fake_is_installed),
            patch.object(launch_utils, "run_pip") as run_pip_mock,
        ):
            launch_utils.check_requirements()

        self.assertFalse(any("onnxruntime" in req for req in installed_calls))
        pip_commands = [call.args[0] for call in run_pip_mock.call_args_list]
        self.assertFalse(any("onnxruntime" in cmd for cmd in pip_commands))
        self.assertTrue(any("tqdm" in cmd for cmd in pip_commands))

    def test_ensure_runtime_skip_sync_keeps_compatible_cuda_torch(self):
        with (
            patch.object(ensure_runtime, "_probe_cuda_torch", return_value=("2.9.1+cu128", "12.8")),
            patch.object(ensure_runtime, "pip") as pip_mock,
        ):
            rc = ensure_runtime.main(["--skip-runtime-sync"])
        self.assertEqual(rc, 0)
        pip_mock.assert_not_called()

        with (
            patch.dict(os.environ, ANIMA_SKIP_RUNTIME_SYNC="1"),
            patch.object(ensure_runtime, "_probe_cuda_torch", return_value=("2.10.0+cu126", "12.6")),
            patch.object(ensure_runtime, "pip") as pip_mock,
        ):
            rc = ensure_runtime.main([])
        self.assertEqual(rc, 0)
        pip_mock.assert_not_called()

    def test_ensure_runtime_skip_sync_still_upgrades_old_or_cpu_torch(self):
        for probe in (("2.8.0+cu124", "12.4"), ("2.9.1+cpu", None)):
            with (
                self.subTest(probe=probe),
                patch.object(ensure_runtime, "_probe_cuda_torch", return_value=probe),
                patch.object(ensure_runtime, "package_version", return_value=probe[0]),
                patch.object(ensure_runtime, "pip", return_value=0) as pip_mock,
                patch.object(ensure_runtime, "sync_triton"),
                patch.object(ensure_runtime, "sync_optional_packages", return_value=[]),
            ):
                rc = ensure_runtime.main(["--skip-runtime-sync"])
            self.assertEqual(rc, 0)
            pip_mock.assert_called_once()

    def test_ensure_runtime_pip_prefers_uv_and_falls_back_to_pip(self):
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", return_value=0) as run_mock,
        ):
            os.environ.pop("ANIMA_NO_UV", None)
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 1)
        cmd = run_mock.call_args.args[0]
        self.assertEqual(cmd[:4], ["/usr/local/bin/uv", "pip", "install", "--python"])

        # Fallback to pip when uv fails
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", side_effect=[1, 0]) as run_mock,
        ):
            os.environ.pop("ANIMA_NO_UV", None)
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 2)
        self.assertEqual(run_mock.call_args_list[1].args[0][1:3], ["-m", "pip"])

        # ANIMA_NO_UV=1 bypasses uv completely
        with (
            patch.dict(os.environ, ANIMA_NO_UV="1"),
            patch.object(ensure_runtime.shutil, "which", return_value="/usr/local/bin/uv"),
            patch.object(ensure_runtime, "run", return_value=0) as run_mock,
        ):
            rc = ensure_runtime.pip("install", "tqdm")
        self.assertEqual(rc, 0)
        self.assertEqual(run_mock.call_count, 1)
        self.assertEqual(run_mock.call_args.args[0][1:3], ["-m", "pip"])


if __name__ == "__main__":
    unittest.main()
