import asyncio
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.server import app
from backend.tageditor.core import caption_revision, get_cached_scan_dataset
from backend.tageditor.repository import save_caption_transaction, restore_timeline_event
from backend.tageditor.sessions import DatasetSessionService
from backend.tageditor.snapshots import create_snapshot, restore_snapshot
from backend.tageditor.timeline import TimelineStore


class TagEditorTransactionTests(unittest.TestCase):
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

    def test_txt_priority_is_explicit_and_conflict_blocks_save(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            image.touch()
            image.with_suffix(".txt").write_text("from txt", encoding="utf-8")
            image.with_suffix(".caption").write_text("from caption", encoding="utf-8")

            images, _ = get_cached_scan_dataset(root)
            self.assertEqual(images[0]["tags"], "from txt")
            self.assertTrue(images[0]["caption_conflict"])

            result = save_caption_transaction(root, [{"path": str(image), "tags": "new"}])
            self.assertEqual(result["saved"], 0)
            self.assertIn("同时存在", result["failed"][0]["reason"])


class TagEditorSessionTests(unittest.TestCase):
    def test_session_pages_filters_and_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(65):
                image = root / f"img-{index:03}.png"
                image.touch()
                if index % 2 == 0:
                    image.with_suffix(".txt").write_text("cat, even", encoding="utf-8")

            service = DatasetSessionService(max_sessions=2, ttl_seconds=60)
            session = service.create(str(root), True)
            first = service.page(session.id, page=1, page_size=30)
            third = service.page(session.id, page=3, page_size=30)
            cats = service.page(session.id, page=1, page_size=30, include_tags=("cat",))
            no_tags = service.page(session.id, page=1, page_size=30, quick_filter="notag")

            self.assertEqual(first["total"], 65)
            self.assertEqual(len(first["items"]), 30)
            self.assertEqual(len(third["items"]), 5)
            self.assertEqual(cats["total"], 33)
            self.assertEqual(no_tags["total"], 32)
            refreshed = service.refresh(session.id)
            self.assertEqual(refreshed.generation, 2)
            self.assertTrue(service.delete(session.id))
            with self.assertRaises(KeyError):
                service.get(session.id)

    def test_session_sorts_by_filesystem_modified_time(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            images = [
                {"path": str(root / "new.png"), "rel_path": "new.png", "modified_ns": 30, "tags": ""},
                {"path": str(root / "old.png"), "rel_path": "old.png", "modified_ns": 10, "tags": ""},
                {"path": str(root / "mid.png"), "rel_path": "mid.png", "modified_ns": 20, "tags": ""},
            ]
            service = DatasetSessionService()
            with patch("backend.tageditor.sessions.get_cached_scan_dataset", return_value=(images, [])):
                session = service.create(str(root), True)

            ascending = service.page(session.id, sort_by="modified", sort_asc=True)
            descending = service.page(session.id, sort_by="modified", sort_asc=False)
            self.assertEqual([item["rel_path"] for item in ascending["items"]], ["old.png", "mid.png", "new.png"])
            self.assertEqual([item["rel_path"] for item in descending["items"]], ["new.png", "mid.png", "old.png"])

    def test_session_http_contract(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(35):
                (root / f"img-{index:02}.png").touch()
            client = TestClient(app)

            created = client.post("/api/tageditor/sessions", json={
                "dir": str(root), "recursive": True, "page_size": 30,
            }).json()
            self.assertEqual(created["status"], "success")
            self.assertEqual(created["data"]["count"], 35)
            self.assertEqual(len(created["data"]["items"]), 30)
            session_id = created["data"]["session_id"]

            second = client.get(f"/api/tageditor/sessions/{session_id}/images", params={
                "page": 2, "page_size": 30,
            }).json()
            self.assertEqual(second["status"], "success")
            self.assertEqual(len(second["data"]["items"]), 5)
            self.assertTrue(client.delete(f"/api/tageditor/sessions/{session_id}").json()["data"]["closed"])
            self.assertEqual(
                client.get(f"/api/tageditor/sessions/{session_id}/images").json()["status"],
                "error",
            )


class TagEditorTimelineTests(unittest.TestCase):
    def test_timeline_round_trip_and_restore(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            caption = root / "a.txt"
            image.touch()
            caption.write_text("old", encoding="utf-8")
            store = TimelineStore(root / "timeline.sqlite3")

            with patch("backend.tageditor.repository.timeline_store", store):
                saved = save_caption_transaction(root, [{"path": str(image), "tags": "new"}])
                event_id = saved["timeline_event"]["id"]
                self.assertEqual(store.list(root)[0]["file_count"], 1)
                restored = restore_timeline_event(root, event_id)

            self.assertEqual(restored["restored"], 1)
            self.assertEqual(caption.read_text(encoding="utf-8"), "old")
            events = store.list(root)
            self.assertEqual(events[0]["event_type"], "restore")
            self.assertEqual(events[0]["metadata"]["source_event_id"], event_id)

    def test_timeline_restore_rejects_external_modification(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            caption = root / "a.txt"
            image.touch()
            caption.write_text("old", encoding="utf-8")
            store = TimelineStore(root / "timeline.sqlite3")

            with patch("backend.tageditor.repository.timeline_store", store):
                saved = save_caption_transaction(root, [{"path": str(image), "tags": "new"}])
                caption.write_text("external", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "时间线恢复冲突"):
                    restore_timeline_event(root, saved["timeline_event"]["id"])

            self.assertEqual(caption.read_text(encoding="utf-8"), "external")
            self.assertEqual([event["event_type"] for event in store.list(root)], ["save"])


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

    def test_snapshot_rejects_symlink_members(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snap_dir = root / ".snapshots"
            snap_dir.mkdir()
            snapshot_id = "symlink"
            with zipfile.ZipFile(snap_dir / f"{snapshot_id}.zip", "w") as archive:
                member = zipfile.ZipInfo("link.txt")
                member.create_system = 3
                member.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(member, "outside.txt")

            with self.assertRaisesRegex(ValueError, "符号链接"):
                restore_snapshot(str(root), snapshot_id)

    def test_snapshot_restore_rolls_back_exact_text_on_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = root / "a.txt"
            second = root / "b.txt"
            first.write_text("  original a\n\n", encoding="utf-8")
            second.write_text("original b", encoding="utf-8")
            snapshot = create_snapshot(str(root))
            first.write_text("changed a", encoding="utf-8")
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

            self.assertEqual(first.read_text(encoding="utf-8"), "changed a")
            self.assertEqual(second.read_text(encoding="utf-8"), "changed b")


class TagEditorFrontendRefactorContracts(unittest.TestCase):
    def test_session_timeline_and_shortcut_contracts_are_wired(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("fetch('/api/tageditor/sessions'", source)
        self.assertIn("tagEditorPageItems", source)
        self.assertIn("AbortController", source)
        self.assertIn("edit_version", source)
        self.assertIn("expected_revision", source)
        self.assertIn("e.isComposing || e.keyCode === 229", source)
        self.assertIn("tagEditorFetchPage(tagEditorPage + 1)", html)
        self.assertIn("snap.label || snap.event_type", html)
        self.assertNotIn("_teFormatSize(snap.size_bytes)", html)


if __name__ == "__main__":
    unittest.main()
