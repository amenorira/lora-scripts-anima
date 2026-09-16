import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.monitor.artifacts import read_log_slice, read_clean_log_lines
from backend.monitor import training


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

    def test_index_does_not_normalize_whole_file_again(self):
        path = self._tmp_path() / 'train.log'
        path.write_text('INFO row\n' * 10000, encoding='utf-8')
        read_log_slice(path, limit=10)
        from backend.monitor.artifacts import _clean_log_text
        with patch('backend.monitor.artifacts._clean_log_text', wraps=_clean_log_text) as normalize:
            page = read_log_slice(path, offset=10, limit=10)
        self.assertEqual(len(page['lines']), 10)
        self.assertEqual(normalize.call_count, 10)

    def test_index_invalidates_search_after_append_and_larger_rewrite(self):
        path = self._tmp_path() / 'train.log'
        path.write_text('old\nmatch\n', encoding='utf-8')
        self.assertEqual(read_log_slice(path, query='match')['match_indices'], [1])
        with path.open('a', encoding='utf-8') as handle:
            handle.write('match again\n')
        self.assertEqual(read_log_slice(path, query='match')['match_indices'], [1, 2])
        path.write_text('replacement content longer than the previous log\n', encoding='utf-8')
        result = read_log_slice(path, query='match')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['match_indices'], [])

    def test_learning_rate_precision_and_raw_diagnostic_window(self):
        tmp_path = self._tmp_path()
        (tmp_path / 'log').mkdir()

        class Accumulator:
            def Tags(self): return {'scalars': ['lr/unet', 'loss/average']}
            def Scalars(self, tag):
                return [SimpleNamespace(step=n, value=1e-7 if tag == 'lr/unet' else 1 / (n + 1)) for n in range(150)]

        with patch.object(training, '_get_cached_accumulator', return_value=Accumulator()):
            series = {s['tag']: s for s in training.read_tensorboard_loss(run_dir=str(tmp_path), downsample_to=10)}
        self.assertEqual(series['lr/unet']['latest'], 1e-7)
        self.assertEqual(len(series['loss/average']['points']), 10)
        self.assertEqual(len(series['loss/average']['diagnostic_points']), 120)


if __name__ == "__main__":
    unittest.main()
