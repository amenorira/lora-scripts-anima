import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from backend.tageditor.core import caption_revision, read_caption_snapshot
from backend.tageditor.repository import save_caption_transaction, restore_timeline_event
from backend.tageditor.snapshots import create_snapshot, restore_snapshot
from backend.tageditor.timeline import TimelineStore


class TagEditorTransactionTests(unittest.TestCase):
    def test_raw_text_round_trip_noop_and_timeline_restore(self):
        for extension in (".txt", ".caption"):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                image = root / "a.png"
                image.touch()
                caption = image.with_suffix(extension)
                original = "\ufeff  描述,  with spaces\r\n\r\n---===--- # long\n  尾段\r\n  "
                caption.write_bytes(original.encode("utf-8"))
                before_stat = caption.stat().st_mtime_ns
                text, revision, _ = read_caption_snapshot(caption)
                self.assertEqual(text, original)
                store = TimelineStore(root / "timeline.sqlite3")
                with patch("backend.tageditor.repository.timeline_store", store):
                    noop = save_caption_transaction(root, [{"path": str(image), "tags": text, "expected_revision": revision}])
                    self.assertEqual(noop["saved"], 0)
                    self.assertEqual(caption.stat().st_mtime_ns, before_stat)
                    edited = original.replace("尾段", "新尾段, with commas")
                    saved = save_caption_transaction(root, [{"path": str(image), "tags": edited, "expected_revision": revision}])
                    self.assertEqual(caption.read_bytes(), edited.encode("utf-8"))
                    changes = store.changes_for(saved["timeline_event"]["id"], root)
                    self.assertEqual(changes[0]["before_text"], original)
                    self.assertEqual(changes[0]["after_text"], edited)
                    restore_timeline_event(root, saved["timeline_event"]["id"])
                self.assertEqual(caption.read_bytes(), original.encode("utf-8"))

    def test_transaction_rolls_back_all_applied_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = root / "a.png"
            second = root / "b.png"
            first.touch()
            second.touch()
            first.with_suffix(".txt").write_text("old", encoding="utf-8")

            def writer(path, tags):
                if path == second.with_suffix(".txt"):
                    return False
                path.write_text(tags, encoding="utf-8")
                return True

            result = save_caption_transaction(root, [
                {"path": str(first), "tags": "new-a"},
                {"path": str(second), "tags": "new-b"},
            ], writer=writer)

            self.assertTrue(result["rolled_back"])
            self.assertEqual(result["saved"], 0)
            self.assertEqual(first.with_suffix(".txt").read_text(encoding="utf-8"), "old")
            self.assertFalse(second.with_suffix(".txt").exists())

    def test_revision_conflict_aborts_without_writing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            caption = root / "a.txt"
            image.touch()
            caption.write_text("old", encoding="utf-8")
            stale = caption_revision(caption)
            caption.write_text("external", encoding="utf-8")

            result = save_caption_transaction(root, [{
                "path": str(image), "tags": "draft", "expected_revision": stale,
            }])

            self.assertTrue(result["aborted"])
            self.assertEqual(result["saved"], 0)
            self.assertEqual(len(result["conflicts"]), 1)
            self.assertEqual(result["conflicts"][0]["error_code"], "tageditor_external_change")
            self.assertEqual(result["conflicts"][0]["path"], str(image.resolve()))
            self.assertEqual(caption.read_text(encoding="utf-8"), "external")


    def test_shared_caption_disagreeing_aliases_abort_before_any_write(self):
        for values in (("first", "second"), ("original", "edit"), ("edit", "original")):
            with self.subTest(values=values), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                images = [root / "same.png", root / "same.jpg", root / "other.png"]
                for image in images:
                    image.touch()
                caption = root / "same.txt"
                caption.write_text("original", encoding="utf-8")
                with patch("backend.tageditor.repository.timeline_store.record") as record:
                    result = save_caption_transaction(root, [
                        {"path": str(image), "tags": text} for image, text in zip(images, (*values, "other edit"))
                    ])
                self.assertTrue(result["aborted"])
                self.assertEqual(result["saved"], 0)
                self.assertEqual({item["path"] for item in result["conflicts"]}, {str(image) for image in images[:2]})
                self.assertEqual({item["error_code"] for item in result["conflicts"]}, {"tageditor_shared_caption_conflict"})
                self.assertEqual(caption.read_text(encoding="utf-8"), "original")
                self.assertFalse((root / "other.txt").exists())
                record.assert_not_called()


class TagEditorSnapshotCompatibilityTests(unittest.TestCase):
    def test_snapshot_restore_is_exact_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            original = root / "a.txt"
            original.write_text("old", encoding="utf-8")
            snapshot = create_snapshot(str(root))
            original.write_text("new", encoding="utf-8")
            added = root / "later.caption"
            added.write_text("later", encoding="utf-8")

            self.assertTrue(restore_snapshot(str(root), snapshot["id"]))
            self.assertEqual(original.read_text(encoding="utf-8"), "old")
            self.assertFalse(added.exists())

            malicious_id = "malicious"
            malicious_zip = root / ".snapshots" / f"{malicious_id}.zip"
            with zipfile.ZipFile(malicious_zip, "w") as archive:
                archive.writestr("../escape.txt", "bad")
            with self.assertRaisesRegex(ValueError, "越界"):
                restore_snapshot(str(root), malicious_id)
            self.assertFalse((root.parent / "escape.txt").exists())


    def test_snapshot_restore_rolls_back_exact_text_on_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = root / "a.txt"
            second = root / "b.txt"
            first.write_text("  original a\n\n", encoding="utf-8")
            second.write_text("original b", encoding="utf-8")
            snapshot = create_snapshot(str(root))
            raw_before = b"\xef\xbb\xbf  changed a\r\n\r\nlast  \n"
            first.write_bytes(raw_before)
            second.write_text("changed b", encoding="utf-8")

            from backend.tageditor import snapshots as snapshot_module
            real_restore = snapshot_module.restore_caption_state
            calls = 0

            def failing_restore(path, existed, text):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected failure")
                return real_restore(path, existed, text)

            with patch("backend.tageditor.snapshots.restore_caption_state", side_effect=failing_restore):
                with self.assertRaisesRegex(OSError, "injected failure"):
                    restore_snapshot(str(root), snapshot["id"])

            self.assertEqual(first.read_bytes(), raw_before)
            self.assertEqual(second.read_text(encoding="utf-8"), "changed b")


if __name__ == "__main__":
    unittest.main()
