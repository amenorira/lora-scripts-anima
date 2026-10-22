import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.tagger import workspace
from backend.utils import file_io as writing
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


    def test_scan_task_results_and_atomic_caption_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "sample_failed_error.png"
            self._image(image_path)
            source = workspace.scan_source(str(root), True)
            self.assertEqual(source["total"], 1)
            self.assertEqual(source["with_caption"], 0)
            page = workspace.source_items(source["source_token"], 0, 1)
            self.assertEqual(page["total"], 1)
            self.assertEqual(page["items"][0]["index"], 0)

            with patch.object(workspace, "_load_local_model"), patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace, "_local_tags", return_value=(
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
            self.assertEqual(result["logs"][-1]["level"], "success")
            self.assertEqual(result["logs"][-1]["failed"], 0)
            self.assertEqual([line["level"] for line in result["logs"] if line["event"] == "written"], ["info"])
            self.assertEqual(result["source_root"], str(root.resolve()))
            self.assertEqual(image_path.with_suffix(".txt").read_text(encoding="utf-8"), "1girl, blue eyes")
            items = workspace.task_items(task_id)["items"]
            self.assertEqual(items[0]["result"]["text"], "1girl, blue eyes")
            self.assertFalse(list(root.glob(".*.tmp")))

    def test_model_loading_and_first_inference_are_separate_and_cancel_skips_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(3):
                self._image(root / f"{index}.png")
            source = workspace.scan_source(str(root))
            loading = threading.Event()
            loaded = threading.Event()
            inferring = threading.Event()
            inferred = threading.Event()

            def load(*_args):
                loading.set()
                self.assertTrue(loaded.wait(5))

            def infer(*_args, **_kwargs):
                inferring.set()
                self.assertTrue(inferred.wait(5))
                return ["tag"], {}

            with patch.object(workspace, "_load_local_model", side_effect=load), patch.object(
                workspace, "_local_tags", side_effect=infer,
            ) as inference, patch.object(workspace, "_write_caption") as write:
                try:
                    task_id = workspace.create_task({
                        "source_token": source["source_token"], "model_id": "camie-tagger-v2",
                        "write_captions": True,
                    })
                    self.assertTrue(loading.wait(5))
                    snapshot = workspace.task_snapshot(task_id)
                    self.assertEqual(snapshot["phase"], "loading_model")
                    self.assertNotIn("ready", [line["event"] for line in snapshot["logs"]])
                    loaded.set()
                    self.assertTrue(inferring.wait(5))
                    snapshot = workspace.task_snapshot(task_id)
                    self.assertEqual(snapshot["phase"], "first_inference")
                    self.assertEqual([line["event"] for line in snapshot["logs"]],
                                     ["start", "loading", "ready", "first_inference"])
                    self.assertTrue(workspace.cancel_task(task_id))
                    self.assertEqual(workspace.task_snapshot(task_id)["phase"], "cancelling")
                finally:
                    loaded.set()
                    inferred.set()
                result = self._wait(task_id)
            self.assertEqual(result["status"], "cancelled")
            self.assertEqual(result["success"], 0)
            self.assertEqual(inference.call_count, 1)
            write.assert_not_called()
            self.assertEqual(list(root.glob("*.txt")), [])
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)

    def test_cancel_during_model_load_skips_inference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._image(root / "sample.png")
            source = workspace.scan_source(str(root))
            loading = threading.Event()
            release = threading.Event()

            def load(*_args):
                loading.set()
                self.assertTrue(release.wait(5))

            with patch.object(workspace, "_load_local_model", side_effect=load), patch.object(
                workspace, "_local_tags",
            ) as inference:
                try:
                    task_id = workspace.create_task({
                        "source_token": source["source_token"], "model_id": "camie-tagger-v2",
                        "write_captions": True,
                    })
                    self.assertTrue(loading.wait(5))
                    workspace.cancel_task(task_id)
                finally:
                    release.set()
                result = self._wait(task_id)
            self.assertEqual(result["status"], "cancelled")
            inference.assert_not_called()
            self.assertNotIn("first_inference", [line["event"] for line in result["logs"]])
            self.assertEqual(list(root.glob("*.txt")), [])

    def test_caption_write_failure_stops_batch_and_releases_training_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(3):
                self._image(root / f"{index}.png")
            source = workspace.scan_source(str(root))
            with patch.object(workspace, "_load_local_model"), patch.object(
                workspace, "_local_tags", return_value=(["tag"], {}),
            ) as inference, patch.object(workspace, "_write_caption", side_effect=PermissionError("denied")) as write:
                task_id = workspace.create_task({
                    "source_token": source["source_token"], "model_id": "camie-tagger-v2",
                    "write_captions": True,
                })
                result = self._wait(task_id)
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["failed"], 1)
            self.assertIn("标签写入失败", result["error_detail"])
            self.assertIn("0.txt", result["error_detail"])
            self.assertEqual(inference.call_count, 1)
            self.assertEqual(write.call_count, 1)
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)

    def test_cancel_during_caption_write_cleans_temporary_and_stops_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(3):
                self._image(root / f"{index}.png")
            source = workspace.scan_source(str(root))
            writing_started = threading.Event()
            release = threading.Event()

            def sync(_fd):
                writing_started.set()
                self.assertTrue(release.wait(5))

            with patch.object(workspace, "_load_local_model"), patch.object(
                workspace, "_local_tags", return_value=(["tag"], {}),
            ) as inference, patch.object(writing.os, "fsync", side_effect=sync):
                try:
                    task_id = workspace.create_task({
                        "source_token": source["source_token"], "model_id": "camie-tagger-v2",
                        "write_captions": True,
                    })
                    self.assertTrue(writing_started.wait(5))
                    self.assertEqual(workspace.task_snapshot(task_id)["phase"], "writing")
                    workspace.cancel_task(task_id)
                finally:
                    release.set()
                result = self._wait(task_id)
            self.assertEqual(result["status"], "cancelled")
            self.assertEqual(result["success"], 0)
            self.assertEqual(inference.call_count, 1)
            self.assertEqual(list(root.glob("*.txt")), [])
            self.assertEqual(list(root.glob(".*.tmp")), [])


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
            with patch.object(workspace, "_load_local_model"), patch.object(workspace, "_local_tags", side_effect=slow_inference):
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

    def test_api_auth_failure_stops_new_requests_and_releases_training_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(4):
                self._image(root / f"{index}.png")
            source = workspace.scan_source(str(root))
            with patch.object(workspace.captioning, "process", side_effect=workspace.api_engine.ApiAuthError("invalid key")) as process:
                task_id = workspace.create_task({
                    "engine": "api", "source_token": source["source_token"],
                    "api": {"base_url":"http://localhost/v1", "model":"fake", "max_workers":1},
                })
                result = self._wait(task_id)
            self.assertEqual(result["status"], "error")
            self.assertIn("鉴权失败", result["error_detail"])
            self.assertEqual(process.call_count, 1)
            reservation = tm.reserve_task()
            self.assertIsNotNone(reservation)
            tm.release_reserved(reservation)


if __name__ == "__main__":
    unittest.main()
