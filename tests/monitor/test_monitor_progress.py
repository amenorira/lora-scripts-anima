import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from backend.monitor.monitor import TaskMonitor
from backend.monitor.artifacts import _tail_file, read_clean_log_lines, read_log_slice
from backend.training.supervisor import _build_train_env


class ProgressParsingTests(unittest.TestCase):
    def test_terminal_width_tqdm_bars_are_compacted_for_web_logs(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_text(
                "steps:   8%|##" + " " * 180 + "| 52/650 [01:04<12:21, 1.24s/it, avr_loss=0.118]\n",
                encoding="utf-8",
            )

            lines = read_clean_log_lines(log_path)

        self.assertEqual(
            lines,
            ["steps:   8%|#---------| 52/650 [01:04<12:21, 1.24s/it, avr_loss=0.118]"],
        )

    def test_adjacent_updates_for_the_same_tqdm_step_keep_the_latest_value(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "train.log"
            log_path.write_text(
                "steps: 64%|######----| 513/800 [39:36<22:09, 4.63s/it, avr_loss=0.0276]\n"
                "steps: 64%|######----| 513/800 [39:36<22:09, 4.63s/it, avr_loss=0.0287]\n"
                "ordinary duplicate\nordinary duplicate\n"
                "steps: 64%|######----| 514/800 [39:40<22:04, 4.63s/it, avr_loss=0.0278]\n",
                encoding="utf-8",
            )

            lines = read_clean_log_lines(log_path)
            page = read_log_slice(log_path, offset=0, limit=20)

        self.assertEqual(lines, page["lines"])
        self.assertEqual(page["total"], 4)
        self.assertEqual(page["lines"][0].split("avr_loss=")[-1], "0.0287]")
        self.assertEqual(page["lines"][1:3], ["ordinary duplicate", "ordinary duplicate"])
        self.assertIn("514/800", page["lines"][3])

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


class ConsoleLoggingTests(unittest.TestCase):
    def test_redirected_rich_log_keeps_message_and_source_columns(self):
        result = subprocess.run(
            [sys.executable, "-c", '''
import logging
from rich.console import Console
from rich.logging import RichHandler
handler = RichHandler(console=Console(stderr=True))
record = logging.LogRecord("test", logging.INFO, "qwen_image_autoencoder_kl.py", 1631,
                           "Loading VAE from ./models/qwen_image_vae.safetensors", (), None)
handler.emit(record)
'''],
            env=_build_train_env("output/test", "task"),
            capture_output=True, text=True, encoding="utf-8", check=True,
        )
        lines = result.stderr.splitlines()
        self.assertEqual(len(lines), 1)
        self.assertIn("Loading VAE from ./models/qwen_image_vae.safetensors", lines[0])
        self.assertIn("qwen_image_autoencoder_kl.py:1631", lines[0])


if __name__ == "__main__":
    unittest.main()
