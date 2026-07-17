import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
WINDOWS_SCRIPT = ROOT / "tools" / "bootstrap_windows.ps1"
WINDOWS_MESSAGES = ROOT / "tools" / "bootstrap_messages.json"


class BootstrapContractTests(unittest.TestCase):
    def test_windows_powershell_source_is_ascii_for_legacy_windows_powershell(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        self.assertTrue(script.isascii())

    def test_windows_batch_delegates_to_powershell_bootstrap(self):
        script = (ROOT / "start.bat").read_text(encoding="utf-8")

        self.assertIn("chcp 65001", script)
        self.assertTrue(script.isascii())
        self.assertIn("powershell.exe -NoProfile -ExecutionPolicy Bypass", script)
        self.assertIn("tools\\bootstrap_windows.ps1", script)
        self.assertIn('if "%_ANIMA_RC%"=="23"', script)
        self.assertIn("ANIMA_BOOTSTRAP_RESTARTED", script)

    def test_windows_keeps_python_compatibility_and_verified_install(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("sys.version_info[:2] < (3,13)", script)
        self.assertIn("python-3.12.10-amd64.exe", script)
        self.assertIn("Get-AuthenticodeSignature", script)
        self.assertIn("*Python Software Foundation*", script)
        self.assertIn("InstallAllUsers=0", script)
        self.assertIn("PrependPath=0", script)

    def test_windows_git_install_is_verified_and_user_scoped(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("winget.exe", script)
        self.assertIn("Git.Git", script)
        self.assertIn("Git-2.55.0.3-64-bit.exe", script)
        self.assertIn(
            "af12577d0fdff74243a5988197aa49b957d5044edc17004f6ddf0768996f1dca",
            script,
        )
        self.assertIn("/CURRENTUSER", script)
        self.assertIn("ext\\reg\\shellhere", script)
        self.assertIn("HKCU:\\Software\\Classes\\Directory", script)

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

    def test_existing_unknown_repository_origin_is_warning_only(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")
        messages = json.loads(WINDOWS_MESSAGES.read_text(encoding="utf-8"))

        self.assertIn('"remote", "get-url", "origin"', script)
        self.assertIn('Write-Text "git_origin_unknown"', script)
        self.assertIn(" / ", messages["git_origin_unknown"])

    def test_quiet_mode_does_not_implicitly_repair_git(self):
        script = WINDOWS_SCRIPT.read_text(encoding="utf-8")

        self.assertIn('if ($script:Quiet) { return $false }', script)
        self.assertIn('if ($arg -eq "--setup-git")', script)
        self.assertIn('if ($arg -eq "--skip-git-setup")', script)

    def test_bootstrap_messages_are_bilingual_utf8(self):
        messages = json.loads(WINDOWS_MESSAGES.read_text(encoding="utf-8"))

        required = {
            "git_zip_detected",
            "git_origin_unknown",
            "git_install_failed",
            "git_backup",
            "python_missing",
            "venv_missing",
            "install_done",
            "fatal_error",
        }
        self.assertTrue(required.issubset(messages))
        for key in required:
            self.assertIn(" / ", messages[key], key)
            self.assertTrue(any("\u4e00" <= char <= "\u9fff" for char in messages[key]), key)

    def test_launchers_reject_incompatible_interpreters(self):
        windows_script = WINDOWS_SCRIPT.read_text(encoding="utf-8")
        linux_script = (ROOT / "start.sh").read_text(encoding="utf-8")
        gui = (ROOT / "backend" / "gui.py").read_text(encoding="utf-8")

        self.assertIn("sys.version_info[:2] < (3,13)", windows_script)
        self.assertIn("sys.version_info[:2] < (3, 13)", linux_script)
        self.assertIn("sys.version_info[:2] < (3, 13)", gui)
        self.assertIn("Please run {launcher}", gui)

    def test_gui_is_an_internal_module(self):
        windows_script = WINDOWS_SCRIPT.read_text(encoding="utf-8")
        linux_script = (ROOT / "start.sh").read_text(encoding="utf-8")
        supervisor = (ROOT / "backend" / "training" / "supervisor.py").read_text(encoding="utf-8")

        self.assertFalse((ROOT / "gui.py").exists())
        self.assertTrue((ROOT / "backend" / "gui.py").is_file())
        self.assertIn("-m backend.gui @script:ForwardArgs", windows_script)
        self.assertNotIn("-m backend.gui @script:ForwardArgs | Out-Host", windows_script)
        self.assertIn("Invoke-MainBootstrap\n    exit $script:BootstrapExitCode", windows_script)
        self.assertIn("-m backend.gui", linux_script)
        self.assertFalse((ROOT / "sitecustomize.py").exists())
        self.assertTrue((ROOT / "tools" / "python_startup" / "sitecustomize.py").is_file())
        self.assertIn("tools\\python_startup", windows_script)
        self.assertIn("tools/python_startup", linux_script)
        self.assertIn('"tools" / "python_startup"', supervisor)


if __name__ == "__main__":
    unittest.main()
