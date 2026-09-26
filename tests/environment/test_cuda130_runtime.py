import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import launch_utils
from tools import ensure_runtime


ROOT = Path(__file__).parents[2]


class ExistingVenvMigrationTests(unittest.TestCase):
    def test_user_flash_installation_is_never_modified(self):
        versions = {"flash-attn": "2.8.3+cu130torch2.10"}
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip"
        ) as pip_mock, patch.object(ensure_runtime, "run") as run_mock:
            self.assertEqual(ensure_runtime.sync_optional_packages(core_changed=True), [])
        pip_mock.assert_not_called()
        run_mock.assert_not_called()
    def test_core_upgrade_migrates_old_cu130_torch(self):
        versions = {
            "torch": "2.10.0+cu130",
            "torchvision": "0.25.0+cu130",
        }
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip", return_value=0
        ) as pip_mock, patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as sync_mock:
            self.assertEqual(ensure_runtime.main(), 0)

        arguments = pip_mock.call_args.args
        self.assertIn("torch==2.12.1+cu130", arguments)
        self.assertIn("torchvision==0.27.1+cu130", arguments)
        self.assertIn("--extra-index-url", arguments)
        sync_mock.assert_called_once_with(core_changed=True)

    def test_matching_core_is_not_reinstalled(self):
        versions = {"torch": ensure_runtime.TORCH, "torchvision": ensure_runtime.TORCHVISION}
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip"
        ) as pip_mock, patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as sync:
            self.assertEqual(ensure_runtime.main(), 0)
        pip_mock.assert_not_called()
        sync.assert_called_once_with(core_changed=False)

    def test_absent_optional_packages_are_not_installed(self):
        with patch.object(ensure_runtime, "package_version", return_value=None), patch.object(
            ensure_runtime, "pip"
        ) as pip_mock, patch.object(ensure_runtime, "run") as run_mock:
            self.assertEqual(ensure_runtime.sync_optional_packages(core_changed=True), [])
        pip_mock.assert_not_called()
        run_mock.assert_not_called()

    def test_installed_extensions_use_matching_versions(self):
        triton = "triton-windows" if sys.platform == "win32" else "triton"
        versions = {"xformers": "0.0.33", triton: "3.6.0"}
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip", return_value=0
        ) as pip_mock:
            self.assertEqual(ensure_runtime.sync_optional_packages(core_changed=True), [])
        arguments = [arg for call in pip_mock.call_args_list for arg in call.args]
        self.assertIn("xformers==0.0.35", arguments)
        self.assertIn(f"{triton}>=3.7.1,<3.8" if sys.platform == "win32" else "triton==3.7.1", arguments)


class RuntimeRepairRegressionTests(unittest.TestCase):
    def test_pip_mutation_invalidates_package_version_cache(self):
        launch_utils._PKG_VERSION_CACHE = {"onnxruntime-gpu": "1.20.1"}
        try:
            with patch.object(launch_utils, "run", return_value=0):
                launch_utils.run_pip("install onnxruntime-gpu==1.27.0")
            self.assertIsNone(launch_utils._PKG_VERSION_CACHE)
        finally:
            launch_utils._PKG_VERSION_CACHE = None

if __name__ == "__main__":
    unittest.main()
