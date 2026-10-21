import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image
from backend.tagger import api_engine, captioning, workspace

RESPONSE = {"caption": {"long": "Long description\nVisible text", "medium": "Medium description", "short": "Short description"}, "watermark": [], "borders": ["none"]}


class CaptioningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / "sample.png"
        Image.new("RGB", (48, 32)).save(self.image)
        self.calls = []

    def config(self, **kwargs):
        return captioning.validate_config({"base_url": "http://fixture/v1", "model": "fixture-vlm", "max_retries": 0, **kwargs}, captioning.validate_options({}))

    def runtime(self, **kwargs):
        return captioning.prepare_runtime(captioning.validate_options(kwargs), self.root)

    def seed_json(self, **kwargs):
        path = self.root / "sample_caption.json"
        path.write_text(json.dumps({"response": RESPONSE, **kwargs}), encoding="utf-8")
        return path

    def client(self):
        def respond(request):
            self.calls.append(json.loads(request.content))
            content = json.dumps(RESPONSE)
            if request.url.path.endswith("/messages"):
                payload = {"content": [{"type": "text", "text": content}]}
            elif request.url.path.endswith("/responses"):
                payload = {"output_text": content}
            else:
                payload = {"choices": [{"message": {"content": content}}], "usage": {"total_tokens": 40}}
            return httpx.Response(200, json=payload)
        client = httpx.Client(transport=httpx.MockTransport(respond))
        self.addCleanup(client.close)
        return client

    def test_generation_reference_knowledge_reuse_and_offline_export(self):
        self.image.with_suffix(".tags").write_text("original tags", encoding="utf-8")
        (self.root / "_knowledge.txt").write_text("Directory identity", encoding="utf-8")
        (self.root / "sample_knowledge.txt").write_text("Image identity", encoding="utf-8")
        config, runtime = self.config(), self.runtime(knowledge="Shared identity")
        with patch.object(api_engine, "create_client", return_value=self.client()):
            self.assertEqual(captioning.process(config, self.image, runtime)["status"], "success")
        data = json.loads((self.root / "sample_caption.json").read_text(encoding="utf-8"))
        self.assertEqual(data["knowledge"], "Shared identity\n\nDirectory identity\n\nImage identity")
        self.assertEqual(data["reference"], "original tags")
        self.assertEqual(data["usage"], {"total_tokens": 40})
        text = self.image.with_suffix(".txt").read_text(encoding="utf-8")
        self.assertIn("# original\noriginal tags", text)
        self.assertIn("Long description\nVisible text", text)
        self.assertEqual(captioning.process(config, self.image, runtime)["status"], "skipped")
        self.image.with_suffix(".txt").unlink()
        self.assertEqual(captioning.process(config, self.image, runtime)["event"], "reused")
        captioning.process(config, self.image, self.runtime(mode="export", overwrite=True, candidates=["short"], separator="===", knowledge_file="unused-missing"))
        self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "=== # short\nShort description\n")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(data, json.loads((self.root / "sample_caption.json").read_text(encoding="utf-8")))

    def test_overwrite_retains_original_when_reference_equals_output(self):
        self.image.with_suffix(".txt").write_text("original tags", encoding="utf-8")
        runtime = self.runtime(overwrite=True, reference_extension=".txt")
        for _ in range(2):
            with patch.object(api_engine, "create_client", return_value=self.client()):
                captioning.process(self.config(), self.image, runtime)
            data = json.loads((self.root / "sample_caption.json").read_text(encoding="utf-8"))
            self.assertEqual(data["reference"], "original tags")
        self.assertEqual(len(self.calls), 2)

    def test_export_requires_no_model_and_preserves_existing_output_by_default(self):
        config = captioning.validate_config({}, captioning.validate_options({"mode": "export"}))
        runtime = self.runtime(mode="export", candidates=["medium"])
        with patch.object(api_engine, "interrogate") as interrogate:
            self.assertEqual(captioning.process(config, self.image, runtime)["event"], "missing_json")
            self.seed_json()
            self.assertEqual(captioning.process(config, self.image, runtime)["event"], "reused")
            self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "---===--- # medium\nMedium description\n")
            self.assertEqual(captioning.process(config, self.image, runtime)["status"], "skipped")
            interrogate.assert_not_called()

    def test_original_only_without_reference_cannot_overwrite_with_empty_text(self):
        self.seed_json()
        self.image.with_suffix(".txt").write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "No selected candidate"):
            captioning.process(self.config(), self.image, self.runtime(mode="export", overwrite=True, candidates=["original"]))
        self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "keep")

    def test_input_check_never_calls_model_or_changes_files(self):
        self.image.with_suffix(".txt").write_text("existing", encoding="utf-8")
        options = captioning.validate_options({"dry_run": True, "overwrite": True, "knowledge": "Known character"})
        with patch.object(api_engine, "interrogate") as interrogate:
            result = captioning.process(captioning.validate_config({}, options), self.image, captioning.prepare_runtime(options, self.root))
        self.assertEqual(result["event"], "checked")
        self.assertIn("Known character", result["prompt"])
        self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "existing")
        self.assertFalse((self.root / "sample_caption.json").exists())
        interrogate.assert_not_called()

    def test_three_protocols_preserve_same_json_and_generation_parameters(self):
        for protocol in api_engine.PROTOCOLS:
            with self.subTest(protocol=protocol), Image.open(self.image) as image:
                config = self.config(protocol=protocol, temperature=0, top_p=.8, max_image_size=0, extra_body='{"seed":42}')
                parsed, _ = api_engine.interrogate(config, image, client=self.client())
                self.assertEqual(parsed, RESPONSE)
                body = self.calls[-1]
                self.assertEqual((body["temperature"], body["top_p"], body["seed"]), (0, .8, 42))
                self.assertIn("image/png", json.dumps(body))

    def test_invalid_output_settings_and_legacy_json_are_rejected(self):
        for options in ({"caption_extension": ".png"}, {"caption_extension": ".json"}, {"sidecar_suffix": "../result.json"}, {"candidates": []}, {"reference_extension": ".txt"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                captioning.validate_options(options)
        self.seed_json(parse_mode="tags")
        with self.assertRaisesRegex(ValueError, "Not a MOSS"):
            captioning.process(self.config(), self.image, self.runtime(mode="export"))

    def test_exclusive_prompt_sources_and_automatic_reference_knowledge_append(self):
        template = self.root / "prompt.txt"
        template.write_text("File prompt {{knowledge}}", encoding="utf-8")
        options = captioning.validate_options({"prompt_source": "text", "prompt_text": "Custom", "prompt_file": "unused-missing"})
        self.assertEqual(captioning.resolve_prompt(options), "Custom")
        options.update(prompt_source="file", prompt_file=str(template))
        self.assertEqual(captioning.resolve_prompt(options), "File prompt {{knowledge}}")
        with self.assertRaises(ValueError):
            captioning.validate_options({"prompt_source": "file"})
        self.image.with_suffix(".tags").write_text("reference tags", encoding="utf-8")
        result = captioning.process(self.config(), self.image, self.runtime(dry_run=True, prompt_source="text", prompt_text="Custom", knowledge="Known character"))
        self.assertIn("reference tags", result["prompt"])
        self.assertIn("Known character", result["prompt"])

    def test_malformed_json_is_retried(self):
        attempts = []
        def respond(request):
            attempts.append(request)
            text = "invalid JSON" if len(attempts) == 1 else json.dumps(RESPONSE)
            return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})
        with httpx.Client(transport=httpx.MockTransport(respond)) as client, patch.object(api_engine.time, "sleep"), Image.open(self.image) as image:
            parsed, _ = api_engine.interrogate(self.config(max_retries=1), image, client=client)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(parsed, RESPONSE)

    def test_cancellation_after_response_does_not_write_results(self):
        cancel = threading.Event()
        def returned(*_args, **_kwargs):
            cancel.set()
            return RESPONSE, json.dumps(RESPONSE)
        with patch.object(api_engine, "interrogate", side_effect=returned), self.assertRaises(InterruptedError):
            captioning.process(self.config(), self.image, self.runtime(), cancel_event=cancel)
        self.assertFalse(self.image.with_suffix(".txt").exists())
        self.assertFalse((self.root / "sample_caption.json").exists())

    def test_preflight_counts_and_custom_extension_pagination(self):
        self.image.with_suffix(".tags").write_text("tags", encoding="utf-8")
        self.image.with_suffix(".caption").write_text("ordinary caption", encoding="utf-8")
        self.seed_json()
        source = workspace.scan_source(str(self.root), caption_extension=".caption", caption_options={})
        self.assertEqual((source["with_caption"], source["references"], source["sidecars"], source["ordinary_outputs"]), (1, 1, 1, 1))
        self.assertTrue(workspace.source_items(source["source_token"])["items"][0]["has_caption"])
        self.image.with_suffix(".caption").write_text("---===--- # long\nDescription\n", encoding="utf-8")
        self.assertEqual(workspace.scan_source(str(self.root), caption_extension=".caption", caption_options={})["ordinary_outputs"], 0)

    def test_workspace_offline_export_restores_options(self):
        self.seed_json()
        source = workspace.scan_source(str(self.root))
        with patch.object(api_engine, "create_client") as create_client:
            task_id = workspace.create_task({"engine": "api", "source_token": source["source_token"], "options": {"captioning": {"mode": "export", "candidates": ["short"]}}})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                snapshot = workspace.task_snapshot(task_id)
                if snapshot["status"] in {"done", "error", "cancelled"}: break
                time.sleep(.02)
            self.assertEqual(snapshot["status"], "done", snapshot)
            self.assertEqual(snapshot["caption_options"]["mode"], "export")
            self.assertNotIn("api_payload", snapshot)
            create_client.assert_not_called()
            self.assertTrue(any(line["event"] == "caption_export" for line in snapshot["logs"]))
