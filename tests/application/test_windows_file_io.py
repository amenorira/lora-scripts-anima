"""Real Windows handle tests: readers retain old bytes while writers publish new ones."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.utils import file_io


@unittest.skipUnless(os.name == "nt", "Windows handle semantics")
class WindowsAtomicIOTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        source, target = self.root / "probe.tmp", self.root / "probe.txt"
        source.write_bytes(b"probe")
        if not file_io._windows.try_atomic_replace(source, target):
            self.skipTest("Filesystem does not support FileRenameInfoEx")

    def test_open_reader_keeps_old_bytes_and_new_readers_see_replacement_without_retry(self):
        target = self.root / ("a" * 210 + "标签😀.txt")
        target.write_bytes(b"old version")
        with file_io.open_read(target) as reader:
            with patch.object(file_io.time, "sleep") as sleep:
                file_io.atomic_write_text(target, "new version")
            sleep.assert_not_called()
            self.assertEqual(reader.read(), b"old version")
            self.assertEqual(file_io.read_text(target), "new version")


    def test_embedded_null_cannot_truncate_a_source_or_target_path(self):
        source, target = self.root / "source.tmp", self.root / "caption.txt"
        source.write_bytes(b"replacement")
        target.write_bytes(b"original")
        for before, after in ((Path(str(source) + "\0suffix"), target), (source, Path(str(target) + "\0suffix"))):
            with self.subTest(source=before, target=after), self.assertRaises(ValueError):
                file_io.atomic_replace(before, after)
            self.assertEqual(file_io.read_bytes(source), b"replacement")
            self.assertEqual(file_io.read_bytes(target), b"original")
