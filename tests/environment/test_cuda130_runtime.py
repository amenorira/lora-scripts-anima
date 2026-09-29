import sys
import unittest
from types import SimpleNamespace
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
            ensure_runtime.sync_triton()
        arguments = [arg for call in pip_mock.call_args_list for arg in call.args]
        self.assertIn("xformers==0.0.35", arguments)
        self.assertIn(f"{triton}>=3.7.1,<3.8" if sys.platform == "win32" else "triton==3.7.1", arguments)


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

    def test_matching_triton_keeps_startup_offline(self):
        for platform, version in (("win32", "3.7.1.post27"), ("linux", "3.7.1")):
            with self.subTest(platform=platform), patch.object(sys, "platform", platform), \
                 patch.object(ensure_runtime, "package_version", return_value=version), \
                 patch.object(ensure_runtime, "pip") as install:
                ensure_runtime.sync_triton()
                install.assert_not_called()

    def test_install_failure_fails_startup(self):
        versions = {"torch": ensure_runtime.TORCH, "torchvision": ensure_runtime.TORCHVISION}
        with patch.object(sys, "platform", "win32"), \
             patch.object(ensure_runtime, "package_version", side_effect=versions.get), \
             patch.object(ensure_runtime, "pip", side_effect=RuntimeError("download failed")), \
             patch.object(ensure_runtime, "sync_optional_packages") as optional:
            self.assertEqual(ensure_runtime.main(), 1)
            optional.assert_not_called()

    def test_fresh_install_selects_only_the_platform_triton_package(self):
        from packaging.requirements import Requirement
        requirements = [Requirement(line) for line in (ROOT / "requirements.txt").read_text(
            encoding="utf-8"
        ).splitlines() if line.startswith("triton")]
        for platform, expected in (("win32", "triton-windows"), ("linux", "triton")):
            selected = [req for req in requirements if req.marker.evaluate({"sys_platform": platform})]
            self.assertEqual([req.name for req in selected], [expected])
            self.assertIn("3.7.1", selected[0].specifier)
            self.assertNotIn("3.8.0", selected[0].specifier)


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

    def test_missing_platform_requirement_is_one_pip_argument(self):
        requirement = 'triton-windows>=3.7.1,<3.8; sys_platform == "win32"'
        with patch.object(Path, "read_text", return_value=requirement), \
             patch.object(launch_utils, "is_installed", return_value=False), \
             patch.object(launch_utils, "run") as run_mock:
            launch_utils.check_requirements()
        self.assertEqual(run_mock.call_args.args[0][-2:], ["install", requirement])

    def test_cuda_wheel_checks_do_not_import_torch(self):
        for version, cuda, ort in (("2.12.1+cu130", "13.0", "1.27.0"),
                                   ("2.5.0+cu121", "12.1", "1.20.1"),
                                   ("2.5.0+cpu", None, None)):
            with self.subTest(version=version), \
                 patch.object(launch_utils.importlib_metadata, "version", return_value=version), \
                 patch.dict(sys.modules, {"torch": None}):
                self.assertEqual(launch_utils._torch_cuda_version(), cuda)
                self.assertEqual(launch_utils._resolve_ort_version_for_torch(), ort)

    def test_untagged_torch_build_keeps_runtime_probe(self):
        torch = SimpleNamespace(version=SimpleNamespace(cuda="12.8"))
        with patch.object(launch_utils.importlib_metadata, "version", return_value="2.7.0"), \
             patch.dict(sys.modules, {"torch": torch}):
            self.assertEqual(launch_utils._torch_cuda_version(), "12.8")
            self.assertEqual(launch_utils._resolve_ort_version_for_torch(), "1.20.1")

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
