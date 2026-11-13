"""Invalid resume offsets must preserve an existing download destination."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.utils import hf_download as hf


def reply(data=b"abcdef", status=200, headers=None):
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {"content-length": str(len(data))}
    response.iter_content.return_value = [data]
    response.__enter__.return_value = response
    return response


class HFDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dest = Path(self.temp.name) / "model.bin"

    def test_wrong_resume_offset_never_replaces_destination(self):
        self.dest.write_bytes(b"original")
        self.dest.with_suffix(".bin.partial").write_bytes(b"abc")
        response = reply(b"xyz", 206, {"content-range": "bytes 0-2/6"})
        with patch.object(hf, "_head_total", return_value=6), patch("requests.get", return_value=response):
            with self.assertRaises(hf.IntegrityError):
                hf.download_url_with_fallback(["https://example.invalid/file"], self.dest)
        self.assertEqual(self.dest.read_bytes(), b"original")
