"""公共 HF 下载器：端点回退、真实 HTTP 分块、超时与跨源续传。"""
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

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

    def test_endpoint_order_supports_both_directions_and_custom_endpoint(self):
        for preferred, expected in [
            ("https://hf-mirror.com", ["https://hf-mirror.com", "https://huggingface.co"]),
            ("https://huggingface.co", ["https://huggingface.co", "https://hf-mirror.com"]),
            ("https://custom.example", ["https://custom.example", "https://hf-mirror.com", "https://huggingface.co"]),
        ]:
            with self.subTest(preferred=preferred), patch.dict("os.environ", {"HF_ENDPOINT": preferred}):
                self.assertEqual(hf._endpoints_for_download(), expected)
        with patch.dict("os.environ", {"HF_ENDPOINT": "https://hf-mirror.com/"}):
            self.assertEqual(len(hf._endpoints_for_download()), 2)

    def test_head_connection_failure_immediately_tries_next_source(self):
        progress, logs = {}, []
        with patch("requests.head", side_effect=[requests.ConnectTimeout("offline"), reply()]) as head, \
                patch("requests.get", return_value=reply()) as get, patch.object(hf.time, "sleep") as sleep:
            hf.download_url_with_fallback(["https://mirror.invalid/file", "https://official.invalid/file"],
                                          self.dest, progress=progress, on_log=logs.append)
        self.assertEqual(head.call_count, 2)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.args[0], "https://official.invalid/file")
        self.assertEqual(progress["source"], "official.invalid")
        self.assertTrue(any("mirror.invalid" in log for log in logs))
        sleep.assert_not_called()

    def test_unknown_size_skips_extra_range_probe(self):
        head_reply = reply(headers={"content-type": "application/octet-stream"})
        with patch("requests.head", return_value=head_reply) as head, patch("requests.get", return_value=reply()) as get:
            hf.download_url_with_fallback(["https://example.invalid/file"], self.dest)
        self.assertEqual(head.call_count, 1)
        self.assertEqual(get.call_count, 1)
        self.assertNotIn("Range", get.call_args.kwargs["headers"])

    def test_interrupted_stream_resumes_on_next_source_without_retry_sleep(self):
        def interrupted(chunk_size):
            yield b"abc"
            raise requests.ConnectionError("read stalled")
        first = reply()
        first.iter_content.side_effect = interrupted
        second = reply(b"def", 206, {"content-range": "bytes 3-5/6", "content-length": "3"})
        with patch.object(hf, "_head_total", return_value=6), \
                patch("requests.get", side_effect=[first, second]) as get:
            hf.download_url_with_fallback(["https://mirror.invalid/file", "https://official.invalid/file"], self.dest)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args.kwargs["headers"]["Range"], "bytes=3-")
        self.assertEqual(self.dest.read_bytes(), b"abcdef")

    def test_wrong_resume_offset_never_replaces_destination(self):
        self.dest.write_bytes(b"original")
        self.dest.with_suffix(".bin.partial").write_bytes(b"abc")
        response = reply(b"xyz", 206, {"content-range": "bytes 0-2/6"})
        with patch.object(hf, "_head_total", return_value=6), patch("requests.get", return_value=response):
            with self.assertRaises(hf.IntegrityError):
                hf.download_url_with_fallback(["https://example.invalid/file"], self.dest)
        self.assertEqual(self.dest.read_bytes(), b"original")

    def test_416_does_not_promote_unverified_partial(self):
        self.dest.with_suffix(".bin.partial").write_bytes(b"stale")
        with patch.object(hf, "_head_total", return_value=0), patch("requests.get", return_value=reply(status=416)):
            with self.assertRaises(hf.IntegrityError):
                hf.download_url_with_fallback(["https://example.invalid/file"], self.dest)
        self.assertFalse(self.dest.exists())

    def test_failed_part_signals_peer_before_waiting_for_executor(self):
        started = threading.Barrier(2)
        stopped = threading.Event()
        def download_part(url, path, start, end, index, size, progress, stop, expected_total):
            started.wait(timeout=2)
            if index == 0:
                raise requests.ConnectionError("connection failed")
            if stop.wait(1):
                stopped.set()
            else:
                raise AssertionError("peer was not cancelled")
        with patch.object(hf, "_PART_MIN", 2), patch.object(hf, "_head_total", return_value=4), \
                patch.object(hf, "_download_part", side_effect=download_part):
            with self.assertRaises(requests.ConnectionError):
                hf.download_url_with_fallback(["https://example.invalid/file"], self.dest)
        self.assertTrue(stopped.is_set())

    def test_changed_remote_total_does_not_publish_partial_file(self):
        self.dest.write_bytes(b"original")
        response = reply(b"ab", 206, {"content-range": "bytes 0-1/8"})
        with patch("requests.get", return_value=response):
            with self.assertRaises(hf.IntegrityError):
                hf._download_part("https://example.invalid/file", self.dest.with_suffix(".part0"),
                                  0, 1, 0, 2, [0], expected_total=6)
        self.assertEqual(self.dest.read_bytes(), b"original")


class HTTPDownloadTests(unittest.TestCase):
    """用真实本机 HTTP 服务器验证并发、服务器忽略 Range 和短超时，不依赖公网。"""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dest = Path(self.temp.name) / "model.bin"
        self.data = bytes(range(256)) * 16
        self.active = self.peak = 0
        self.calls = []
        self.lock = threading.Lock()
        case = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_HEAD(self):
                case.calls.append(("HEAD", self.path))
                if self.path == "/slow":
                    time.sleep(2.5)
                self.send_response(200)
                self.send_header("Content-Length", str(len(case.data)))
                self.end_headers()

            def do_GET(self):
                byte_range = self.headers.get("Range")
                case.calls.append(("GET", self.path, byte_range))
                with case.lock:
                    case.active += 1
                    case.peak = max(case.peak, case.active)
                try:
                    time.sleep(0.05)
                    if byte_range and self.path != "/no-range":
                        start, end = byte_range.removeprefix("bytes=").split("-")
                        start, end = int(start), int(end) if end else len(case.data) - 1
                        body = case.data[start:end + 1]
                        self.send_response(206)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{len(case.data)}")
                    else:
                        body = case.data
                        self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with case.lock:
                        case.active -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.close_server)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=2)

    def test_real_parallel_ranges_reconstruct_original_file(self):
        with patch.object(hf, "_PART_MIN", 1024):
            hf.download_url_with_fallback([self.url + "/file"], self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertGreaterEqual(self.peak, 2)
        self.assertLessEqual(self.peak, 4)
        self.assertEqual(len([c for c in self.calls if c[0] == "GET"]), 4)

    def test_ignored_ranges_fall_back_to_one_full_get(self):
        with patch.object(hf, "_PART_MIN", 1024):
            hf.download_url_with_fallback([self.url + "/no-range"], self.dest)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual(len([c for c in self.calls if c[0] == "GET" and c[2] is None]), 1)
        self.assertEqual(list(self.dest.parent.iterdir()), [self.dest])

    def test_real_head_timeout_switches_in_seconds_without_retries(self):
        started = time.monotonic()
        hf.download_url_with_fallback([self.url + "/slow", self.url + "/file"], self.dest)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 4.5)
        self.assertEqual(self.dest.read_bytes(), self.data)
        self.assertEqual([c for c in self.calls if c[1] == "/slow"], [("HEAD", "/slow")])
