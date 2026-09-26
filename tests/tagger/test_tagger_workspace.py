import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from PIL import Image

from backend.tagger import interrogator, workspace
from backend.tasks import tm


class TaggerWorkspaceTests(unittest.TestCase):
    def _image(self, path: Path, color=(120, 80, 160)) -> None:
        Image.new("RGB", (48, 32), color).save(path)

    def _wait(self, task_id: str) -> dict:
        deadline = time.time() + 5
        while time.time() < deadline:
            result = workspace.task_snapshot(task_id)
            if result.get("status") in {"done", "error", "cancelled"}:
                return result
            time.sleep(0.02)
        self.fail("Tagger task did not finish")

    def test_cleanup_bounds_finished_task_history(self):
        now = time.time()
        tasks = {
            f"finished-{index}": {
                "status": "done", "updated_at": now - (20 - index), "source_token": f"source-{index}",
            }
            for index in range(workspace._TASK_KEEP_MAX + 2)
        }
        tasks["active"] = {"status": "running", "updated_at": now - 100, "source_token": "active-source"}
        with patch.object(workspace, "_tasks", tasks), patch.object(workspace, "_sources", {}):
            workspace._cleanup()
            self.assertEqual(len(tasks), workspace._TASK_KEEP_MAX + 1)
            self.assertIn("active", tasks)
            self.assertNotIn("finished-0", tasks)
            self.assertNotIn("finished-1", tasks)

    def test_cancelling_task_remains_latest_active(self):
        task = {"id": "cancel-pending", "status": "cancelling", "updated_at": time.time()}
        with patch.object(workspace, "_tasks", {task["id"]: task}):
            self.assertEqual(workspace.latest_active_task_id(), task["id"])

    def test_scan_task_results_and_atomic_caption_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "sample.png"
            self._image(image_path)
            source = workspace.scan_source(str(root), True)
            self.assertEqual(source["total"], 1)
            self.assertEqual(source["with_caption"], 0)
            page = workspace.source_items(source["source_token"], 0, 1)
            self.assertEqual(page["total"], 1)
            self.assertEqual(page["items"][0]["index"], 0)

            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_onnx_tags", return_value=(
                    ["1girl", "blue eyes"],
                    {"general": {"tags": [["1girl", 0.99]]}},
                )
            ):
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "camie-tagger-v2",
                    "conflict": "copy",
                    "write_captions": True,
                })
                result = self._wait(task_id)

            self.assertEqual(result["status"], "done")
            self.assertEqual(result["source_root"], str(root.resolve()))
            self.assertEqual(image_path.with_suffix(".txt").read_text(encoding="utf-8"), "1girl, blue eyes")
            items = workspace.task_items(task_id)["items"]
            self.assertEqual(items[0]["result"]["text"], "1girl, blue eyes")
            self.assertFalse(list(root.glob(".*.tmp")))

    def test_skip_existing_caption_does_not_run_inference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "existing.png"
            self._image(image_path)
            image_path.with_suffix(".txt").write_text("existing tag", encoding="utf-8")
            source = workspace.scan_source(str(root), True)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_onnx_tags", side_effect=AssertionError("inference should be skipped")
            ):
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "camie-tagger-v2",
                    "conflict": "ignore",
                    "write_captions": True,
                })
                result = self._wait(task_id)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(workspace.task_items(task_id)["items"][0]["result"]["text"], "existing tag")

    def test_prefetch_start_failure_releases_training_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "sample.png")
            source = workspace.scan_source(str(root), True)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_start_image_prefetch", side_effect=OSError("prefetch unavailable"),
            ):
                task_id = workspace.create_task({
                    "source_token": source["source_token"],
                    "model_id": "camie-tagger-v2",
                    "write_captions": False,
                })
                self.assertEqual(self._wait(task_id)["status"], "error")
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)

    def test_read_only_api_task_allows_training_but_blocks_dataset_rename(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "sample.png")
            source = workspace.scan_source(str(root), True)
            entered = threading.Event()
            release = threading.Event()
            config = SimpleNamespace(model="fake", base_url="http://localhost", concurrency=1)

            def slow_tag(*_args):
                entered.set()
                self.assertTrue(release.wait(5))
                return {"status": "success", "tag_count": 1, "result": {"text": "tag"}}

            with patch.object(workspace.api_engine, "validate_config", return_value=config), patch.object(
                workspace.api_engine, "create_client", return_value=MagicMock(),
            ), patch.object(workspace, "_api_tag_one", side_effect=slow_tag):
                task_id = workspace.create_task({
                    "engine": "api", "api": {}, "source_token": source["source_token"],
                    "write_captions": False,
                })
                self.assertTrue(entered.wait(5))
                reservation = tm.reserve_task()
                self.assertIsNotNone(reservation)
                tm.release_reserved(reservation)
                self.assertFalse(tm.begin_dataset_mutation())
                release.set()
                self.assertEqual(self._wait(task_id)["status"], "done")
                self.assertTrue(tm.begin_dataset_mutation())
                tm.end_dataset_mutation()

    def test_onnx_result_keeps_all_raw_categories_and_passes_category_thresholds(self):
        raw = {
            "general": [("1girl", 0.99)],
            "character": [("alice", 0.88)],
            "rating": [("safe", 0.97)],
            "model": [("anime", 0.91)],
        }
        fake = MagicMock()
        fake.interrogate.return_value = raw
        thresholds = {"general": 0.4, "character": 0.7, "rating": 1.01, "model": 1.01}
        with patch.dict(workspace.available_interrogators, {"camie-tagger-v2": fake}), patch.object(
            interrogator.Interrogator,
            "postprocess_tags",
            return_value={"1girl": 0.99, "alice": 0.88},
        ) as postprocess:
            tags, categories = workspace._onnx_tags(
                "camie-tagger-v2",
                Image.new("RGB", (16, 16)),
                {"category_thresholds": thresholds},
            )

        self.assertEqual(tags, ["1girl", "alice"])
        self.assertEqual(set(categories), {"general", "character", "rating", "model"})
        self.assertEqual(categories["character"]["tags"], [["alice", 0.88]])
        self.assertEqual(categories["character"]["total"], 1)
        self.assertFalse(categories["character"]["truncated"])
        self.assertEqual(postprocess.call_args.args[3], thresholds)
        self.assertFalse(postprocess.call_args.args[12])
        self.assertEqual(set(raw), {"general", "character", "rating", "model"})

    def test_api_tags_keep_literal_parentheses_unless_escaping_is_requested(self):
        self.assertEqual(workspace._finalize_api_tags(["star_(symbol)"], {}), ["star (symbol)"])
        self.assertEqual(workspace._finalize_api_tags(["star_(symbol)"], {"escape_tag": True}), [r"star \(symbol\)"])

    def test_task_items_pages_without_changing_original_indices(self):
        task_id = "page-index-test"
        task = {
            "lock": threading.RLock(),
            "items": [{"name": str(index), "status": "failed" if index == 3 else "success"} for index in range(5)],
            "results": {index: {"text": str(index)} for index in range(5)},
        }
        with workspace._tasks_lock:
            workspace._tasks[task_id] = task
        try:
            page = workspace.task_items(task_id, offset=2, limit=2)
            self.assertEqual(page["total"], 5)
            self.assertEqual([item["index"] for item in page["items"]], [2, 3])
            self.assertEqual(page["items"][1]["result"], {"text": "3"})
            failed = workspace.task_items(task_id, failed_only=True)
            self.assertEqual(failed["total"], 1)
            self.assertEqual(failed["items"][0]["index"], 3)
        finally:
            with workspace._tasks_lock:
                workspace._tasks.pop(task_id, None)

    def test_append_caption_respects_remove_duplicated_option(self):
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "sample.png"
            caption_path = image_path.with_suffix(".txt")
            caption_path.write_text("1girl, blue eyes", encoding="utf-8")

            workspace._write_caption(image_path, ["blue eyes", "smile"], "prepend", False)
            self.assertEqual(caption_path.read_text(encoding="utf-8"), "1girl, blue eyes, blue eyes, smile")

            caption_path.write_text("1girl, blue eyes", encoding="utf-8")
            workspace._write_caption(image_path, ["blue eyes", "smile"], "prepend", True)
            self.assertEqual(caption_path.read_text(encoding="utf-8"), "1girl, blue eyes, smile")

    def test_legacy_cancel_returns_without_reacquiring_progress_lock(self):
        task_id = "cancel-lock-test"
        with interrogator._states_lock:
            interrogator._task_states[task_id] = {"status": "running", "logs": []}
        thread = threading.Thread(target=interrogator.cancel_tagger_task, args=(task_id,))
        thread.start()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(interrogator.get_tagger_task_snapshot(task_id)["status"], "cancelled")
        with interrogator._states_lock:
            interrogator._task_states.pop(task_id, None)

    def test_api_cancel_stops_scheduling_and_waits_for_inflight_caption_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(8):
                self._image(root / f"{index:02d}.png")
            source = workspace.scan_source(str(root), True)
            both_started = threading.Event()
            release = threading.Event()
            started = []
            started_lock = threading.Lock()
            client = MagicMock()
            config = SimpleNamespace(model="fake", base_url="http://localhost", concurrency=2)

            def slow_tag(_cancel, _config, _client, index, path, *_args):
                with started_lock:
                    started.append(index)
                    if len(started) == 2:
                        both_started.set()
                self.assertTrue(release.wait(5))
                path.with_suffix(".txt").write_text(f"tag {index}", encoding="utf-8")
                return {"status": "success", "tag_count": 1, "result": {"index": index, "text": f"tag {index}"}}

            with patch.object(workspace.api_engine, "validate_config", return_value=config), patch.object(
                workspace.api_engine, "create_client", return_value=client,
            ), patch.object(workspace, "_api_tag_one", side_effect=slow_tag):
                task_id = workspace.create_task({
                    "engine": "api", "api": {}, "source_token": source["source_token"],
                    "write_captions": True,
                })
                self.assertTrue(both_started.wait(5))
                self.assertTrue(workspace.cancel_task(task_id))
                self.assertEqual(workspace.task_snapshot(task_id)["status"], "cancelling")
                self.assertIsNone(tm.reserve_task())
                client.close.assert_not_called()
                with started_lock:
                    self.assertEqual(len(started), 2)
                release.set()
                result = self._wait(task_id)

            self.assertEqual(result["status"], "cancelled")
            self.assertEqual(result["success"], 2)
            self.assertEqual(len(started), 2)
            self.assertEqual(len(list(root.glob("*.txt"))), 2)
            client.close.assert_called_once()
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)

    def test_retry_keeps_original_scope_for_sibling_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / "a" / "one.png", root / "b" / "two.png"]
            for path in paths:
                path.parent.mkdir()
                self._image(path)
            prior_id = "retry-scope-test"
            previous = {
                "lock": threading.RLock(), "items": [
                    {"path": str(path), "status": "failed"} for path in paths
                ],
                "engine": "api", "model_id": "api:fake", "options": {},
                "conflict": "ignore", "write_captions": False, "api_payload": {},
                "source_root": str(root), "source_kind": "folder",
            }
            with workspace._tasks_lock:
                workspace._tasks[prior_id] = previous
            token = None
            try:
                with patch.object(workspace, "create_task", return_value="new-task") as start:
                    self.assertEqual(workspace.retry_failed_task(prior_id), "new-task")
                token = start.call_args.args[0]["source_token"]
                self.assertEqual(workspace.source_item(token, 0), paths[0].resolve())
                self.assertEqual(workspace.source_item(token, 1), paths[1].resolve())
                with workspace._sources_lock:
                    workspace._sources[token]["paths"].append(root.parent / "outside.png")
                with self.assertRaises(ValueError):
                    workspace.source_item(token, 2)
            finally:
                with workspace._tasks_lock:
                    workspace._tasks.pop(prior_id, None)
                if token is not None:
                    with workspace._sources_lock:
                        workspace._sources.pop(token, None)

    def test_onnx_task_claim_excludes_training_and_second_tagger(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "sample.png")
            source = workspace.scan_source(str(root), True)
            entered = threading.Event()
            release = threading.Event()

            def slow_inference(*_args, **_kwargs):
                entered.set()
                self.assertTrue(release.wait(5))
                return ["tag"], {}

            payload = {
                "source_token": source["source_token"], "model_id": "camie-tagger-v2",
                "write_captions": False,
            }
            with patch.object(workspace, "_onnx_tags", side_effect=slow_inference):
                task_id = workspace.create_task(payload)
                self.assertTrue(entered.wait(5))
                self.assertIsNone(tm.reserve_task())
                with self.assertRaises(RuntimeError):
                    workspace.create_task(payload)
                release.set()
                self.assertEqual(self._wait(task_id)["status"], "done")
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)


if __name__ == "__main__":
    unittest.main()
