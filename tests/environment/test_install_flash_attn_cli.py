import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from tools import install_flash_attn as cli


class FlashAttentionCLITests(unittest.TestCase):
    def test_help_and_unknown_options_exit_before_install(self):
        with patch.object(cli.flash_attention, "install") as install:
            for args, code in [(["--help"], 0), (["--source", "direct"], 2)]:
                with self.subTest(args=args), patch.object(sys, "argv", ["installer", *args]), \
                     redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as exit_status:
                        cli.main()
                    self.assertEqual(exit_status.exception.code, code)
            install.assert_not_called()

    def test_no_arguments_starts_install(self):
        with patch.object(sys, "argv", ["installer"]), patch.object(cli.flash_attention, "install") as install:
            self.assertEqual(cli.main(), 0)
            install.assert_called_once()
