import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import runtime_paths


class RuntimePathTests(unittest.TestCase):
    def test_startup_hook_works_with_only_the_launcher_pythonpath(self):
        env = os.environ.copy()
        # No extra project-root entry or trailing separator to hide startup bugs.
        env["PYTHONPATH"] = str(runtime_paths.ROOT / "tools/python_startup")
        result = subprocess.run(
            [sys.executable, "-c", "import sys, tempfile; "
             "assert 'sitecustomize' in sys.modules; print(tempfile.gettempdir())"],
            cwd=runtime_paths.ROOT, env=env, capture_output=True,
            text=True, encoding="utf-8", timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(Path(result.stdout.strip()), Path(tempfile.gettempdir()))

    def test_temporary_files_and_children_do_not_fall_back_to_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with patch.dict(os.environ, {}, clear=True), patch.object(tempfile, "tempdir", str(Path.cwd())):
                runtime_paths.configure_runtime_paths(testing=True, root=project)
                expected = (project / "cache/tests/tmp").resolve()
                with tempfile.NamedTemporaryFile() as handle:
                    self.assertEqual(Path(handle.name).parent, expected)
                result = subprocess.run(
                    [sys.executable, "-c", "import tempfile; print(tempfile.gettempdir())"],
                    capture_output=True, text=True, encoding="utf-8", timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(Path(result.stdout.strip()), expected)

    def test_explicit_compiler_caches_and_inherited_temporary_directory_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = {
                "ANIMA_TEMP_DIR": str(root / "parent-tmp"),
                "TORCHINDUCTOR_CACHE_DIR": str(root / "custom-inductor"),
                "TRITON_CACHE_DIR": str(root / "custom-triton"),
                "LYCORIS_KERNEL_CACHE_DIR": str(root / "custom-lycoris"),
            }
            with patch.dict(os.environ, values, clear=True), patch.object(tempfile, "tempdir", None):
                runtime_paths.configure_runtime_paths(root=root)
                for key, value in values.items():
                    self.assertEqual(os.environ[key], value)
                self.assertEqual(Path(tempfile.gettempdir()), root / "parent-tmp")
                self.assertTrue(Path(os.environ["XDG_CACHE_HOME"]).is_relative_to(root / "cache"))

    def test_lycoris_presets_have_a_stable_managed_path_even_if_tempfile_falls_back(self):
        from backend.training.adapter import _write_lycoris_scope_preset_file

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(runtime_paths, "ROOT", root), patch.object(tempfile, "tempdir", str(Path.cwd())):
                first = _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
                second = _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
                self.assertEqual(first, second)
                self.assertTrue(Path(first).is_relative_to(root / "cache/runtime/lycoris"))
                self.assertIn("scope_probe", Path(first).read_text(encoding="utf-8"))
