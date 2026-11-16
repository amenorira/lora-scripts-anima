"""Check crop overlays against actual pixel preprocessing and image capabilities."""
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from backend.training.datasets.crop_preview import inspect_crops, resolve_preview_image


class CropPreviewTests(unittest.TestCase):
    def test_sd_geometry_matches_real_crop_and_handles_bad_images(self):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.utils import load_image, trim_and_resize_if_required

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '1_subject'
            subset.mkdir()
            Image.new('RGB', (181, 257)).save(subset / 'portrait.png')
            Image.new('RGB', (381, 131)).save(subset / 'wide.png')
            (subset / 'broken.png').write_bytes(b'not an image')
            png = (subset / 'portrait.png').read_bytes()
            truncated = subset / 'truncated.png'
            truncated.write_bytes(png[:50])
            no_pixels = subset / 'no_pixels.png'
            no_pixels.write_bytes(png[:33] + png[-12:])  # Signature and IHDR, followed by IEND.
            no_iend = subset / 'no_iend.png'
            no_iend.write_bytes(png[:-12])  # All pixels are present, and training can still decode them.
            truncated_jpeg = subset / 'truncated.jpg'
            Image.new('RGB', (181, 257)).save(truncated_jpeg)
            truncated_jpeg.write_bytes(truncated_jpeg.read_bytes()[:-3])
            for corrupt in (truncated, no_pixels, truncated_jpeg):
                with Image.open(corrupt) as image:
                    self.assertEqual(image.size, (181, 257))
                with self.assertRaises(OSError):
                    load_image(corrupt)
            self.assertEqual(load_image(no_iend).shape, (257, 181, 3))
            for no_upscale in (True, False):
                result = inspect_crops(dict(train_data_dir=str(root), resolution='256,256',
                    enable_bucket=True, bucket_no_upscale=no_upscale, bucket_reso_steps=64,
                    min_bucket_reso=64, max_bucket_reso=512))
                self.assertEqual(len(result['items']), 7)
                self.assertEqual({Path(i['name']).name for i in result['items'] if 'error' in i},
                                 {'broken.png', 'truncated.png', 'no_pixels.png', 'truncated.jpg'})
                for item in result['items']:
                    if 'error' in item:
                        self.assertNotIn('thumb', item)
                        continue
                    rw, rh = item['resized']
                    bw, bh = item['bucket']
                    x, y, w, h = item['crop']
                    pixels = np.arange(rw * rh * 3, dtype=np.uint8).reshape(rh, rw, 3)
                    actual, _, _ = trim_and_resize_if_required(False, pixels, (bw, bh), (rw, rh))
                    left, top = round(x * rw), round(y * rh)
                    np.testing.assert_array_equal(actual, pixels[top:top + round(h * rh), left:left + round(w * rw)])
                    self.assertAlmostEqual(item['crop_percent'], (1 - bw * bh / (rw * rh)) * 100)
                    source = resolve_preview_image(result['session_id'], item['id'])
                    self.assertTrue(source.is_relative_to(root))
                self.assertIsNone(resolve_preview_image(result['session_id'], '../portrait.png'))
                self.assertIsNone(resolve_preview_image('invalid', '0'))
