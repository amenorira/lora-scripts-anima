import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


from backend.tageditor.routes import save_all_tags


class TagEditorBackendTests(unittest.TestCase):
    def test_save_all_reports_each_success_skip_and_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            saved_image = root / "saved.png"
            skipped_image = root / "skipped.png"
            failed_image = root / "failed.png"
            missing_image = root / "missing.png"
            for image_path in (saved_image, skipped_image, failed_image):
                image_path.touch()
            (skipped_image.with_suffix(".txt")).write_text("unchanged", encoding="utf-8")

            real_write_tags = __import__("backend.tageditor.routes", fromlist=["write_tags"]).write_tags

            def selective_write(path, tags):
                if path == failed_image.with_suffix(".txt"):
                    return False
                return real_write_tags(path, tags)

            with patch("backend.tageditor.routes.write_tags", side_effect=selective_write):
                result = asyncio.run(save_all_tags({
                    "dir": str(root),
                    "images": [
                        {"path": str(saved_image), "tags": "saved"},
                        {"path": str(skipped_image), "tags": "unchanged"},
                        {"path": str(failed_image), "tags": "failed"},
                        {"path": str(missing_image), "tags": "missing"},
                    ],
                }))

            data = result["data"]
            self.assertEqual(result["status"], "success")
            self.assertEqual(data["saved"], 0)
            self.assertEqual(data["skipped"], 1)
            self.assertEqual(data["saved_paths"], [])
            self.assertEqual(data["skipped_paths"], [str(skipped_image.resolve())])
            self.assertEqual(
                {item["path"] for item in data["failed"]},
                {str(missing_image)},
            )
            self.assertTrue(data["aborted"])
            self.assertFalse((root / "saved.txt").exists())
            self.assertFalse((root / "failed.txt").exists())
            self.assertFalse(data["rolled_back"])


if __name__ == "__main__":
    unittest.main()
