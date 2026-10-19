import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import runtime_paths


class RuntimePathTests(unittest.TestCase):
    def test_startup_hook_preserves_normal_temporary_and_compiler_paths(self):
        env = os.environ.copy()
        # No extra project-root entry or trailing separator to hide startup bugs.
        env["PYTHONPATH"] = str(runtime_paths.ROOT / "tools/python_startup")
        keys = ("TEMP", "TMP", "TMPDIR", "TORCHINDUCTOR_CACHE_DIR", "TORCH_EXTENSIONS_DIR",
                "TRITON_CACHE_DIR", "LYCORIS_KERNEL_CACHE_DIR", "CUDA_CACHE_PATH", "XDG_CACHE_HOME")
        for key in (*keys, "ANIMA_TEMP_DIR"):
            env.pop(key, None)
        with tempfile.TemporaryDirectory() as directory:
            env.update({key: directory for key in ("TEMP", "TMP", "TMPDIR")})
            env["TORCHINDUCTOR_CACHE_DIR"] = str(Path(directory) / "custom-inductor")
            script = (
                "import json, os, sys, tempfile; assert 'sitecustomize' in sys.modules; "
                f"print(json.dumps({{key: os.environ.get(key) for key in {keys!r}}})); "
                "print(tempfile.gettempdir())"
            )
            result = subprocess.run(
                [sys.executable, "-c", script], cwd=runtime_paths.ROOT, env=env,
                capture_output=True, text=True, encoding="utf-8", timeout=15,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        paths, temporary = result.stdout.splitlines()
        self.assertEqual(json.loads(paths), {key: env.get(key) for key in keys})
        self.assertEqual(Path(temporary), Path(directory))

    def test_temporary_files_and_children_do_not_fall_back_to_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with patch.dict(os.environ, {}, clear=True), patch.object(tempfile, "tempdir", str(Path.cwd())):
                runtime_paths.configure_test_paths(root=project)
                expected = (project / "cache/tests/tmp").resolve()
                with tempfile.NamedTemporaryFile() as handle:
                    self.assertEqual(Path(handle.name).parent, expected)
                result = subprocess.run(
                    [sys.executable, "-c", "import tempfile; print(tempfile.gettempdir())"],
                    capture_output=True, text=True, encoding="utf-8", timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(Path(result.stdout.strip()), expected)

    def test_test_setup_preserves_explicit_compiler_caches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = {
                "TORCHINDUCTOR_CACHE_DIR": str(root / "custom-inductor"),
                "TRITON_CACHE_DIR": str(root / "custom-triton"),
                "LYCORIS_KERNEL_CACHE_DIR": str(root / "custom-lycoris"),
            }
            with patch.dict(os.environ, values, clear=True), patch.object(tempfile, "tempdir", None):
                runtime_paths.configure_test_paths(root=root)
                for key, value in values.items():
                    self.assertEqual(os.environ[key], value)
                self.assertEqual(Path(tempfile.gettempdir()), root / "cache/tests/tmp")
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
