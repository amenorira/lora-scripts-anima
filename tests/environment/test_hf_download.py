"""Invalid resume offsets, stall fallback, and SHA-256 verification tests."""
import hashlib
import tempfile
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import MagicMock, patch

from backend.utils import hf_download as hf


def reply(data=b"abcdef", status=200, headers=None):
    response = MagicMock()
    response.status_code = status
    response.headers = headers or {"content-length": str(len(data))}
    response.iter_content.return_value = [data] if isinstance(data, bytes) else list(data)
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

    def test_stall_preserves_partial_and_resumes_from_next_source(self):
        slow_resp = reply([b"abc", b"d"], 200, {"content-length": "6"})
        fast_resp = reply(b"ef", 206, {"content-range": "bytes 4-5/6"})

        clock = iter([0.0, 0.5, 11.0, 11.1, 11.2, 11.3])

        def fake_get(url, **kwargs):
            if "slow.invalid" in url:
                return slow_resp
            self.assertEqual(kwargs["headers"].get("Range"), "bytes=4-")
            return fast_resp

        with patch.object(hf, "_head_total", return_value=6), \
             patch.object(hf, "_REPORT_INTERVAL", 0.0), \
             patch.object(hf, "_LOW_SPEED_WINDOW", 5.0), \
             patch.object(hf, "_MIN_SPEED_BYTES", 1024 * 1024), \
             patch.object(hf.time, "monotonic", side_effect=lambda: next(clock, 12.0)), \
             patch("requests.get", side_effect=fake_get):
            out = hf.download_url_with_fallback(
                ["https://slow.invalid/file.bin", "https://fast.invalid/file.bin"],
                self.dest,
                expected_size=6,
            )

        self.assertEqual(out.read_bytes(), b"abcdef")

    def test_sha256_mismatch_clears_temp_and_falls_back_to_valid_source(self):
        self.dest.write_bytes(b"existing")
        bad_payload = b"corrupted"
        good_payload = b"validdata"
        good_sha = hashlib.sha256(good_payload).hexdigest()

        bad_resp = reply(bad_payload, 200, {"content-length": str(len(bad_payload))})
        good_resp = reply(good_payload, 200, {"content-length": str(len(good_payload))})

        with patch.object(hf, "_head_total", return_value=len(good_payload)), \
             patch("requests.get", side_effect=[bad_resp, good_resp]):
            out = hf.download_url_with_fallback(
                ["https://bad.invalid/file", "https://good.invalid/file"],
                self.dest,
                expected_size=len(good_payload),
                expected_sha256=good_sha,
            )

        self.assertEqual(out.read_bytes(), good_payload)
        self.assertFalse(self.dest.with_suffix(".bin.partial").exists())

    def test_public_wheel_fallback_keeps_head_range_and_full_get_anonymous(self):
        urls = ["https://huggingface.co/wheel", "https://github.com/wheel"]
        # Upstream ignores Range, so the downloader also exercises its full GET.
        with patch.object(hf, "_auth_headers") as auth, \
             patch.object(hf, "_PART_MIN", 6), \
             patch("requests.head", side_effect=[OSError("offline"), reply()]) as head, \
             patch("requests.get", side_effect=[reply(), reply()]) as get:
            hf.download_url_with_fallback(urls, self.dest)

        auth.assert_not_called()
        self.assertEqual([call.args[0] for call in head.call_args_list], urls)
        self.assertEqual([call.args[0] for call in get.call_args_list], [urls[1]] * 2)
        for call in head.call_args_list + get.call_args_list:
            self.assertNotIn("Authorization", call.kwargs["headers"])
            self.assertEqual(call.kwargs["headers"]["Accept-Encoding"], "identity")
        self.assertEqual(get.call_args_list[0].kwargs["headers"]["Range"], "bytes=0-5")
        self.assertNotIn("Range", get.call_args_list[1].kwargs["headers"])

    def test_hf_download_preserves_authentication(self):
        url = "https://huggingface.co/repo/resolve/main/file"
        with patch.object(hf, "hf_resolve_urls", return_value=[url]), \
             patch("huggingface_hub.get_token", return_value="test-token"), \
             patch("requests.head", return_value=reply()) as head, \
             patch("requests.get", return_value=reply()) as get:
            hf.download_hf_file("repo", "file", self.dest)
        for request in (head, get):
            self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer test-token")

    def test_slow_final_chunk_promotes_verified_file_without_switching_source(self):
        response = reply([b"abc", b"def"], headers={"content-length": "6"})
        with patch.object(hf, "_head_total", return_value=6), \
             patch.object(hf.time, "monotonic", side_effect=[0, 6, 12]), \
             patch("requests.get", return_value=response) as get:
            hf.download_url_with_fallback(
                ["https://slow.invalid/file", "https://backup.invalid/file"], self.dest,
                expected_sha256=hashlib.sha256(b"abcdef").hexdigest(),
            )
        self.assertEqual(self.dest.read_bytes(), b"abcdef")
        get.assert_called_once()

    def test_speed_window_measures_bursts_across_report_ticks(self):
        # The reporter sees one 256 KiB chunk every eight seconds (32 KiB/s).
        with patch.object(hf, "_LOW_SPEED_WINDOW", 10), patch.object(hf, "_MIN_SPEED_BYTES", 50 * 1024):
            for chunk_size, should_switch in ((256 * 1024, True), (512 * 1024, False)):
                with self.subTest(chunk_size=chunk_size):
                    samples = deque([(0.0, 0)])
                    for tick in range(1, 35):
                        now = tick * 0.3
                        switch = hf._below_speed_window(samples, now, int(now // 8) * chunk_size)
                        self.assertEqual(switch, now >= 10 and should_switch)

    def test_html_200_error_page_rejected_and_falls_back(self):
        html_resp = reply(
            b"<html><body>Maintenance</body></html>",
            200,
            {"content-length": "37", "content-type": "text/html; charset=utf-8"},
        )
        good_resp = reply(
            b"valid-model",
            200,
            {"content-length": "11", "content-type": "application/octet-stream"},
        )
        with patch.object(hf, "_head_total", return_value=0), \
             patch("requests.get", side_effect=[html_resp, good_resp]):
            out = hf.download_url_with_fallback(
                ["https://hijack.invalid/model.bin", "https://good.invalid/model.bin"],
                self.dest,
            )

        self.assertEqual(out.read_bytes(), b"valid-model")
