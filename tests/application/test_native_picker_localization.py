"""The native picker displays UI labels without changing file filters."""
import asyncio
import unittest
from unittest.mock import patch

from backend.server.routes import system


class NativePickerLocalizationTests(unittest.TestCase):
    def test_picker_displays_supplied_labels_and_keeps_backend_filters(self):
        with patch.object(system, "tk_is_available", return_value=True), \
             patch.object(system, "open_file_selector", return_value="") as file_picker, \
             patch.object(system, "open_directory_selector", return_value="") as directory_picker:
            for picker_type, pattern in (
                ("model-file", "*.safetensors;*.ckpt;*.pt"),
                ("text-file", "*.txt;*.md"),
                ("image-file", "*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff;*.avif"),
            ):
                with self.subTest(picker_type=picker_type):
                    asyncio.run(system.pick_file(picker_type, "标题", "类型", "全部"))
                    self.assertEqual(file_picker.call_args.args, (
                        "", "标题", [("类型", pattern), ("全部", "*.*")],
                    ))
            asyncio.run(system.pick_file("folder", title="选择目录"))
            directory_picker.assert_called_once_with("", "选择目录")

    def test_missing_labels_and_invalid_picker_type(self):
        with patch.object(system, "tk_is_available", return_value=True), \
             patch.object(system, "open_file_selector", return_value="") as file_picker:
            result = asyncio.run(system.pick_file("text-file"))
            file_picker.assert_called_once_with("", "", [("*.txt;*.md", "*.txt;*.md"), ("*.*", "*.*")])
            self.assertEqual(result.status, "fail")
            self.assertIn("cancelled", result.message)
            file_picker.reset_mock()
            result = asyncio.run(system.pick_file("unknown"))
            self.assertEqual(result.status, "fail")
            self.assertIn("Invalid picker_type", result.message)
            file_picker.assert_not_called()
