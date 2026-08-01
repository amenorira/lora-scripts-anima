import io
import logging
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import launch_utils, startup_output
from backend.log import _ConsoleVisibilityFilter
from backend.utils import devices


class StartupRenderingTests(unittest.TestCase):
    def test_plain_output_timestamps_each_major_startup_event(self):
        output = io.StringIO()
        sections = [("Software / 软件", "App test")]
        with patch.object(startup_output, "console", None), patch.object(
            startup_output, "_timestamp", return_value="2026-08-01 12:34:56-123456"
        ), patch.object(startup_output, "_elapsed", return_value="4.2s"), redirect_stdout(output):
            startup_output.show_step("Loading / 加载")
            startup_output.show_environment(sections)
            startup_output.show_ready(
                "http://127.0.0.1:12333/",
                tensorboard_url=None,
                log_path=Path("logs/anima.log"),
            )

        rendered = output.getvalue()
        self.assertIn("2026-08-01 12:34:56-123456  > Loading / 加载", rendered)
        self.assertIn("2026-08-01 12:34:56-123456  Environment / 运行环境", rendered)
        self.assertIn("2026-08-01 12:34:56-123456  READY / 服务已就绪", rendered)
        self.assertIn("Startup:     4.2s", rendered)

    def test_console_filter_keeps_normal_runtime_logs_visible(self):
        visibility_filter = _ConsoleVisibilityFilter()
        normal = logging.LogRecord("test", logging.INFO, "", 0, "download", (), None)
        startup_detail = logging.LogRecord("test", logging.INFO, "", 0, "detail", (), None)
        startup_detail.console = False

        self.assertTrue(visibility_filter.filter(normal))
        self.assertFalse(visibility_filter.filter(startup_detail))


class StartupDeviceSummaryTests(unittest.TestCase):
    def test_successful_probe_returns_structured_summary_without_info_noise(self):
        props = types.SimpleNamespace(
            name="Test GPU",
            total_memory=12 * 1024**3,
            major=12,
            minor=0,
            multi_processor_count=46,
        )
        fake_torch = types.ModuleType("torch")
        fake_torch.__version__ = "2.10.0+cu130"
        fake_torch.version = types.SimpleNamespace(cuda="13.0", hip=None)
        fake_torch.backends = types.SimpleNamespace(
            cudnn=types.SimpleNamespace(is_available=lambda: True, version=lambda: 91200)
        )
        fake_torch.cuda = types.SimpleNamespace(
            is_available=lambda: True,
            device_count=lambda: 1,
            get_device_properties=lambda _pos: props,
            device=lambda pos: f"cuda:{pos}",
        )

        with patch.dict(sys.modules, {"torch": fake_torch}):
            report = devices.check_torch_gpu()

        self.assertEqual(report["torch_version"], "2.10.0+cu130")
        self.assertEqual(report["backend"], "CUDA 13.0")
        self.assertEqual(
            report["gpus"],
            [{"index": 0, "name": "Test GPU", "memory_gb": 12}],
        )
        self.assertEqual(devices.printable_devices, ["GPU 0: Test GPU (12 GB)"])

    def test_unavailable_gpu_keeps_gui_usable_report(self):
        fake_torch = types.ModuleType("torch")
        fake_torch.__version__ = "2.10.0+cu130"
        fake_torch.cuda = types.SimpleNamespace(is_available=lambda: False)

        with patch.dict(sys.modules, {"torch": fake_torch}):
            report = devices.check_torch_gpu()

        self.assertEqual(report["backend"], "CPU")
        self.assertEqual(report["gpus"], [])


class StartupDiskCheckTests(unittest.TestCase):
    def setUp(self):
        launch_utils._ENV_CHECKED = False

    def tearDown(self):
        launch_utils._ENV_CHECKED = False

    def test_healthy_disk_capacity_is_returned_for_the_summary(self):
        usage = SimpleNamespace(free=630 * 1024**3)
        with patch.object(launch_utils.shutil, "disk_usage", return_value=usage):
            self.assertEqual(launch_utils.check_environment(), 630)

    def test_low_disk_warning_explains_the_user_impact(self):
        usage = SimpleNamespace(free=20 * 1024**3)
        with patch.object(launch_utils.shutil, "disk_usage", return_value=usage), patch.object(
            launch_utils.log, "warning"
        ) as warning:
            self.assertEqual(launch_utils.check_environment(), 20)

        self.assertIn("checkpoints need more room", warning.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
