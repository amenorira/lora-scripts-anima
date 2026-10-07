import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.monitor.monitor import TaskMonitor
from backend.monitor.artifacts import _tail_file
from backend.monitor import training


class ProgressParsingTests(unittest.TestCase):
    def test_new_tensorboard_steps_reload_immediately_even_with_unchanged_mtime(self):
        from tensorboard.backend.event_processing import event_accumulator

        accumulator = Mock()
        with tempfile.TemporaryDirectory() as tmp_dir, patch.dict(training._tb_cache, clear=True), patch.object(
            event_accumulator, "EventAccumulator", return_value=accumulator
        ), patch.object(training.time, "time", return_value=100):
            log_dir = Path(tmp_dir)
            event_file = log_dir / "events.out.tfevents.test"
            event_file.write_bytes(b"step 1")
            stat = event_file.stat()
            self.assertIs(training._get_cached_accumulator(log_dir), accumulator)
            self.assertEqual(accumulator.Reload.call_count, 1)
            training._get_cached_accumulator(log_dir)
            self.assertEqual(accumulator.Reload.call_count, 1)
            # 同一时刻写入下一步：缓存不得再等两秒；粗粒度 mtime 也由文件大小补足。
            event_file.write_bytes(b"step 1\nstep 2")
            os.utime(event_file, ns=(stat.st_atime_ns, stat.st_mtime_ns))
            training._get_cached_accumulator(log_dir)
            self.assertEqual(accumulator.Reload.call_count, 2)
            training._get_cached_accumulator(log_dir)
            self.assertEqual(accumulator.Reload.call_count, 2)

    def test_sparklines_receive_raw_tail_instead_of_resampled_global_curve(self):
        events = [SimpleNamespace(step=step, value=1 + step % 7) for step in range(1000)]
        accumulator = Mock()
        accumulator.Tags.return_value = {"scalars": ["loss/current", "lr/unet"]}
        accumulator.Scalars.return_value = events
        with tempfile.TemporaryDirectory() as tmp_dir, patch.object(
            training, "_get_cached_accumulator", return_value=accumulator
        ):
            (Path(tmp_dir) / "log").mkdir()
            series = {item["tag"]: item for item in training.read_tensorboard_loss(
                run_dir=tmp_dir, downsample_to=64
            )}
        self.assertEqual(len(series["lr/unet"]["points"]), 64)
        self.assertEqual([point["step"] for point in series["lr/unet"]["diagnostic_points"]], list(range(960, 1000)))
        self.assertEqual([point["step"] for point in series["loss/current"]["diagnostic_points"]], list(range(840, 1000)))

    def test_tail_reader_keeps_terminal_overwrite_semantics(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_bytes(b"start\nstep 1\rstep 2\rstep 3\nfinished\n")

            lines = _tail_file(log_path, max_bytes=1024)

        self.assertEqual(lines, ["start", "step 3", "finished"])


class ProgressStateTests(unittest.TestCase):
    def test_partial_updates_keep_previous_fields(self):
        monitor = TaskMonitor()
        first = monitor._merge_progress("task", {
            "step": 0,
            "total_steps": 600,
            "percent": 0,
            "epoch": "1/2",
            "lr": "3.0000e-04",
        })
        second = monitor._merge_progress("task", {
            "step": 1,
            "total_steps": 600,
            "percent": 0.17,
            "loss": "0.113",
            "epoch": None,
            "lr": "",
        })

        self.assertEqual(first["step"], 0)
        self.assertEqual(second["step"], 1)
        self.assertEqual(second["epoch"], "1/2")
        self.assertEqual(second["lr"], "3.0000e-04")
        self.assertEqual(second["loss"], "0.113")


if __name__ == "__main__":
    unittest.main()
