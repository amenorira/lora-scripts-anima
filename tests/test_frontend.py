"""Run the standalone JavaScript suite through the documented pytest entrypoint."""
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FrontendTests(unittest.TestCase):
    def test_javascript_suite(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Install Node.js to run frontend tests; see tests/README.md")
        scripts = sorted((ROOT / "tests" / "frontend").glob("*.test.cjs"))
        self.assertTrue(scripts, "No frontend tests found")
        result = subprocess.run(
            [node, "--test", *map(str, scripts)], cwd=ROOT,
            capture_output=True, text=True, encoding="utf-8", timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
