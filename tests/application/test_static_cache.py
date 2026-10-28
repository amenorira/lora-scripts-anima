"""Frontend upgrades must revalidate assets without losing conditional requests."""
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from backend.server.application import CachePolicyMiddleware


ROOT = Path(__file__).resolve().parents[2]


class StaticCacheTests(unittest.TestCase):
    def test_assets_revalidate_and_changed_content_replaces_cached_response(self):
        with tempfile.TemporaryDirectory() as directory:
            asset = Path(directory) / "app.js"
            asset.write_text("old script", encoding="utf-8")
            app = FastAPI()
            app.add_middleware(CachePolicyMiddleware)
            app.mount("/anima-ui", StaticFiles(directory=directory))
            with TestClient(app) as client:
                for suffix in ("", "?v=old-manual-version"):
                    url = "/anima-ui/app.js" + suffix
                    first = client.get(url)
                    self.assertEqual(first.headers["cache-control"], "no-cache, max-age=0")
                    headers = {"If-None-Match": first.headers["etag"]}
                    same = client.get(url, headers=headers)
                    self.assertEqual(same.status_code, 304)
                    self.assertEqual(same.headers["cache-control"], "no-cache, max-age=0")
                    asset.write_text(asset.read_text(encoding="utf-8") + " updated", encoding="utf-8")
                    changed = client.get(url, headers=headers)
                    self.assertEqual(changed.status_code, 200)
                    self.assertNotEqual(changed.headers["etag"], first.headers["etag"])
                    self.assertTrue(changed.text.endswith(" updated"))
