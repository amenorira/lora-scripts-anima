import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.utils import file_io as writing


class CaptionWritingTests(unittest.TestCase):
    def test_tag_editor_replaces_long_caption_filename(self):
        from backend.tageditor.core import restore_caption_state
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / ("a" * 220 + ".txt")
            output.write_text("original", encoding="utf-8")
            restore_caption_state(output, True, "replacement")
            self.assertEqual(output.read_text(encoding="utf-8"), "replacement")
            self.assertEqual(list(output.parent.iterdir()), [output])

    def test_tag_editor_preserves_unicode_and_line_endings(self):
        from backend.tageditor.core import restore_caption_state
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "nested" / "sample.txt"
            text = "标签\r\nline\n"
            restore_caption_state(output, True, text)
            self.assertEqual(output.read_bytes(), text.encode("utf-8"))

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

    def test_permission_denied_is_reported_after_one_creation_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            output.write_text("original", encoding="utf-8")
            with patch.object(Path, "open", side_effect=PermissionError("denied")) as create:
                with self.assertRaises(PermissionError):
                    writing.atomic_write_text(output, "replacement")
                self.assertEqual(create.call_count, 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(output.parent.glob(".*.tmp")), [])

    def test_collision_does_not_remove_someone_elses_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            collision = output.with_name(".collision.tmp")
            collision.write_text("someone else", encoding="utf-8")
            with patch.object(writing.uuid, "uuid4", return_value=SimpleNamespace(hex="collision")):
                with self.assertRaises(FileExistsError):
                    writing.atomic_write_text(output, "replacement")
            self.assertEqual(collision.read_text(encoding="utf-8"), "someone else")
            self.assertFalse(output.exists())

    def test_replace_failure_preserves_caption_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            output.write_text("original", encoding="utf-8")
            with patch.object(writing.os, "replace", side_effect=PermissionError("in use")):
                with self.assertRaises(PermissionError):
                    writing.atomic_write_text(output, "replacement")
            self.assertEqual(output.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(output.parent.glob(".*.tmp")), [])

    def test_cancel_before_replace_preserves_original_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "sample.txt"
            output.write_text("original", encoding="utf-8")
            cancelled = threading.Event()
            with patch.object(writing.os, "fsync", side_effect=lambda _fd: cancelled.set()):
                with self.assertRaises(InterruptedError):
                    writing.atomic_write_text(output, "replacement", cancel_event=cancelled)
            self.assertEqual(output.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(output.parent.glob(".*.tmp")), [])
