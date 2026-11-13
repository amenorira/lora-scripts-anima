import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.tagger import workspace
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
                self.assertTrue(workspace.cancel_task(task_id))
                self.assertEqual(workspace.task_snapshot(task_id)["status"], "cancelling")
                self.assertIsNone(tm.reserve_task())
                with started_lock:
                    self.assertEqual(len(started), 2)
                release.set()
                result = self._wait(task_id)

            self.assertEqual(result["status"], "cancelled")
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
