import tempfile
import unittest
import asyncio
from pathlib import Path
from unittest.mock import patch

from backend.monitor.log_download import snapshot_response


class LogDownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_log_download_entry_points_use_snapshots(self):
        from backend.monitor import routes
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'train.log'
            path.write_bytes(b'original\n')
            with patch.object(routes, '_resolve_monitor_log_path', return_value=path):
                log_response = await routes.monitor_log_download(run_dir=directory, task_id='')
            with patch.object(routes, 'resolve_artifact_file', return_value=path):
                output_response = await routes.download_single_output(run_dir=directory, path='train.log')
            try:
                path.write_bytes(b'changed')
                self.assertEqual(log_response.snapshot.read(), b'original\n')
                self.assertEqual(output_response.snapshot.read(), b'original\n')
            finally:
                log_response.snapshot.close()
                output_response.snapshot.close()

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

    async def test_disconnect_closes_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'train.log'
            path.write_bytes(b'content\n')
            response = snapshot_response(path)
            delivered = asyncio.Event()
            async def send(message):
                if message['type'] == 'http.response.body':
                    delivered.set()
                    await asyncio.Future()
            async def receive():
                await delivered.wait()
                return {'type': 'http.disconnect'}
            await response({'type': 'http', 'method': 'GET'}, receive, send)
            self.assertTrue(response.snapshot.closed)
