import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.execution import musubi_runtime as runtime


class SharedRuntimeRequirementsTests(unittest.TestCase):
    def test_manifest_constraints_drive_runtime_checks_without_importing_training(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "requirements.txt"
            manifest.write_text(
                "# shared stack\nAccelerate>=7,<8 # release range\nPyTorch-Optimizer==4.1.0\n",
                encoding="utf-8",
            )
            read_requirements = runtime.runtime_requirements
            versions = {"accelerate": "7.2", "pytorch_optimizer": "4.1.0",
                        "torch": "2.12.1+cu130", "torchvision": "0.27.1+cu130"}
            with patch.object(runtime, "_SHARED_RUNTIME_PACKAGES", ("accelerate", "pytorch_optimizer")), \
                 patch.object(runtime, "runtime_requirements", side_effect=lambda: read_requirements(manifest)), \
                 patch.object(runtime.importlib.metadata, "version", side_effect=versions.__getitem__), \
                 patch.object(runtime.importlib, "import_module") as imports:
                self.assertTrue(runtime.shared_runtime_status(verify_imports=False)["ok"])
                manifest.write_text("accelerate>=8,<9\npytorch_optimizer==4.1.0\n", encoding="utf-8")
                status = runtime.shared_runtime_status(verify_imports=False)
                self.assertFalse(status["ok"])
                self.assertIn("accelerate", status["errors"][0])
                imports.assert_not_called()

    def test_incomplete_or_ambiguous_manifest_reports_an_actionable_failure(self):
        for contents in ("", "accelerate==7\nAccelerate==8\n", "not a requirement!\n",
                         "accelerate @ https://example.invalid/package.whl\n"):
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                manifest = Path(directory) / "requirements.txt"
                manifest.write_text(contents, encoding="utf-8")
                read_requirements = runtime.runtime_requirements
                with patch.object(runtime, "_SHARED_RUNTIME_PACKAGES", ("accelerate",)), \
                     patch.object(runtime, "runtime_requirements", side_effect=lambda: read_requirements(manifest)), \
                     patch.object(runtime.importlib.metadata, "version") as lookup:
                    status = runtime.shared_runtime_status(verify_imports=False)
                self.assertFalse(status["ok"])
                self.assertFalse(status["imports_verified"])
                self.assertIn("依赖约束", status["errors"][0])
                lookup.assert_not_called()

    def test_repository_manifest_covers_every_selected_package(self):
        requirements = runtime.runtime_requirements()
        self.assertEqual(set(requirements), {*runtime._SHARED_RUNTIME_PACKAGES, "torch", "torchvision"})
        self.assertTrue(all(requirements.values()))

    def test_version_ranges_and_cuda_local_versions_follow_pep440(self):
        self.assertIsNone(runtime.version_error("torch", ">=2.9.1", "2.12.1+cu130"))
        self.assertIsNone(runtime.version_error("package", ">=7,<8", "7.2"))
        self.assertIsNotNone(runtime.version_error("package", ">=7,<8", "8.0"))
        self.assertIsNotNone(runtime.version_error("package", "==7", "invalid"))
