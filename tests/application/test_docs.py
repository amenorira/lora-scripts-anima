import re
import unittest
from pathlib import Path, PurePosixPath

from fastapi import HTTPException

from backend.server.routes.docs import (
    _DOCUMENTS,
    _document_path,
    _normalize_locale,
    _render_markdown,
    _resolve_asset_path,
)
from backend.training.field_registry import FIELDS


class DocumentationTests(unittest.TestCase):
    def test_registered_documents_have_unique_heading_ids(self):
        root = Path(__file__).resolve().parents[2] / "docs"
        for slug in _DOCUMENTS:
            for locale in ("zh-CN", "en-US"):
                path = _document_path(slug, locale)
                html, _ = _render_markdown(
                    path.read_text(encoding="utf-8"),
                    PurePosixPath(path.relative_to(root).as_posix()),
                )
                heading_ids = re.findall(r'<h[1-6] id="([^"]+)"', html)
                self.assertEqual(
                    len(heading_ids),
                    len(set(heading_ids)),
                    f"duplicate heading id in {slug} {locale}",
                )

    def test_optimizer_documents_render_registered_field_anchors(self):
        expected_anchors = {
            field["doc_anchor"]
            for field in FIELDS
            if field.get("doc_slug") == "optimizers" and field.get("doc_anchor")
        }
        for locale in ("zh-CN", "en-US"):
            path = _document_path("optimizers", locale)
            html, toc = _render_markdown(
                path.read_text(encoding="utf-8"),
                PurePosixPath(f"parameters/optimizers.{locale}.md"),
            )
            for anchor in expected_anchors:
                self.assertIn(f'id="{anchor}"', html)
                self.assertIn(f'href="#{anchor}"', toc)

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

    def test_unsupported_locale_falls_back_to_chinese(self):
        self.assertEqual(_normalize_locale("fr-FR"), "zh-CN")
        self.assertEqual(
            _document_path("lora-plus", "fr-FR"),
            _document_path("lora-plus", "zh-CN"),
        )

    def test_asset_path_rejects_parent_traversal(self):
        with self.assertRaises(HTTPException) as context:
            _resolve_asset_path("../requirements.txt")
        self.assertEqual(context.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
