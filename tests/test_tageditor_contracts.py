import asyncio
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from backend.tageditor.core import (
    _invalidate_cache,
    _prune_thumbnail_cache,
    get_cached_scan_dataset,
    get_thumbnail_path,
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
            self.assertIn("size=320", images[0]["thumbnail"])
            self.assertIn("size=960", images[0]["preview"])
            _invalidate_cache(root)

    def test_thumbnail_is_resized_and_cached(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "large.png"
            Image.new("RGB", (1200, 800), "red").save(source)

            first = get_thumbnail_path(source, 320)
            second = get_thumbnail_path(source, 320)

            self.assertEqual(first, second)
            self.assertTrue(first.is_file())
            with Image.open(first) as image:
                self.assertLessEqual(max(image.size), 320)

    def test_thumbnail_cache_prunes_old_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            for index in range(4):
                (cache_dir / f"{index}.jpg").touch()

            removed = _prune_thumbnail_cache(cache_dir, max_files=3, retain_files=2)

            self.assertEqual(removed, 2)
            self.assertEqual(len(list(cache_dir.glob("*.jpg"))), 2)

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
            self.assertEqual((root / "sample.txt").read_text(encoding="utf-8"), "cat, smile")

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
                "path": str(image_path),
                "tags": "new",
            }))

            self.assertEqual(result["status"], "success")
            self.assertEqual(get_cached_scan_dataset(root, True)[0][0]["tags"], "new")
            _invalidate_cache(root)


class TagEditorFrontendContractTests(unittest.TestCase):
    def test_history_uses_deltas_and_rename_records_after_mutation(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        history_body = source.split("_tePushHistory(meta) {", 1)[1].split("\n  },", 1)[0]
        rename_body = source.split("tagEditorFinishInlineEdit() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("changes: changes", history_body)
        self.assertNotIn("snapshot: checkpoint", history_body)
        self.assertGreater(rename_body.index("this._tePushHistory"), rename_body.index("this.tagEditorImages.forEach"))

    def test_narrow_layout_and_selection_labels_are_explicit(self):
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("@media (max-width: 820px)", css)
        self.assertIn("tagEditor.selectPage", html)
        self.assertIn("tagEditor.selectFiltered", html)
        self.assertIn("tagEditorHistory[tagEditorHistoryDetailIdx]?.meta?.desc", html)

    def test_frequency_error_reset_also_clears_index(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        clear_body = source.split("_teClearFreqData() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("this._teFreqIndex = new Map()", clear_body)
        self.assertIn("this._teClearFreqData();", source)


if __name__ == "__main__":
    unittest.main()
