import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from backend.monitor import hardware


class HardwareTests(unittest.TestCase):
    def test_consumers_share_samples_and_cache_missing_gpu(self):
        with patch.object(hardware, "_samples", {}), patch.object(hardware, "_gpu_info_raw", return_value=None) as reader, patch.object(hardware._time, "monotonic", return_value=10) as clock:
            with ThreadPoolExecutor(max_workers=4) as executor:
                self.assertEqual(list(executor.map(hardware.gpu_info, [True] * 20)), [None] * 20)
            self.assertEqual(reader.call_count, 1)
            clock.return_value = 11
            hardware.gpu_info()
            self.assertEqual(reader.call_count, 1)
            hardware.gpu_info(True)
            self.assertEqual(reader.call_count, 2)
            clock.return_value = 16
            hardware.gpu_info()
            self.assertEqual(reader.call_count, 3)
