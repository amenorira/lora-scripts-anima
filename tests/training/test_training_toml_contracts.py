import asyncio
import unittest

import toml

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str, model_train_type: str | None = None):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(
            content=content, model_train_type=model_train_type)))

    @staticmethod
    def _preview_config_formats(preview):
        from backend.training.config.training_config import dump_training_config

        form = {"model_train_type": "anima-lora", **preview}
        document = {"kind": "training", "profile": {"id": "anima-lora"}}
        return {
            "toml": toml.dumps(form),
            "yaml-v1": dump_training_config({**document, "schema_version": 1, "form": form}),
            "yaml-v2": dump_training_config({**document, "schema_version": 2, "parameters": {"preview": preview}}),
        }

    def test_preview_fields_share_normalization_across_native_and_yaml_imports(self):
        cases = [
            ({}, {}),
            ({"preview_sampler": "", "preview_scheduler": "", "preview_loras": []},
             {"preview_sampler": "euler", "preview_scheduler": "native", "preview_loras": []}),
            ({"preview_sampler": "heun", "preview_scheduler": "simple", "preview_loras": [
                {"path": " external.safetensors ", "multiplier": "-0.5"},
                {"path": "", "multiplier": ""},
            ]}, {"preview_sampler": "heun", "preview_scheduler": "simple", "preview_loras": [
                {"path": "external.safetensors", "multiplier": -0.5},
                {"path": "", "multiplier": ""},
            ]}),
        ]
        keys = ("preview_sampler", "preview_scheduler", "preview_loras")
        for preview, expected in cases:
            for format_name, content in self._preview_config_formats(preview).items():
                with self.subTest(format=format_name, preview=preview):
                    response = self._parse(content)
                    self.assertEqual(response.status, "success", response.message)
                    form = response.data["data"]
                    self.assertEqual({key: form[key] for key in keys if key in form}, expected)

    def test_invalid_preview_fields_return_configuration_errors_in_all_import_formats(self):
        cases = [
            ({"preview_sampler": "unknown"}, "Unsupported preview sampler"),
            ({"preview_scheduler": "unknown"}, "Unsupported preview scheduler"),
            *[({"preview_loras": [{"path": "x.safetensors", "multiplier": value}]}, "multiplier must be finite")
              for value in (10**400, -10**400)],
        ]
        for preview, message in cases:
            for format_name, content in self._preview_config_formats(preview).items():
                with self.subTest(format=format_name, preview=preview):
                    response = self._parse(content)
                    self.assertEqual(response.status, "fail")
                    self.assertIn(message, response.message)


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
