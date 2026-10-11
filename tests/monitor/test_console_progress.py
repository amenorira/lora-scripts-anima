import io
import unittest
from unittest.mock import patch

from rich.console import Console
from rich.segment import Segment

from backend.monitor import console_progress
from backend.monitor.monitor import TaskMonitor


class ConsoleProgressTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.console = Console(
            file=self.output, force_terminal=True, width=180,
            legacy_windows=False, color_system=None, _environ={"TERM": "xterm-256color"},
        )
        with patch.object(console_progress, "console", self.console):
            self.progress = console_progress.build_console_progress()
        self.progress.live.auto_refresh = False
        self.task_id = self.progress.add_task(
            "Training dotabyss_siena_came_" + "中文模型" * 8,
            total=800, completed=450, elapsed="28:42", eta="22:19",
            loss="0.0388508", lr="2.0000e-05", epoch="23", speed="3.83s/it",
        )

    def test_rows_stay_single_line_and_restore_details_when_widened(self):
        for width in (180, 120, 80, 60, 30, 12, 80, 180):
            with self.subTest(width=width):
                self.console.width = width
                lines = self.console.render_lines(self.progress.get_renderable(), pad=False)
                self.assertEqual(len(lines), 1)
                self.assertLessEqual(Segment.get_line_length(lines[0]), width - 1)
                text = "".join(segment.text for segment in lines[0])
                if width >= 60:
                    self.assertIn("450/800", text)
                    self.assertIn("loss=0.0388508", text)
                if width == 180:
                    for detail in ("28:42<22:19", "lr=2.0000e-05", "ep=23", "3.83s/it"):
                        self.assertIn(detail, text)

    def test_shrinking_clears_reflowed_rows_before_refresh_or_log(self):
        self.progress.start()
        try:
            cells = self.progress.live._live_render._shape[0]
            for width, log in ((cells, False), (60, False), (180, False), (50, True), (120, False), (40, False)):
                cells, height = self.progress.live._live_render._shape
                self.assertEqual(height, 1)
                self.console.width = width
                self.output.seek(0)
                self.output.truncate()
                if log:
                    self.console.print("checkpoint saved")
                else:
                    self.progress.refresh()
                # Only move above the cursor to erase rows that belonged to the
                # old progress frame; ordinary log history must stay intact.
                rows = cells // width + 1
                reset = "\r\x1b[2K" + "\x1b[1A\x1b[2K" * (rows - 1)
                self.assertTrue(self.output.getvalue().startswith(reset), repr(self.output.getvalue()))
                self.assertEqual(self.progress.live._live_render._shape[1], 1)
                if log:
                    self.assertIn("checkpoint saved\n", self.output.getvalue())
        finally:
            self.console.width = 20  # resize immediately before final cleanup
            self.progress.stop()
        self.assertTrue(self.output.getvalue().endswith("\r\x1b[1A\x1b[2K"))

    def test_monitor_reuses_progress_and_stops_cleanly_after_resize(self):
        self.progress.remove_task(self.task_id)
        monitor = TaskMonitor()
        with patch("backend.monitor.monitor._build_console_progress", return_value=self.progress):
            monitor._update_console_progress("task", {"step": 451, "total_steps": 800, "loss": "0.0611631"}, "model")
            self.console.width = 60
            monitor._update_console_progress("task", {"step": 452, "total_steps": 800}, "model")
            self.assertIs(monitor._console_progress, self.progress)
            self.assertEqual(len(self.progress.tasks), 1)
            monitor._stop_console_progress()
        self.assertFalse(self.progress.live.is_started)
        self.assertIsNone(monitor._console_progress)
        self.assertIsNone(monitor._progress_active_task)


if __name__ == "__main__":
    unittest.main()
