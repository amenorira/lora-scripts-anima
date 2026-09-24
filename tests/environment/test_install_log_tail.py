import tempfile
import unittest
from pathlib import Path

from backend.server.routes.environment import _read_install_log_tail


class InstallLogTailTests(unittest.TestCase):
    def test_tail_preserves_lines_unicode_and_nonpositive_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "install.log"
            path.write_bytes("第一行\r\n第二行\r\n最后一行".encode("utf-8"))
            self.assertEqual(_read_install_log_tail(str(path), 1), "最后一行")
            self.assertEqual(_read_install_log_tail(str(path), 2), "第二行\r\n最后一行")
            self.assertEqual(_read_install_log_tail(str(path), 0), "第一行\n第二行\n最后一行")
            self.assertEqual(_read_install_log_tail(str(path), -1), "第二行\n最后一行")

    def test_large_single_line_is_bounded_and_marked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "install.log"
            path.write_bytes(b"x" * (600 * 1024))
            tail = _read_install_log_tail(str(path), 20)
            self.assertIn("truncated", tail)
            self.assertLess(len(tail), 513 * 1024)
