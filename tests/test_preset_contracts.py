import asyncio
import unittest

from backend.server.models import PresetParseRequest
from backend.server.routes.presets import parse_preset


class PresetParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str):
        return asyncio.run(parse_preset(PresetParseRequest(content=content)))

    def test_flat_downloaded_config_is_returned_as_data(self):
        response = self._parse(
            r'''
model_train_type = "anima-lora"
train_data_dir = "D:\\lora训练\\doll_new"
max_train_epochs = 10
enable_bucket = true
'''
        )

        self.assertEqual(response.status, "success")
        self.assertEqual(response.data["metadata"], {})
        self.assertEqual(
            response.data["data"],
            {
                "model_train_type": "anima-lora",
                "train_data_dir": r"D:\lora训练\doll_new",
                "max_train_epochs": 10,
                "enable_bucket": True,
            },
        )

    def test_structured_preset_keeps_metadata_and_data_sections(self):
        response = self._parse(
            '''
[metadata]
name = "roundtrip-test"
train_type = "anima-lora"

[data]
learning_rate = 0.0001
max_train_epochs = 8
'''
        )

        self.assertEqual(response.status, "success")
        self.assertEqual(
            response.data["metadata"],
            {"name": "roundtrip-test", "train_type": "anima-lora"},
        )
        self.assertEqual(
            response.data["data"],
            {"learning_rate": 0.0001, "max_train_epochs": 8},
        )

    def test_structured_preset_rejects_non_table_sections(self):
        response = self._parse(
            '''
metadata = "invalid"

[data]
max_train_epochs = 10
'''
        )

        self.assertEqual(response.status, "fail")
        self.assertIn("Invalid preset shape", response.message)


if __name__ == "__main__":
    unittest.main()
