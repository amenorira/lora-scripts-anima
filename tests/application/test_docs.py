import re
import unittest
from pathlib import PurePosixPath

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.constants import DOCS_DIR
from backend.server.routes.docs import _DOCUMENTS, _render_markdown, router


class DocumentationTests(unittest.TestCase):
    def test_markdown_renders_stable_anchors_toc_and_relative_images(self):
        html, toc = _render_markdown(
            "# Guide\n\n<!-- doc-anchor: ratio -->\n## Ratio\n\n### Detail\n\n![curve](images/curve.png)",
            PurePosixPath("parameters/guide.md"),
        )

        self.assertIn('id="ratio"', html)
        self.assertNotIn('href="#guide"', toc)
        self.assertIn('href="#ratio"', toc)
        self.assertIn('href="#detail"', toc)
        self.assertNotIn("doc-anchor", html)
        self.assertNotIn("{#ratio}", html)
        self.assertIn('src="/api/docs/assets/parameters/images/curve.png"', html)

    def test_japanese_guides_render_through_api_with_stable_links_and_local_assets(self):
        app = FastAPI()
        app.include_router(router, prefix="/api")
        with TestClient(app) as client:
            catalog = client.get("/api/docs", params={"locale": "ja-JP"}).json()["data"]
            self.assertEqual(catalog["locale"], "ja-JP")
            self.assertEqual({item["slug"] for item in catalog["documents"]}, set(_DOCUMENTS))
            for item in catalog["documents"]:
                slug = item["slug"]
                with self.subTest(slug=slug):
                    response = client.get(f"/api/docs/{slug}", params={"locale": "ja-JP"})
                    self.assertEqual(response.status_code, 200)
                    document = response.json()["data"]
                    self.assertEqual(document["locale"], "ja-JP")
                    self.assertEqual(document["title"], _DOCUMENTS[slug]["titles"]["ja-JP"])
                    self.assertEqual(document["summary"], item["summary"])
                    self.assertRegex(document["html"], r"[ぁ-んァ-ヶ]")
                    english = (DOCS_DIR / _DOCUMENTS[slug]["files"]["en-US"]).read_text(encoding="utf-8")
                    for anchor in re.findall(r"<!-- doc-anchor: ([\w-]+) -->", english):
                        self.assertIn(f'id="{anchor}"', document["html"])
                    for asset in re.findall(r'src="(/api/docs/assets/[^"<>]+)"', document["html"]):
                        self.assertIn(".ja-JP.jpg", asset)
                        self.assertEqual(client.get(asset).status_code, 200, asset)
            # Switching language changes content without changing the guide's slug or anchors.
            english = client.get("/api/docs/timesteps", params={"locale": "en-US"}).json()["data"]
            japanese = client.get("/api/docs/timesteps", params={"locale": "ja-JP"}).json()["data"]
            self.assertNotEqual(english["html"], japanese["html"])
            self.assertEqual(english["slug"], japanese["slug"])
            self.assertIn('id="subset-offsets"', japanese["html"])
            self.assertEqual(client.get("/api/docs", params={"locale": "unsupported"}).json()["data"]["locale"], "zh-CN")


if __name__ == "__main__":
    unittest.main()
