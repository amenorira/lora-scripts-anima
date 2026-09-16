import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import ensure_musubi_runtime


ROOT = Path(__file__).parents[2]
WINDOWS_SCRIPT = ROOT / "tools" / "bootstrap_windows.ps1"


class BootstrapContractTests(unittest.TestCase):
    def test_windows_powershell_source_is_ascii_for_legacy_windows_powershell(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        self.assertTrue(script.isascii())

    def test_zip_repair_backs_up_before_alignment_and_never_cleans(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        backup = script.index("New-BootstrapBackup $rootFull")
        source_alignment = script.index('@("checkout", "--force", $remoteRef, "--")')
        self.assertLess(backup, source_alignment)
        self.assertIn("bootstrap-backups", script)
        self.assertIn("--set-upstream-to=origin/$Branch", script)
        self.assertIn('"pull.ff", "only"', script)
        self.assertIn('"fetch", "--progress", "--tags"', script)
        self.assertIn("Assert-NoReparseTraversal", script)
        self.assertIn("Test-ProtectedUserPath", script)
        self.assertIn(":(top,exclude,icase,literal)$rootName", script)
        self.assertNotIn("git clean", script.lower())
        self.assertNotIn('@("reset", "--hard"', script)

    def test_quiet_runtime_check_hides_success_but_keeps_errors(self):
        healthy = {"ok": True, "errors": [], "versions": {}}
        output = io.StringIO()
        with patch.object(sys, "argv", ["ensure_musubi_runtime", "--check", "--quiet"]), patch.object(
            ensure_musubi_runtime, "shared_runtime_status", return_value=healthy
        ), contextlib.redirect_stdout(output):
            self.assertEqual(ensure_musubi_runtime.main(), 0)
        self.assertEqual(output.getvalue(), "")

        unhealthy = {"ok": False, "errors": ["missing package"], "versions": {}}
        output = io.StringIO()
        with patch.object(sys, "argv", ["ensure_musubi_runtime", "--check", "--quiet"]), patch.object(
            ensure_musubi_runtime, "shared_runtime_status", return_value=unhealthy
        ), contextlib.redirect_stdout(output):
            self.assertEqual(ensure_musubi_runtime.main(), 1)
        self.assertIn("missing package", output.getvalue())

    def test_launchers_reject_incompatible_interpreters(self):
        windows_script = WINDOWS_SCRIPT.read_text(encoding="utf-8")
        linux_script = (ROOT / "start.sh").read_text(encoding="utf-8")
        gui = (ROOT / "backend" / "gui.py").read_text(encoding="utf-8")

        self.assertIn("sys.version_info[:2] == (3,12)", windows_script)
        self.assertIn("sys.version_info[:2] == (3, 12)", linux_script)
        self.assertIn("sys.version_info[:2] == (3, 12)", gui)
        self.assertIn("Please run {launcher}", gui)


if __name__ == "__main__":
    unittest.main()
