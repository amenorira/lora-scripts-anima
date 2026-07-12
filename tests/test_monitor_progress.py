import logging
import unittest
from pathlib import Path

from backend.log import log
from backend.monitor.monitor import TaskMonitor, _build_console_progress
from backend.monitor.training import parse_log_progress
from backend.training.supervisor import _build_train_env


class ProgressParsingTests(unittest.TestCase):
    def test_speed_is_taken_from_latest_training_progress_line(self):
        progress = parse_log_progress([
            "cache latents: 100%|##########| 2048/2048 [00:00<00:00, 51025.60it/s]",
            "steps:   1%|#         | 5/600 [00:13<27:06, 2.73s/it, loss=0.0615]",
        ])

        self.assertEqual(progress["step"], 5)
        self.assertEqual(progress["total_steps"], 600)
        self.assertEqual(progress["speed"], "2.73s/it")
        self.assertEqual(progress["loss"], "0.0615")

    def test_speed_is_absent_without_training_progress(self):
        progress = parse_log_progress([
            "cache latents: 100%|##########| 2048/2048 [00:00<00:00, 51025.60it/s]",
        ])

        self.assertNotIn("speed", progress)


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

    def test_cleanup_removes_cached_progress(self):
        monitor = TaskMonitor()
        monitor._merge_progress("task", {"step": 1, "total_steps": 10})

        monitor._cleanup_task("task")

        self.assertNotIn("task", monitor._last_progress)


class ConsoleLoggingTests(unittest.TestCase):
    def test_application_logger_does_not_propagate_to_root(self):
        self.assertFalse(log.propagate)

    def test_tensorboard_info_logging_is_disabled(self):
        self.assertFalse(logging.getLogger("tensorboard").isEnabledFor(logging.INFO))
        self.assertTrue(logging.getLogger("tensorboard").isEnabledFor(logging.WARNING))

    def test_console_progress_is_transient(self):
        progress = _build_console_progress()
        self.assertTrue(progress.live.transient)

    def test_train_env_suppresses_only_known_vendor_syntax_warning(self):
        env = _build_train_env("output/test", "task")
        self.assertIn("ignore:invalid escape sequence:SyntaxWarning", env["PYTHONWARNINGS"])


class MonitorFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.render_source = Path("frontend/js/monitor-render.js").read_text(encoding="utf-8")
        cls.core_source = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")

    def test_statusbar_contains_no_duplicate_detail_metrics(self):
        body = self.render_source.split("_statusbarHtml(d, t) {", 1)[1].split("\n  },", 1)[0]
        for field in ("step", "loss", "lr", "epoch", "elapsed", "eta", "speed"):
            self.assertNotIn(f'data-field="{field}"', body)
        self.assertIn('data-role="progress"', body)
        self.assertIn('data-role="actions"', body)

    def test_overview_uses_live_field_patching(self):
        for field in ("step", "loss", "lr", "epoch", "elapsed", "eta", "speed"):
            self.assertIn(f"['{field}'", self.render_source)
        self.assertIn("this._patchOverviewStatus(d);", self.render_source)
        self.assertIn("(d.state||'')", self.render_source)

    def test_sse_merges_fields_and_updates_state(self):
        self.assertIn("this.monitorData.state = data.status;", self.core_source)
        self.assertIn("Object.prototype.hasOwnProperty.call(progress, key)", self.core_source)


if __name__ == "__main__":
    unittest.main()
