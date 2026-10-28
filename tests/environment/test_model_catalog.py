"""Model catalog routing and component classification stay usable offline."""
from pathlib import Path
import tempfile
import unittest

from tools.download_anima_model import MODEL_FILES, _normalize_file, list_local_model_files


class ModelCatalogTests(unittest.TestCase):
    def test_krea2_preview_lora_keeps_its_repository_and_component(self):
        entry = next(item for item in MODEL_FILES if len(item) > 6
                     and item[6] == "environment.animaModel.kreaTurboLora")
        repo, remote, filename, _ = _normalize_file(entry, "Comfy-Org/Krea-2")
        self.assertEqual(repo, "rockerBOO/krea-2-turbo-lora-r64-kohya")
        self.assertEqual(remote, "krea2_turbo_lora_rank_64_bf16_kohya.safetensors")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / filename).write_bytes(b"preview-adapter")
            row = next(item for item in list_local_model_files(root) if item["filename"] == filename)
        self.assertEqual(row["group"], "Krea 2")
        self.assertEqual(row["component_type"], "lora")
        self.assertEqual(row["source_url"], f"https://huggingface.co/{repo}/blob/main/{remote}")
        self.assertTrue(row["exists"])
        self.assertEqual(row["size_bytes"], len(b"preview-adapter"))
        self.assertGreater(row["download_size_bytes"], 0)
