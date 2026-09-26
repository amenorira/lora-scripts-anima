import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training import supervisor


class OptionalFlashTests(unittest.TestCase):
    def probe(self, package_source):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "flash_attn"
            package.mkdir()
            (package / "__init__.py").write_text(package_source, encoding="utf-8")
            return subprocess.run(
                [sys.executable, "-X", "utf8", "-c",
                 "import sys; sys.path.insert(0, sys.argv[1]); "
                 "from tools.python_startup.optional_flash import install; install(); install();\n"
                 "try:\n from flash_attn import flash_attn_func\n print(flash_attn_func())\n"
                 "except ImportError:\n print('SDPA fallback')\n", directory],
                cwd=Path(__file__).resolve().parents[2],
                capture_output=True, text=True, encoding="utf-8", timeout=20,
            )

    def test_broken_dll_becomes_optional_import_failure(self):
        result = self.probe("raise OSError('old torch DLL')")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SDPA fallback", result.stdout)
        self.assertIn("old torch DLL", result.stderr)
        self.assertIn("project venv", result.stderr)

    def test_compatible_user_installation_remains_usable(self):
        result = self.probe("def flash_attn_func(): return 'external flash works'")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("external flash works", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_unavailable_flash_uses_sdpa_even_when_xformers_is_available(self):
        with patch.object(supervisor, "_detect_available_attn", return_value=["torch", "xformers"]):
            actual, warning = supervisor.detect_attention_backend("flash")
        self.assertEqual(actual, "torch")
        self.assertIn("自行安装", warning)

    def test_available_flash_is_preserved(self):
        with patch.object(supervisor, "_detect_available_attn", return_value=["torch", "flash"]):
            self.assertEqual(supervisor.detect_attention_backend("flash"), ("flash", ""))

    def test_installer_routes_are_removed(self):
        from backend.server.routes.environment import router

        self.assertFalse(any("flash-attention" in route.path for route in router.routes))
