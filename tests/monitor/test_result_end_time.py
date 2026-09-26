import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from backend.monitor.routes import _read_train_result
from backend.training.supervisor import _write_result_json


class ResultEndTimeTests(unittest.TestCase):
    def test_new_result_records_end_time(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            _write_result_json(run_dir, "task", "completed", 0, "", 65)
            result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["duration_str"], "1:05")
            self.assertIsNotNone(datetime.fromisoformat(result["ended_at"]).tzinfo)
            _write_result_json(run_dir, "task", "completed", 0, "", 3950)
            result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["duration_str"], "1:05:50")

    def test_local_legacy_result_uses_file_time_but_imported_result_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            result_file = run_dir / "result.json"
            result_file.write_text('{"status":"completed","duration_str":"1m 5s"}', encoding="utf-8")
            ended_at = datetime(2025, 9, 24, 8, 42, 31, tzinfo=timezone.utc)
            os.utime(result_file, (ended_at.timestamp(), ended_at.timestamp()))
            self.assertEqual(_read_train_result(run_dir)["ended_at"], "2025-09-24T08:42:31+00:00")
            self.assertNotIn("ended_at", _read_train_result(run_dir, allow_mtime_fallback=False))
