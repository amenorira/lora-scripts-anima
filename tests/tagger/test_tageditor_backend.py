import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.server import app
from backend.tageditor.core import caption_revision, get_cached_scan_dataset, read_caption_snapshot
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

    def test_failed_transaction_restores_raw_bytes_and_invalid_utf8_is_not_overwritten(self):
        from backend.tageditor.core import write_tags
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            images = [root / "a.png", root / "b.png"]
            for image in images:
                image.touch()
            caption = images[0].with_suffix(".txt")
            original = b"\xef\xbb\xbf  first\r\n\r\nlast  \r\n"
            caption.write_bytes(original)
            result = save_caption_transaction(root, [{"path": str(image), "tags": "new"} for image in images],
                writer=lambda path, text: write_tags(path, text) if path == caption else False)
            self.assertTrue(result["rolled_back"])
            self.assertEqual(caption.read_bytes(), original)
            caption.write_bytes(b"invalid\xff")
            result = save_caption_transaction(root, [{"path": str(images[0]), "tags": "new"}])
            self.assertTrue(result["aborted"])
            self.assertEqual(caption.read_bytes(), b"invalid\xff")

    def test_snapshot_detects_in_place_changes_during_read(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp_dir:
            caption = Path(temp_dir) / "a.txt"
            caption.write_text("old", encoding="utf-8")
            with patch("backend.tageditor.core.os.fstat", side_effect=[
                SimpleNamespace(st_mtime_ns=1, st_size=3),
                SimpleNamespace(st_mtime_ns=2, st_size=3),
            ]):
                with self.assertRaisesRegex(OSError, "changed while reading"):
                    read_caption_snapshot(caption)

    def test_unreadable_caption_aborts_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            image.touch()
            caption = image.with_suffix(".txt")
            caption.write_text("original", encoding="utf-8")
            with patch("backend.tageditor.repository.read_caption_snapshot", side_effect=PermissionError("denied")):
                result = save_caption_transaction(root, [{"path": str(image), "tags": "new"}])
            self.assertTrue(result["aborted"])
            self.assertIn("denied", result["failed"][0]["reason"])
            self.assertEqual(caption.read_text(encoding="utf-8"), "original")

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
            overrides = {path: "new, blue, sky" for path in paths}
            overrides[paths[0]] = ""
            overrides[str(root.parent / "outside.png")] = "new"
            client = TestClient(app)
            url = f"/api/tageditor/sessions/{session.id}/images"
            with patch("backend.tageditor.routes.dataset_sessions", service):
                baseline = client.get(url, params={"search": "new"}).json()["data"]
                self.assertEqual(baseline["total"], 0)
                queries = dict(service.get(session.id).queries)
                for params, total in [
                    ({"search": "new"}, 34),
                    ({"search": "^new,", "use_regex": True}, 34),
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
                self.assertEqual(sorted_page["items"][0]["tags"], "")
                self.assertEqual(dict(service.get(session.id).queries), queries)
                self.assertEqual(client.get(url, params={"search": "new"}).json()["data"]["total"], 0)
                self.assertEqual(client.post(url, params={"search": "[", "use_regex": True}, json=overrides).json()["status"], "error")
                self.assertEqual(client.post(url, json={paths[0]: {"bad": "value"}}).status_code, 422)
                client.delete(f"/api/tageditor/sessions/{session.id}")
                self.assertEqual(client.post(url, json=overrides).json()["code"], "session_expired")
            self.assertTrue(all(item["tags"] == raw for item in session.images))
            self.assertEqual((root / "img-00.txt").read_bytes(), raw.encode("utf-8"))

    def test_refresh_cannot_resurrect_deleted_session(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            service = DatasetSessionService()
            session = service.create(temp_dir)

            def scan(*args):
                service.delete(session.id)
                return [], []

            with patch("backend.tageditor.sessions.get_cached_scan_dataset", side_effect=scan):
                with self.assertRaises(KeyError):
                    service.refresh(session.id)
            with self.assertRaises(KeyError):
                service.get(session.id)


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
            first_item = created["data"]["items"][0]
            self.assertIn("/api/image-preview?", first_item["thumbnail"])
            self.assertIn("scope=dataset", first_item["thumbnail"])
            self.assertIn(f"session_id={session_id}", first_item["thumbnail"])
            self.assertIn("variant=preview", first_item["preview"])

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
