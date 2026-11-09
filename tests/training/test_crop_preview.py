"""Check crop overlays against actual pixel preprocessing and image capabilities."""
from pathlib import Path
import tempfile
import unittest
from itertools import product
from unittest.mock import patch

import numpy as np
from PIL import Image

from backend.image_preview import get_cached_preview_path
from backend.training.datasets.crop_preview import inspect_crops, resolve_preview_image


class CropPreviewTests(unittest.TestCase):
    def test_model_steps_preserve_1280_by_720_at_expected_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '1_subject'
            subset.mkdir()
            Image.new('RGB', (1280, 720)).save(subset / 'image.png')
            for profile, step, expected in [
                ('anima-lora', 16, [1280, 720]),
                ('moss-image-lora', 16, [1280, 720]),
                ('sdxl-lora', 32, [1280, 704]),
            ]:
                with self.subTest(profile=profile):
                    result = inspect_crops(dict(
                        model_train_type=profile, train_data_dir=str(root), resolution='1024,1024',
                        enable_bucket=True, bucket_no_upscale=True, bucket_reso_steps=step,
                        min_bucket_reso=256, max_bucket_reso=2048,
                    ))
                    item = result['items'][0]
                    self.assertEqual(item['resized'], [1280, 720])
                    self.assertEqual(item['bucket'], expected)
                    self.assertAlmostEqual(item['crop_percent'], (1 - expected[1] / 720) * 100)

    def test_sd_configuration_matrix_matches_actual_resize_and_crop(self):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers, _adjust_bucket_range
        manager, _, _ = _sd_dataset_helpers()
        from library.utils import trim_and_resize_if_required, resize_image

        sizes = [(128, 128), (181, 257), (381, 131), (257, 256), (48, 80)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '2_subject'
            subset.mkdir()
            for index, size in enumerate(sizes):
                Image.new('RGB', size).save(subset / f'{index}.png')
            for resolution, step, no_upscale, random_crop in product([(256, 256), (256, 192)], [16, 64], [False, True], [False, True]):
                config = dict(train_data_dir=str(root), resolution=resolution, enable_bucket=True,
                    bucket_no_upscale=no_upscale, bucket_reso_steps=step, random_crop=random_crop,
                    min_bucket_reso=64, max_bucket_reso=512)
                with self.subTest(config=config):
                    result = inspect_crops(config)
                    minimum, maximum = _adjust_bucket_range(resolution, 64, 512, step)
                    selector = manager(no_upscale, resolution, minimum, maximum, step)
                    if not no_upscale:
                        selector.make_buckets()
                    self.assertEqual(result['random_crop'], random_crop)
                    for item in result['items']:
                        original = sizes[int(Path(item['name']).stem)]
                        try:
                            bucket, resized, _ = selector.select_bucket(*original)
                        except ZeroDivisionError:
                            # Smaller than a bucket step: the core cannot form a valid bucket.
                            self.assertIn('error', item)
                            continue
                        if min(bucket) <= 0:
                            self.assertIn('error', item)
                            continue
                        self.assertNotIn('error', item)
                        self.assertEqual(item['bucket'], list(bucket))
                        self.assertEqual(item['resized'], list(resized))
                        ow, oh = original
                        pixels = np.arange(ow * oh * 3, dtype=np.uint8).reshape(oh, ow, 3)
                        scaled = resize_image(pixels, ow, oh, *resized) if resized != original else pixels
                        bw, bh = bucket
                        x, y, w, h = item['crop']
                        left, top = round(x * resized[0]), round(y * resized[1])
                        actual, _, _ = trim_and_resize_if_required(False, pixels, bucket, resized)
                        np.testing.assert_array_equal(actual, scaled[top:top+bh, left:left+bw])
                        self.assertEqual((round(w*resized[0]), round(h*resized[1])), bucket)
                        if random_crop:
                            for end in [0, 1]:
                                with patch('library.utils.random.randint', side_effect=lambda lo, hi: hi if end else lo):
                                    actual, _, _ = trim_and_resize_if_required(True, pixels, bucket, resized)
                                left, top = (resized[0]-bw)*end, (resized[1]-bh)*end
                                np.testing.assert_array_equal(actual, scaled[top:top+bh, left:left+bw])

    def test_krea_configuration_matrix_matches_actual_pixels(self):
        from backend.training.datasets.crop_preview import _krea_selector_class
        selector_class = _krea_selector_class()
        from musubi_tuner.dataset.media_utils import resize_image_to_bucket
        import cv2

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, size in enumerate([(128, 128), (181, 257), (381, 131), (257, 256)]):
                pixels = np.arange(size[0]*size[1]*3, dtype=np.uint8).reshape(size[1], size[0], 3)
                Image.fromarray(pixels).save(root / f'{index}.png')
                (root / f'{index}.txt').write_text('subject')
            for resolution, enabled, no_upscale in product([(256, 256), (256, 192)], [False, True], [False, True]):
                config = dict(model_train_type='krea2-lora', train_data_dir=str(root), dataset_cache_dir=str(root / 'cache'), resolution=resolution,
                    enable_bucket=enabled, bucket_no_upscale=no_upscale, random_crop=True, bucket_reso_steps=64)
                with self.subTest(config=config):
                    result = inspect_crops(config)
                    self.assertFalse(result['random_crop'])  # Not a Krea preprocessing option.
                    selector = selector_class(resolution, enabled, no_upscale)
                    for item in result['items']:
                        self.assertNotIn('error', item)
                        original = tuple(item['original'])
                        bucket = selector.get_bucket_resolution(original)
                        self.assertEqual(item['bucket'], list(bucket))
                        with Image.open(root / item['name']) as source:
                            pixels = np.array(source)
                        actual = resize_image_to_bucket(pixels, bucket)
                        rw, rh = item['resized']
                        if item['scale'] > 1:
                            scaled = np.array(Image.fromarray(pixels).resize((rw, rh), Image.Resampling.LANCZOS))
                        else:
                            scaled = cv2.resize(pixels, (rw, rh), interpolation=cv2.INTER_AREA)
                        x, y, w, h = item['crop']
                        left, top = round(x*rw), round(y*rh)
                        np.testing.assert_array_equal(actual, scaled[top:top+round(h*rh), left:left+round(w*rw)])

    def test_no_bucket_size_boundaries_and_unsupported_face_crop(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '1_subject'
            subset.mkdir()
            for name, size in [('exact', (128, 128)), ('large', (190, 150)), ('small', (64, 128))]:
                Image.new('RGB', size).save(subset / f'{name}.png')
            for random_crop in [False, True]:
                result = inspect_crops(dict(train_data_dir=str(root), resolution='128,128', enable_bucket=False,
                                           random_crop=random_crop, bucket_no_upscale=False))
                items = {Path(item['name']).stem: item for item in result['items']}
                self.assertEqual(items['exact']['crop_percent'], 0)
                self.assertIn('error', items['small'])
                self.assertEqual('error' in items['large'], not random_crop)
            unsupported = inspect_crops(dict(train_data_dir=str(root), resolution='128,128', enable_bucket=False,
                                            face_crop_aug_range=[1, 2]))
            self.assertTrue(all('error' in item for item in unsupported['items']))

    def test_reopen_reuses_urls_but_changed_images_invalidate_browser_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '1_subject'
            subset.mkdir()
            path = subset / 'a.png'
            Image.new('RGB', (128, 128)).save(path)
            config = dict(train_data_dir=str(root), resolution='128,128', enable_bucket=True,
                          min_bucket_reso=64, max_bucket_reso=256)
            first = inspect_crops(config)
            second = inspect_crops(config)
            self.assertEqual(first['session_id'], second['session_id'])
            self.assertEqual(first['items'][0]['preview'], second['items'][0]['preview'])
            Image.new('RGB', (192, 128), 'red').save(path)
            changed = inspect_crops(config)
            self.assertNotEqual(first['items'][0]['preview'], changed['items'][0]['preview'])
            Image.new('RGB', (128, 128)).save(subset / 'b.png')
            expanded = inspect_crops(config)
            self.assertNotEqual(first['session_id'], expanded['session_id'])

    def test_no_upscale_rounds_both_sides_and_matches_trainer_pixels(self):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        from backend.training.datasets.crop_preview import crop_geometry
        manager, _, _ = _sd_dataset_helpers()
        from library.utils import trim_and_resize_if_required

        original = (752, 1328)
        pixels = np.arange(1328 * 752 * 3, dtype=np.uint32).reshape(1328, 752, 3)
        for step, expected in [(64, (704, 1280)), (16, original)]:
            with self.subTest(step=step):
                selector = manager(True, (1024, 1024), 256, 2048, step)
                bucket, resized, _ = selector.select_bucket(*original)
                self.assertEqual(bucket, expected)
                self.assertEqual(resized, original)
                geometry = crop_geometry(original, bucket, resized)
                actual, _, _ = trim_and_resize_if_required(False, pixels, bucket, resized)
                if step == 64:
                    np.testing.assert_array_equal(actual, pixels[24:1304, 24:728])
                    self.assertAlmostEqual(geometry['crop_percent'], 100 * 97536 / 998656)
                else:
                    np.testing.assert_array_equal(actual, pixels)
                    self.assertEqual(geometry['crop_percent'], 0)

    def test_sd_geometry_matches_real_crop_and_handles_bad_images(self):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.utils import trim_and_resize_if_required

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / '1_subject'
            subset.mkdir()
            Image.new('RGB', (181, 257)).save(subset / 'portrait.png')
            Image.new('RGB', (381, 131)).save(subset / 'wide.png')
            (subset / 'broken.png').write_bytes(b'not an image')
            for no_upscale in (True, False):
                result = inspect_crops(dict(train_data_dir=str(root), resolution='256,256',
                    enable_bucket=True, bucket_no_upscale=no_upscale, bucket_reso_steps=64,
                    min_bucket_reso=64, max_bucket_reso=512))
                self.assertEqual(len(result['items']), 3)
                self.assertEqual(sum('error' in i for i in result['items']), 1)
                for item in result['items']:
                    if 'error' in item:
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

    def test_krea_caption_discovery_and_real_bucket(self):
        from backend.training.datasets.crop_preview import _krea_selector_class
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, size in [('portrait', (181, 257)), ('wide', (381, 131)), ('unlabelled', (128, 128))]:
                Image.new('RGB', size).save(root / f'{name}.png')
                if name != 'unlabelled':
                    (root / f'{name}.txt').write_text('subject')
            config = dict(model_train_type='krea2-lora', train_data_dir=str(root),
                          dataset_cache_dir=str(root / 'cache'), resolution='256,256',
                          enable_bucket=True, bucket_no_upscale=True, krea_num_repeats=3)
            result = inspect_crops(config)
            self.assertEqual(len(result['items']), 2)
            selector = _krea_selector_class()((256, 256), True, True)
            for item in result['items']:
                self.assertEqual(tuple(item['bucket']), selector.get_bucket_resolution(tuple(item['original'])))
                self.assertFalse('error' in item)
                self.assertEqual(item['sample_count'], 3)

    def test_repeats_and_regularization_match_step_estimator(self):
        from backend.training.datasets.step_estimator import estimate_training_steps

        for reg_repeats, expected in [(1, [2, 2, 1]), (4, [4, 4])]:
            with self.subTest(reg_repeats=reg_repeats), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                train, reg = root / 'train', root / 'reg'
                (train / '5_subject').mkdir(parents=True)
                (reg / f'{reg_repeats}_regularization').mkdir(parents=True)
                Image.new('RGB', (128, 128)).save(train / '5_subject' / 'train.png')
                for n in range(3):
                    Image.new('RGB', (256, 128)).save(reg / f'{reg_repeats}_regularization' / f'{n}.png')
                config = dict(train_data_dir=str(train), enable_reg_data=True, reg_data_dir=str(reg),
                              resolution='128,128', enable_bucket=True, min_bucket_reso=64, max_bucket_reso=256)
                result = inspect_crops(config)
                regularization = [item for item in result['items'] if item['is_reg']]
                self.assertEqual([item['sample_count'] for item in regularization], expected)
                self.assertEqual(len(result['items']), 1 + len(expected))
                self.assertEqual(result['items'][0]['sample_count'], 5)
                counts = {}
                for item in result['items']:
                    key = tuple(item['bucket'])
                    counts[key] = counts.get(key, 0) + item['sample_count']
                estimate = estimate_training_steps(config)
                self.assertEqual(counts, {tuple(b['resolution']): b['sample_count'] for b in estimate['buckets']})
                self.assertEqual(sum(counts.values()), estimate['repeated_samples'])
                self.assertTrue(resolve_preview_image(result['session_id'], regularization[0]['id']).is_relative_to(reg))
                without_reg = inspect_crops({**config, 'enable_reg_data': False})
                self.assertEqual(len(without_reg['items']), 1)
                self.assertEqual(without_reg['items'][0]['sample_count'], 5)

    def test_no_bucket_does_not_invent_resize(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '1_subject').mkdir()
            Image.new('RGB', (190, 150)).save(root / '1_subject' / 'image.png')
            config = dict(train_data_dir=str(root), resolution='128,128', enable_bucket=False)
            self.assertIn('error', inspect_crops(config)['items'][0])
            result = inspect_crops({**config, 'random_crop': True})
            self.assertTrue(result['random_crop'])
            self.assertEqual(result['items'][0]['resized'], [190, 150])

    def test_training_thumbnails_preserve_raw_orientation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'rotated.jpg'
            exif = Image.Exif()
            exif[274] = 6
            Image.new('RGB', (120, 60)).save(source, exif=exif)
            raw = get_cached_preview_path(source, cache_dir=root / 'cache', orient=False)
            oriented = get_cached_preview_path(source, cache_dir=root / 'cache')
            self.assertNotEqual(raw, oriented)
            with Image.open(raw) as image:
                self.assertEqual(image.size, (120, 60))
                self.assertNotIn(274, image.getexif())
            with Image.open(oriented) as image:
                self.assertEqual(image.size, (60, 120))
