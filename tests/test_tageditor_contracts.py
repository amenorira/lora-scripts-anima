import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


class TagEditorFrontendContractTests(unittest.TestCase):
    def test_history_uses_deltas_and_rename_records_after_mutation(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        history_body = source.split("_tePushHistory(meta) {", 1)[1].split("\n  },", 1)[0]
        rename_body = source.split("tagEditorFinishInlineEdit() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("changes: changes", history_body)
        self.assertNotIn("snapshot: checkpoint", history_body)
        self.assertGreater(rename_body.index("this._tePushHistory"), rename_body.index("images.forEach"))

    def test_desktop_layout_and_selection_labels_are_explicit(self):
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn(".te-shell { display: flex; flex-direction: column; flex: 1; min-width: 960px;", css)
        self.assertNotIn(".te-main { flex-direction: column; }", css)
        self.assertIn("grid-template-columns: auto minmax(0, 1fr) 8px var(--te-right-w, 340px)", css)
        self.assertIn("grid-template-columns: repeat(auto-fill, 160px)", css)
        self.assertIn("object-fit: contain", css)
        self.assertIn("height: clamp(180px, 34vh, 320px)", css)
        self.assertIn("tagEditor.selectPage", html)
        self.assertIn("tagEditor.selectFiltered", html)
        self.assertIn("tagEditorHistory[tagEditorHistoryDetailIdx]?.meta?.desc", html)

    def test_frequency_error_reset_also_clears_index(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        clear_body = source.split("_teClearFreqData() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("this._teFreqIndex = new Map()", clear_body)
        self.assertIn("this._teClearFreqData();", source)

    def test_text_edit_updates_state_immediately_and_only_debounces_history(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        body = source.split("tagEditorDetailTextChange() {", 1)[1].split("\n  },", 1)[0]

        update_index = body.index("this._teUpdateImageTags(img, this.tagEditorDetailText")
        timeout_index = body.index("setTimeout(function()")
        self.assertLess(update_index, timeout_index)
        self.assertIn("{ deferTextHistory: true }", body)
        self.assertIn("self._teFlushPendingTextEdit(path)", body)

    def test_draft_restore_preserves_empty_original_value(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        body = source.split("_teCheckDraft() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("Object.prototype.hasOwnProperty.call(item, 'original')", body)
        self.assertNotIn("item.original || item.tags", body)

    def test_recursive_toggle_batch_scope_and_shortcuts_are_guarded(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        app_source = Path("frontend/js/app.js").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("tagEditorBatchScope: 'selected'", source)
        toggle_body = source.split("tagEditorToggleRecursive() {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("tagEditorModifiedCount() > 0", toggle_body)
        self.assertIn("recursiveUnsavedConfirm", toggle_body)
        self.assertIn("self._teRemoveDraft()", toggle_body)
        reload_body = source.split("tagEditorReloadDir() {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("self._teRemoveDraft()", reload_body)
        self.assertIn("id=\"te-search-input\"", html)
        self.assertIn("document.getElementById('te-search-input')", source)
        self.assertIn("var editableTarget = this._teIsEditableTarget(e.target)", source)
        self.assertIn("if (editableTarget) return;", source)
        self.assertIn("this._teFlushAllPendingTextEdits();", source.split("_teConfirmNav(route) {", 1)[1])
        self.assertIn("typeof this._teFlushAllPendingTextEdits === 'function'", app_source)

    def test_partial_save_resets_history_and_draft_save_skips_active_save(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        save_body = source.split("async _doSaveAll(modified) {", 1)[1].split("\n  },", 1)[0]
        draft_body = source.split("_teSaveDraft() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("if (processedCount > 0 || this._teModifiedCount === 0)", save_body)
        self.assertIn("this.tagEditorHistory = []", save_body)
        self.assertIn("this.tagEditorHistoryDetailIdx = -1", save_body)
        self.assertIn("else if (processedCount > 0)", save_body)
        self.assertIn("!this.tagEditorModified || this._teIsSaving", draft_body)

    def test_relative_paths_are_used_for_search_sort_and_display(self):
        source = Path("frontend/js/tag-editor.js").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("img.rel_path || img.name", source)
        self.assertIn("name: dimg.rel_path || dimg.name", source)
        self.assertIn("x-text=\"img.rel_path || img.name\"", html)
        self.assertIn("tagEditorGetSelectedImg()?.rel_path", html)

    def test_tag_rename_button_reserves_space_without_covering_count(self):
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")
        html = Path("frontend/index.html").read_text(encoding="utf-8")
        row = html.split('<div class="te-tag-row"', 1)[1].split('<span class="te-tag-excl"', 1)[0]
        edit_css = css.split(".te-tag-edit-btn {", 1)[1].split("}", 1)[0]

        self.assertLess(row.index('class="te-tag-count"'), row.index('class="te-tag-edit-btn"'))
        self.assertIn("flex: 0 0 24px", css)
        self.assertIn("flex: 0 0 18px", edit_css)
        self.assertNotIn("position: absolute", edit_css)


if __name__ == "__main__":
    unittest.main()
