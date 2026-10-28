import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import launch_utils


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
            tags = ["v2.20.5", "v26.925.80307", "v26.1017.223010", "v26.1017.13c72",
                    "v26.1018.00001", "v26.1018.0000a"]
            for index, tag in enumerate(tags):
                commit("test: 创建版本兼容性测试提交")
                git("tag", tag)
                with patch.object(launch_utils, "_GIT_TAG_CACHE", {}):
                    self.assertEqual(launch_utils.app_version(root), tag)
                # 更新先后由提交关系决定，不依赖混合格式 tag 的数值或字典序。
                self.assertEqual(git("rev-list", "--count", f"{tags[0]}...{tag}"), str(index))
                self.assertEqual(git("merge-base", tags[0], tag), git("rev-parse", tags[0]))
            commit("test: 创建后续开发提交")
            with patch.object(launch_utils, "_GIT_TAG_CACHE", {}):
                self.assertRegex(launch_utils.app_version(root), r"^v26\.1018\.0000a-1-g[0-9a-f]+$")
