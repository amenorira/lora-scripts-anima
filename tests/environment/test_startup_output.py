import sys
import types
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import launch_utils
from backend import startup_output
from backend.utils import devices


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


class StartupDisplayTests(unittest.TestCase):
    def tearDown(self):
        startup_output.finish_step()

    def test_stages_share_one_live_row_and_ready_stops_it(self):
        from rich.console import Console
        output = StringIO()
        console = Console(file=output, force_terminal=True, width=100)
        retained = []
        print_step = startup_output._print_step

        def retain_step():
            retained.append(startup_output._step)
            print_step()

        with patch.object(startup_output, "console", console), patch.object(startup_output, "_record"), \
             patch.object(startup_output, "_print_step", side_effect=retain_step):
            startup_output.show_step("Loading application")
            live = startup_output._live
            startup_output.show_step("Starting TensorBoard")
            self.assertIs(startup_output._live, live)
            startup_output.show_ready("http://localhost:18888/",
                                      tensorboard_url="http://localhost:18888/tensorboard/",
                                      log_path=Path("logs/anima.log"))
            self.assertIsNone(startup_output._live)
            self.assertFalse(live.is_started)
            startup_output.finish_step()
            self.assertEqual(retained, ["Loading application", "Starting TensorBoard"])
        self.assertIn("READY", output.getvalue())

    def test_redirected_output_keeps_stages_without_terminal_controls(self):
        output = StringIO()
        with patch.object(startup_output, "console", None), \
             patch.object(startup_output, "_record"), redirect_stdout(output):
            startup_output.show_step("Loading application")
            startup_output.show_step("Starting TensorBoard")
        self.assertIn("Loading application", output.getvalue())
        self.assertIn("Starting TensorBoard", output.getvalue())
        self.assertNotIn("\x1b", output.getvalue())
        self.assertIsNone(startup_output._live)


class StartupDiskCheckTests(unittest.TestCase):
    def setUp(self):
        launch_utils._ENV_CHECKED = False

    def tearDown(self):
        launch_utils._ENV_CHECKED = False

    def test_low_disk_warning_explains_the_user_impact(self):
        usage = SimpleNamespace(free=20 * 1024**3)
        with patch.object(launch_utils.shutil, "disk_usage", return_value=usage), patch.object(
            launch_utils.log, "warning"
        ) as warning:
            self.assertEqual(launch_utils.check_environment(), 20)

        self.assertIn("checkpoints need more room", warning.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
