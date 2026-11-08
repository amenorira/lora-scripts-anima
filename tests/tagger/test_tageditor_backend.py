import asyncio
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.server import app
from backend.tageditor.core import caption_revision, read_caption_snapshot, write_tags
from backend.tageditor.repository import save_caption_transaction, restore_timeline_event, restore_legacy_backups
from backend.tageditor.sessions import DatasetSessionService
from backend.tageditor.snapshots import create_snapshot, restore_snapshot
from backend.tageditor.timeline import TimelineStore


class TagEditorTransactionTests(unittest.TestCase):
    def test_distinct_caption_entries_are_written_even_if_resolve_maps_them_together(self):
        # Simulate final-symlink resolution without requiring Windows symlink privileges.
        # Real files and the production atomic writer verify both replacement entries.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            images = [root / "a.png", root / "b.png"]
            captions = {image.with_suffix(".txt") for image in images}
            for image in images:
                image.touch()
                image.with_suffix(".txt").write_text("original", encoding="utf-8")
            store = TimelineStore(root / "timeline.sqlite3")
            resolve = Path.resolve

            def shared_final_target(path, *args, **kwargs):
                if path in captions:
                    return root / "shared.txt"
                return resolve(path, *args, **kwargs)

            with patch.object(Path, "resolve", shared_final_target), patch(
                "backend.tageditor.repository.timeline_store", store
            ):
                result = save_caption_transaction(root, [
                    {"path": str(image), "tags": "edited"} for image in images
                ])
                changes = store.changes_for(result["timeline_event"]["id"], root)
            self.assertEqual(result["saved"], 2)
            self.assertEqual({item["rel_path"] for item in changes}, {"a.txt", "b.txt"})
            for caption in captions:
                self.assertEqual(caption.read_text(encoding="utf-8"), "edited")

    def test_shared_caption_writes_once_and_restores_one_history_change(self):
        for extension in (".txt", ".caption"):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                images = [root / "same.png", root / "same.jpg"]
                for image in images:
                    image.touch()
                caption = root / f"same{extension}"
                caption.write_text("original", encoding="utf-8")
                store = TimelineStore(root / "timeline.sqlite3")
                with patch("backend.tageditor.repository.timeline_store", store), patch(
                    "backend.tageditor.repository.write_tags", wraps=write_tags
                ) as writer:
                    result = save_caption_transaction(root, [
                        {"path": str(image), "tags": "shared edit"} for image in images
                    ], writer=writer)
                    self.assertEqual(writer.call_count, 1)
                    self.assertEqual(result["saved"], 2)
                    self.assertEqual(result["saved_paths"], [str(image) for image in images])
                    self.assertEqual(set(result["revisions"].values()), {caption_revision(caption)})
                    changes = store.changes_for(result["timeline_event"]["id"], root)
                    self.assertEqual(len(changes), 1)
                    restore_timeline_event(root, result["timeline_event"]["id"])
                self.assertEqual(caption.read_text(encoding="utf-8"), "original")

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

    def test_timeline_record_failure_rolls_back_restore_and_allows_retry(self):
        for original in ("\ufeff  original\r\n", None):
            with self.subTest(original=original), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                image = root / "a.png"
                image.touch()
                caption = root / "a.txt"
                if original is not None:
                    caption.write_bytes(original.encode("utf-8"))
                store = TimelineStore(root / "timeline.sqlite3")
                with patch("backend.tageditor.repository.timeline_store", store):
                    result = save_caption_transaction(root, [{"path": str(image), "tags": "edited"}])
                    event_id = result["timeline_event"]["id"]
                    with patch.object(store, "record", side_effect=OSError("database unavailable")):
                        with self.assertRaisesRegex(OSError, "database unavailable"):
                            restore_timeline_event(root, event_id)
                    self.assertEqual(caption.read_bytes(), b"edited")
                    self.assertEqual(len(store.list(root)), 1)
                    restore_timeline_event(root, event_id)
                if original is not None:
                    self.assertEqual(caption.read_bytes(), original.encode("utf-8"))
                else:
                    self.assertFalse(caption.exists())

    def test_restore_rollback_reports_failure_and_attempts_remaining_files(self):
        from backend.tageditor import repository
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            images = [root / "a.png", root / "b.png"]
            for image in images:
                image.touch()
                image.with_suffix(".txt").write_text("original", encoding="utf-8")
            store = TimelineStore(root / "timeline.sqlite3")
            restore = repository.restore_caption_state

            def fail_one_rollback(path, existed, text):
                if path.name == "a.txt" and text == "edited":
                    raise OSError("rollback denied")
                restore(path, existed, text)

            with patch.object(repository, "timeline_store", store):
                saved = save_caption_transaction(root, [{"path": str(image), "tags": "edited"} for image in images])
                with patch.object(store, "record", side_effect=OSError("database unavailable")), patch.object(
                    repository, "restore_caption_state", side_effect=fail_one_rollback
                ):
                    with self.assertRaisesRegex(RuntimeError, "a.txt"):
                        restore_timeline_event(root, saved["timeline_event"]["id"])
            self.assertEqual((root / "a.txt").read_text(encoding="utf-8"), "original")
            self.assertEqual((root / "b.txt").read_text(encoding="utf-8"), "edited")

    def test_legacy_record_failure_restores_existing_and_removes_new_caption(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            caption = root / "a.txt"
            before = b"\xef\xbb\xbf exact\r\n"
            caption.write_bytes(before)
            (root / "a.txt.bak").write_text("backup-a", encoding="utf-8")
            (root / "b.caption.bak").write_text("backup-b", encoding="utf-8")
            with patch("backend.tageditor.repository.timeline_store.record", side_effect=OSError("database unavailable")):
                with self.assertRaisesRegex(OSError, "database unavailable"):
                    restore_legacy_backups(root)
            self.assertEqual(caption.read_bytes(), before)
            self.assertFalse((root / "b.caption").exists())

    def test_batch_detects_caption_changed_after_transform(self):
        from backend.tageditor import routes
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            image.touch()
            caption = root / "a.txt"
            caption.write_text("original", encoding="utf-8")
            apply = routes.apply_operation

            def concurrent_operation(tags, operation, args):
                result = apply(tags, operation, args)
                caption.write_text("concurrent edit", encoding="utf-8")
                return result

            context = (None, root, "add_suffix", {"value": "suffix"}, [{"path": str(image), "name": image.name}])
            with patch.object(routes, "_resolve_batch_context", return_value=context), patch.object(
                routes, "apply_operation", side_effect=concurrent_operation
            ):
                result = asyncio.run(routes.batch_edit_tags({}))["data"]
            self.assertEqual(result["modified"], 0)
            self.assertTrue(result["errors"])
            self.assertEqual(caption.read_text(encoding="utf-8"), "concurrent edit")

    def test_failed_restore_invalidates_cached_views(self):
        from backend.tageditor import routes
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(routes, "restore_timeline_event", side_effect=OSError("failed rollback")), patch.object(
                routes, "_invalidate_cache"
            ) as invalidate, patch.object(routes.dataset_sessions, "invalidate_dataset") as invalidate_session:
                result = asyncio.run(routes.api_restore_timeline("event", str(root)))
            self.assertEqual(result["status"], "error")
            invalidate.assert_called_once_with(root, None)
            invalidate_session.assert_called_once_with(root)

    def test_route_returns_timeline_conflict_code_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            image.touch()
            caption = image.with_suffix(".txt")
            caption.write_text("before", encoding="utf-8")
            store = TimelineStore(root / "timeline.sqlite3")
            with patch("backend.tageditor.repository.timeline_store", store):
                saved = save_caption_transaction(root, [{"path": str(image), "tags": "saved"}])
                caption.write_text("external", encoding="utf-8")
                with TestClient(app) as client:
                    response = client.post(
                        f"/api/tageditor/timeline/{saved['timeline_event']['id']}/restore",
                        params={"dataset_dir": str(root)},
                    ).json()
            self.assertEqual(response["error_code"], "tageditor_timeline_conflict")
            self.assertEqual(response["error_params"]["count"], 1)
            self.assertEqual(caption.read_text(encoding="utf-8"), "external")

    def test_invalid_directory_error_has_code_and_original_path(self):
        with tempfile.TemporaryDirectory() as temp_dir, TestClient(app) as client:
            missing = str(Path(temp_dir) / "missing")
            response = client.post("/api/tageditor/sessions", json={"dir": missing}).json()
        self.assertEqual(response["error_code"], "tageditor_invalid_directory")
        self.assertEqual(response["error_params"]["directory"], missing)

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

    def test_caption_conflict_returns_structured_reason_without_writing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image = root / "a.png"
            image.touch()
            for extension in (".txt", ".caption"):
                image.with_suffix(extension).write_text("original", encoding="utf-8")
            result = save_caption_transaction(root, [{"path": str(image), "tags": "edited"}])
            self.assertTrue(result["aborted"])
            self.assertEqual(result["failed"][0]["error_code"], "tageditor_caption_conflict")
            self.assertEqual(result["failed"][0]["path"], str(image.resolve()))
            self.assertEqual(image.with_suffix(".txt").read_text(encoding="utf-8"), "original")


class TagEditorSessionTests(unittest.TestCase):
    def test_open_session_detects_caption_changes_and_retries_unacknowledged_update(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "a.png").touch()
            (root / "b.png").touch()
            (root / "c.png").touch()
            (root / "d.png").touch()
            (root / "a.txt").write_text("old", encoding="utf-8")
            (root / "b.caption").write_text("removed", encoding="utf-8")
            (root / "d.txt").write_text("old, old", encoding="utf-8")
            client = TestClient(app)

            with patch("backend.tageditor.routes.dataset_sessions", DatasetSessionService()):
                first = client.post("/api/tageditor/sessions", json={"dir": temp_dir}).json()["data"]
                url = f"/api/tageditor/sessions/{first['session_id']}"
                check = f"{url}/refresh?since_generation={first['generation']}"
                with patch("backend.tageditor.sessions.get_cached_scan_dataset") as scan:
                    self.assertIsNone(client.post(check).json()["data"])
                    scan.assert_not_called()
                (root / "a.txt").write_text("rewritten", encoding="utf-8")
                (root / "b.caption").unlink()
                (root / "c.caption").write_text("added", encoding="utf-8")
                with (
                    patch("backend.tageditor.sessions.get_cached_scan_dataset") as scan,
                    patch("backend.tageditor.core.read_caption_snapshot", wraps=read_caption_snapshot) as read,
                ):
                    update = client.post(check).json()["data"]
                    scan.assert_not_called()
                    self.assertCountEqual([call.args[0].name for call in read.call_args_list], ["a.txt", "c.caption"])
                self.assertEqual(update["generation"], first["generation"] + 1)
                self.assertEqual(update["no_tag_count"], 1)
                self.assertEqual(
                    {item["rel_path"]: item["tags"] for item in update["changed_images"]},
                    {"a.png": "rewritten", "b.png": "", "c.png": "added"},
                )
                self.assertEqual({item["tag"]: item["count"] for item in update["tags"]},
                                 {"old": 2, "rewritten": 1, "added": 1})
                stats = client.get("/api/tageditor/tags", params={"dir": temp_dir}).json()["data"]
                self.assertEqual(stats["tags"], update["tags"])
                self.assertEqual(client.post(check).json()["data"], update)
                self.assertIsNone(client.post(f"{url}/refresh?since_generation={update['generation']}").json()["data"])
                page = client.get(f"{url}/images", params={"include_tags": "rewritten"}).json()["data"]
                self.assertEqual([item["rel_path"] for item in page["items"]], ["a.png"])
                saved = client.post("/api/tageditor/save-all", json={
                    "dir": temp_dir,
                    "images": [{"path": first["items"][0]["path"], "tags": "draft",
                                "expected_revision": first["items"][0]["caption_revision"]}],
                }).json()["data"]
                self.assertEqual(saved["conflicts"][0]["error_code"], "tageditor_external_change")
                self.assertEqual((root / "a.txt").read_text(encoding="utf-8"), "rewritten")

    def test_incremental_refresh_tracks_new_and_removed_images_with_existing_captions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "removed.png").touch()
            (root / "removed.txt").write_text("gone", encoding="utf-8")
            (root / "added.caption").write_text("kept", encoding="utf-8")
            service = DatasetSessionService()
            session = service.create(temp_dir)

            (root / "removed.png").unlink()
            (root / "added.png").touch()
            (root / "added.jpg").touch()
            refreshed = service.refresh(session.id, since_generation=session.generation)
            self.assertEqual(refreshed.removed_paths, (str(root / "removed.png"),))
            self.assertEqual([item["name"] for item in refreshed.images], ["added.jpg", "added.png"])
            self.assertEqual(refreshed.tags, ({"tag": "kept", "count": 2},))

    def test_reopening_dataset_reads_externally_rewritten_caption(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(30):
                (root / f"a-{index:02}.png").touch()
            (root / "z.png").touch()
            caption = root / "z.txt"
            caption.write_text("before", encoding="utf-8")
            client = TestClient(app)
            url = "/api/tageditor/sessions"

            with patch("backend.tageditor.routes.dataset_sessions", DatasetSessionService()):
                first = client.post(url, json={"dir": temp_dir}).json()["data"]
                caption.write_text("after", encoding="utf-8")
                target = first["items"][-1]
                reopened = client.post(url, json={
                    "dir": temp_dir, "page_size": 30, "retained_paths": [target["path"]],
                }).json()["data"]

                self.assertEqual(target["tags"], "before")
                self.assertNotIn(target["path"], {item["path"] for item in reopened["items"]})
                self.assertEqual(reopened["retained_items"][0]["tags"], "after")
                self.assertIn(reopened["session_id"], reopened["retained_items"][0]["preview"])
                self.assertEqual(reopened["tags"], [{"tag": "after", "count": 1}])
                self.assertNotEqual(reopened["revision"], first["revision"])
                original_page = client.get(f"{url}/{first['session_id']}/images", params={"search": "z.png"}).json()["data"]
                self.assertEqual(original_page["items"][0]["tags"], "before")

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
