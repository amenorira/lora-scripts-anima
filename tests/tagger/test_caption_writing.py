import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.utils import file_io as writing


class CaptionWritingTests(unittest.TestCase):


    def test_tag_editor_rejects_invalid_unicode_without_replacing_original(self):
        from backend.tageditor.core import restore_caption_state
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            original = "原文\r\n".encode("utf-8")
            output.write_bytes(original)
            with self.assertRaises(UnicodeEncodeError):
                restore_caption_state(output, True, "invalid \ud800")
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(list(output.parent.iterdir()), [output])


    def test_replace_failure_preserves_caption_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            output.write_text("original", encoding="utf-8")
            with patch.object(writing, "atomic_replace", side_effect=PermissionError("in use")):
                with self.assertRaises(PermissionError):
                    writing.atomic_write_text(output, "replacement")
            self.assertEqual(output.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(output.parent.glob(".*.tmp")), [])
