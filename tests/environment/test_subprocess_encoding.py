import os
import sys
import unittest
from pathlib import Path

from tools.python_startup import sitecustomize  # noqa: F401

from backend import launch_utils


ROOT = Path(__file__).parents[2]


class SubprocessEncodingTests(unittest.TestCase):
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
