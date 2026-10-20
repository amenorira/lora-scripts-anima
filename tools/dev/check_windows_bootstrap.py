"""Run manually after Windows launcher/update changes (requires Git and PowerShell)."""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.runtime_paths import configure_test_paths

configure_test_paths()

import ctypes
import json
import os
import subprocess
import tempfile
import time
import unittest
import zipfile
from contextlib import contextmanager


ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "tools/bootstrap_windows.ps1"
SETTINGS = "config/sample_prompts.txt"
ACCELERATE = "huggingface/accelerate/default_config.yaml"
UPDATE_MARKER = ".anima_tmp/git-update-incomplete.json"


@unittest.skipUnless(os.name == "nt", "Windows bootstrap integration tests")
class WindowsBootstrapIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="anima bootstrap ")
        self.addCleanup(self.cleanup_directory, temporary)
        self.base = Path(temporary.name)

    @staticmethod
    def cleanup_directory(temporary):
        # Windows can briefly report a sharing violation after a subprocess
        # exits. Keep cleanup strict, retrying only WinError 32 for at most 3s.
        deadline = time.monotonic() + 3
        while True:
            try:
                temporary.cleanup()
                return
            except PermissionError as error:
                if getattr(error, "winerror", None) != 32 or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

    def run_command(self, args, cwd=None, check=True):
        result = subprocess.run(
            [str(arg) for arg in args], cwd=cwd, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        if check and result.returncode != 0:
            self.fail(f"command failed ({result.returncode}): {args}\n{result.stdout}")
        return result

    def git(self, cwd, *args, check=True):
        return self.run_command(["git", *args], cwd=cwd, check=check)

    def commit(self, cwd):
        return self.git(cwd, "commit", "-m", "test: 更新启动器测试历史", "-m", "- 构建集成测试所需的临时提交")

    def write(self, root, relative, content):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        return path

    def publish(self, remote, files=None, remove=()):
        for relative in remove:
            self.git(remote, "rm", "--", relative)
        for relative, content in (files or {}).items():
            self.write(remote, relative, content)
            self.git(remote, "add", "-f", "--", relative)
        self.commit(remote)

    def prepare(self, *, repair=True, old_zip=False):
        remote = self.base / "远端 source repo"
        remote.mkdir()
        self.git(remote, "init", "-b", "main")
        self.git(remote, "config", "user.name", "Bootstrap Test")
        self.git(remote, "config", "user.email", "bootstrap@example.invalid")
        files = {
            ".gitignore": "venv/\nmodels/\noutput/\nconfig/\n.anima_tmp/\nbootstrap-backups/\n",
            ".gitattributes": "* text=auto eol=lf\n",
            "start.bat": "@echo off\n", "backend/gui.py": "print('old')\n",
            "README.md": "old upstream\n", "中文文件.txt": "old unicode\n",
            "obsolete.txt": "obsolete\n", SETTINGS: "old settings\n",
            ACCELERATE: "old accelerate settings\n",
            "huggingface/hub/version.txt": "old cache\n",
            "models/.gitkeep": "old model marker\n",
        }
        for relative, content in files.items():
            self.write(remote, relative, content)
        self.git(remote, "add", "-f", ".")
        self.commit(remote)
        old = self.git(remote, "rev-parse", "HEAD").stdout.strip()
        self.git(remote, "tag", "v-test", old)
        self.git(remote, "branch", "dev", old)
        self.publish(remote, {
            "backend/gui.py": "print('latest')\n", "README.md": "latest upstream\n",
            "中文文件.txt": "latest unicode\n", "latest.txt": "latest\n",
            SETTINGS: "latest settings\n", "models/.gitkeep": "latest marker\n",
            "models/remote-only.bin": "must not enter user models\n",
        }, remove=("obsolete.txt",))
        target = self.base / "下载目录 含空格"
        archive = self.base / "source.zip"
        self.git(remote, "archive", "--format=zip", "-o", archive, old if old_zip else "HEAD")
        target.mkdir()
        with zipfile.ZipFile(archive) as source:
            source.extractall(target)
        if repair:
            self.action(target, remote, "repair-git")
        return remote, target

    def action(self, target, remote, action, *, check=True, extra=()):
        return self.run_command([
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BOOTSTRAP,
            f"--bootstrap-action={action}", f"--bootstrap-root={target}",
            f"--bootstrap-repository-url={remote}", "--bootstrap-assume-yes", *extra,
        ], cwd=ROOT, check=check)

    def assert_start_blocked(self, target, remote):
        result = self.action(target, remote, "run", check=False, extra=("--skip-git-setup", "--quiet"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("startup has stopped", result.stdout)

    @contextmanager
    def lock_file(self, path):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                     ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel.CreateFileW.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            yield
        finally:
            kernel.CloseHandle(handle)

    def test_old_zip_backup_user_data_and_pull(self):
        remote, target = self.prepare(repair=False, old_zip=True)
        preserved = {
            SETTINGS: "personal settings", ACCELERATE: "personal accelerate", "cache/user.bin": "cache",
            "huggingface/hub/version.txt": "local cache", "logs/user.log": "log",
            "venv/keep.txt": "venv", "models/keep.bin": "model", "output/keep.txt": "output",
        }
        for relative, content in {**preserved, "README.md": "edited source", "中文文件.txt": "edited unicode"}.items():
            self.write(target, relative, content)
        self.action(target, remote, "repair-git")
        self.assertEqual(self.git(target, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.strip(), "origin/main")
        self.assertEqual((target / "README.md").read_text(), "latest upstream\n")
        self.assertFalse((target / "obsolete.txt").exists())
        self.assertFalse((target / "models/remote-only.bin").exists())
        self.assertEqual((target / "models/.gitkeep").read_text(), "old model marker\n")
        for relative, content in preserved.items():
            self.assertEqual((target / relative).read_text(), content)
        backups = list((target / "bootstrap-backups").glob("*.zip"))
        self.assertEqual(len(backups), 1)
        with zipfile.ZipFile(backups[0]) as backup:
            self.assertEqual(backup.read("README.md"), b"edited source")
            self.assertTrue({"obsolete.txt", "中文文件.txt", "bootstrap-manifest.json"}.issubset(backup.namelist()))
        self.assertEqual(self.git(target, "config", "remote.origin.fetch").stdout.strip(), "+refs/heads/main:refs/remotes/origin/main")
        self.assertEqual(self.git(target, "config", "remote.origin.tagOpt").stdout.strip(), "--no-tags")
        self.publish(remote, {"after-repair.txt": "pull works\n"})
        self.git(target, "pull")
        self.assertTrue((target / "after-repair.txt").is_file())
        self.assertEqual(self.git(target, "tag").stdout.strip(), "")
        self.assertNotIn("origin/dev", self.git(target, "branch", "-r").stdout)


    def test_source_edits_and_staged_work_stop_update(self):
        remote, target = self.prepare()
        head = self.git(target, "rev-parse", "HEAD").stdout
        self.write(target, "README.md", "my source\n")
        result = self.action(target, remote, "update", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("modified locally", result.stdout)
        self.assertEqual((target / "README.md").read_text(), "my source\n")
        self.git(target, "checkout", "--", "README.md")
        self.write(target, SETTINGS, "staged settings\n")
        self.git(target, "add", "-f", SETTINGS)
        staged = self.git(target, "diff", "--cached").stdout
        self.assertNotEqual(self.action(target, remote, "update", check=False).returncode, 0)
        self.assertEqual(self.git(target, "diff", "--cached").stdout, staged)
        self.assertEqual(self.git(target, "rev-parse", "HEAD").stdout, head)


    def test_failed_settings_restore_keeps_zip_and_blocks_startup(self):
        remote, target = self.prepare()
        self.write(target, SETTINGS, "personal\n")
        self.publish(remote, remove=(SETTINGS,))
        with self.lock_file(target / SETTINGS):
            result = self.action(target, remote, "update", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("restoration did not finish", result.stdout)
            state = json.loads((target / UPDATE_MARKER).read_text(encoding="utf-8"))
            with zipfile.ZipFile(state["backup"]) as backup:
                self.assertEqual(backup.read(SETTINGS), b"personal\n")
            self.assert_start_blocked(target, remote)


if __name__ == "__main__":
    unittest.main()
