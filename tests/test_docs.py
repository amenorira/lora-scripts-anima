import unittest
from pathlib import PurePosixPath

from fastapi import HTTPException

from backend.server.routes.docs import (
    _document_path,
    _render_markdown,
    _resolve_asset_path,
)


class DocumentationTests(unittest.TestCase):
    def test_loraplus_documents_exist_for_both_locales(self):
        self.assertTrue(_document_path("lora-plus", "zh-CN").is_file())
        self.assertTrue(_document_path("lora-plus", "en-US").is_file())

    def test_markdown_renders_stable_anchors_toc_and_relative_images(self):
        html, toc = _render_markdown(
            "# Guide\n\n## Ratio {#ratio}\n\n![curve](images/curve.png)",
            PurePosixPath("parameters/guide.md"),
        )

        self.assertIn('id="ratio"', html)
        self.assertIn('href="#ratio"', toc)
        self.assertIn('src="/api/docs/assets/parameters/images/curve.png"', html)

    def test_asset_path_rejects_parent_traversal(self):
        with self.assertRaises(HTTPException) as context:
            _resolve_asset_path("../requirements.txt")
        self.assertEqual(context.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
