"""Filesystem, synchronous preview and task integration for the MOSS workspaces."""
import asyncio
import json
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend.server.routes.tagger import router
from backend.tagger import api_engine, captioning, workspace
from backend.tageditor.routes import router as editor_router
from backend.tageditor.sessions import dataset_sessions
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

    def test_preview_file_and_upload_are_read_only_and_ignore_local_knowledge(self):
        self.image.with_suffix(".txt").write_text("keep", encoding="utf-8")
        (self.root / "_knowledge.txt").write_text("not for preview", encoding="utf-8")
        self.image.with_name("00_knowledge.txt").write_text("not for preview", encoding="utf-8")
        for register in (lambda: workspace.scan_source(str(self.image)), lambda: workspace.register_upload(self.image)):
            source = register()
            before = {p.name: p.read_bytes() for p in self.root.iterdir()}
            def respond(config, image, **kwargs):
                self.assertIn("Shared only", config.prompt)
                self.assertNotIn("not for preview", config.prompt)
                kwargs["metadata"].update(usage={"total_tokens": 8}, attempts=1, finish_reason="stop")
                return RESPONSE, json.dumps(RESPONSE)
            with patch.object(api_engine, "interrogate", side_effect=respond):
                result = workspace.preview_caption({"source_token": source["source_token"], "api": self.api,
                    "captioning": {"knowledge": "Shared only", "candidates": ["short", "long"]}})
            self.assertEqual(list(result["candidates"]), ["long", "short"])
            self.assertEqual(result["attempts"], 1)
            self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
            self.assertFalse(workspace.preview_state()["active"])

    def test_preview_protocol_errors_release_gate_and_redact_key(self):
        app = FastAPI()
        app.include_router(router, prefix="/api")
        source = workspace.scan_source(str(self.image))
        responses = [(401, {"error": self.api["api_key"]}, "401"), (400, {"error": "vision unsupported"}, "400"),
                     (200, {"choices": [{"message": {"content": "invalid JSON"}}]}, "Malformed"),
                     (200, {"choices": [{"message": {"content": json.dumps({"caption": {"long": "", "medium": "", "short": ""}})}}]}, "Malformed")]
        with TestClient(app) as client:
            for status, body, expected in responses:
                with self.subTest(status=status, expected=expected), httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))) as api_client:
                    with patch.object(api_engine, "create_client", return_value=api_client):
                        result = client.post("/api/tagger/caption/preview", json={"source_token":source["source_token"],"api":self.api}).json()
                    self.assertEqual(result["status"], "fail")
                    self.assertIn(expected, result["message"])
                    self.assertNotIn(self.api["api_key"], result["message"])
                    self.assertFalse(workspace.preview_state()["tagger_busy"])

    def test_preview_timeout_releases_gate(self):
        source = workspace.scan_source(str(self.image))
        with httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("fixture")))) as client:
            with patch.object(api_engine, "create_client", return_value=client), self.assertRaisesRegex(api_engine.ApiTransientError, "ReadTimeout"):
                workspace.preview_caption({"source_token":source["source_token"],"api":self.api})
        self.assertFalse(workspace.preview_state()["active"])

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

    def test_plan_modes_and_filesystem_refresh(self):
        reused = self.add_image("01.png")
        missing = self.add_image("02.png")
        self.image.with_suffix(".txt").write_text("ordinary", encoding="utf-8")
        self.sidecar(reused)
        source = self.scan()
        expected = [("generate", False, (2,1,0,3)), ("generate", True, (3,0,0,3)),
                    ("export", False, (0,1,2,1)), ("export", True, (0,1,2,1))]
        for mode, overwrite, plan in expected:
            result = workspace.caption_plan(source["source_token"], {"mode":mode,"overwrite":overwrite})
            self.assertEqual(tuple(result["plan"][key] for key in ("requests","reused","skipped","writes")),plan)
        counts = result["counts"]
        self.assertEqual((counts["ordinary_outputs"],counts["missing_outputs"],counts["missing_json"],counts["reusable"],counts["requestable"]),(1,2,2,1,2))
        missing.with_suffix(".txt").write_text("---===--- # short\nNew caption\n",encoding="utf-8")
        result = workspace.annotations(source["source_token"],status="missing")
        self.assertEqual([item["name"] for item in result["items"]],["01.png"])
        self.assertEqual(result["counts"]["moss_outputs"],1)

    def test_overview_reuses_recent_stats_but_plan_and_refresh_are_always_fresh(self):
        token = self.scan()["source_token"]
        with patch.object(captioning, "output_state", wraps=captioning.output_state) as state:
            workspace.annotations(token, cached=True)
            state.assert_not_called()
            self.image.with_suffix(".txt").write_text("external", encoding="utf-8")
            result = workspace.annotations(token, cached=True, refresh=True)
            self.assertEqual(result["counts"]["ordinary_outputs"], 1)
            self.assertEqual(state.call_count, 1)
            source = workspace._get_source(token)
            source["annotation_dirty"].add(str(self.image))
            workspace.annotations(token, cached=True)
            self.assertEqual(state.call_count, 2)
            workspace.caption_plan(token, {})
            self.assertEqual(state.call_count, 3)
            source["annotation_checked_at"] -= 6
            workspace.annotations(token, cached=True)
            self.assertEqual(state.call_count, 4)

    def test_invalid_record_filter_plan_and_task_failures(self):
        self.image.with_suffix(".txt").write_text("existing tags", encoding="utf-8")
        sidecar = self.sidecar(response={"caption": {"long": "incomplete"}})
        token = self.scan()["source_token"]
        page = workspace.annotations(token, status="invalid_json")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["counts"]["invalid_json"], 1)
        self.assertTrue(page["items"][0]["sidecar_error"])
        plan = workspace.caption_plan(token, {})["plan"]
        self.assertEqual((plan["failed"], plan["requests"], plan["writes"]), (1, 0, 0))
        before = sidecar.read_bytes()
        with patch.object(api_engine, "interrogate") as call:
            _, result = self.run_task(token)
            call.assert_not_called()
        self.assertEqual((result["failed"], result["written"]), (1, 0))
        self.assertEqual(sidecar.read_bytes(), before)

    def test_pagination_search_reads_only_page_and_detail_allowlist(self):
        for i in range(1, 125):
            self.add_image(f"{i:03d}.png").with_suffix(".txt").write_text("ordinary", encoding="utf-8")
        self.image.with_suffix(".txt").write_text("---===--- # short\nShort\n---===--- # long\nLong\n", encoding="utf-8")
        self.sidecar(api_key="never expose", secret="hidden", knowledge="Identity")
        source = self.scan()
        with patch.object(captioning,"read_bounded",wraps=captioning.read_bounded) as read:
            page = workspace.annotations(source["source_token"],offset=60)
        self.assertEqual((page["total"],len(page["items"])),(125,60))
        self.assertEqual(read.call_count,60)
        self.assertTrue(all("text" not in item and "sidecar" not in item for item in page["items"]))
        self.assertEqual(workspace.annotations(source["source_token"],q="00.PNG")["total"],2)
        index = next(i["index"] for i in workspace.annotations(source["source_token"],status="all")["items"] if i["name"] == "00.png")
        detail = workspace.annotation_detail(source["source_token"],index)
        self.assertEqual(list(detail["candidates"]),["short","long"])
        self.assertEqual(detail["sidecar"]["knowledge"],"Identity")
        self.assertNotIn("api_key",detail["sidecar"])
        self.assertNotIn("secret",detail["sidecar"])

    def test_detail_locates_same_named_image_beyond_first_editor_page(self):
        for index in range(61):
            (self.root / f"{index:02d}").mkdir()
            self.add_image(f"{index:02d}/image[1].png")
        source = self.scan()
        app = FastAPI()
        app.include_router(router, prefix="/api")
        app.include_router(editor_router, prefix="/api")
        with TestClient(app) as client:
            page = client.get(f"/api/tagger/source/{source['source_token']}/annotations", params={"offset": 60}).json()["data"]
            target = next(item for item in page["items"] if item["relative"] == "60/image[1].png")
            detail = client.get(f"/api/tagger/source/{source['source_token']}/annotations/{target['index']}").json()["data"]
            self.assertEqual(detail["relative"], target["relative"])
            session = client.post("/api/tageditor/sessions", json={"dir": str(self.root), "page_size": 60}).json()["data"]
            self.addCleanup(dataset_sessions.delete, session["session_id"])
            self.assertNotIn(detail["path"], [item["path"] for item in session["items"]])
            endpoint = f"/api/tageditor/sessions/{session['session_id']}/images"
            by_name = client.get(endpoint, params={"search": detail["name"]}).json()["data"]
            self.assertEqual(by_name["total"], 61)
            self.assertNotIn(detail["path"], [item["path"] for item in by_name["items"]])
            exact = client.get(endpoint, params={"search": "^" + re.escape(detail["relative"]) + "$", "use_regex": True}).json()["data"]
            self.assertEqual(exact["total"], 1)
            self.assertEqual([item["path"] for item in exact["items"]], [detail["path"]])

    def test_rescan_new_files_configuration_and_empty_directory(self):
        source = self.scan()
        self.add_image("new.png")
        self.assertEqual(workspace.annotations(source["source_token"])["total"],1)
        self.assertEqual(workspace.annotations(source["source_token"],refresh=True)["total"],2)
        self.image.with_suffix(".caption").write_text("=== # long\nText", encoding="utf-8")
        page = workspace.annotations(source["source_token"],options={"caption_extension":".caption","separator":"==="})
        self.assertEqual(page["counts"]["moss_outputs"],1)
        empty = self.root / "empty"
        empty.mkdir()
        token = workspace.scan_source(str(empty))["source_token"]
        self.assertEqual(workspace.annotations(token)["items"],[])

    def test_scope_expiry_and_oversize_detail(self):
        source = self.scan()
        token = source["source_token"]
        with self.assertRaises(IndexError): workspace.annotation_detail(token,10)
        with workspace._sources_lock:
            workspace._sources[token]["paths"] = [self.root.parent / "outside.png"]
        with self.assertRaises(ValueError): workspace.annotations(token)
        with workspace._sources_lock:
            workspace._sources[token]["created_at"] = time.time() - workspace._SOURCE_TTL - 1
        with self.assertRaises(KeyError): workspace.annotations(token)
        token = self.scan()["source_token"]
        self.image.with_suffix(".txt").write_text("x" * (512 * 1024 + 1),encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"too large"): workspace.annotation_detail(token,0)

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

    def test_dry_run_export_checks_json_without_writing(self):
        self.sidecar()
        token = self.scan()["source_token"]
        task_id,data = self.run_task(token,mode="export",dry_run=True)
        self.assertEqual((data["checked"],data["written"]),(1,0))
        self.assertFalse(self.image.with_suffix(".txt").exists())
        self.assertFalse(data["has_check_prompt"])
        self.assertEqual(workspace.task_items(task_id)["items"][0]["planned_action"],"reuse")

    def test_conflicting_output_and_knowledge_names_reject_before_request(self):
        self.add_image("00.jpg")
        token = self.scan()["source_token"]
        with patch.object(api_engine,"interrogate") as call, self.assertRaisesRegex(ValueError,"Conflicting"):
            workspace.create_task({"source_token":token,"engine":"api","api":self.api})
        call.assert_not_called()
        (self.root / "00.jpg").unlink()
        self.add_image("_knowledge.png")
        token = self.scan()["source_token"]
        with self.assertRaisesRegex(ValueError,"Conflicting"):
            workspace.create_task({"source_token":token,"engine":"api","api":self.api})

    def test_retry_subset_uses_path_and_original_source_token(self):
        second = self.add_image("01.png")
        self.sidecar(second)
        token = self.scan()["source_token"]
        task_id,data = self.run_task(token,mode="export")
        self.assertEqual(data["written"],1)
        # Simulate a failed second item. Its retry index becomes zero.
        with workspace._tasks_lock:
            previous = workspace._tasks[task_id]
            previous["items"][0]["status"] = "skipped"
            previous["items"][1]["status"] = "failed"
        second.with_suffix(".txt").unlink()
        retry = workspace.retry_failed_task(task_id)
        data = self.wait(retry)
        self.assertEqual(data["overview_source_token"],token)
        self.assertNotEqual(data["source_token"],token)
        self.assertEqual(workspace.task_items(retry)["items"][0]["index"],0)
        page = workspace.annotations(token,task_id=retry)
        self.assertEqual(page["total"],2)
        states = {item["name"]:item["task"] for item in page["items"]}
        self.assertEqual(states["00.png"],{})
        self.assertEqual(states["01.png"]["event"],"reused")

    def test_http_overview_prompt_and_legacy_single_gate(self):
        app = FastAPI()
        app.include_router(router,prefix="/api")
        token = self.scan()["source_token"]
        with TestClient(app) as client:
            page = client.get(f"/api/tagger/source/{token}/annotations?limit=1").json()
            self.assertEqual(page["status"],"success")
            task_id,_ = self.run_task(token,dry_run=True)
            self.assertTrue(client.get(f"/api/tagger/tasks/{task_id}/check-prompt").json()["data"]["prompt"])
            workspace.claim_direct_tagger("fixture-remote",remote=True,cancel_event=threading.Event())
            try:
                with self.image.open("rb") as image:
                    result = client.post("/api/tagger/single",files={"file":("00.png",image,"image/png")},data={"interrogator_model":"camie-tagger-v2"}).json()
                self.assertEqual(result["status"],"fail")
                self.assertIn("Tagger",result["message"])
            finally:
                workspace.release_direct_tagger("fixture-remote")

    def test_http_upload_moss_preview_and_local_tagger_single_regression(self):
        app = FastAPI()
        app.include_router(router,prefix="/api")
        with TestClient(app) as client:
            uploaded = client.post("/api/tagger/uploads",files={"file":("00.png",self.image.read_bytes(),"image/png")}).json()
            self.assertEqual(uploaded["status"],"success")
            data = uploaded["data"]
            with patch.object(api_engine,"interrogate",return_value=(RESPONSE,"raw")):
                preview = client.post("/api/tagger/caption/preview",json={"source_token":data["source_token"],"api":self.api}).json()
            self.assertEqual(preview["status"],"success")
            self.assertIn("long",preview["data"]["candidates"])
            self.assertFalse(Path(data["path"]).with_suffix(".txt").exists())
            model = workspace.available_interrogators["camie-tagger-v2"]
            with patch.object(model,"interrogate",return_value={"general":[("violet_circle",.9)]}):
                local = client.post("/api/tagger/single",files={"file":("00.png",self.image.read_bytes(),"image/png")},data={"interrogator_model":"camie-tagger-v2"}).json()
            self.assertEqual(local["status"],"success")
            self.assertEqual(local["data"]["categories"]["general"],[["violet_circle",.9]])
            self.assertFalse(workspace.preview_state()["tagger_busy"])

    def test_invalid_json_does_not_hide_filesystem_caption_in_details(self):
        self.image.with_suffix(".txt").write_text("ordinary caption",encoding="utf-8")
        self.image.with_name("00_caption.json").write_text("invalid JSON",encoding="utf-8")
        token = self.scan(reference_extension=".txt")["source_token"]
        detail = workspace.annotation_detail(token,0)
        self.assertEqual(detail["text"],"ordinary caption")
        self.assertEqual(detail["reference"],"ordinary caption")
        self.assertTrue(detail["sidecar_error"])

    def test_original_only_preflight_without_reference_fails_before_api(self):
        token = self.scan()["source_token"]
        with patch.object(api_engine,"interrogate") as call:
            _,data = self.run_task(token,dry_run=True,candidates=["original"])
        self.assertEqual((data["checked"],data["failed"],data["written"]),(0,1,0))
        call.assert_not_called()

    def test_preflight_prompt_comes_from_first_new_request_not_reused_json(self):
        self.sidecar(prompt="Historical prompt")
        self.add_image("01_new.png")
        token = self.scan()["source_token"]
        task_id,_ = self.run_task(token,dry_run=True,knowledge="Current knowledge")
        prompt = workspace.task_check_prompt(task_id)
        self.assertIn("01_new.png",prompt["path"])
        self.assertIn("Current knowledge",prompt["prompt"])
        self.assertNotIn("Historical prompt",prompt["prompt"])

    def test_overview_allows_conflicts_but_plans_check_only_actual_writes(self):
        self.add_image("00.jpg")
        token = self.scan()["source_token"]
        app = FastAPI()
        app.include_router(router, prefix="/api")
        with TestClient(app) as client:
            page = client.get(f"/api/tagger/source/{token}/annotations").json()
            self.assertEqual(page["status"], "success")
            self.assertEqual(page["data"]["total"], 2)
            self.assertNotIn("plan", page["data"])
            plan = client.post(f"/api/tagger/source/{token}/caption-plan", json={}).json()
            self.assertEqual(plan["status"], "fail")
            self.assertIn("Conflicting", plan["message"])
            self.image.with_suffix(".txt").write_text("existing", encoding="utf-8")
            self.sidecar()
            plan = client.post(f"/api/tagger/source/{token}/caption-plan", json={}).json()
            self.assertEqual(plan["data"]["plan"]["writes"], 0)
            _, result = self.run_task(token)
            self.assertEqual((result["skipped"], result["written"]), (2, 0))

    def test_local_tagger_and_json_export_do_not_apply_generation_knowledge_rules(self):
        image = self.add_image("_knowledge.png")
        self.sidecar(image)
        token = self.scan()["source_token"]
        plan = workspace.caption_plan(token, {"mode": "export"})
        self.assertEqual(plan["plan"]["writes"], 1)
        _, data = self.run_task(token, mode="export")
        self.assertEqual(data["written"], 1)
        image.with_suffix(".txt").unlink()
        with patch.object(workspace, "_load_local_model"), patch.object(workspace, "_local_tags", return_value=(["test_tag"], {})):
            task_id = workspace.create_task({"source_token": token, "model_id": "camie-tagger-v2"})
            self.assertEqual(self.wait(task_id)["written"], 2)
        self.assertEqual(image.with_suffix(".txt").read_text(encoding="utf-8"), "test_tag")

    def test_unreadable_caption_is_an_item_error_and_can_recover_without_file_changes(self):
        locked = self.image.with_suffix(".txt")
        locked.write_text("locked caption", encoding="utf-8")
        other = self.add_image("01.png")
        other.with_suffix(".txt").write_text("readable caption", encoding="utf-8")
        original_open = Path.open
        def open_file(path, *args, **kwargs):
            if path == locked:
                raise PermissionError("fixture: caption is locked")
            return original_open(path, *args, **kwargs)
        with patch.object(Path, "open", open_file):
            token = self.scan()["source_token"]
            page = workspace.annotations(token)
            self.assertEqual(page["counts"]["total"], 2)
            self.assertEqual(page["counts"]["unreadable_outputs"], 1)
            self.assertEqual(page["items"][0]["caption_kind"], "unreadable")
            self.assertIn("locked", page["items"][0]["read_error"])
            self.assertEqual(workspace.annotations(token, status="ordinary")["total"], 1)
            self.assertEqual(workspace.annotations(token, status="missing")["total"], 0)
            self.assertIn("read_error", workspace.annotation_detail(token, 0))
        page = workspace.annotations(token)
        self.assertEqual(page["counts"]["ordinary_outputs"], 2)
        self.assertNotIn("read_error", page["items"][0])

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

    def test_api_tasks_keep_metadata_without_caption_bodies_or_local_result_cache(self):
        response = {**RESPONSE, "caption": {**RESPONSE["caption"], "long": "Long text " * 20000}}
        self.sidecar(response=response)
        token = self.scan()["source_token"]
        task_id, data = self.run_task(token, mode="export")
        self.assertEqual(data["written"], 1)
        self.assertEqual(data["plan"]["reused"], 1)
        self.assertNotIn("current_result", data)
        self.assertNotIn("results", workspace._tasks[task_id])
        self.assertNotIn("result", workspace.task_items(task_id)["items"][0])
        self.assertLess(len(json.dumps(data)), 16000)
