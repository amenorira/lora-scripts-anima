import importlib.metadata
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.python_startup import sitecustomize  # noqa: F401

from backend import launch_utils


ROOT = Path(__file__).parents[1]
BNB_GAUDI_PROBE = "pip list | grep habana-torch-plugin"


class SubprocessEncodingTests(unittest.TestCase):
    def test_decode_falls_back_to_native_encoding_after_invalid_utf8(self):
        native_text = "fatal: \u4e0d\u662f Git \u4ed3\u5e93"

        with patch.object(launch_utils.locale, "getencoding", return_value="gbk", create=True):
            decoded = launch_utils.decode_subprocess_output(native_text.encode("gbk"))

        self.assertEqual(decoded, native_text)

    def test_capture_does_not_decode_inside_subprocess_reader_threads(self):
        result = launch_utils.run_capture_text(
            [
                sys.executable,
                "-c",
                (
                    "import sys; "
                    "sys.stdout.buffer.write(b'v1.1.3\\n'); "
                    "sys.stderr.buffer.write(b'fatal: \\xb2\\xbb')"
                ),
            ]
        )

        self.assertEqual(result.returncode, 0)
        self.assertIsInstance(result.stdout, str)
        self.assertEqual(result.stdout, "v1.1.3\n")
        self.assertIsInstance(result.stderr, str)
        self.assertTrue(result.stderr.startswith("fatal: "))

    def test_capture_rejects_conflicting_text_arguments(self):
        with self.assertRaises(TypeError):
            launch_utils.run_capture_text(
                [sys.executable, "-c", "pass"],
                capture_output=True,
            )

    @unittest.skipUnless(sys.platform == "win32", "Windows-only bitsandbytes compatibility")
    def test_bitsandbytes_gaudi_probe_uses_package_metadata(self):
        with patch.object(importlib.metadata, "version", return_value="1.22.0"):
            result = subprocess.run(
                BNB_GAUDI_PROBE,
                shell=True,
                text=True,
                capture_output=True,
            )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "habana-torch-plugin 1.22.0\n")
        self.assertEqual(result.stderr, "")

    @unittest.skipUnless(sys.platform == "win32", "Windows-only bitsandbytes compatibility")
    def test_fresh_process_import_avoids_gbk_reader_thread_failure(self):
        script = """
import ctypes
import sys

kernel32 = ctypes.windll.kernel32
original_cp = kernel32.GetConsoleOutputCP()
kernel32.SetConsoleOutputCP(936)
try:
    from bitsandbytes.backends.utils import GAUDI_SW_VER
    print(f"SITECUSTOMIZE={'sitecustomize' in sys.modules};GAUDI={GAUDI_SW_VER}")
finally:
    kernel32.SetConsoleOutputCP(original_cp)
"""
        env = os.environ.copy()
        env["PYTHONUTF8"] = "1"
        env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT / "tools" / "python_startup"), str(ROOT), env.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)

        result = launch_utils.run_capture_text(
            [sys.executable, "-c", script],
            cwd=ROOT,
            env=env,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SITECUSTOMIZE=True;GAUDI=None", result.stdout)
        self.assertNotIn("UnicodeDecodeError", result.stderr)
        self.assertNotIn("Exception in thread", result.stderr)


if __name__ == "__main__":
    unittest.main()
