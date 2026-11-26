"""词典小文件的压缩响应、自动回退与失败落盘回归；不访问公网。"""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from backend.tageditor import dictionary
from backend.utils import hf_download as hf


class DictionaryDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "meta.csv"

    def download(self):
        return hf.download_url_with_fallback(["https://example.invalid/meta.csv"], self.target)

    def test_invalid_multipart_download_does_not_replace_existing_file(self):
        self.target.write_bytes(b"previous valid data")
        def part(url, path, start, end, index, size, progress, stop, expected_total, headers):
            path.write_bytes(b"too long")
            progress[index] = size
        with patch.object(hf, "_PART_MIN", 1), patch.object(hf, "_head_total", return_value=2), \
                patch.object(hf, "_download_part", side_effect=part):
            with self.assertRaises(hf.IntegrityError):
                self.download()
        self.assertEqual(self.target.read_bytes(), b"previous valid data")

    def test_remote_info_falls_back_to_mirror_endpoint(self):
        siblings = [
            SimpleNamespace(rfilename=path, lfs=SimpleNamespace(sha256=f"sha-{idx}"), blob_id=None)
            for idx, (path, _) in enumerate(dictionary.HF_FILES)
        ]
        dataset_info = SimpleNamespace(sha="abc123", siblings=siblings)

        def fake_hf_api(endpoint=None):
            api = MagicMock()
            if endpoint == "https://huggingface.co":
                api.dataset_info.side_effect = OSError("timeout")
            else:
                api.dataset_info.return_value = dataset_info
            return api

        with patch.object(dictionary, "resolve_hf_endpoints", return_value=["https://huggingface.co", "https://hf-mirror.com"]), \
             patch.object(dictionary, "invalidate_hf_cache") as invalidate, \
             patch.object(dictionary, "HfApi", side_effect=fake_hf_api):
            sha, hashes = dictionary._remote_info()

        self.assertEqual(sha, "abc123")
        self.assertEqual(len(hashes), len(dictionary.HF_FILES))
        invalidate.assert_called_once()
