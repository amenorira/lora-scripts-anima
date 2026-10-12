"""Healthy launch probes stay read-only and avoid unrelated training imports."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StartupFastPathTests(unittest.TestCase):
    def run_python(self, *args, env=None):
        result = subprocess.run(
            [sys.executable, "-B", *args], cwd=ROOT, env=env,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_metadata_probe_does_not_load_training_or_web_stack(self):
        self.run_python("-c", """
import sys
from backend.training.musubi_runtime import shared_runtime_status
shared_runtime_status(verify_imports=False)
for module in ('backend.training.supervisor', 'fastapi', 'torch', 'transformers'):
    assert module not in sys.modules, module
""")


if __name__ == "__main__":
    unittest.main()
