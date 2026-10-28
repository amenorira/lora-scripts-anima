"""Filesystem, synchronous preview and task integration for the MOSS workspaces."""
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend.server.routes.tagger import router
from backend.tagger import api_engine, workspace
from backend.tasks import tm
from tests.tagger.test_captioning import RESPONSE


class CaptionWorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.image = self.add_image("00.png")
        self.api = {"base_url": "http://fixture/v1", "model": "fixture", "api_key": "secret-test-key", "max_retries": 0}

    def add_image(self, name):
        path = self.root / name
        Image.new("RGB", (32, 24), (100, 80, 170)).save(path)
        return path

    def scan(self, **options):
        return workspace.scan_source(str(self.root), caption_extension=options.get("caption_extension", ".txt"), caption_options=options)

    def sidecar(self, path=None, **data):
        path = path or self.image
        file = path.with_name(path.stem + "_caption.json")
        file.write_text(json.dumps({"response": RESPONSE, "prompt": "Saved prompt", **data}), encoding="utf-8")
        return file

    def wait(self, task_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = workspace.task_snapshot(task_id)
            if data["status"] in {"done", "error", "cancelled"}:
                return data
            time.sleep(.01)
        self.fail("task did not settle")

    def run_task(self, token, **options):
        task_id = workspace.create_task({"engine": "api", "source_token": token, "api": self.api, "options": {"captioning": options}})
        return task_id, self.wait(task_id)


    def test_preview_cancellation_holds_gate_until_request_settles_and_allows_training(self):
        source = workspace.scan_source(str(self.image))
        batch = self.scan()
        entered, release = threading.Event(), threading.Event()
        errors = []
        def respond(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return RESPONSE, "raw"
        def request():
            try:
                workspace.preview_caption({"request_id":"fixture-cancel", "source_token":source["source_token"], "api":self.api})
            except Exception as exc:
                errors.append(exc)
        with patch.object(api_engine, "interrogate", side_effect=respond):
            worker = threading.Thread(target=request)
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                reservation = tm.reserve_task()
                self.assertIsNotNone(reservation)
                tm.release_reserved(reservation)
                self.assertTrue(workspace.cancel_preview("fixture-cancel"))
                self.assertTrue(workspace.preview_state()["active"])
                with self.assertRaises(RuntimeError):
                    workspace.create_task({"source_token":batch["source_token"],"model_id":"camie-tagger-v2"})
                with self.assertRaises(RuntimeError):
                    workspace.claim_direct_tagger("local-single")
                with self.assertRaises(RuntimeError):
                    workspace.preview_caption({"source_token":source["source_token"],"api":self.api})
            finally:
                release.set()
                worker.join(5)
        self.assertIsInstance(errors[0], InterruptedError)
        self.assertFalse(workspace.preview_state()["active"])


    def test_dry_run_skip_first_prompt_and_counters_no_files_changed(self):
        self.image.with_suffix(".txt").write_text("keep",encoding="utf-8")
        self.add_image("01.png")
        self.sidecar(self.add_image("02.png"))
        source = self.scan()
        before = {p.name:p.read_bytes() for p in self.root.iterdir()}
        with patch.object(api_engine,"interrogate") as call:
            task_id,data = self.run_task(source["source_token"],dry_run=True)
        self.assertEqual((data["success"],data["skipped"],data["checked"],data["written"],data["reused"]),(0,0,3,0,0))
        self.assertEqual(data["plan"],{"requests":2,"reused":1,"skipped":0,"writes":3})
        self.assertTrue(data["has_check_prompt"])
        self.assertTrue(workspace.task_check_prompt(task_id)["prompt"])
        self.assertNotIn("check_prompt",data)
        self.assertFalse(any(line["event"] == "prompt" for line in data["logs"]))
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.root.iterdir()})
        self.assertEqual([item["event"] for item in workspace.task_items(task_id)["items"]],["checked","checked","checked"])
        call.assert_not_called()


    def test_annotation_settings_are_request_scoped_including_detail_and_cache(self):
        self.image.with_suffix(".txt").write_text("---===--- # short\nFirst", encoding="utf-8")
        self.image.with_suffix(".caption").write_text("=== # long\nSecond", encoding="utf-8")
        token = self.scan()["source_token"]
        original_settings = dict(workspace._sources[token]["caption_options"])
        app = FastAPI()
        app.include_router(router, prefix="/api")
        with TestClient(app) as client:
            prefix = f"/api/tagger/source/{token}/annotations"
            first = client.get(prefix, params={"caption_extension": ".txt"}).json()["data"]
            second = client.get(prefix, params={"caption_extension": ".caption", "separator": "==="}).json()["data"]
            self.assertEqual(second["items"][0]["caption_kind"], "moss")
            detail = client.get(prefix + "/0", params=first["settings"]).json()["data"]
            self.assertEqual(detail["candidates"], {"short": "First"})
            self.assertEqual(workspace._sources[token]["caption_options"], original_settings)
            self.assertEqual(workspace.annotations(token)["items"][0]["caption_excerpt"], "First")

    def test_cancel_prepared_http_request_before_worker_runs_never_calls_model(self):
        source = workspace.scan_source(str(self.image))
        app = FastAPI()
        app.include_router(router, prefix="/api")
        entered, release = threading.Event(), threading.Event()
        original_preview = workspace.preview_caption
        replies = []
        def delayed_preview(payload, request):
            self.assertIsNotNone(request)
            entered.set()
            self.assertTrue(release.wait(5))
            return original_preview(payload, request)
        with TestClient(app) as client, patch.object(workspace, "preview_caption", side_effect=delayed_preview), patch.object(api_engine, "interrogate") as call:
            worker = threading.Thread(target=lambda: replies.append(client.post("/api/tagger/caption/preview", json={
                "source_token": source["source_token"], "request_id": "prepare-cancel", "api": self.api}).json()))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(client.get("/api/tagger/caption/preview-state").json()["data"]["phase"], "preparing")
                self.assertTrue(client.post("/api/tagger/caption/preview-cancel", json={"request_id": "prepare-cancel"}).json()["data"]["cancelling"])
            finally:
                release.set()
                worker.join(5)
            self.assertEqual(replies[0]["status"], "fail")
            self.assertIn("cancelled", replies[0]["message"])
            call.assert_not_called()
            self.assertFalse(workspace.preview_state()["tagger_busy"])
