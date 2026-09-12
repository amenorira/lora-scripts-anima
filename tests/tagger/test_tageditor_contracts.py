import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.tageditor.core import (
    _invalidate_cache,
    get_cached_scan_dataset,
)
from backend.tageditor.routes import _resolve_target_images, save_all_tags, save_image_tags


class TagEditorBackendTests(unittest.TestCase):
    def test_dataset_scan_returns_images_and_tag_frequency_together(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "a.png").touch()
            (root / "a.txt").write_text("cat, blue eyes", encoding="utf-8")
            (root / "b.jpg").touch()
            (root / "b.txt").write_text("cat", encoding="utf-8")

            images, tags = get_cached_scan_dataset(root)

            self.assertEqual(len(images), 2)
            self.assertEqual(tags, [
                {"tag": "cat", "count": 2},
                {"tag": "blue eyes", "count": 1},
            ])
            self.assertNotIn("thumbnail", images[0])
            self.assertNotIn("preview", images[0])
            _invalidate_cache(root)

    def test_batch_scope_resolves_selected_and_rejects_unknown_scope(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            selected = root / "selected.png"
            selected.touch()

            images, error = _resolve_target_images(
                {"scope": "selected", "selected_paths": [str(selected)]}, root
            )
            self.assertIsNone(error)
            self.assertEqual([item["path"] for item in images], [str(selected)])

            images, error = _resolve_target_images({"scope": "unknown"}, root)
            self.assertEqual(images, [])
            self.assertIn("无效", error)

    def test_save_all_writes_captions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            image_path = root / "sample.png"
            image_path.touch()

            result = asyncio.run(save_all_tags({
                "dir": str(root),
                "images": [{"path": str(image_path), "tags": "cat, smile"}],
            }))

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["data"]["saved"], 1)
            self.assertEqual(result["data"]["saved_paths"], [str(image_path.resolve())])
            self.assertEqual(result["data"]["failed"], [])
            self.assertEqual((root / "sample.txt").read_text(encoding="utf-8"), "cat, smile")

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

    def test_single_save_invalidates_recursive_parent_cache(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            child = root / "nested"
            child.mkdir()
            image_path = child / "sample.png"
            image_path.touch()
            (child / "sample.txt").write_text("old", encoding="utf-8")
            self.assertEqual(get_cached_scan_dataset(root, True)[0][0]["tags"], "old")

            result = asyncio.run(save_image_tags({
                "dir": str(root),
                "path": str(image_path),
                "tags": "new",
            }))

            self.assertEqual(result["status"], "success")
            self.assertEqual(get_cached_scan_dataset(root, True)[0][0]["tags"], "new")
            _invalidate_cache(root)


if __name__ == "__main__":
    unittest.main()
