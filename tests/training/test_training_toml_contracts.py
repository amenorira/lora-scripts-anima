import asyncio
import unittest

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(content=content)))


    def test_invalid_toml_is_rejected(self):
        response = self._parse('model_train_type = "unterminated')

        self.assertEqual(response.status, "fail")
        self.assertIn("Invalid TOML", response.message)


if __name__ == "__main__":
    unittest.main()
