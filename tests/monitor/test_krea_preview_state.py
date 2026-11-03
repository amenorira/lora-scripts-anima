import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.training.execution import launch_krea2
from tests.training.test_multi_core_krea2 import krea2_config


class KreaPreviewStateTests(unittest.TestCase):
    def test_launch_records_the_actual_preview_setting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for enabled in (False, True):
                with self.subTest(enabled=enabled):
                    case = root / str(enabled)
                    config = krea2_config(case)
                    config['adapter_id'] = 'musubi_lora'
                    config['enable_krea_samples'] = enabled
                    if enabled:
                        config['krea_sample_prompts'] = 'a portrait'
                    task = SimpleNamespace(task_id=f'test-{enabled}', owned_run_paths=[], owned_autosave=None,
                                           launch=Mock(return_value={'status': 'success', 'data': {}}))
                    with patch.object(launch_krea2, 'OUTPUT_DIR', case / 'records'), \
                         patch.object(launch_krea2, 'AUTOSAVE_DIR', case / 'autosave'), \
                         patch.object(launch_krea2, 'krea2_preflight', return_value={'ok': True, 'errors': [], 'cache': {'ready': True}}):
                        result = asyncio.run(launch_krea2.prepare_run(config, None, '20261103-120000', dict(config), task))
                    self.assertEqual(result['status'], 'success')
                    self.assertIs(task.launch.call_args.kwargs['preview_enabled'], enabled)
