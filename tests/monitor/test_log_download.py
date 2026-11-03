import tempfile
import unittest
import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from backend.monitor.log_download import snapshot_response
from backend.monitor import routes


class LogDownloadTests(unittest.IsolatedAsyncioTestCase):

    async def test_download_reports_missing_sources_and_snapshot_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'training.log'
            with patch.object(routes, '_resolve_monitor_log_path', return_value=path):
                missing = await routes.monitor_log_download(run_dir='output/run', task_id='')
                self.assertEqual(missing.status_code, 404)
                self.assertEqual(json.loads(missing.body)['error_code'], 'monitorLogNotFound')
                path.write_text('log', encoding='utf-8')
                with patch('backend.monitor.log_download.snapshot_response', side_effect=OSError('disk full')):
                    failed = await routes.monitor_log_download(run_dir='output/run', task_id='')
                self.assertEqual(failed.status_code, 500)
                self.assertEqual(json.loads(failed.body)['error_code'], 'monitorLogAccessFailed')
                self.assertIn('disk full', json.loads(failed.body)['error_details'])

    async def test_preview_metadata_errors_have_codes_and_keep_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sample.png'
            with patch.object(routes, 'resolve_artifact_file', return_value=path):
                missing = await routes.monitor_preview_metadata(run_dir='output/run', path='sample.png', request=None)
                self.assertEqual(missing['error_code'], 'monitorPreviewNotFound')
                path.write_bytes(b'not an image')
                invalid = await routes.monitor_preview_metadata(run_dir='output/run', path='sample.png', request=None)
                self.assertEqual(invalid['error_code'], 'monitorMetadataReadFailed')
                self.assertTrue(invalid['error_details'])
                with patch.object(Path, 'stat', side_effect=FileNotFoundError('moved')):
                    moved = await routes.monitor_preview_metadata(run_dir='output/run', path='sample.png', request=None)
                self.assertEqual(moved['error_code'], 'monitorPreviewNotFound')
                with patch.object(Path, 'stat', side_effect=PermissionError('denied')):
                    denied = await routes.monitor_preview_metadata(run_dir='output/run', path='sample.png', request=None)
                self.assertEqual(denied['error_code'], 'monitorMetadataReadFailed')
                self.assertIn('denied', denied['error_details'])

    async def test_download_is_immutable_after_append_or_truncate(self):
        for content in (b'original\n', b'x' * (1024 * 1024 + 1)):
            with self.subTest(size=len(content)), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / '训练.log'
                path.write_bytes(content)
                response = snapshot_response(path)
                with path.open('ab') as stream:
                    stream.write(b'new data\n')
                path.write_bytes(b'replaced\n')
                sent = []
                async def send(message):
                    sent.append(message)
                async def receive():
                    await asyncio.Future()
                await response({'type': 'http', 'method': 'GET'}, receive, send)
                body = b''.join(m.get('body', b'') for m in sent)
                self.assertEqual(body, content)
                self.assertEqual(int(dict(sent[0]['headers'])[b'content-length']), len(body))
                self.assertIn("filename*=utf-8''", response.headers['content-disposition'])
                self.assertTrue(response.snapshot.closed)
