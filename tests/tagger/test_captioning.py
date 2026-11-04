import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image
from backend.tagger import api_engine, captioning

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
        config, runtime = self.config(), self.runtime(reference_extension=".tags", knowledge="Shared identity")
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


    def test_unreadable_record_cannot_trigger_paid_regeneration(self):
        self.seed_json()
        with patch.object(captioning, "read_result", side_effect=PermissionError("record denied")), patch.object(api_engine, "interrogate") as call:
            with self.assertRaises(PermissionError):
                captioning.process(self.config(), self.image, self.runtime(overwrite=True))
            call.assert_not_called()

    def test_plain_caption_generation_regeneration_and_json_export(self):
        self.image.with_suffix(".txt").write_text("original tags", encoding="utf-8")
        config = self.config()
        with patch.object(api_engine, "interrogate", return_value=(RESPONSE, json.dumps(RESPONSE))) as call:
            runtime = self.runtime(output_format="plain", candidates=["long"])
            captioning.process(config, self.image, runtime)
            self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "Long description Visible text\n")
            record = self.root / "sample_caption.json"
            data = json.loads(record.read_text(encoding="utf-8"))
            self.assertEqual(data["response"], RESPONSE)
            self.assertEqual(data["reference"], "original tags")
            captioning.process(config, self.image, self.runtime(output_format="plain", candidates=["short"], overwrite=True))
            self.assertEqual(json.loads(record.read_text(encoding="utf-8"))["reference"], "original tags")
            calls = call.call_count
            captioning.process(config, self.image, self.runtime(mode="export", output_format="plain", candidates=["original"], overwrite=True))
            self.assertEqual(self.image.with_suffix(".txt").read_text(encoding="utf-8"), "original tags\n")
            captioning.process(config, self.image, self.runtime(mode="export", candidates=["long", "short"], overwrite=True))
            self.assertIn("---===--- # long\nLong description", self.image.with_suffix(".txt").read_text(encoding="utf-8"))
            self.assertEqual(call.call_count, calls)

            # A manually replaced ordinary reference is new input, not our prior output.
            self.image.with_suffix(".txt").write_text("new manual reference", encoding="utf-8")
            captioning.process(config, self.image, self.runtime(output_format="plain", candidates=["long"], overwrite=True))
            self.assertEqual(json.loads(record.read_text(encoding="utf-8"))["reference"], "new manual reference")

    def test_plain_preview_and_validation(self):
        with self.assertRaisesRegex(ValueError, "one candidate"):
            self.runtime(output_format="plain", candidates=["long", "short"])
        with patch.object(api_engine, "interrogate", return_value=(RESPONSE, json.dumps(RESPONSE))):
            options = captioning.validate_options({"output_format": "plain", "candidates": ["long"]})
            result = captioning.preview(self.config(), self.image, options)
        self.assertEqual(result["candidates"], {"long": "Long description Visible text"})
        self.assertEqual(result["text"], "Long description Visible text\n")
        with self.assertRaises(captioning.TaggerUserError) as exc:
            captioning.validate_write_targets([self.image], [self.image.with_suffix(".txt"), self.image.with_suffix(".txt")])
        self.assertEqual(exc.exception.code, "caption_output_conflict")
        self.assertEqual(exc.exception.params["path"], str(self.image.with_suffix(".txt")))

    def test_regeneration_preserves_reference_across_paths_formats_and_separators(self):
        for initial_format, next_format, extension in (("plain", "plain", ".caption"), ("multi", "multi", ".txt"), ("multi", "plain", ".txt")):
            with self.subTest(initial=initial_format, next=next_format, extension=extension):
                record = self.root / "sample_caption.json"
                record.unlink(missing_ok=True)
                self.image.with_suffix(".txt").write_text("true original", encoding="utf-8")
                with patch.object(api_engine, "interrogate", return_value=(RESPONSE, json.dumps(RESPONSE))):
                    captioning.process(self.config(), self.image, self.runtime(output_format=initial_format, candidates=["long"], separator="OLD", overwrite=True))
                    captioning.process(self.config(), self.image, self.runtime(output_format=next_format, candidates=["short"], separator="NEW", caption_extension=extension, overwrite=True))
                self.assertEqual(json.loads(record.read_text(encoding="utf-8"))["reference"], "true original")

    def test_plain_ignores_invalid_separator_but_keeps_valid_custom_value(self):
        for separator in ("", "bad\nseparator"):
            options = captioning.validate_options({"output_format": "plain", "candidates": ["long"], "separator": separator})
            self.assertEqual(options["separator"], "---===---")
            with self.assertRaises(captioning.TaggerUserError):
                captioning.validate_options({"output_format": "multi", "separator": separator})
        self.assertEqual(self.runtime(output_format="plain", candidates=["long"], separator="CUSTOM")["options"]["separator"], "CUSTOM")


    def test_three_protocols_preserve_same_json_and_generation_parameters(self):
        for protocol in api_engine.PROTOCOLS:
            with self.subTest(protocol=protocol), Image.open(self.image) as image:
                config = self.config(protocol=protocol, temperature=0, top_p=.8, max_image_size=0, extra_body='{"seed":42}')
                parsed, _ = api_engine.interrogate(config, image, client=self.client())
                self.assertEqual(parsed, RESPONSE)
                body = self.calls[-1]
                self.assertEqual((body["temperature"], body["top_p"], body["seed"]), (0, .8, 42))
                self.assertIn("image/png", json.dumps(body))


    def test_cancellation_after_response_does_not_write_results(self):
        cancel = threading.Event()
        def returned(*_args, **_kwargs):
            cancel.set()
            return RESPONSE, json.dumps(RESPONSE)
        with patch.object(api_engine, "interrogate", side_effect=returned), self.assertRaises(InterruptedError):
            captioning.process(self.config(), self.image, self.runtime(), cancel_event=cancel)
        self.assertFalse(self.image.with_suffix(".txt").exists())
        self.assertFalse((self.root / "sample_caption.json").exists())
