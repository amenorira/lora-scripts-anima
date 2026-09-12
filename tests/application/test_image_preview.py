import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.image_preview import get_cached_preview_path
from backend.server.application import app
from backend.tageditor.sessions import dataset_sessions
from backend.tagger.workspace import scan_source


class SharedImagePreviewTests(unittest.TestCase):
    def test_webp_preview_is_near_lossless_and_mask_modes_are_lossless(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rgb_path = root / "rgb.png"
            Image.new("RGB", (1200, 800), (81, 132, 203)).save(rgb_path)
            gray_path = root / "mask.png"
            gray = Image.new("L", (32, 24))
            gray.putdata([(x * 17 + y * 29) % 256 for y in range(24) for x in range(32)])
            gray.save(gray_path)
            alpha_path = root / "alpha.png"
            Image.new("RGBA", (24, 20), (40, 90, 160, 73)).save(alpha_path)
            cache = root / "cache"

            rgb_preview = get_cached_preview_path(rgb_path, "preview", cache_dir=cache)
            gray_preview = get_cached_preview_path(gray_path, "inspect", cache_dir=cache)
            alpha_preview = get_cached_preview_path(alpha_path, "inspect", cache_dir=cache)

            with Image.open(rgb_preview) as image:
                self.assertEqual(image.format, "WEBP")
                self.assertLessEqual(max(image.size), 960)
            with Image.open(gray_preview) as image:
                self.assertEqual(image.convert("L").tobytes(), gray.tobytes())
            with Image.open(alpha_preview) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.getchannel("A").tobytes(), bytes([73]) * (24 * 20))

    def test_dataset_scope_serves_webp_variants_and_exact_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "sample.png"
            Image.new("RGB", (640, 400), (24, 80, 140)).save(image_path)
            original_bytes = image_path.read_bytes()
            session = dataset_sessions.create(str(root), True)
            client = TestClient(app)
            params = {
                "scope": "dataset",
                "session_id": session.id,
                "path": "sample.png",
            }

            thumb = client.get("/api/image-preview", params={**params, "variant": "thumb"})
            original = client.get("/api/image-preview", params={**params, "variant": "original"})
            denied = client.get("/api/image-preview", params={**params, "path": "missing.png", "variant": "original"})

            self.assertEqual(thumb.status_code, 200)
            self.assertEqual(thumb.headers["content-type"], "image/webp")
            self.assertIn("immutable", thumb.headers["cache-control"])
            self.assertEqual(original.status_code, 200)
            self.assertEqual(original.headers["content-type"], "image/png")
            self.assertEqual(original.content, original_bytes)
            self.assertEqual(denied.status_code, 404)
            cached = client.get("/api/image-preview", params={**params, "variant": "thumb"}, headers={"If-None-Match": thumb.headers["etag"]})
            self.assertEqual(cached.status_code, 304)
            dataset_sessions.delete(session.id)

    def test_artifact_scope_delegates_to_registered_run_resolver(self):
        with tempfile.TemporaryDirectory() as temporary:
            image_path = Path(temporary) / "sample.png"
            Image.new("RGB", (80, 60), (30, 120, 90)).save(image_path)
            client = TestClient(app)
            with patch("backend.monitor.run_registry.resolve_artifact_file", return_value=image_path) as resolver:
                response = client.get("/api/image-preview", params={
                    "scope": "artifact",
                    "run_dir": "runs/example",
                    "path": "sample.png",
                    "variant": "inspect",
                })

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/webp")
            resolver.assert_called_once_with("runs/example", "sample.png")

    def test_tagger_scope_uses_token_capability(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_path = root / "tagger.png"
            Image.new("RGB", (300, 200), (120, 60, 170)).save(image_path)
            source = scan_source(str(root), True)
            client = TestClient(app)
            params = {
                "scope": "tagger",
                "source_token": source["source_token"],
                "index": 0,
                "variant": "thumb",
                "size": 160,
            }

            response = client.get("/api/image-preview", params=params)
            denied = client.get("/api/image-preview", params={**params, "index": 1})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/webp")
            self.assertEqual(denied.status_code, 404)


if __name__ == "__main__":
    unittest.main()
