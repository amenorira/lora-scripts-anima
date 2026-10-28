import tempfile
import unittest
import asyncio
from pathlib import Path

from backend.monitor.log_download import snapshot_response


class LogDownloadTests(unittest.IsolatedAsyncioTestCase):

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
