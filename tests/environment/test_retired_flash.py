import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RetiredFlashTests(unittest.TestCase):
    def test_broken_package_is_never_executed_in_training_processes(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "flash_attn"
            package.mkdir()
            package_file = package / "__init__.py"
            source = "raise OSError('old incompatible DLL must never load')\n"
            package_file.write_text(source, encoding="utf-8")
            env = os.environ.copy()
            env["PYTHONPATH"] = os.pathsep.join([
                str(root / "tools/python_startup"), str(root), directory,
                str(root / "vendor/sd-scripts"), str(root / "vendor/musubi-tuner/src"),
            ])
            script = (
                "import importlib.util; assert importlib.util.find_spec('flash_attn') is None; "
                "from library import attention as sd; "
                "from musubi_tuner.modules import attention as mu; "
                "assert sd.flash_attn is None and mu.flash_attn is None; print('SDPA ready')"
            )
            result = subprocess.run([sys.executable, "-X", "utf8", "-c", script],
                cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("SDPA ready", result.stdout)
            self.assertNotIn("flash-attn", result.stderr)
            self.assertNotIn("old incompatible DLL", result.stderr)
            self.assertEqual(package_file.read_text(encoding="utf-8"), source)
