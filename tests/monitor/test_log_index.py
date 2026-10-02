import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.monitor.artifacts import read_log_slice, read_clean_log_lines
from backend.monitor.monitor import TaskMonitor
from backend.monitor import log_index


class LogIndexTests(unittest.TestCase):
    def test_search_cache_scans_only_changed_tail_and_rebuilds_after_rewrite(self):
        path = self._tmp_path() / 'search.log'
        path.write_text(''.join(f'INFO match {n}\n' for n in range(100)) + 'partial', encoding='utf-8')
        self.assertEqual(len(read_log_slice(path, query='match')['match_indices']), 100)
        with path.open('ab') as handle:
            handle.write(b' match\nINFO match new\n')
        with patch.object(log_index, 'clean_bytes', wraps=log_index.clean_bytes) as clean:
            page = read_log_slice(path, limit=1, query='match')
        self.assertEqual(page['match_indices'], list(range(102)))
        self.assertLessEqual(clean.call_count, 5)
        path.write_text('replacement\n', encoding='utf-8')
        self.assertEqual(read_log_slice(path, query='match')['match_indices'], [])

    def test_capped_search_can_be_extended_after_last_match_is_overwritten(self):
        path = self._tmp_path() / 'cap.log'
        path.write_bytes(b'match\nmatch\nmatch\r')
        with patch.object(log_index, 'MAX_SEARCH_MATCHES', 2):
            self.assertTrue(read_log_slice(path, query='match')['matches_truncated'])
            with path.open('ab') as handle:
                handle.write(b'no result\n')
            page = read_log_slice(path, query='match')
            self.assertEqual(page['match_indices'], [0, 1])
            self.assertFalse(page['matches_truncated'])

    def test_partial_frame_remains_separate_from_preceding_step(self):
        path = self._tmp_path() / 'partial.log'
        path.write_bytes(b'INFO start\n\rsteps: 10%|x| 1/10 [avr_loss=.9]\rste')
        monitor = TaskMonitor()
        with patch('backend.monitor.monitor.find_train_log_path', return_value=path):
            self.assertEqual(monitor._read_log_delta('partial')['total'], 3)
            with path.open('ab') as handle:
                handle.write(b'ps: 10%|x| 1/10 [avr_loss=.8]')
            delta = monitor._read_log_delta('partial')
        self.assertEqual(delta['total'], 3)
        self.assertEqual(delta['offset'], 2)
        self.assertIn('avr_loss=.8', delta['lines'][0])
        self.assertEqual(read_log_slice(path)['lines'], read_clean_log_lines(path))

    def test_all_cr_refreshes_survive_pagination_search_and_live_append(self):
        path = self._tmp_path() / 'train.log'
        def step(n, loss):
            return f'\r\x1b[32msteps: {n * 10}%|##| {n}/10 [00:01, avr_loss={loss}]\x1b[0m'
        path.write_bytes(('中文启动\r\n' + step(1, '.9') + step(1, '.8') + step(2, '.7')).encode())
        page = read_log_slice(path)
        self.assertEqual(page['total'], 4)
        self.assertIn('avr_loss=.9', page['lines'][1])
        self.assertIn('avr_loss=.8', page['lines'][2])
        self.assertEqual(page['lines'], read_clean_log_lines(path))
        self.assertEqual(read_log_slice(path, offset=1, limit=1)['lines'], page['lines'][1:2])
        self.assertEqual(read_log_slice(path, query='.8')['match_indices'], [2])
        monitor = TaskMonitor()
        with patch('backend.monitor.monitor.find_train_log_path', return_value=path):
            monitor._read_log_delta('A')
            with path.open('ab') as handle:
                handle.write((step(2, '.6') + step(3, '.5') + '\r\nINFO done\r\n').encode())
            delta = monitor._read_log_delta('A')
        self.assertEqual(delta['offset'], 4)
        self.assertIn('avr_loss=.6', delta['lines'][0])
        self.assertEqual(delta['total'], 7)
        self.assertEqual(read_log_slice(path)['lines'], read_clean_log_lines(path))
        self.assertEqual(read_log_slice(path, query='.7')['match_indices'], [3])

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
        self.assertEqual(monitor._read_log_delta('A')['total'], 4)
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
