import asyncio
import unittest

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str, model_train_type: str | None = None):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(
            content=content, model_train_type=model_train_type)))


    def test_invalid_toml_is_rejected(self):
        response = self._parse('model_train_type = "unterminated')

        self.assertEqual(response.status, "fail")
        self.assertIn("Invalid TOML", response.message)

    def test_native_moss_import_restores_network_arguments_without_app_selector(self):
        arguments = ('network_args = ["train_llm_adapter=True", "rank_dropout=0.2", '
                     '"loraplus_lr_ratio=4", "network_reg_dims=layers.*=8"]\n')
        for marker, current_type in (
            ('network_module = "networks.lora_generic"\n', None),
            ('moss_max_token_length = 2048\n', "anima-lora"),
            ("", "moss-image-lora"),
        ):
            with self.subTest(marker=marker, current_type=current_type):
                response = self._parse(marker + arguments, current_type)
                self.assertEqual(response.status, "success")
                form = response.data["data"]
                self.assertEqual(form["model_train_type"], "moss-image-lora")
                self.assertIs(form["train_text_embedder"], True)
                self.assertEqual(form["rank_dropout"], 0.2)
                self.assertIs(form["enable_loraplus"], True)
                self.assertEqual(form["loraplus_lr_ratio"], 4)
                self.assertEqual(form["network_args_custom"], "network_reg_dims=layers.*=8")
                self.assertNotIn("network_args", form)

    def test_explicit_profile_takes_precedence_over_import_context(self):
        for profile in ("anima-lora", "sdxl-lora", "krea2-lora"):
            response = self._parse(
                f'model_train_type = "{profile}"\nnetwork_args = ["rank_dropout=0.2"]', "moss-image-lora")
            self.assertEqual(response.data["data"], {
                "model_train_type": profile, "network_args": ["rank_dropout=0.2"],
            })

    def test_moss_import_context_rejects_malformed_native_arguments(self):
        response = self._parse('network_args = "rank_dropout=0.2"', "moss-image-lora")
        self.assertEqual(response.status, "fail")
        self.assertIn("network_args", response.message)


if __name__ == "__main__":
    unittest.main()
