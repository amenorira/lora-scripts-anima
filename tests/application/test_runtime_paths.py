import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from tools import runtime_paths


class RuntimePathTests(unittest.TestCase):


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
