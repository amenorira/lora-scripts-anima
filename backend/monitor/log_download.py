"""Immutable, bounded-memory downloads of logs which may still be growing."""
import os
import tempfile
from pathlib import Path
from urllib.parse import quote

from starlette.responses import StreamingResponse


class _SnapshotResponse(StreamingResponse):
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.snapshot.close()


def snapshot_response(path: Path) -> StreamingResponse:
    snapshot = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode='w+b')
    try:
        with path.open('rb') as source:
            remaining = os.fstat(source.fileno()).st_size
            while remaining:
                chunk = source.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                snapshot.write(chunk)
                remaining -= len(chunk)
        size = snapshot.tell()
        snapshot.seek(0)
    except BaseException:
        snapshot.close()
        raise

    def chunks():
        try:
            while chunk := snapshot.read(64 * 1024):
                yield chunk
        finally:
            snapshot.close()

    response = _SnapshotResponse(
        chunks(), media_type='text/plain; charset=utf-8',
        headers={'Content-Length': str(size),
                 'Content-Disposition': "attachment; filename*=utf-8''" + quote(path.name),
                 'Cache-Control': 'no-store'},
    )
    response.snapshot = snapshot
    return response
