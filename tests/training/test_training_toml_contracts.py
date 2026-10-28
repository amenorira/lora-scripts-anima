import asyncio
import unittest

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str, model_train_type: str | None = None):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(
            content=content, model_train_type=model_train_type)))


    def test_native_optimizer_arguments_survive_import_for_all_profiles(self):
        from backend.training.config.optimizer_contracts import collect_optimizer_args, parse_optimizer_args
        for profile in ("anima-lora", "sdxl-lora", "moss-image-lora"):
            with self.subTest(profile=profile):
                response = self._parse('optimizer_type = "AdamW"\n'
                    'optimizer_args = ["weight_decay=0.123", "betas=(0.8, 0.95)", "foreach=None"]', profile)
                self.assertEqual(response.status, "success")
                form = response.data["data"]
                self.assertNotIn("optimizer_args", form)
                self.assertEqual(form["weight_decay"], 0.123)
                self.assertEqual(form["betas"], "(0.8, 0.95)")
                parsed, errors = parse_optimizer_args(form)
                self.assertEqual(errors, [])
                self.assertEqual(collect_optimizer_args(form, parsed),
                    {"weight_decay": 0.123, "betas": (0.8, 0.95), "foreach": None})


    def test_anima_native_import_restores_controls_and_preserves_unknown_arguments(self):
        response = self._parse('''network_module = "lycoris.kohya"
network_args = ["algo=lokr", "preset=attn-mlp", "train_llm_adapter=true", "factor=8", "network_reg_dims=blocks.*=4"]
''', "anima-lora")
        self.assertEqual(response.status, "success")
        self.assertEqual(response.data["data"], {
            "model_train_type": "anima-lora", "network_module": "lycoris.kohya",
            "lycoris_algo": "lokr", "lycoris_preset": "attn-mlp", "train_llm_adapter": True,
            "lokr_factor": 8, "network_args_custom": "network_reg_dims=blocks.*=4",
        })


if __name__ == "__main__":
    unittest.main()
