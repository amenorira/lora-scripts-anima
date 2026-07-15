import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class BootstrapContractTests(unittest.TestCase):
    def test_windows_skips_store_placeholder_and_keeps_scanning(self):
        script = (ROOT / "start.bat").read_text(encoding="utf-8")

        self.assertNotIn("[FAIL] Microsoft Store Python placeholder detected.", script)
        self.assertIn('findstr /i /c:"WindowsApps"', script)
        self.assertIn(
            "for %%c in (python3.12.exe python3.11.exe python3.10.exe python3.exe python.exe)",
            script,
        )
        self.assertLess(
            script.index('if exist "venv\\Scripts\\python.exe"'),
            script.index("REM Scan every PATH result"),
        )

    def test_windows_can_add_python312_without_replacing_newer_python(self):
        script = (ROOT / "start.bat").read_text(encoding="utf-8")

        self.assertIn("python-3.12.10-amd64.exe", script)
        self.assertIn("Get-AuthenticodeSignature", script)
        self.assertIn("Python Software Foundation", script)
        self.assertIn("InstallAllUsers=0", script)
        self.assertIn("PrependPath=0", script)

    def test_launchers_reject_incompatible_interpreters(self):
        windows_script = (ROOT / "start.bat").read_text(encoding="utf-8")
        linux_script = (ROOT / "start.sh").read_text(encoding="utf-8")
        gui = (ROOT / "backend" / "gui.py").read_text(encoding="utf-8")

        version_guard = "sys.version_info[:2] < (3,13)"
        self.assertIn(version_guard, windows_script)
        self.assertIn("sys.version_info[:2] < (3, 13)", linux_script)
        self.assertIn("sys.version_info[:2] < (3, 13)", gui)
        self.assertIn("Please run {launcher}", gui)

    def test_gui_is_an_internal_module(self):
        windows_script = (ROOT / "start.bat").read_text(encoding="utf-8")
        linux_script = (ROOT / "start.sh").read_text(encoding="utf-8")

        self.assertFalse((ROOT / "gui.py").exists())
        self.assertTrue((ROOT / "backend" / "gui.py").is_file())
        self.assertIn("-m backend.gui", windows_script)
        self.assertIn("-m backend.gui", linux_script)


if __name__ == "__main__":
    unittest.main()
