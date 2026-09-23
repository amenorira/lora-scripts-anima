import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import launch_utils
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
