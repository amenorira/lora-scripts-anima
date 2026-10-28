"""Windows replacement contention must be bounded and preserve existing data."""
import json
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

    def test_other_permission_errors_fail_without_waiting(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "caption.txt"
            target.write_text("original", encoding="utf-8")
            with patch.object(file_io.os, "replace", side_effect=PermissionError("denied")) as replace, \
                    patch.object(file_io.time, "sleep") as sleep:
                with self.assertRaises(PermissionError):
                    file_io.atomic_write_text(target, "replacement")
            self.assertEqual(replace.call_count, 1)
            sleep.assert_not_called()
            self.assertEqual(target.read_text(encoding="utf-8"), "original")

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

    def test_generation_and_training_manifests_use_the_shared_retry(self):
        from backend.regularization.storage import atomic_write
        from backend.training.cache.krea2_cache import write_manifest

        publishers = (
            lambda target, payload: atomic_write(target, json.dumps(payload).encode("utf-8")),
            write_manifest,
        )
        for publish in publishers:
            with self.subTest(publish=publish), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "manifest.json"
                target.write_text('{"version": 0}', encoding="utf-8")
                replace = file_io.os.replace
                attempts = []

                def temporarily_busy(source, destination):
                    attempts.append((source, destination))
                    if len(attempts) == 1:
                        raise windows_busy()
                    return replace(source, destination)

                with patch.object(file_io.os, "replace", side_effect=temporarily_busy), \
                        patch.object(file_io.time, "sleep"):
                    publish(target, {"version": 1})
                self.assertEqual(len(attempts), 2)
                self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"version": 1})
                self.assertEqual(list(target.parent.iterdir()), [target])
