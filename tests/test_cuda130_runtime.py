import sys
import types
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

from backend import launch_utils
from backend.utils import devices
from tools import ensure_runtime
from tools import install_flash_attn


ROOT = Path(__file__).parents[1]


class Cuda130SourceContractTests(unittest.TestCase):
    def test_new_installs_and_launchers_use_cu130(self):
        windows = (ROOT / "tools/bootstrap_windows.ps1").read_text(encoding="utf-8")
        linux = (ROOT / "start.sh").read_text(encoding="utf-8")
        messages = (ROOT / "tools/bootstrap_messages.json").read_text(encoding="utf-8")

        for source in (windows, linux):
            self.assertIn("torch==2.10.0+cu130", source)
            self.assertIn("torchvision==0.25.0+cu130", source)
            self.assertIn("https://download.pytorch.org/whl/cu130", source)
            self.assertIn("tools.ensure_runtime", source)
        self.assertIn("CUDA 13.0", messages)

    def test_cuda_bound_project_dependencies_follow_cu130(self):
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        environment = (ROOT / "backend/server/routes/environment.py").read_text(encoding="utf-8")

        self.assertIn("onnxruntime-gpu==1.27.0", requirements)
        self.assertIn("https://download.pytorch.org/whl/cu{match.group(1)}", environment)
        self.assertIn('"--no-deps"', environment)


class ExistingVenvMigrationTests(unittest.TestCase):
    def test_core_upgrade_keeps_torch_minor_and_changes_cuda_only(self):
        versions = {
            "torch": "2.10.0+cu128",
            "torchvision": "0.25.0+cu128",
        }
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip", return_value=0
        ) as pip_mock, patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as sync_mock:
            self.assertEqual(ensure_runtime.main(), 0)

        arguments = pip_mock.call_args.args
        self.assertIn("torch==2.10.0+cu130", arguments)
        self.assertIn("torchvision==0.25.0+cu130", arguments)
        self.assertIn("--extra-index-url", arguments)
        sync_mock.assert_called_once_with(core_changed=True)

    def test_installed_acceleration_wheels_are_rematched(self):
        expected_triton = "triton-windows" if sys.platform == "win32" else "triton"
        versions = {
            "bitsandbytes": "0.47.0",
            "xformers": "0.0.35",
            "flash-attn": "2.8.3+cu128torch2.10",
            expected_triton: "3.6.0",
        }
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "package_file", return_value=None
        ), patch.object(ensure_runtime, "xformers_cuda_build", return_value=1208), patch.object(
            ensure_runtime, "pip", return_value=0
        ) as pip_mock, patch.object(ensure_runtime, "run", return_value=0) as run_mock:
            warnings = ensure_runtime.sync_optional_packages(core_changed=True)

        self.assertEqual(warnings, [])
        commands = [call.args for call in pip_mock.call_args_list]
        self.assertTrue(any("bitsandbytes" in command for command in commands))
        self.assertTrue(any("xformers" in command and ensure_runtime.PYTORCH_INDEX in command for command in commands))
        self.assertTrue(any(any(str(arg).startswith(expected_triton) for arg in command) for command in commands))
        self.assertIn("tools.install_flash_attn", run_mock.call_args.args[0])
        self.assertEqual(run_mock.call_args.kwargs["input_text"], "\n")
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 1800)

    def test_flash_upgrade_failure_keeps_existing_installation(self):
        versions = {
            "bitsandbytes": None,
            "xformers": None,
            "flash-attn": "2.8.3+cu128torch2.10",
            "triton-windows" if sys.platform == "win32" else "triton": None,
        }
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "xformers_cuda_build", return_value=None
        ), patch.object(ensure_runtime, "package_file", return_value=None), patch.object(
            ensure_runtime, "run", return_value=1
        ) as run_mock, patch.object(ensure_runtime, "pip") as pip_mock:
            warnings = ensure_runtime.sync_optional_packages(core_changed=True)

        # 升级失败 → 不卸载旧版（被墙环境下保留可用旧 wheel），只打警告
        self.assertEqual(run_mock.call_count, 1)
        uninstall_calls = [
            call.args for call in pip_mock.call_args_list if "uninstall" in str(call.args[0])
        ]
        self.assertEqual(uninstall_calls, [])
        self.assertTrue(any("keeping the existing installation" in w for w in warnings))


class RuntimeRepairRegressionTests(unittest.TestCase):
    def test_pip_mutation_invalidates_package_version_cache(self):
        launch_utils._PKG_VERSION_CACHE = {"onnxruntime-gpu": "1.20.1"}
        try:
            with patch.object(launch_utils, "run", return_value=0):
                launch_utils.run_pip("install onnxruntime-gpu==1.27.0")
            self.assertIsNone(launch_utils._PKG_VERSION_CACHE)
        finally:
            launch_utils._PKG_VERSION_CACHE = None

    def test_flash_verification_does_not_claim_cuda_forward_without_gpu(self):
        fake_torch = types.ModuleType("torch")

        def unavailable_cuda():
            warnings.warn(
                "cudaGetDeviceCount() returned cudaErrorNotSupported, likely using older driver or on CPU machine",
                UserWarning,
            )
            return False

        fake_torch.cuda = types.SimpleNamespace(is_available=unavailable_cuda)
        fake_flash = types.ModuleType("flash_attn")
        fake_flash.flash_attn_func = lambda *_args: None

        with warnings.catch_warnings(record=True) as caught, patch.dict(
            sys.modules, {"torch": fake_torch, "flash_attn": fake_flash}
        ):
            warnings.simplefilter("always")
            ok, message = install_flash_attn.verify_flash_attn()

        self.assertTrue(ok)
        self.assertEqual(caught, [])
        self.assertIn("跳过", message)
        self.assertNotIn("测试通过", message)

    def test_gpu_probe_suppresses_expected_no_driver_warning(self):
        fake_torch = types.ModuleType("torch")
        fake_torch.__version__ = "2.10.0+cu130"

        def unavailable_cuda():
            warnings.warn(
                "cudaGetDeviceCount() returned cudaErrorNotSupported, likely using older driver or on CPU machine",
                UserWarning,
            )
            return False

        fake_torch.cuda = types.SimpleNamespace(is_available=unavailable_cuda)
        with warnings.catch_warnings(record=True) as caught, patch.dict(sys.modules, {"torch": fake_torch}):
            warnings.simplefilter("always")
            devices.check_torch_gpu()

        self.assertEqual(caught, [])


if __name__ == "__main__":
    unittest.main()
