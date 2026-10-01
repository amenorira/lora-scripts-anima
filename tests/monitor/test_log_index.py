import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.monitor.artifacts import read_log_slice, read_clean_log_lines
from backend.monitor.monitor import TaskMonitor


class LogIndexTests(unittest.TestCase):
    def _tmp_path(self) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        return Path(temp_dir.name)

    def test_index_matches_normalization_and_handles_appends(self):
        path = self._tmp_path() / 'train.log'
        monitor = TaskMonitor()
        log_path = patch('backend.monitor.monitor.find_train_log_path', return_value=path)
        log_path.start()
        self.addCleanup(log_path.stop)
        path.write_text('INFO start\nsteps: 10%|x| 1/10 [00:01]\nsteps: 10%|x| 1/10 [00:02]\npart', encoding='utf-8')
        self.assertEqual(read_log_slice(path, tail=True)['lines'], read_clean_log_lines(path))
        self.assertEqual(monitor._read_log_delta('A')['total'], 3)
        self.assertIsNone(monitor._read_log_delta('A'))
        with path.open('a', encoding='utf-8') as handle:
            handle.write('ial\nnext\n')
        self.assertEqual(read_log_slice(path, tail=True)['lines'], read_clean_log_lines(path))
        self.assertEqual(monitor._read_log_delta('A')['lines'], ['partial', 'next'])
        for text in ['rotated\n', 'another\n', 'rewritten\nlonger\nfile\n']:
            path.write_text(text, encoding='utf-8')
            self.assertEqual(read_log_slice(path)['lines'], text.splitlines())
            delta = monitor._read_log_delta('A')
            self.assertTrue(delta['reset'])
            self.assertEqual(delta['offset'], 0)


if __name__ == "__main__":
    unittest.main()
