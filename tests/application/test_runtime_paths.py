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

    def test_test_setup_isolates_inherited_compiler_caches_and_bytecode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = {
                "TORCHINDUCTOR_CACHE_DIR": "torchinductor_lou",
                "TRITON_CACHE_DIR": str(root / "custom-triton"),
                "LYCORIS_KERNEL_CACHE_DIR": str(root / "custom-lycoris"),
            }
            with patch.dict(os.environ, values, clear=True), patch.object(tempfile, "tempdir", None):
                runtime_paths.configure_test_paths(root=root)
                for key in values:
                    self.assertTrue(Path(os.environ[key]).is_relative_to(root / "cache/tests"))
                self.assertTrue(sys.dont_write_bytecode)
                self.assertEqual(os.environ["PYTHONDONTWRITEBYTECODE"], "1")
                self.assertEqual(Path(tempfile.gettempdir()), root / "cache/tests/tmp")
                self.assertTrue(Path(os.environ["XDG_CACHE_HOME"]).is_relative_to(root / "cache"))

    def test_entrypoint_isolates_paths_before_test_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "test_probe.py"
            probe.write_text(
                "import os, pathlib, sys, tempfile, unittest\n"
                "from tools.runtime_paths import ROOT\n"
                "class Probe(unittest.TestCase):\n"
                " def test_paths(self):\n"
                "  base = ROOT / 'cache/tests'\n"
                "  assert pathlib.Path(tempfile.gettempdir()).is_relative_to(base)\n"
                "  assert pathlib.Path(os.environ['TORCHINDUCTOR_CACHE_DIR']).is_relative_to(base)\n"
                "  assert sys.dont_write_bytecode\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            env["TORCHINDUCTOR_CACHE_DIR"] = "torchinductor_lou"
            env["PYTHONPATH"] = directory
            result = subprocess.run(
                [sys.executable, str(runtime_paths.ROOT / "tools/dev/run_tests.py"), "test_probe"],
                cwd=directory, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((Path(directory) / "__pycache__").exists())
            self.assertFalse((Path(directory) / "torchinductor_lou").exists())

    def test_lycoris_presets_have_a_stable_managed_path_even_if_tempfile_falls_back(self):
        from backend.training.config.adapter import _write_lycoris_scope_preset_file

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(runtime_paths, "ROOT", root), patch.object(tempfile, "tempdir", str(Path.cwd())):
                first = _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
                with patch("backend.training.config.adapter.atomic_write_text", side_effect=AssertionError("unchanged preset rewritten")):
                    second = _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
                self.assertEqual(first, second)
                self.assertTrue(Path(first).is_relative_to(root / "cache/runtime/lycoris"))
                self.assertIn("scope_probe", Path(first).read_text(encoding="utf-8"))

    def test_lycoris_preset_repair_and_failed_replace_preserve_existing_bytes(self):
        from backend.training.config.adapter import _write_lycoris_scope_preset_file

        with tempfile.TemporaryDirectory() as directory, patch.object(runtime_paths, "ROOT", Path(directory)):
            target = Path(_write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"]))
            expected = target.read_bytes()
            target.write_bytes(b"broken")
            with patch("backend.utils.file_io.os.replace", side_effect=PermissionError("in use")):
                with self.assertRaises(PermissionError):
                    _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
            self.assertEqual(target.read_bytes(), b"broken")
            self.assertEqual(list(target.parent.glob("*.tmp")), [])
            _write_lycoris_scope_preset_file("attn-mlp", ["scope_probe"])
            self.assertEqual(target.read_bytes(), expected)
