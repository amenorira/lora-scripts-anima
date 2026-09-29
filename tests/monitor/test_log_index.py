import tempfile
import unittest
from pathlib import Path

from backend.monitor.artifacts import read_log_slice, read_clean_log_lines


class LogIndexTests(unittest.TestCase):
    def _tmp_path(self) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        return Path(temp_dir.name)

    def test_index_matches_normalization_and_handles_appends(self):
        path = self._tmp_path() / 'train.log'
        path.write_text('INFO start\nsteps: 10%|x| 1/10 [00:01]\nsteps: 10%|x| 1/10 [00:02]\npart', encoding='utf-8')
        self.assertEqual(read_log_slice(path, tail=True)['lines'], read_clean_log_lines(path))
        with path.open('a', encoding='utf-8') as handle:
            handle.write('ial\nnext\n')
        self.assertEqual(read_log_slice(path, tail=True)['lines'], read_clean_log_lines(path))
        path.write_text('rotated\n', encoding='utf-8')
        self.assertEqual(read_log_slice(path)['lines'], ['rotated'])


if __name__ == "__main__":
    unittest.main()
