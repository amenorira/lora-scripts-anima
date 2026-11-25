"""Preview rendering, JPEG draft downsampling, EXIF orientation, and decode concurrency tests."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageOps, JpegImagePlugin

from backend.image_preview import (
    PREVIEW_RENDER_VERSION,
    get_cached_preview_path,
    open_preview_source,
)


def _asymmetric_marker_image(width: int, height: int) -> Image.Image:
    """Create a 4-corner color-coded image to verify orientation and mirroring."""
    image = Image.new("RGB", (width, height), (30, 30, 30))
    draw = ImageDraw.Draw(image)
    w3, h3 = max(1, width // 3), max(1, height // 3)
    draw.rectangle([0, 0, w3, h3], fill=(255, 0, 0))
    draw.rectangle([width - w3, 0, width, h3], fill=(0, 255, 0))
    draw.rectangle([0, height - h3, w3, height], fill=(0, 0, 255))
    draw.rectangle([width - w3, height - h3, width, height], fill=(255, 255, 0))
    return image


class ImagePreviewTests(unittest.TestCase):
    def test_preview_render_version_remains_webp_v2(self):
        self.assertEqual(PREVIEW_RENDER_VERSION, "webp-v2")

    def test_exif_orientations_match_full_res_transpose_including_odd_and_panoramic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"

            # All 8 EXIF orientations on an asymmetric 1600x900 JPEG
            base = _asymmetric_marker_image(1600, 900)
            for ori in range(1, 9):
                with self.subTest(orientation=ori):
                    src = root / f"ori_{ori}.jpg"
                    exif = base.getexif()
                    exif[0x0112] = ori
                    base.save(src, quality=92, exif=exif)

                    expected = ImageOps.exif_transpose(base, in_place=False)
                    # Wait: exif_transpose on `base` (no tag) copies; tag it to compute expected orientation.
                    tagged = base.copy()
                    tagged.info["exif"] = exif.tobytes()
                    expected = ImageOps.exif_transpose(tagged)
                    expected.thumbnail((320, 320), Image.Resampling.LANCZOS)

                    rendered = get_cached_preview_path(src, "thumb", cache_dir=cache)
                    with Image.open(rendered) as out:
                        self.assertEqual(out.size, expected.size)
                        w, h = out.size
                        for pt in [(10, 10), (w - 10, 10), (10, h - 10), (w - 10, h - 10)]:
                            got = out.getpixel(pt)
                            exp = expected.getpixel(pt)
                            self.assertTrue(
                                all(abs(g - e) <= 25 for g, e in zip(got, exp)),
                                f"orientation {ori} corner {pt}: got {got}, expected {exp}",
                            )

            # Odd dimensions (3841x2163) and panoramic (4000x600) with Orientation=6 (90 deg CW -> portrait)
            for label, size in [("odd", (3841, 2163)), ("panoramic", (4000, 600))]:
                with self.subTest(case=label):
                    src = root / f"{label}_ori6.jpg"
                    im = _asymmetric_marker_image(*size)
                    ex = im.getexif()
                    ex[0x0112] = 6
                    im.save(src, quality=90, exif=ex)
                    rendered = get_cached_preview_path(src, "thumb", cache_dir=cache)
                    with Image.open(rendered) as out:
                        exp_w = max(1, round(320 * size[1] / size[0]))
                        self.assertEqual(out.size, (exp_w, 320))
                        # Orientation=6 moves top-left red corner to top-right
                        top_right = out.getpixel((max(0, out.width - 5), 5))
                        self.assertGreater(top_right[0], 180)
                        self.assertLess(top_right[1], 60)

    def test_orient_false_preserves_raw_orientation_and_strips_exif(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = root / "crop_ori6.jpg"
            im = _asymmetric_marker_image(1280, 720)
            ex = im.getexif()
            ex[0x0112] = 6
            im.save(src, quality=90, exif=ex)

            rendered = get_cached_preview_path(src, "thumb", cache_dir=root / "cache", orient=False)
            with Image.open(rendered) as out:
                self.assertEqual(out.size, (320, 180))
                self.assertIsNone(out.getexif().get(0x0112))
                self.assertNotIn("exif", out.info)
                # Top-left remains red when unrotated
                tl = out.getpixel((5, 5))
                self.assertGreater(tl[0], 180)
                self.assertLess(tl[1], 60)

    def test_square_jpeg_drafts_at_least_2x_and_runs_lanczos(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            src = root / "square_2560.jpg"
            Image.effect_noise((2560, 2560), 30).convert("RGB").save(src, quality=85)

            draft_calls = []
            resize_calls = []
            orig_draft = JpegImagePlugin.JpegImageFile.draft
            orig_resize = Image.Image.resize

            def spy_draft(self, mode, size):
                res = orig_draft(self, mode, size)
                draft_calls.append((mode, size, self.size, res))
                return res

            def spy_resize(self, size, resample=None, box=None, reducing_gap=None):
                resize_calls.append((self.size, size, resample, box, reducing_gap))
                return orig_resize(self, size, resample=resample, box=box, reducing_gap=reducing_gap)

            with patch.object(JpegImagePlugin.JpegImageFile, "draft", spy_draft), \
                    patch.object(Image.Image, "resize", spy_resize):
                rendered = get_cached_preview_path(src, "thumb", cache_dir=root / "cache")

            self.assertEqual(len(draft_calls), 1)
            self.assertIsNone(draft_calls[0][0])
            self.assertEqual(draft_calls[0][1], (640, 640))
            self.assertEqual(draft_calls[0][2], (640, 640))
            self.assertEqual(len(resize_calls), 1)
            self.assertEqual(resize_calls[0][0], (640, 640))
            self.assertEqual(resize_calls[0][1], (320, 320))
            self.assertEqual(resize_calls[0][2], Image.Resampling.LANCZOS)
            self.assertIsNotNone(resize_calls[0][3])
            with Image.open(rendered) as out:
                self.assertEqual(out.size, (320, 320))

    def test_grayscale_cmyk_icc_and_progressive_jpegs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"

            # Grayscale L JPEG -> draft(None) keeps L mode and lossless=True
            gray = root / "gray.jpg"
            Image.new("L", (1600, 1200), 123).save(gray, quality=90)
            save_orig = Image.Image.save
            save_kwargs = []

            def spy_save(img, fp, *args, **kwargs):
                save_kwargs.append((img.mode, dict(kwargs)))
                return save_orig(img, fp, *args, **kwargs)

            with patch.object(Image.Image, "save", spy_save):
                rendered_gray = get_cached_preview_path(gray, "thumb", cache_dir=cache)
            self.assertEqual(save_kwargs[0][0], "L")
            self.assertTrue(save_kwargs[0][1]["lossless"])
            with Image.open(rendered_gray) as out:
                self.assertEqual(out.size, (320, 240))
                self.assertEqual(out.convert("L").getpixel((10, 10)), 123)

            # CMYK JPEG + ICC profile
            cmyk = root / "cmyk_icc.jpg"
            fake_icc = b"TEST_ICC_PROFILE_BYTES_0123456789"
            Image.new("CMYK", (1600, 1000), (10, 120, 200, 0)).save(cmyk, quality=90, icc_profile=fake_icc)
            rendered_cmyk = get_cached_preview_path(cmyk, "thumb", cache_dir=cache)
            with Image.open(rendered_cmyk) as out:
                self.assertEqual(out.size, (320, 200))
                self.assertEqual(out.info.get("icc_profile"), fake_icc)

            # Progressive JPEG
            prog = root / "prog.jpg"
            _asymmetric_marker_image(2560, 1440).save(prog, quality=85, progressive=True)
            rendered_prog = get_cached_preview_path(prog, "thumb", cache_dir=cache)
            with Image.open(rendered_prog) as out:
                self.assertEqual(out.size, (320, 180))

    def test_inspect_and_small_rotated_images_skip_downscale_and_rotate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"

            # inspect variant (target_size=None) keeps full size and applies EXIF rotation
            full = root / "inspect_ori6.jpg"
            im_full = _asymmetric_marker_image(800, 500)
            ex_full = im_full.getexif()
            ex_full[0x0112] = 6
            im_full.save(full, quality=92, exif=ex_full)
            rendered_inspect = get_cached_preview_path(full, "inspect", cache_dir=cache)
            with Image.open(rendered_inspect) as out:
                self.assertEqual(out.size, (500, 800))

            # Small image (<= target_size) with EXIF=6 skips resize and rotates cleanly
            small = root / "small_ori6.jpg"
            im_small = _asymmetric_marker_image(200, 100)
            ex_small = im_small.getexif()
            ex_small[0x0112] = 6
            im_small.save(small, quality=92, exif=ex_small)
            rendered_small = get_cached_preview_path(small, "thumb", cache_dir=cache)
            with Image.open(rendered_small) as out:
                self.assertEqual(out.size, (100, 200))
                top_right = out.getpixel((95, 5))
                self.assertGreater(top_right[0], 180)
                self.assertLess(top_right[1], 60)

    def test_decode_semaphore_bounds_cold_concurrency_and_skips_cache_hits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            sources = []
            for idx in range(6):
                p = root / f"img_{idx}.png"
                Image.new("RGB", (64, 64), (idx * 30, 100, 150)).save(p)
                sources.append(p)

            active = 0
            max_active = 0
            active_lock = threading.Lock()
            entered_three = threading.Event()

            def slow_open(path):
                nonlocal active, max_active
                with active_lock:
                    active += 1
                    max_active = max(max_active, active)
                    if active == 3:
                        entered_three.set()
                entered_three.wait(timeout=0.5)
                try:
                    return open_preview_source(path)
                finally:
                    with active_lock:
                        active -= 1

            with patch("backend.image_preview.open_preview_source", side_effect=slow_open):
                with ThreadPoolExecutor(max_workers=6) as pool:
                    paths = list(pool.map(lambda p: get_cached_preview_path(p, "thumb", cache_dir=cache), sources))

            self.assertEqual(len(paths), 6)
            self.assertLessEqual(max_active, 3)
            self.assertEqual(max_active, 3)

            # Cache hits must return immediately without touching _decode_semaphore
            with patch("backend.image_preview._decode_semaphore") as mock_sem:
                mock_sem.__enter__.side_effect = AssertionError("cache hit must not acquire semaphore")
                for p in sources:
                    self.assertTrue(get_cached_preview_path(p, "thumb", cache_dir=cache).is_file())

    def test_same_key_concurrent_requests_encode_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            source = root / "same.png"
            Image.new("RGB", (800, 600), "red").save(source)

            save_orig = Image.Image.save
            encodes = 0
            encodes_lock = threading.Lock()

            def spy_save(img, *args, **kwargs):
                nonlocal encodes
                with encodes_lock:
                    encodes += 1
                return save_orig(img, *args, **kwargs)

            with patch.object(Image.Image, "save", spy_save), ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: get_cached_preview_path(source, "thumb", cache_dir=cache), range(6)))

            self.assertEqual(len(set(results)), 1)
            self.assertEqual(encodes, 1)

    def test_rotated_2048x1520_exif6_matches_baseline_across_formats_and_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            base = _asymmetric_marker_image(2048, 1520)

            for mode in ("L", "P", "RGBA"):
                with self.subTest(format="TIFF", mode=mode):
                    src = root / f"ori6_{mode.lower()}.tiff"
                    im = base.convert(mode)
                    ex = im.getexif()
                    ex[0x0112] = 6
                    im.save(src, format="TIFF", exif=ex)

                    with Image.open(src) as baseline_src:
                        expected = ImageOps.exif_transpose(baseline_src)
                        expected.thumbnail((320, 320), Image.Resampling.LANCZOS)

                    rendered = get_cached_preview_path(src, "thumb", cache_dir=cache)
                    with Image.open(rendered) as out:
                        self.assertEqual(out.size, expected.size)

            cases = [
                ("JPEG", "jpg", ("RGB", "L")),
                ("PNG", "png", ("RGB", "RGBA", "P", "L")),
                ("WEBP", "webp", ("RGB", "RGBA", "P", "L")),
            ]
            orig_draft = JpegImagePlugin.JpegImageFile.draft
            for fmt, ext, modes in cases:
                for mode in modes:
                    with self.subTest(format=fmt, mode=mode):
                        src = root / f"ori6_{fmt.lower()}_{mode.lower()}.{ext}"
                        im = base.convert(mode)
                        ex = im.getexif()
                        ex[0x0112] = 6
                        save_kwargs = {"format": fmt, "exif": ex}
                        if fmt == "JPEG":
                            save_kwargs["quality"] = 92
                        elif fmt == "WEBP":
                            save_kwargs["quality"] = 90
                        im.save(src, **save_kwargs)

                        with Image.open(src) as baseline_src:
                            expected = ImageOps.exif_transpose(baseline_src)
                            expected.thumbnail((320, 320), Image.Resampling.LANCZOS)
                        self.assertEqual(expected.size, (237, 320))

                        draft_calls = []

                        def spy_draft(img, draft_mode, size):
                            res = orig_draft(img, draft_mode, size)
                            draft_calls.append((draft_mode, size, res))
                            return res

                        with patch.object(JpegImagePlugin.JpegImageFile, "draft", spy_draft):
                            rendered = get_cached_preview_path(src, "thumb", cache_dir=cache)

                        if fmt == "JPEG":
                            self.assertEqual(len(draft_calls), 1)
                            self.assertIsNone(draft_calls[0][0])
                            self.assertEqual(draft_calls[0][1], (640, 474))
                        else:
                            self.assertEqual(draft_calls, [])

                        with Image.open(rendered) as out:
                            self.assertEqual(out.size, (237, 320))
                            self.assertEqual(out.size, expected.size)
                            if mode != "L":
                                top_right = out.getpixel((out.width - 5, 5))
                                self.assertGreater(top_right[0], 180)
                                self.assertLess(top_right[1], 60)
