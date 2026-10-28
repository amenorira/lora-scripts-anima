"""词典小文件的压缩响应与失败落盘回归；不访问公网。"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
        def part(url, path, start, end, index, size, progress, stop=None, expected_total=None):
            path.write_bytes(b"too long")
            progress[index] = size
        with patch.object(hf, "_PART_MIN", 1), patch.object(hf, "_head_total", return_value=2), \
                patch.object(hf, "_download_part", side_effect=part):
            with self.assertRaises(hf.IntegrityError):
                self.download()
        self.assertEqual(self.target.read_bytes(), b"previous valid data")
