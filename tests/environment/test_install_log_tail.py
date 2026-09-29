import tempfile
import unittest
from pathlib import Path

from backend.server.routes.environment import _read_install_log_tail


class InstallLogTailTests(unittest.TestCase):
    def test_large_single_line_is_bounded_and_marked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "install.log"
            path.write_bytes(b"x" * (600 * 1024))
            tail = _read_install_log_tail(str(path), 20)
            self.assertIn("truncated", tail)
            self.assertLess(len(tail), 513 * 1024)
