import asyncio
import unittest

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(content=content)))

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
        self.assertEqual(
            response.data["data"],
            {
                "model_train_type": "anima-lora",
                "train_data_dir": r"D:\lora训练\doll_new",
                "max_train_epochs": 10,
                "enable_bucket": True,
            },
        )

    def test_invalid_toml_is_rejected(self):
        response = self._parse('model_train_type = "unterminated')

        self.assertEqual(response.status, "fail")
        self.assertIn("Invalid TOML", response.message)

    def test_structured_legacy_preset_is_rejected_explicitly(self):
        response = self._parse(
            '''
[metadata]
name = "legacy"

[data]
learning_rate = 0.0001
'''
        )

        self.assertEqual(response.status, "fail")
        self.assertIn("no longer supported", response.message)


if __name__ == "__main__":
    unittest.main()
