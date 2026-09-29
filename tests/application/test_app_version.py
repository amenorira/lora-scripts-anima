import subprocess
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from packaging.version import Version

from backend import launch_utils
from tools.dev.generate_version import format_version


class AppVersionTests(unittest.TestCase):
    def test_real_git_tags_describe_and_compare_range(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(
                    ["git", "-C", directory, *args], stderr=subprocess.PIPE, encoding="utf-8"
                ).strip()

            def commit(message):
                git("-c", "user.name=Version Test", "-c", "user.email=version@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message,
                    "-m", "- 验证临时仓库的版本兼容性")

            git("init")
            commit("test: 创建旧版测试提交")
            git("tag", "v2.20.5")
            commit("test: 创建日历版本提交")
            git("tag", "v26.925.80307")
            with patch.object(launch_utils, "_GIT_TAG_CACHE", {}):
                self.assertEqual(launch_utils.app_version(root), "v26.925.80307")
            self.assertEqual(git("rev-list", "--count", "v2.20.5...v26.925.80307"), "1")
            commit("test: 创建后续开发提交")
            with patch.object(launch_utils, "_GIT_TAG_CACHE", {}):
                self.assertRegex(launch_utils.app_version(root), r"^v26\.925\.80307-1-g[0-9a-f]+$")

    def test_calver_timezone_boundaries_and_numeric_order(self):
        cases = [
            ("2026-09-25T08:03:07", "26.925.80307"),
            ("2026-09-25T00:03:07+00:00", "26.925.80307"),
            ("2026-12-31T16:00:00+00:00", "27.101.0"),
            ("2026-01-01T00:00:01+08:00", "26.101.1"),
        ]
        for when, expected in cases:
            with self.subTest(when=when):
                actual = format_version(datetime.fromisoformat(when))
                self.assertEqual(actual, expected)
                self.assertEqual(Version("v" + actual).release, tuple(map(int, actual.split("."))))
        versions = ["2.20.5", "26.925.95959", "26.925.100000", "26.1001.0", "27.101.0"]
        self.assertEqual(sorted(versions, key=Version), versions)
