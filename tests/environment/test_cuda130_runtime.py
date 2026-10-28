import sys
import unittest
from unittest.mock import patch

from backend import launch_utils


class RuntimeRepairRegressionTests(unittest.TestCase):
    def test_platform_requirements_are_checked_as_complete_pep508_specs(self):
        for requirement, installed, expected in (
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', "3.7.1.post27", True),
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', None, False),
            ('triton-windows>=3.7.1,<3.8; sys_platform == "win32"', "3.6.0", False),
            ('triton==3.7.1; sys_platform == "linux"', None, True),
        ):
            with self.subTest(requirement=requirement, installed=installed), \
                 patch.object(sys, "platform", "win32"), \
                 patch.object(launch_utils, "_PKG_VERSION_CACHE", {}), \
                 patch.object(launch_utils, "_installed_version", return_value=installed) as lookup:
                self.assertEqual(launch_utils.is_installed(requirement), expected)
                if '"linux"' in requirement:
                    lookup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
