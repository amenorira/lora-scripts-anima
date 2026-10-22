import asyncio
import unittest
import yaml

from backend.server.models import TrainingTomlParseRequest
from backend.server.routes.training import parse_training_toml
from backend.training.training_config import build_training_config


class TrainingTomlParseTests(unittest.TestCase):
    @staticmethod
    def _parse(content: str, model_train_type: str | None = None):
        return asyncio.run(parse_training_toml(TrainingTomlParseRequest(
            content=content, model_train_type=model_train_type)))


    def test_invalid_toml_is_rejected(self):
        response = self._parse('model_train_type = "unterminated')

        self.assertEqual(response.status, "fail")
        self.assertIn("Invalid TOML", response.message)

    def test_native_optimizer_arguments_survive_import_for_all_profiles(self):
        from backend.training.optimizer_contracts import collect_optimizer_args, parse_optimizer_args
        for profile in ("anima-lora", "sdxl-lora", "moss-image-lora", "krea2-lora"):
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

    def test_optimizer_import_preserves_specific_mappings_and_custom_precedence(self):
        response = self._parse('optimizer_type = "Muon"\n'
            'optimizer_args = ["momentum=0.8", "nesterov=False"]\n'
            'optimizer_args_custom = "momentum=0.7"', "anima-lora")
        self.assertEqual(response.status, "success")
        self.assertEqual(response.data["data"]["muon_momentum"], 0.7)
        self.assertIs(response.data["data"]["muon_nesterov"], False)
        self.assertEqual(response.data["data"]["optimizer_args_custom"], "")

    def test_malformed_optimizer_arguments_are_rejected(self):
        response = self._parse('optimizer_args = ["betas=invalid"]')
        self.assertEqual(response.status, "fail")
        self.assertIn("optimizer_args", response.message)

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
                f'model_train_type = "{profile}"\n'
                'network_args = ["rank_dropout=0.2", "network_reg_dims=blocks.*=4"]', "moss-image-lora")
            self.assertEqual(response.status, "success")
            self.assertEqual(response.data["data"], {
                "model_train_type": profile, "rank_dropout": 0.2,
                "network_args_custom": "network_reg_dims=blocks.*=4",
            })

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

    def test_anima_import_rejects_empty_target_presets_before_frontend_normalization(self):
        for preset in ("attn-only", "unet-convblock-only"):
            for setting in (f'network_args = ["preset={preset}"]', f'lycoris_preset = "{preset}"'):
                response = self._parse('network_module = "lycoris.kohya"\n' + setting, "anima-lora")
                self.assertEqual(response.status, "fail")
                self.assertIn(preset, response.message)
                response = self._parse('network_module = "lycoris.kohya"\n' + setting, "sdxl-lora")
                self.assertEqual(response.status, "success")

    def test_yaml_import_also_rejects_incompatible_presets(self):
        document = build_training_config({"network_module": "lycoris.kohya", "lycoris_preset": "attn-only"},
                                         profile_id="anima-lora")
        response = self._parse(yaml.safe_dump(document, sort_keys=False))
        self.assertEqual(response.status, "fail")
        self.assertIn("attn-only", response.message)

    def test_yaml_import_is_independent_of_key_order_comments_and_bom(self):
        document = build_training_config({"learning_rate": 0.001}, profile_id="anima-lora")
        reordered = {key: document[key] for key in reversed(document)}
        for content in (yaml.safe_dump(reordered, sort_keys=False),
                        "\ufeff# exported configuration\n---\n" + yaml.safe_dump(reordered, sort_keys=False),
                        yaml.safe_dump(document, sort_keys=False).replace("kind:", '"kind":')):
            with self.subTest(content=content[:80]):
                response = self._parse(content)
                self.assertEqual(response.status, "success", response.message)
                self.assertEqual(response.data["format"], "yaml")
                self.assertEqual(response.data["data"]["learning_rate"], 0.001)

    def test_moss_import_context_rejects_malformed_native_arguments(self):
        response = self._parse('network_args = "rank_dropout=0.2"', "moss-image-lora")
        self.assertEqual(response.status, "fail")
        self.assertIn("network_args", response.message)


if __name__ == "__main__":
    unittest.main()
