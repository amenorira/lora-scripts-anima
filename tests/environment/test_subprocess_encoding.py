import os
import sys
import unittest
from pathlib import Path


from backend import launch_utils


ROOT = Path(__file__).parents[2]


class SubprocessEncodingTests(unittest.TestCase):
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
