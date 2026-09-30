import sys
import unittest
from unittest.mock import patch

from backend import launch_utils
from tools import ensure_runtime


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
        ) as pip_mock, patch.object(ensure_runtime, "sync_triton") as triton_mock, patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as sync_mock:
            self.assertEqual(ensure_runtime.main(), 0)

        arguments = pip_mock.call_args.args
        self.assertIn("torch==2.12.1+cu130", arguments)
        self.assertIn("torchvision==0.27.1+cu130", arguments)
        self.assertIn("--extra-index-url", arguments)
        sync_mock.assert_called_once_with(core_changed=True)
        triton_mock.assert_called_once_with()

    def test_matching_core_is_not_reinstalled(self):
        versions = {"torch": ensure_runtime.TORCH, "torchvision": ensure_runtime.TORCHVISION}
        with patch.object(ensure_runtime, "package_version", side_effect=versions.get), patch.object(
            ensure_runtime, "pip"
        ) as pip_mock, patch.object(ensure_runtime, "sync_triton") as triton_mock, patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as sync:
            self.assertEqual(ensure_runtime.main(), 0)
        pip_mock.assert_not_called()
        sync.assert_called_once_with(core_changed=False)
        triton_mock.assert_called_once_with()


class TritonBootstrapTests(unittest.TestCase):
    def test_missing_or_incompatible_triton_is_installed_for_each_platform(self):
        for platform, requirement in (("win32", "triton-windows>=3.7.1,<3.8"),
                                      ("linux", "triton==3.7.1")):
            for version in (None, "3.6.0", "3.8.0"):
                with self.subTest(platform=platform, version=version), \
                     patch.object(sys, "platform", platform), \
                     patch.object(ensure_runtime, "package_version", return_value=version), \
                     patch.object(ensure_runtime, "pip") as install:
                    ensure_runtime.sync_triton()
                    install.assert_called_once_with(
                        "install", "--upgrade", "--only-binary=:all:", "--no-deps", requirement
                    )


    def test_install_failure_continues_startup(self):
        versions = {"torch": ensure_runtime.TORCH, "torchvision": ensure_runtime.TORCHVISION}
        for platform in ("win32", "linux"):
            for core_changed in (False, True):
                installed = {} if core_changed else versions
                results = ([0] if core_changed else []) + [RuntimeError("download failed")]
                with self.subTest(platform=platform, core_changed=core_changed), \
                     patch.object(sys, "platform", platform), \
                     patch.object(ensure_runtime, "package_version", side_effect=installed.get), \
                     patch.object(ensure_runtime, "pip", side_effect=results), \
                     patch.object(ensure_runtime, "sync_optional_packages", return_value=[]) as optional:
                    self.assertEqual(ensure_runtime.main(), 0)
                    optional.assert_called_once_with(core_changed=core_changed)


class RuntimeRepairRegressionTests(unittest.TestCase):
    def test_platform_requirements_are_checked_as_complete_pep508_specs(self):
        for requirement, installed, expected in (
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', "3.7.1.post27", True),
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', None, False),
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', "3.6.0", False),
            ('triton==3.7.1; sys_platform == "linux"', None, True),
        ):
            with self.subTest(requirement=requirement, installed=installed), \
                 patch.object(sys, "platform", "win32"), \
                 patch.object(launch_utils, "_PKG_VERSION_CACHE", {}), \
                 patch.object(launch_utils, "_installed_version", return_value=installed) as lookup:
                self.assertEqual(launch_utils.is_installed(requirement), expected)
                if '"linux"' in requirement:
                    lookup.assert_not_called()


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
