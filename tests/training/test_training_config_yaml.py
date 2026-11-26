import tempfile
import unittest
from uuid import UUID
from pathlib import Path

from backend.training.config.training_config import (
    MAX_TRAINING_CONFIG_BYTES,
    TRAINING_CONFIG_SCHEMA_VERSION,
    TrainingConfigError,
    build_training_config,
    dump_training_config,
    extract_training_form,
    load_training_config,
    parse_training_config_text,
    write_training_config,
)
from backend.training.config.optimizer_contracts import LORA_MUON_OPTIMIZER_TYPE


class TrainingConfigYamlTests(unittest.TestCase):
    def test_long_prompts_are_not_wrapped_and_round_trip(self):
        multiline_prompt = "low quality\nextra limbs\n"
        prompts = [
            ", ".join(["masterpiece", "一名角色", "detailed background"] * 40),
            ", ".join(["description: character", "# detail"] * 40),
        ]
        for prompt in prompts:
            with self.subTest(prompt=prompt[:20]):
                document = build_training_config(
                    {
                        "model_train_type": "anima-lora",
                        "enable_preview": True,
                        "positive_prompts": prompt,
                        "negative_prompts": multiline_prompt,
                    },
                    profile_id="anima-lora",
                )

                content = dump_training_config(document)
                prompt_line = next(line for line in content.splitlines() if "positive_prompts:" in line)
                self.assertIn(prompt, prompt_line)
                restored = extract_training_form(parse_training_config_text(content))
                self.assertEqual(restored["positive_prompts"], prompt)
                self.assertEqual(restored["negative_prompts"], multiline_prompt)

    def test_round_trip_preserves_ui_only_and_nested_values(self):
        document = build_training_config(
            {
                "model_train_type": "anima-lora",
                "subset_timestep_offsets": {"10_character": [1, 2]},
                "enable_preview": True,
                "positive_prompts": "一名角色",
                "sample_seed": 42,
                "train_batch_size": 1,
                "flip_aug": True,
                "random_crop": True,
                "cache_latents": False,
                "cache_latents_to_disk": False,
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "network_dim": 16,
                "network_alpha": 16,
                "max_grad_norm": 0,
                "inv_sqrt_steps": 5,
                "qwen_image_vae_2d": False,
                "gradient_checkpointing": False,
                "max_data_loader_n_workers": 0,
            },
            profile_id="anima-lora",
        )
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "training.yaml"
            write_training_config(path, document)
            loaded = load_training_config(path)

        restored = extract_training_form(loaded)
        self.assertEqual(loaded["schema_version"], TRAINING_CONFIG_SCHEMA_VERSION)
        UUID(loaded["document_id"])
        self.assertEqual(loaded["profile"]["id"], "anima-lora")
        self.assertNotIn("adapter_id", loaded["profile"])
        self.assertEqual(restored["subset_timestep_offsets"], {"10_character": [1, 2]})
        self.assertEqual(restored["positive_prompts"], "一名角色")
        self.assertEqual(loaded["parameters"]["training"]["train_batch_size"], 1)
        self.assertEqual(restored["train_batch_size"], 1)
        for key, value in (("flip_aug", True), ("random_crop", True), ("cache_latents", False), ("cache_latents_to_disk", False)):
            self.assertIs(restored[key], value)
        self.assertEqual(restored["network_dim"], 16)
        self.assertEqual(restored["network_alpha"], 16)
        self.assertEqual(restored["max_grad_norm"], 0)
        self.assertEqual(restored["inv_sqrt_steps"], 5)
        self.assertIs(restored["qwen_image_vae_2d"], False)
        self.assertIs(restored["gradient_checkpointing"], False)
        self.assertEqual(restored["max_data_loader_n_workers"], 0)
        self.assertNotIn("runtime", loaded)

    def test_validation_and_size_errors_carry_codes_while_syntax_errors_preserve_detail(self):
        with self.assertRaises(TrainingConfigError) as schema_ctx:
            parse_training_config_text("kind: training\nschema_version: 999\n")
        self.assertEqual(schema_ctx.exception.code, "configYamlUnsupportedSchema")
        self.assertEqual(schema_ctx.exception.params, {"version": "999"})

        for kind_sample in (
            "schema_version: 999\n",
            "kind: other\nschema_version: 2\n",
            "kind: [training]\nschema_version: 2\n",
            "kind: {}\nschema_version: 2\n",
        ):
            with self.subTest(kind_sample=kind_sample.strip()), self.assertRaises(TrainingConfigError) as kind_ctx:
                parse_training_config_text(kind_sample)
            self.assertEqual(kind_ctx.exception.code, "configYamlUnsupportedKind")

        invalid_fields = [
            ("kind: training\nprofile:\n  id: anima-lora\nparameters: {}\n", "schema_version"),
            ("kind: training\nschema_version: [2]\nprofile:\n  id: anima-lora\nparameters: {}\n", "schema_version"),
            ("kind: training\nschema_version: true\nprofile:\n  id: anima-lora\nparameters: {}\n", "schema_version"),
            ("kind: training\nschema_version: 2\ndocument_id: not-a-uuid\nprofile:\n  id: anima-lora\nparameters: {}\n", "document_id"),
            ("kind: training\nschema_version: 2\nparameters: {}\n", "profile.id"),
            ("kind: training\nschema_version: 2\nprofile:\n  id: [anima-lora]\nparameters: {}\n", "profile.id"),
            ("kind: training\nschema_version: 1\nprofile:\n  id: anima-lora\nform: []\n", "form"),
            ("kind: training\nschema_version: 2\nprofile:\n  id: anima-lora\n", "parameters"),
        ]
        for content, expected_field in invalid_fields:
            with self.subTest(expected_field=expected_field), self.assertRaises(TrainingConfigError) as field_ctx:
                parse_training_config_text(content)
            self.assertEqual(field_ctx.exception.code, "configYamlInvalidField")
            self.assertEqual(field_ctx.exception.params, {"field": expected_field})

        preview_cases = [
            (
                "kind: training\nschema_version: 2\nprofile:\n  id: anima-lora\nparameters:\n  preview:\n    preview_sampler: wrong\n",
                "configUnsupportedFieldValue",
                {"field": "preview_sampler", "value": "wrong"},
            ),
            (
                "kind: training\nschema_version: 2\nprofile:\n  id: anima-lora\nparameters:\n  preview:\n    preview_scheduler: wrong\n",
                "configUnsupportedFieldValue",
                {"field": "preview_scheduler", "value": "wrong"},
            ),
            (
                "kind: training\nschema_version: 2\nprofile:\n  id: anima-lora\nparameters:\n  preview:\n    preview_loras: wrong\n",
                "configPreviewLorasMustBeList",
                {},
            ),
            (
                "kind: training\nschema_version: 2\nprofile:\n  id: anima-lora\nparameters:\n  preview:\n    preview_loras:\n      - path: x.safetensors\n        multiplier: .inf\n",
                "configPreviewLoraMultiplierNotFinite",
                {"index": 1},
            ),
        ]
        for content, expected_code, expected_params in preview_cases:
            with self.subTest(expected_code=expected_code), self.assertRaises(TrainingConfigError) as preview_ctx:
                extract_training_form(parse_training_config_text(content))
            self.assertEqual(preview_ctx.exception.code, expected_code)
            self.assertEqual(preview_ctx.exception.params, expected_params)

        oversized = "kind: training\nschema_version: 2\n" + ("a" * MAX_TRAINING_CONFIG_BYTES)
        with self.assertRaises(TrainingConfigError) as text_size_ctx:
            parse_training_config_text(oversized)
        self.assertEqual(text_size_ctx.exception.code, "configFileTooLarge")

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "large.yaml"
            path.write_text(oversized, encoding="utf-8")
            with self.assertRaises(TrainingConfigError) as file_size_ctx:
                load_training_config(path)
        self.assertEqual(file_size_ctx.exception.code, "configFileTooLarge")

        for raw_sample in ("a = 1\nb = [2", "caption = hello: world", "kind: [unclosed"):
            with self.subTest(raw_sample=raw_sample), self.assertRaises(TrainingConfigError) as syntax_ctx:
                parse_training_config_text(raw_sample)
            self.assertIsNone(syntax_ctx.exception.code)

    def test_export_config_and_krea2_routes_return_coded_errors(self):
        import asyncio
        import json
        from starlette.requests import Request
        from backend.server.routes import training as training_routes

        def _json_request(path: str, body: dict) -> Request:
            raw = json.dumps(body).encode("utf-8")
            sent = False

            async def _recv():
                nonlocal sent
                if sent:
                    return {"type": "http.disconnect"}
                sent = True
                return {"type": "http.request", "body": raw, "more_body": False}

            return Request({"type": "http", "method": "POST", "path": path, "headers": []}, _recv)

        async def _run():
            unknown_profile = await training_routes.export_training_config(
                _json_request("/training/export-config", {"form": {"model_train_type": "unknown-profile"}})
            )
            self.assertEqual(unknown_profile.status, "fail")
            self.assertEqual(unknown_profile.data["errorCode"], "configUnknownProfile")
            self.assertEqual(unknown_profile.data["errorParams"], {"profile": "unknown-profile"})

            bad_doc_id = await training_routes.export_training_config(
                _json_request("/training/export-config", {"form": {"model_train_type": "anima-lora"}, "document_id": "not-a-uuid"})
            )
            self.assertEqual(bad_doc_id.status, "fail")
            self.assertEqual(bad_doc_id.data["errorCode"], "invalidConfig")

            missing_path = await training_routes.krea2_model_format(
                _json_request("/training/krea2/model-format", {"path": ""})
            )
            self.assertEqual(missing_path.status, "fail")
            self.assertEqual(missing_path.data["errorCode"], "trainingModelPathRequired")

            wrong_profile = await training_routes.krea2_cache_status(
                _json_request("/training/krea2/cache-status", {"model_train_type": "anima-lora"})
            )
            self.assertEqual(wrong_profile.status, "fail")
            self.assertEqual(wrong_profile.data["errorCode"], "trainingKrea2ProfileRequired")

        asyncio.run(_run())
