import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).parents[1]
BOOTSTRAP = ROOT / "tools" / "bootstrap_windows.ps1"


@unittest.skipUnless(os.name == "nt", "Windows bootstrap integration tests")
class WindowsBootstrapIntegrationTests(unittest.TestCase):
    maxDiff = None

    def run_command(self, args, cwd=None, check=True):
        result = subprocess.run(
            [str(arg) for arg in args],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if check and result.returncode != 0:
            self.fail(f"command failed ({result.returncode}): {args}\n{result.stdout}")
        return result

    def git(self, cwd, *args, check=True):
        return self.run_command(["git", *args], cwd=cwd, check=check)

    def write(self, root, relative, content):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def create_remote_history(self, base):
        remote = base / "远端 source repo"
        remote.mkdir(parents=True)
        self.git(remote, "init", "-b", "main")
        self.git(remote, "config", "user.name", "Bootstrap Test")
        self.git(remote, "config", "user.email", "bootstrap@example.invalid")
        self.write(
            remote,
            ".gitignore",
            "venv/\nmodels/\noutput/\nconfig/\n.anima_tmp/\nbootstrap-backups/\n",
        )
        self.write(remote, "start.bat", "@echo off\n")
        self.write(remote, "backend/gui.py", "print('old')\n")
        self.write(remote, "README.md", "old upstream\n")
        self.write(remote, "中文文件.txt", "old unicode file\n")
        self.write(remote, "obsolete.txt", "old tracked file\n")
        protected_tracked = {
            "cache/.keep": "old cache marker\n",
            "config/user.toml": "old upstream config\n",
            "huggingface/cache/version.txt": "old hf cache marker\n",
            "logs/.keep": "old log marker\n",
            "models/.gitkeep": "old model marker\n",
            "output/.keep": "old output marker\n",
        }
        for relative, content in protected_tracked.items():
            self.write(remote, relative, content)
        self.git(remote, "add", ".")
        self.git(remote, "add", "-f", *protected_tracked)
        self.git(remote, "commit", "-m", "initial")
        old_commit = self.git(remote, "rev-parse", "HEAD").stdout.strip()

        self.write(remote, "backend/gui.py", "print('latest')\n")
        self.write(remote, "README.md", "latest upstream\n")
        self.write(remote, "中文文件.txt", "latest unicode file\n")
        (remote / "obsolete.txt").unlink()
        self.write(remote, "latest.txt", "latest file\n")
        self.write(remote, "config/user.toml", "latest upstream config\n")
        self.write(remote, "models/.gitkeep", "latest model marker\n")
        self.write(remote, "models/remote-only.bin", "must not enter user models\n")
        self.git(remote, "add", "-A")
        self.git(remote, "add", "-f", "models/remote-only.bin")
        self.git(remote, "commit", "-m", "latest")
        return remote, old_commit

    def extract_old_zip(self, remote, old_commit, target, archive):
        self.git(remote, "archive", "--format=zip", "-o", archive, old_commit)
        target.mkdir(parents=True)
        with zipfile.ZipFile(archive) as source_zip:
            source_zip.extractall(target)

    def run_repair(self, target, remote_url):
        return self.run_command(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                BOOTSTRAP,
                "--bootstrap-action=repair-git",
                f"--bootstrap-root={target}",
                f"--bootstrap-repository-url={remote_url}",
                "--bootstrap-assume-yes",
            ],
            cwd=ROOT,
        )

    def test_old_zip_is_backed_up_aligned_and_can_pull(self):
        with tempfile.TemporaryDirectory(prefix="anima bootstrap ") as temp:
            base = Path(temp)
            remote, old_commit = self.create_remote_history(base)
            target = base / "下载目录 含空格"
            archive = base / "old.zip"
            self.extract_old_zip(remote, old_commit, target, archive)

            self.write(target, "README.md", "local customized source\n")
            self.write(target, "中文文件.txt", "local unicode customization\n")
            preserved = {
                "cache/user.bin": "cache data",
                "config/user.toml": "local user config",
                "huggingface/cache/version.txt": "local hf cache data",
                "logs/user.log": "log data",
                "venv/keep.txt": "venv data",
                "models/keep.bin": "model data",
                "output/keep.txt": "output data",
            }
            for relative, content in preserved.items():
                self.write(target, relative, content)

            local_source_bytes = (target / "README.md").read_bytes()
            result = self.run_repair(target, remote)
            self.assertIn("Repository repair complete", result.stdout)
            self.assertTrue((target / ".git").is_dir())
            self.assertEqual(self.git(target, "branch", "--show-current").stdout.strip(), "main")
            self.assertEqual(
                self.git(target, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.strip(),
                "origin/main",
            )
            self.assertEqual((target / "README.md").read_text(encoding="utf-8"), "latest upstream\n")
            self.assertFalse((target / "obsolete.txt").exists())
            self.assertTrue((target / "latest.txt").is_file())
            self.assertEqual(
                (target / "models/.gitkeep").read_text(encoding="utf-8"),
                "old model marker\n",
            )
            self.assertFalse((target / "models/remote-only.bin").exists())
            for relative, content in preserved.items():
                self.assertEqual((target / relative).read_text(encoding="utf-8"), content)

            backups = list((target / "bootstrap-backups").glob("*.zip"))
            self.assertEqual(len(backups), 1)
            with zipfile.ZipFile(backups[0]) as backup_zip:
                names = set(backup_zip.namelist())
                self.assertIn("README.md", names)
                self.assertIn("中文文件.txt", names)
                self.assertIn("obsolete.txt", names)
                self.assertIn("bootstrap-manifest.json", names)
                self.assertEqual(backup_zip.read("README.md"), local_source_bytes)

            status = self.git(target, "status", "--porcelain").stdout.splitlines()
            self.assertTrue(any(line.endswith(" config/user.toml") for line in status), status)
            self.assertTrue(any(line.endswith(" models/.gitkeep") for line in status), status)
            self.assertTrue(any(line.endswith(" models/remote-only.bin") for line in status), status)

            self.write(remote, "after-repair.txt", "pull works\n")
            self.git(remote, "add", "after-repair.txt")
            self.git(remote, "commit", "-m", "after repair")
            self.git(target, "pull")
            self.assertTrue((target / "after-repair.txt").is_file())

    def test_existing_and_corrupt_git_entries_are_not_replaced(self):
        with tempfile.TemporaryDirectory(prefix="anima bootstrap state ") as temp:
            base = Path(temp)
            existing = base / "existing repo"
            existing.mkdir()
            self.write(existing, "start.bat", "@echo off\n")
            self.write(existing, "backend/gui.py", "print('existing')\n")
            self.git(existing, "init", "-b", "main")
            self.git(existing, "config", "user.name", "Bootstrap Test")
            self.git(existing, "config", "user.email", "bootstrap@example.invalid")
            self.git(existing, "add", ".")
            self.git(existing, "commit", "-m", "existing")
            before = self.git(existing, "rev-parse", "HEAD").stdout.strip()
            existing_result = self.run_repair(existing, base / "missing remote")
            self.assertIn("origin could not be confirmed", existing_result.stdout)
            self.assertEqual(self.git(existing, "rev-parse", "HEAD").stdout.strip(), before)

            corrupt = base / "corrupt zip"
            corrupt.mkdir()
            self.write(corrupt, "start.bat", "@echo off\n")
            self.write(corrupt, "backend/gui.py", "print('corrupt')\n")
            self.write(corrupt, ".git/junk", "do not delete\n")
            result = self.run_repair(corrupt, base / "missing remote")
            self.assertIn("not a valid repository", result.stdout)
            self.assertEqual((corrupt / ".git/junk").read_text(encoding="utf-8"), "do not delete\n")

    def test_fetch_failure_is_non_destructive(self):
        with tempfile.TemporaryDirectory(prefix="anima bootstrap failure ") as temp:
            target = Path(temp) / "zip source"
            target.mkdir()
            self.write(target, "start.bat", "@echo off\n")
            self.write(target, "backend/gui.py", "print('unchanged')\n")
            result = self.run_repair(target, Path(temp) / "remote does not exist")
            self.assertIn("Repository repair failed", result.stdout)
            self.assertFalse((target / ".git").exists())
            self.assertEqual(
                (target / "backend/gui.py").read_text(encoding="utf-8"),
                "print('unchanged')\n",
            )

    def test_normal_bootstrap_returns_restart_code_after_zip_repair(self):
        with tempfile.TemporaryDirectory(prefix="anima bootstrap restart ") as temp:
            base = Path(temp)
            remote, old_commit = self.create_remote_history(base)
            target = base / "zip source"
            self.extract_old_zip(remote, old_commit, target, base / "old.zip")

            result = self.run_command(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    BOOTSTRAP,
                    f"--bootstrap-root={target}",
                    f"--bootstrap-repository-url={remote}",
                    "--setup-git",
                    "--quiet",
                ],
                cwd=ROOT,
                check=False,
            )

            self.assertEqual(result.returncode, 23, result.stdout)
            self.assertTrue((target / ".git").is_dir())
            self.assertIn("restarting the latest bootstrap", result.stdout)


if __name__ == "__main__":
    unittest.main()
