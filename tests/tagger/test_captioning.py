import base64
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
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

    def config(self, mode="multi-caption", protocol="chat-completions", **kwargs):
        return api_engine.validate_config({"base_url": "http://fixture/v1", "model": "fixture-vlm", "prompt": captioning.upstream.DEFAULT_PROMPT, "parse_mode": mode, "protocol": protocol, "max_retries": 0, "max_tokens": 16384, **kwargs})

    def client(self, text=None):
        def respond(request):
            body = json.loads(request.content)
            self.calls.append(body)
            content = json.dumps(RESPONSE) if text is None else text
            if request.url.path.endswith("/messages"):
                payload = {"content": [{"type": "text", "text": content}], "usage": {"output_tokens": 40}, "stop_reason": "end_turn"}
            elif request.url.path.endswith("/responses"):
                payload = {"output_text": content, "usage": {"output_tokens": 40}}
            else:
                payload = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": {"total_tokens": 40}}
            return httpx.Response(200, json=payload)
        client = httpx.Client(transport=httpx.MockTransport(respond))
        self.addCleanup(client.close)
        return client

    def runtime(self, **kwargs):
        options = captioning.validate_options(kwargs)
        return captioning.prepare_runtime(options, self.root, captioning.upstream.DEFAULT_PROMPT)

    def test_multidescription_reference_knowledge_cache_and_export_share_one_pipeline(self):
        (self.root / "sample.tags").write_text("original tags", encoding="utf-8")
        (self.root / "_knowledge.txt").write_text("Directory identity", encoding="utf-8")
        (self.root / "sample_knowledge.txt").write_text("Image identity", encoding="utf-8")
        config = self.config()
        runtime = self.runtime(reference_extension=".tags", knowledge="Shared identity")
        result = captioning.process(config, self.image, runtime, client=self.client(), write=True)
        self.assertEqual(result["status"], "success")
        data = json.loads((self.root / "sample_caption.json").read_text(encoding="utf-8"))
        self.assertEqual(data["knowledge"], "Shared identity\n\nDirectory identity\n\nImage identity")
        self.assertEqual(data["reference"], "original tags")
        self.assertEqual(data["usage"], {"total_tokens": 40})
        text = self.image.with_suffix(".txt").read_text(encoding="utf-8")
        self.assertIn("# original\noriginal tags", text)
        self.assertIn("Long description\nVisible text", text)
        self.assertEqual(captioning.process(config, self.image, runtime, write=True)["status"], "skipped")
        self.image.with_suffix(".txt").unlink()
        self.assertEqual(captioning.process(config, self.image, runtime, write=True)["event"], "reused")
        runtime = self.runtime(mode="export", candidates=["short"], separator="===", knowledge_file="missing-file-is-unused")
        captioning.process(config, self.image, runtime, write=True)
        self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "=== # short\nShort description\n")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(data, json.loads((self.root / "sample_caption.json").read_text(encoding="utf-8")))

    def test_ai_outputs_keep_underscores_parentheses_and_natural_descriptions(self):
        config = self.config(mode="tags")
        runtime = self.runtime(save_json=False)
        result = captioning.process(config, self.image, runtime, client=self.client("blue_eyes, watermark, (visible text)"), write=True)
        self.assertEqual(result["result"]["text"], "blue_eyes, watermark, (visible text)")
        self.assertFalse((self.root / "sample_caption.json").exists())
        text = "A blue_eyes label, a comma, and (parentheses).\nVisible text."
        result = captioning.process(self.config(mode="caption"), self.image, self.runtime(mode="regenerate"),
                                    client=self.client(text), write=True)
        self.assertEqual(result["result"]["text"], text)

    def test_upstream_json_can_be_exported_without_model_or_api(self):
        (self.root / "sample_caption.json").write_text(json.dumps({"response": RESPONSE, "reference": "reference tags"}), encoding="utf-8")
        config = api_engine.ApiConfig("", "", "", "", parse_mode="multi-caption")
        result = captioning.process(config, self.image, self.runtime(mode="export", candidates=["medium"]), write=True)
        self.assertEqual(result["result"]["text"], "---===--- # medium\nMedium description\n")
        self.assertFalse(self.calls)
        result = captioning.process(config, self.image, self.runtime(mode="export", export_overwrite=False), write=True)
        self.assertEqual(result["status"], "skipped")

    def test_original_only_without_reference_does_not_overwrite_caption(self):
        (self.root / "sample_caption.json").write_text(json.dumps({"response": RESPONSE}), encoding="utf-8")
        self.image.with_suffix(".txt").write_text("keep this caption", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "No selected candidate"):
            captioning.process(self.config(), self.image, self.runtime(mode="export", candidates=["original"]), write=True)
        self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "keep this caption")

    def test_input_check_never_calls_model_or_changes_outputs(self):
        output = self.image.with_suffix(".txt")
        output.write_text("existing", encoding="utf-8")
        result = captioning.process(self.config(), self.image, self.runtime(dry_run=True, knowledge="Known character"), write=True)
        self.assertEqual(result["event"], "checked")
        self.assertIn("Known character", result["prompt"])
        self.assertEqual(output.read_text(encoding="utf-8"), "existing")
        self.assertFalse((self.root / "sample_caption.json").exists())
        self.assertFalse(self.calls)

    def test_all_protocols_support_same_json_format_and_generation_options(self):
        for protocol in api_engine.PROTOCOLS:
            with self.subTest(protocol=protocol):
                config = self.config(protocol=protocol, temperature=0, top_p=.8, max_edge=0, jpeg_quality="", extra_body='{"seed":42}')
                with Image.open(self.image) as image:
                    parsed, raw = api_engine.interrogate(config, image, client=self.client())
                self.assertEqual(parsed[2], RESPONSE["caption"]["short"])
                body = self.calls[-1]
                self.assertEqual(body["temperature"], 0)
                self.assertEqual(body["top_p"], .8)
                self.assertEqual(body["seed"], 42)
                self.assertIn("image/png", json.dumps(body))

    def test_unsafe_outputs_and_incompatible_cached_formats_are_rejected(self):
        for options in ({"caption_extension": ".png"}, {"caption_extension": ".json"}, {"sidecar_suffix": "../result.json"}, {"candidates": []}, {"reference_extension": ".txt"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                captioning.validate_options(options)
        (self.root / "sample_caption.json").write_text(json.dumps({"parse_mode": "tags", "response": {"text": "tags"}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "another output format"):
            captioning.process(self.config(), self.image, self.runtime(mode="export"), write=True)

    def test_hidden_multi_options_do_not_block_other_output_formats(self):
        for mode in ("tags", "caption"):
            (self.root / "sample.tags").write_text("reference tags", encoding="utf-8")
            options = captioning.validate_options({"mode": "regenerate", "candidates": [], "separator": "", "reference_extension": ".tags"}, mode)
            self.assertEqual(options["candidates"], [])
            runtime = captioning.prepare_runtime(options, self.root, "Describe the image.")
            result = captioning.process(self.config(mode=mode), self.image, runtime, client=self.client("A visible subject."), write=True)
            self.assertEqual(result["status"], "success")

    def test_custom_caption_extension_is_used_for_scan_and_pagination(self):
        self.image.with_suffix(".caption").write_text("caption", encoding="utf-8")
        source = workspace.scan_source(str(self.root), caption_extension=".caption")
        self.assertEqual(source["with_caption"], 1)
        self.assertTrue(workspace.source_items(source["source_token"])["items"][0]["has_caption"])

    def test_request_image_honors_exif_orientation_without_modifying_source(self):
        with Image.open(self.image) as image:
            image.getexif()[274] = 6
            encoded = api_engine.encode_image(image, 0, None)
            with Image.open(io.BytesIO(base64.b64decode(encoded.split(",", 1)[1]))) as sent:
                self.assertEqual(sent.size, (32, 48))
            self.assertEqual(image.size, (48, 32))

    def test_prompt_file_overrides_editor_and_malformed_json_is_retried(self):
        template = self.root / "prompt.txt"
        template.write_text("File prompt {{knowledge}}", encoding="utf-8")
        self.assertEqual(captioning.resolve_prompt({"prompt_file": str(template)}, ""), "File prompt {{knowledge}}")
        self.assertEqual(captioning.resolve_prompt({"prompt_file": str(template)}, "editor"), "File prompt {{knowledge}}")
        attempts = []
        def respond(request):
            attempts.append(request)
            text = "invalid JSON" if len(attempts) == 1 else json.dumps(RESPONSE)
            return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})
        with httpx.Client(transport=httpx.MockTransport(respond)) as client, patch.object(api_engine.time, "sleep"):
            with Image.open(self.image) as image:
                parsed, _ = api_engine.interrogate(self.config(max_retries=1), image, client=client)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(parsed[-1], "Short description")

    def test_existing_workspace_task_handles_offline_export_and_restoration(self):
        (self.root / "sample_caption.json").write_text(json.dumps({"response": RESPONSE}), encoding="utf-8")
        source = workspace.scan_source(str(self.root))
        with patch.object(api_engine, "create_client") as create_client:
            task_id = workspace.create_task({"engine": "api", "source_token": source["source_token"], "api": {"parse_mode": "multi-caption"}, "options": {"captioning": {"mode": "export", "candidates": ["short"]}}})
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                snapshot = workspace.task_snapshot(task_id)
                if snapshot["status"] in {"done", "error", "cancelled"}: break
                time.sleep(.02)
            self.assertEqual(snapshot["status"], "done", snapshot)
            self.assertEqual(snapshot["parse_mode"], "multi-caption")
            self.assertEqual(snapshot["caption_options"]["mode"], "export")
            create_client.assert_not_called()
            self.assertTrue(any(line["event"] == "caption_export" for line in snapshot["logs"]))


if __name__ == "__main__":
    unittest.main()
