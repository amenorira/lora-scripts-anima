import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from backend.server.routes import environment
from tools import download_anima_model as models


class MossModelCatalogTests(unittest.TestCase):
    def test_catalog_has_compatible_variants_and_complete_translations(self):
        root = Path(__file__).parents[2]
        with tempfile.TemporaryDirectory() as directory:
            entries = [item for item in models.list_local_model_files(Path(directory)) if item["group"] == "MOSS-Image"]
        self.assertEqual(len(entries), 8)
        self.assertEqual(len({item["filename"] for item in entries}), 8)
        self.assertEqual(sum(item["filename"].startswith("moss_image_") for item in entries), 4)
        self.assertEqual(sum(item["filename"].startswith("qwen3.5_") for item in entries), 2)
        self.assertEqual(sum(item["filename"].startswith("flux2-vae") for item in entries), 2)
        self.assertEqual([item["component_type"] for item in entries],
                         ["model"] * 4 + ["encoder"] * 2 + ["vae"] * 2)
        for locale in ("zh-CN", "en-US", "ja-JP"):
            messages = json.loads((root / f"frontend/i18n/{locale}.json").read_text(encoding="utf-8"))
            for item in entries:
                with self.subTest(locale=locale, filename=item["filename"]):
                    self.assertEqual(item["repo_id"], "Comfy-Org/MOSS-Image")
                    self.assertNotIn("gptq", item["filename"])
                    self.assertIn("/blob/main/", item["source_url"])
                    message = messages
                    for part in item["desc_key"].split("."):
                        message = message[part]
                    self.assertTrue(message)

    def test_download_api_routes_group_and_single_file_to_the_correct_source(self):
        def fake_download(repo_id, hf_path, dest, **kwargs):
            self.assertEqual(repo_id, "Comfy-Org/MOSS-Image")
            self.assertEqual(Path(hf_path).name, dest.name)
            dest.write_bytes(b"test checkpoint")
            return dest

        for only_file, count in ((None, 8), ("flux2-vae_small.safetensors", 1)):
            with self.subTest(file=only_file), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory)
                with patch.object(environment, "SD_MODELS_DIR", destination), \
                        patch.object(environment, "_download_jobs", {}), \
                        patch.object(environment.threading, "Thread") as thread, \
                        patch("backend.utils.hf_download.make_progress_bar", return_value=MagicMock()), \
                        patch.object(models, "download_hf_file", side_effect=fake_download) as download:
                    thread.return_value.start.side_effect = lambda: thread.call_args.kwargs["target"]()
                    job_id = environment._start_download_job(only_file, "MOSS-Image")
                    snapshot = environment._download_job_snapshot(job_id)
                    self.assertEqual(snapshot["status"], "finished")
                    self.assertTrue(snapshot["success"])
                    self.assertEqual(download.call_count, count)
                    self.assertEqual(snapshot["progress"]["group"], "MOSS-Image")
                    self.assertEqual(len(snapshot["progress"]["batch"]), count)
                    local = [item for item in models.list_local_model_files(destination) if item["group"] == "MOSS-Image"]
                    self.assertEqual(sum(item["exists"] for item in local), count)
