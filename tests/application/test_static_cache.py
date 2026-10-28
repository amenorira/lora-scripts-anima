"""Frontend upgrades must revalidate assets without losing conditional requests."""
import re
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
from starlette.datastructures import MutableHeaders, URL

from backend.server.application import CachePolicyMiddleware, apply_cache_policy


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

    def test_html_entrypoints_revalidate_and_content_hashed_dictionary_stays_cached(self):
        for path in ("/", "/index.html", "/anima-ui/", "/fallback-route"):
            headers = MutableHeaders({"content-type": "text/html; charset=utf-8"})
            apply_cache_policy(URL(path), headers)
            self.assertEqual(headers["cache-control"], "no-cache, max-age=0")
        for path, expected in (
            ("/api/tageditor/dictionary/asset/core.hash.json?v=core.hash.json", "public, max-age=31536000, immutable"),
            ("/api/tageditor/dictionary/asset/manifest.json?v=legacy", "no-cache, max-age=0"),
        ):
            headers = MutableHeaders()
            apply_cache_policy(URL(path), headers)
            self.assertEqual(headers["cache-control"], expected)

    def test_frontend_no_longer_requests_old_manual_version_urls(self):
        # Dropping the old query changes the cache key on the first upgrade,
        # before the browser has seen the new response cache policy.
        files = [ROOT / "frontend/index.html", * (ROOT / "frontend/js").rglob("*.js"),
                 * (ROOT / "frontend/css").glob("*.css")]
        for file in files:
            with self.subTest(file=file.name):
                self.assertIsNone(re.search(r"\?v=202\d{5}-", file.read_text(encoding="utf-8")))
        index = (ROOT / "frontend/index.html").read_text(encoding="utf-8")
        self.assertIn('src="/anima-ui/js/shared/anima-select.js"', index)

    def test_frontend_entrypoints_and_dynamic_assets_resolve_after_grouping(self):
        from urllib.parse import urljoin
        from backend.server.application import app

        frontend = ROOT / "frontend"
        index = (frontend / "index.html").read_text(encoding="utf-8")
        urls = set(re.findall(r'(?:src|href)="(/anima-ui/[^\"]+)"', index))
        for script in (frontend / "js").rglob("*.js"):
            if "vendor" in script.relative_to(frontend).parts:
                continue
            source = script.read_text(encoding="utf-8")
            urls.update(re.findall(r"(?:fetch|new Worker)\(\s*['\"](/anima-ui/[^'\"]+)['\"]", source))
            base = "/anima-ui/" + script.relative_to(frontend).as_posix()
            urls.update(urljoin(base, value) for value in re.findall(r"importScripts\(\s*['\"]([^'\"]+)['\"]", source))

        # Requests intentionally skip lifespan: asset checks must not launch GPU
        # probes, monitoring, TensorBoard, or the preview worker pool.
        client = TestClient(app)
        for url in sorted(urls):
            with self.subTest(url=url):
                response = client.get(url)
                self.assertEqual(response.status_code, 200)
                if url.endswith(".js"):
                    self.assertIn("javascript", response.headers["content-type"])
                elif url.endswith(".css"):
                    self.assertIn("text/css", response.headers["content-type"])
