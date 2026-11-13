import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def config(self, **kwargs):
        return captioning.validate_config({"base_url": "http://fixture/v1", "model": "fixture-vlm", "max_retries": 0, **kwargs}, captioning.validate_options({}))

    def runtime(self, **kwargs):
        return captioning.prepare_runtime(captioning.validate_options(kwargs), self.root)

    def test_cancellation_after_response_does_not_write_results(self):
        cancel = threading.Event()
        def returned(*_args, **_kwargs):
            cancel.set()
            return RESPONSE, json.dumps(RESPONSE)
        with patch.object(api_engine, "interrogate", side_effect=returned), self.assertRaises(InterruptedError):
            captioning.process(self.config(), self.image, self.runtime(), cancel_event=cancel)
        self.assertFalse(self.image.with_suffix(".txt").exists())
        self.assertFalse((self.root / "sample_caption.json").exists())


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
