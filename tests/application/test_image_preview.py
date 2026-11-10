"""Shared preview rendering, deduplication and browser cache contracts."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from starlette.requests import Request

from backend.image_preview import get_cached_preview_path
from backend.server.routes.image_preview import serve_preview_file


class ImagePreviewTests(unittest.TestCase):
    def test_concurrent_requests_encode_once_and_replaced_files_invalidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'image.png'
            Image.new('RGB', (1400, 800), 'red').save(source)
            save = Image.Image.save
            encodes = []

            def record(image, *args, **kwargs):
                encodes.append(kwargs)
                return save(image, *args, **kwargs)

            with patch.object(Image.Image, 'save', record), ThreadPoolExecutor(max_workers=4) as pool:
                paths = list(pool.map(lambda _: get_cached_preview_path(source, cache_dir=root/'cache'), range(8)))
            self.assertEqual(len(set(paths)), 1)
            self.assertEqual(len(encodes), 1)
            self.assertEqual(encodes[0]['quality'], 95)
            self.assertEqual(encodes[0]['method'], 2)
            with Image.open(paths[0]) as image:
                self.assertEqual(image.size, (960, 549))
            Image.new('RGB', (1400, 801), 'blue').save(source)
            self.assertNotEqual(get_cached_preview_path(source, cache_dir=root/'cache'), paths[0])
            self.assertEqual(get_cached_preview_path(source, 'original'), source)

    def test_transparency_and_grayscale_survive_fast_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for mode, color in [('RGBA', (120, 180, 230, 73)), ('L', 127)]:
                source = root / f'{mode}.png'
                Image.new(mode, (128, 64), color).save(source)
                rendered = get_cached_preview_path(source, 'thumb', cache_dir=root/'cache')
                with Image.open(rendered) as image:
                    if mode == 'RGBA':
                        self.assertEqual(image.getpixel((0, 0))[3], 73)
                    else:
                        self.assertEqual(image.convert('L').getpixel((0, 0)), color)

    def test_jpeg_xl_path_reaches_optional_decoder_and_webp_renderer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'image.JXL'
            # Use PNG pixels to exercise the route without requiring an optional codec.
            Image.new('RGB', (32, 16)).save(source, format='PNG')
            with patch('backend.image_preview._register_jpeg_xl_decoders') as register, patch(
                'backend.server.routes.image_preview.get_cached_preview_path',
                partial(get_cached_preview_path, cache_dir=root / 'cache'),
            ):
                response = asyncio.run(serve_preview_file(source, variant='thumb', orient=False))
            register.assert_called_once_with()
            self.assertEqual(response.status_code, 200)
            with Image.open(response.path) as preview:
                self.assertEqual((preview.format, preview.size), ('WEBP', (32, 16)))

    def test_versioned_urls_cache_and_unversioned_urls_revalidate(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'image.png'
            Image.new('RGB', (32, 32)).save(source)

            def request(query=b'', etag=None):
                return Request({'type':'http', 'query_string':query, 'headers':
                                [(b'if-none-match', etag.encode())] if etag else []})

            cached = asyncio.run(serve_preview_file(source, variant='original', request=request(b'v=1')))
            self.assertIn('immutable', cached.headers['cache-control'])
            self.assertEqual(cached.path, source)
            unchanged = asyncio.run(serve_preview_file(source, variant='original', request=request(b'v=1', cached.headers['etag'])))
            self.assertEqual(unchanged.status_code, 304)
            unversioned = asyncio.run(serve_preview_file(source, variant='original', request=request()))
            self.assertEqual(unversioned.headers['cache-control'], 'private, no-cache')
            Image.new('RGB', (64, 64)).save(source)
            changed = asyncio.run(serve_preview_file(source, variant='original', request=request(b'', cached.headers['etag'])))
            self.assertEqual(changed.status_code, 200)
            self.assertNotEqual(changed.headers['etag'], cached.headers['etag'])
