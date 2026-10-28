"""Windows replacement contention must be bounded and preserve existing data."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import call, patch

from backend.utils import file_io


def windows_busy(code=5):
    error = PermissionError("file is busy")
    error.winerror = code
    return error


class AtomicReplacementTests(unittest.TestCase):
    def setUp(self):
        # The compatibility path remains necessary on unsupported filesystems.
        legacy = patch.object(file_io, "_windows", None)
        legacy.start()
        self.addCleanup(legacy.stop)

    def test_transient_windows_contention_retries_only_the_replacement(self):
        for code in (5, 32, 33):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "caption.txt"
                target.write_text("original", encoding="utf-8")
                replace = file_io.os.replace
                attempts = []

                def temporarily_busy(source, destination):
                    attempts.append((source, destination))
                    if len(attempts) < 3:
                        raise windows_busy(code)
                    return replace(source, destination)

                with patch.object(file_io.os, "replace", side_effect=temporarily_busy), \
                        patch.object(file_io.time, "sleep") as sleep:
                    file_io.atomic_write_text(target, "replacement")
                self.assertEqual(len(attempts), 3)
                self.assertEqual(len({source for source, _ in attempts}), 1)
                self.assertEqual(sleep.call_args_list, [call(.02), call(.04)])
                self.assertEqual(target.read_text(encoding="utf-8"), "replacement")
                self.assertEqual(list(target.parent.iterdir()), [target])


    def test_persistent_contention_stops_and_preserves_the_original(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "caption.txt"
            target.write_text("original", encoding="utf-8")
            with patch.object(file_io.os, "replace", side_effect=windows_busy()) as replace, \
                    patch.object(file_io.time, "sleep") as sleep:
                with self.assertRaises(PermissionError):
                    file_io.atomic_write_text(target, "replacement")
            self.assertEqual(replace.call_count, 5)
            self.assertEqual(sleep.call_args_list, [call(.02), call(.04), call(.08), call(.16)])
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(target.parent.iterdir()), [target])


    def test_cancellation_during_retry_preserves_the_original(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "caption.txt"
            target.write_text("original", encoding="utf-8")
            cancelled = threading.Event()

            def cancel_while_waiting(_delay):
                cancelled.set()
                return True

            with patch.object(file_io.os, "replace", side_effect=windows_busy()) as replace, \
                    patch.object(cancelled, "wait", side_effect=cancel_while_waiting):
                with self.assertRaises(InterruptedError):
                    file_io.atomic_write_text(target, "replacement", cancel_event=cancelled)
            self.assertEqual(replace.call_count, 1)
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(list(target.parent.iterdir()), [target])


class SharedReaderTests(unittest.TestCase):


    def test_concurrent_cache_writers_own_different_complete_temporary_files(self):
        from backend.training.cache.krea2_cache import write_manifest

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "manifest.json"
            barrier = threading.Barrier(2)
            sources = []
            replace = file_io.atomic_replace

            def publish_together(source, destination, **options):
                sources.append(source)
                barrier.wait(timeout=10)
                replace(source, destination, **options)

            payloads = [{"writer": index, "content": str(index) * 1000} for index in (1, 2)]
            with patch.object(file_io, "atomic_replace", side_effect=publish_together):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(write_manifest, target, payload) for payload in payloads]
                    for future in futures:
                        future.result(timeout=15)
            self.assertEqual(len(set(sources)), 2)
            self.assertIn(json.loads(file_io.read_text(target)), payloads)
            self.assertEqual(list(target.parent.iterdir()), [target])
