import tempfile
import unittest
from pathlib import Path


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
