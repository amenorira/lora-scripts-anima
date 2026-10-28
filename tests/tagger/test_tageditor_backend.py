import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.server import app
from backend.tageditor.core import caption_revision, read_caption_snapshot
from backend.tageditor.repository import save_caption_transaction, restore_timeline_event
from backend.tageditor.sessions import DatasetSessionService
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
            self.assertEqual(caption.read_text(encoding="utf-8"), "external")


class TagEditorSessionTests(unittest.TestCase):
    def test_unsaved_caption_queries_are_request_scoped_and_preserve_raw_baselines(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            raw = "\ufeff  cat, dog\r\n"
            for index in range(35):
                image = root / f"img-{index:02}.png"
                image.touch()
                image.with_suffix(".txt").write_bytes(raw.encode("utf-8"))
            service = DatasetSessionService()
            session = service.create(temp_dir)
            paths = [item["path"] for item in session.images]
            overrides = {path: "\ufeff  new, blue, sky\r\n" for path in paths}
            overrides[paths[0]] = "\ufeff \r\n"
            overrides[str(root.parent / "outside.png")] = "new"
            client = TestClient(app)
            url = f"/api/tageditor/sessions/{session.id}/images"
            with patch("backend.tageditor.routes.dataset_sessions", service):
                baseline = client.get(url, params={"search": "new"}).json()["data"]
                self.assertEqual(baseline["total"], 0)
                self.assertEqual(client.get(url, params={"include_tags": "cat"}).json()["data"]["total"], 35)
                queries = dict(service.get(session.id).queries)
                for params, total in [
                    ({"search": "new"}, 34),
                    ({"search": "new,", "use_regex": True}, 34),
                    ({"include_tags": "new\x1fsky"}, 34),
                    ({"include_tags": "missing\x1fsky", "tag_logic": "OR"}, 34),
                    ({"exclude_tags": "blue"}, 1),
                    ({"quick_filter": "notag"}, 1),
                ]:
                    with self.subTest(params=params):
                        result = client.post(url, params={**params, "page_size": 30, "group_by_dir": True}, json=overrides).json()
                        self.assertEqual(result["status"], "success")
                        self.assertEqual(result["data"]["total"], total)
                        self.assertEqual(result["data"]["directory_counts"], {"": total})
                        self.assertEqual(result["data"]["revision"], session.revision)
                second = client.post(url, params={"search": "new", "page_size": 30, "page": 2}, json=overrides).json()["data"]
                self.assertEqual(len(second["items"]), 4)
                sorted_page = client.post(url, params={"sort_by": "tagCount"}, json=overrides).json()["data"]
                self.assertEqual(sorted_page["items"][0]["tags"], "\ufeff \r\n")
                self.assertEqual(dict(service.get(session.id).queries), queries)
                self.assertEqual(client.get(url, params={"search": "new"}).json()["data"]["total"], 0)
                self.assertEqual(client.post(url, params={"search": "[", "use_regex": True}, json=overrides).json()["status"], "error")
                self.assertEqual(client.post(url, json={paths[0]: {"bad": "value"}}).status_code, 422)
                client.delete(f"/api/tageditor/sessions/{session.id}")
                self.assertEqual(client.post(url, json=overrides).json()["code"], "session_expired")
            self.assertTrue(all(item["tags"] == raw for item in session.images))
            self.assertEqual((root / "img-00.txt").read_bytes(), raw.encode("utf-8"))


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
