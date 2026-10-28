import subprocess
import sys
import unittest

from tools.runtime_paths import ROOT


class MonitorImportTests(unittest.TestCase):
    def test_pure_tools_do_not_load_routes_or_field_metadata(self):
        script = """
import sys
from backend.monitor import artifacts, checkpoints, log_files, run_registry
assert checkpoints.parse_checkpoint('demo-step00000012.safetensors')['step'] == 12
for name in ('fastapi', 'backend.monitor.routes', 'backend.monitor.history', 'backend.training.fields.field_registry'):
    assert name not in sys.modules, name
"""
        result = subprocess.run([sys.executable, "-B", "-c", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
