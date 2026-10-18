import ctypes
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).parents[2]
BOOTSTRAP = ROOT / "tools/bootstrap_windows.ps1"
UPDATER_FILES = ("update.bat", "tools/bootstrap_windows.ps1", "tools/bootstrap_messages.json")
SETTINGS = "config/sample_prompts.txt"
ACCELERATE = "huggingface/accelerate/default_config.yaml"
UPDATE_MARKER = ".anima_tmp/git-update-incomplete.json"
REPAIR_MARKER = ".anima_tmp/git-repair-incomplete.json"


@unittest.skipUnless(os.name == "nt", "Windows bootstrap integration tests")
class WindowsBootstrapIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="anima bootstrap ")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

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

    def prepare(self, *, repair=True, old_zip=False, updater=False):
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
        if updater:
            for relative in UPDATER_FILES:
                path = remote / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / relative).read_bytes())
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

    def test_existing_corrupt_and_fetch_failure_do_not_replace_files(self):
        remote, target = self.prepare()
        head = self.git(target, "rev-parse", "HEAD").stdout
        result = self.action(target, self.base / "foreign", "repair-git")
        self.assertIn("origin could not be confirmed", result.stdout)
        self.assertEqual(self.git(target, "rev-parse", "HEAD").stdout, head)
        for corrupt in (False, True):
            root = self.base / str(corrupt)
            self.write(root, "start.bat", "@echo off\n")
            self.write(root, "backend/gui.py", "original\n")
            if corrupt:
                self.write(root, ".git/junk", "keep")
            result = self.action(root, self.base / "missing", "repair-git", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / "backend/gui.py").read_text(), "original\n")
            self.assertFalse((root / REPAIR_MARKER).exists())
            if corrupt:
                self.assertEqual((root / ".git/junk").read_text(), "keep")
            else:
                self.assertFalse((root / ".git").exists())

    def test_settings_migrate_once_then_normal_updates_and_pull_work(self):
        remote, target = self.prepare()
        personal = b"personal settings\r\n\x00"
        for relative in (SETTINGS, ACCELERATE):
            (target / relative).write_bytes(personal)
        (target / "huggingface/hub/version.txt").unlink()
        self.publish(remote, {"README.md": "migrated\n"}, remove=(SETTINGS, ACCELERATE, "huggingface/hub/version.txt"))
        self.action(target, remote, "update")
        for relative in (SETTINGS, ACCELERATE):
            self.assertEqual((target / relative).read_bytes(), personal)
        self.assertFalse((target / "huggingface/hub/version.txt").exists())
        self.assertEqual(self.git(target, "ls-files", SETTINGS).stdout.strip(), "")
        self.assertFalse((target / UPDATE_MARKER).exists())
        backups = list((target / "bootstrap-backups").glob("user-settings-*.zip"))
        self.assertEqual(len(backups), 1)
        self.publish(remote, {"README.md": "normal update\n"})
        self.action(target, remote, "update")
        self.assertEqual(list((target / "bootstrap-backups").glob("user-settings-*.zip")), backups)
        self.publish(remote, {"README.md": "pull update\n"})
        self.git(target, "pull")
        for relative in (SETTINGS, ACCELERATE):
            self.assertEqual((target / relative).read_bytes(), personal)
        self.assertEqual((target / "README.md").read_text(), "pull update\n")

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

    def test_failed_merge_restores_migrating_settings(self):
        remote, target = self.prepare()
        self.write(target, SETTINGS, "personal\n")
        self.write(target, "new-source.txt", "untracked personal file\n")
        head = self.git(target, "rev-parse", "HEAD").stdout
        self.publish(remote, {"new-source.txt": "upstream\n"}, remove=(SETTINGS,))
        self.assertNotEqual(self.action(target, remote, "update", check=False).returncode, 0)
        self.assertEqual((target / SETTINGS).read_text(), "personal\n")
        self.assertEqual((target / "new-source.txt").read_text(), "untracked personal file\n")
        self.assertEqual(self.git(target, "rev-parse", "HEAD").stdout, head)
        self.assertFalse((target / UPDATE_MARKER).exists())

    def test_interrupted_repair_blocks_startup_and_can_retry(self):
        remote, target = self.prepare(repair=False, old_zip=True)
        with self.lock_file(target / "obsolete.txt"):
            self.assertNotEqual(self.action(target, remote, "repair-git", check=False).returncode, 0)
            self.assertTrue((target / REPAIR_MARKER).is_file())
            self.assert_start_blocked(target, remote)
        self.action(target, remote, "repair-git")
        self.assertFalse((target / REPAIR_MARKER).exists())
        self.assertFalse((target / "obsolete.txt").exists())

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

    def test_divergent_and_foreign_repositories_stop_update(self):
        remote, target = self.prepare()
        self.git(target, "config", "user.name", "Bootstrap Test")
        self.git(target, "config", "user.email", "bootstrap@example.invalid")
        self.publish(target, {"local.txt": "local\n"})
        self.publish(remote, {"remote.txt": "remote\n"})
        head = self.git(target, "rev-parse", "HEAD").stdout
        result = self.action(target, remote, "update", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fast-forward", result.stdout)
        self.assertNotEqual(self.action(target, self.base / "foreign", "update", check=False).returncode, 0)
        self.assertEqual(self.git(target, "rev-parse", "HEAD").stdout, head)
        self.assertEqual(self.git(target, "remote", "get-url", "origin").stdout.strip(), str(remote))

    def test_shallow_clone_can_pull_switch_main_dev_and_update_each_branch(self):
        remote, _ = self.prepare(repair=False)
        target = self.base / "clone"
        self.run_command(["git", "clone", "--depth", "1", "--single-branch", "--branch", "main", "--no-tags", remote.as_uri(), target])
        self.assertEqual(self.git(target, "rev-list", "--count", "HEAD").stdout.strip(), "1")
        for number in range(2):
            self.publish(remote, {"README.md": f"main {number}\n"})
            self.git(target, "pull")
            self.assertEqual((target / "README.md").read_text(), f"main {number}\n")
        self.git(target, "config", "--add", "remote.origin.fetch", "+refs/heads/dev:refs/remotes/origin/dev")
        self.git(target, "fetch", "--no-tags", "origin")
        self.git(target, "switch", "--track", "origin/dev")
        self.git(remote, "switch", "dev")
        self.publish(remote, {"dev.txt": "updated dev\n"})
        self.action(target, remote.as_uri(), "update")
        self.assertEqual((target / "dev.txt").read_text(), "updated dev\n")
        self.git(target, "switch", "main")
        self.git(remote, "switch", "main")
        self.publish(remote, {"README.md": "updated main\n"})
        self.action(target, remote.as_uri(), "update")
        self.assertEqual((target / "README.md").read_text(), "updated main\n")
        self.git(target, "switch", "dev")
        self.assertEqual((target / "dev.txt").read_text(), "updated dev\n")
        self.assertEqual(self.git(target, "tag").stdout.strip(), "")

    def test_update_accepts_old_and_hexadecimal_versions(self):
        remote, target = self.prepare()
        for version in ("2.20.5", "26.1017.223010", "26.1017.13c72", "26.1018.00001"):
            with self.subTest(version=version):
                self.publish(remote, {"VERSION": version + "\n"})
                self.git(remote, "tag", "v" + version)
                self.action(target, remote, "update")
                self.assertEqual((target / "VERSION").read_text(), version + "\n")
                head = self.git(target, "rev-parse", "HEAD").stdout
                self.assertEqual(head, self.git(remote, "rev-parse", "HEAD").stdout)

    def test_batch_entry_and_external_zip_can_update_old_folder(self):
        remote, target = self.prepare(updater=True)
        self.publish(remote, {"README.md": "batch update\n"})
        command = ["cmd.exe", "/d", "/c", "call", target / "update.bat", f"--bootstrap-repository-url={remote}"]
        self.run_command(command, cwd=self.base)
        self.assertEqual((target / "README.md").read_text(), "batch update\n")
        self.publish(remote, {"tools/bootstrap_windows.ps1": "# old bootstrap\n", "tools/bootstrap_messages.json": "{}\n"}, remove=("update.bat",))
        self.git(target, "pull")
        self.assertFalse((target / "update.bat").exists())
        new_zip = self.base / "新 ZIP"
        for relative in UPDATER_FILES:
            path = new_zip / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((ROOT / relative).read_bytes())
        self.write(target, SETTINGS, "personal\n")
        self.publish(remote, {"README.md": "external update\n"}, remove=(SETTINGS,))
        command[4] = new_zip / "update.bat"
        self.run_command([*command, f"--bootstrap-root={target}"], cwd=self.base)
        self.assertEqual((target / SETTINGS).read_text(), "personal\n")
        self.assertEqual((target / "README.md").read_text(), "external update\n")


if __name__ == "__main__":
    unittest.main()
