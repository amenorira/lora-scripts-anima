import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image

from backend.tagger import workspace, workspace_tasks
from backend.server.routes import tagger as tagger_routes
from backend.tasks import tm


class TaggerResponseIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_and_retry_return_the_server_instance(self):
        with (patch.object(tagger_routes, "task_snapshot", return_value={"status": "done"}),
              patch.object(tagger_routes, "retry_failed_task", return_value="new-task"),
              patch.object(tagger_routes.realtime_tasks, "register", new_callable=AsyncMock)):
            status = await tagger_routes.get_tagger_workspace_task("old-task")
            retry = await tagger_routes.retry_tagger_workspace_task("old-task")
        self.assertEqual(status.data["server_instance_id"], tagger_routes.SERVER_INSTANCE_ID)
        self.assertEqual(retry.data["server_instance_id"], tagger_routes.SERVER_INSTANCE_ID)
        self.assertEqual(retry.data["task_id"], "new-task")

    async def test_status_and_retry_failures_identify_the_server(self):
        with (patch.object(tagger_routes, "task_snapshot", return_value={"status": "error", "error_detail": "Task not found"}),
              patch.object(tagger_routes, "retry_failed_task", side_effect=ValueError("retry failed"))):
            status = await tagger_routes.get_tagger_workspace_task("old-task")
            retry = await tagger_routes.retry_tagger_workspace_task("old-task")
        self.assertEqual(status.status, "fail")
        self.assertEqual(retry.status, "fail")
        self.assertEqual(status.data["server_instance_id"], tagger_routes.SERVER_INSTANCE_ID)
        self.assertEqual(retry.data["server_instance_id"], tagger_routes.SERVER_INSTANCE_ID)


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

    def test_a_captured_plan_does_not_change_after_later_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "sample.png")
            source = workspace.scan_source(str(root), True)
            started, release = threading.Event(), threading.Event()

            def caption(*_args, **_kwargs):
                started.set()
                if not release.wait(5):
                    raise TimeoutError("caption was not released")
                return {"status": "success", "planned_action": "request", "event": "caption_written"}

            with patch.object(workspace.captioning, "process", side_effect=caption):
                task_id = workspace.create_task({"engine": "api", "api": {"base_url": "http://localhost/v1", "model": "fake"},
                                                 "source_token": source["source_token"], "write_captions": True})
                try:
                    self.assertTrue(started.wait(5))
                    before = workspace.task_snapshot(task_id)
                finally:
                    release.set()
                result = self._wait(task_id)
            self.assertEqual(result["status"], "done")
            self.assertEqual(result["plan"]["requests"], 1)
            self.assertEqual(before["plan"]["requests"], 0)
            self.assertGreater(result["snapshot_revision"], before["snapshot_revision"])

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
            def slow_tag(_config, path, _runtime, *, cancel_event):
                with started_lock:
                    started.append(path)
                    if len(started) == 2:
                        both_started.set()
                self.assertTrue(release.wait(5))
                if cancel_event.is_set():
                    raise InterruptedError("cancelled")
                self.fail("Cancellation should reach the in-flight image")

            with patch.object(workspace.captioning, "process", side_effect=slow_tag):
                task_id = workspace.create_task({
                    "engine": "api", "api": {"base_url":"http://localhost/v1", "model":"fake", "max_workers":2}, "source_token": source["source_token"],
                    "write_captions": True,
                })
                self.assertTrue(both_started.wait(5))
                before = workspace.task_snapshot(task_id)
                clock = SimpleNamespace(time=lambda: before["updated_at"] - 60, strftime=time.strftime)
                with patch.object(workspace_tasks, "time", clock):
                    self.assertTrue(workspace.cancel_task(task_id))
                    cancelling = workspace.task_snapshot(task_id)
                    self.assertEqual(cancelling["status"], "cancelling")
                    self.assertLess(cancelling["updated_at"], before["updated_at"])
                    self.assertGreater(cancelling["snapshot_revision"], before["snapshot_revision"])
                    self.assertIsNone(tm.reserve_task())
                    with started_lock:
                        self.assertEqual(len(started), 2)
                    release.set()
                    result = self._wait(task_id)

            self.assertEqual(result["status"], "cancelled")
            self.assertGreater(result["snapshot_revision"], cancelling["snapshot_revision"])
            self.assertGreater(result["items_version"], 0)
            self.assertEqual(result["logs"][-1]["level"], "warning")
            self.assertEqual(result["success"], 0)
            self.assertEqual(len(started), 2)
            self.assertEqual(len(list(root.glob("*.txt"))), 0)
            self.assertEqual({item["status"] for item in workspace.task_items(task_id)["items"]}, {"cancelled"})
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)


if __name__ == "__main__":
    unittest.main()
