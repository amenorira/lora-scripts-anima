"""Healthy launch probes stay read-only and avoid unrelated training imports."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import pip_index_config

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


    def test_combined_pip_probe_preserves_user_and_site_selection(self):
        from pip._internal.configuration import kinds
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "user.ini"
            site = Path(tmp) / "site.ini"
            content = "[global]\nindex-url = http://example.invalid/simple\nextra-index-url = https://extra.invalid/simple\n"
            config.write_text(content, encoding="utf-8")
            files = {kinds.GLOBAL: [], kinds.USER: [str(config)], kinds.SITE: [str(site)]}
            with patch.dict(os.environ, {"PIP_CONFIG_FILE": ""}), \
                 patch("pip._internal.configuration.get_configuration_files", return_value=files):
                self.assertEqual(pip_index_config.read_indexes(), {
                    "global.index-url": "http://example.invalid/simple",
                    "global.extra-index-url": "https://extra.invalid/simple",
                })
                site.write_text("[global]\nindex-url = https://site.invalid/simple\n", encoding="utf-8")
                self.assertEqual(pip_index_config.read_indexes(), {
                    "global.index-url": "https://site.invalid/simple",
                })
            self.assertEqual(config.read_text(encoding="utf-8"), content)


if __name__ == "__main__":
    unittest.main()
