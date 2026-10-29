"""The native picker receives the language chosen in the web UI."""
import asyncio
import unittest
from unittest.mock import patch

from backend.server.routes import system


class NativePickerLocalizationTests(unittest.TestCase):
    def test_model_picker_and_folder_receive_localized_labels(self):
        with patch.object(system, "tk_is_available", return_value=True), \
             patch.object(system, "open_file_selector", return_value="") as file_picker, \
             patch.object(system, "open_directory_selector", return_value="") as directory_picker:
            asyncio.run(system.pick_file("model-file", "ja-JP"))
            self.assertEqual(file_picker.call_args.args[1], "モデルファイルを選択")
            self.assertEqual(file_picker.call_args.args[2][0][0], "モデルファイル")
            asyncio.run(system.pick_file("folder", "zh-CN"))
            directory_picker.assert_called_once_with("", "选择文件夹")
