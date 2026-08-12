import asyncio
import tempfile
import unittest
from uuid import UUID
from pathlib import Path
from unittest.mock import patch

from backend.monitor import routes as monitor_routes
from backend.monitor import run_registry
from backend.server.routes import training as training_routes
from backend.server.models import TrainingTomlParseRequest
from backend.training.training_config import (
    TRAINING_CONFIG_SCHEMA_VERSION,
    TrainingConfigError,
    build_training_config,
    extract_training_form,
    load_training_config,
    write_training_config,
)


class TrainingConfigYamlTests(unittest.TestCase):
    def test_round_trip_preserves_ui_only_and_nested_values(self):
        document = build_training_config(
            {
                "model_train_type": "anima-lora",
                "subset_timestep_offsets": {"10_character": [1, 2]},
                "enable_preview": True,
                "positive_prompts": "一名角色",
                "sample_seed": 42,
                "train_batch_size": 1,
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
        self.assertNotIn("runtime", loaded)

    def test_conditional_fields_follow_ui_hierarchy(self):
        document = build_training_config(
            {
                "model_train_type": "anima-lora",
                "enable_bucket": True,
                "bucket_no_upscale": True,
                "max_bucket_reso": 2048,
                "optimizer_type": "Muon",
                "muon_momentum": 0.95,
                "bnb_percentile_clipping": 100,
                "bnb_min_8bit_size": 4096,
                "enable_preview": True,
                "positive_prompts": "一名角色",
                "sample_width": 1024,
                "subset_timestep_offsets": {"10_face": -0.25},
                "logging_dir": "./logs",
            },
            profile_id="anima-lora",
        )

        params = document["parameters"]
        self.assertEqual(params["model"]["enable_bucket"]["enabled"], True)
        self.assertEqual(params["model"]["enable_bucket"]["options"]["max_bucket_reso"], 2048)
        self.assertEqual(params["optimizer"]["optimizer_type"]["selected"], "Muon")
        optimizer_options = params["optimizer"]["optimizer_type"]["options"]
        self.assertNotIn("bnb_percentile_clipping", optimizer_options)
        self.assertNotIn("bnb_min_8bit_size", optimizer_options)
        self.assertNotIn("save", params)
        self.assertEqual(params["training"]["subset_timestep_offsets"], {"10_face": -0.25})
        self.assertEqual(params["preview"]["enable_preview"]["options"]["sample_width"], 1024)
        self.assertEqual(extract_training_form(document)["positive_prompts"], "一名角色")

    def test_duplicate_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "training.yaml"
            path.write_text(
                "kind: training\n"
                "schema_version: 1\n"
                "profile:\n"
                "  id: anima-lora\n"
                "form: {}\n"
                "form: {}\n",
                encoding="utf-8",
            )
            with self.assertRaises(TrainingConfigError):
                load_training_config(path)

    def test_wrong_kind_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "preset.yaml"
            path.write_text(
                "kind: preset\n"
                "schema_version: 1\n"
                "profile:\n"
                "  id: anima-lora\n"
                "form: {}\n",
                encoding="utf-8",
            )
            with self.assertRaises(TrainingConfigError):
                load_training_config(path)

    def test_schema_v1_flat_form_remains_importable(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "training.yaml"
            path.write_text(
                "kind: training\n"
                "schema_version: 1\n"
                "profile:\n"
                "  id: anima-lora\n"
                "form:\n"
                "  enable_preview: true\n"
                "  positive_prompts: legacy prompt\n",
                encoding="utf-8",
            )
            restored = extract_training_form(load_training_config(path))

        self.assertTrue(restored["enable_preview"])
        self.assertEqual(restored["positive_prompts"], "legacy prompt")

    def test_history_prefers_training_yaml_form_state(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "output"
            autosave = root / "config" / "autosave"
            run_dir = output / "demo_20260811-120000"
            artifact_dir = root / "artifacts" / run_dir.name
            run_dir.mkdir(parents=True)
            artifact_dir.mkdir(parents=True)
            autosave.mkdir(parents=True)
            (run_dir / "config.toml").write_text(
                f'output_dir = "{artifact_dir.as_posix()}"\nlearning_rate = 0.0001\n',
                encoding="utf-8",
            )
            write_training_config(
                run_dir / "training.yaml",
                build_training_config(
                    {
                        "model_train_type": "anima-lora",
                        "output_dir": "D:/models",
                        "enable_preview": True,
                        "positive_prompts": "完整预览提示词",
                    },
                    profile_id="anima-lora",
                ),
            )

            with (
                patch.object(run_registry, "REPO_ROOT", root),
                patch.object(run_registry, "OUTPUT_DIR", output),
                patch.object(run_registry, "AUTOSAVE_DIR", autosave),
            ):
                run_registry.write_run_record(
                    run_dir,
                    artifact_dir=artifact_dir,
                    task_id="task-yaml",
                    output_base_dir="D:/models",
                )
                response = asyncio.run(
                    monitor_routes.get_config_from_run(run_dir=f"output/{run_dir.name}")
                )

        self.assertEqual(response["status"], "success")
        self.assertEqual(response["data"]["config_format"], "yaml")
        self.assertEqual(response["data"]["params"]["output_dir"], "D:/models")
        self.assertTrue(response["data"]["params"]["enable_preview"])
        self.assertEqual(response["data"]["params"]["positive_prompts"], "完整预览提示词")

    def test_export_endpoint_returns_application_yaml(self):
        class _Request:
            async def json(self):
                return {
                    "form": {
                        "model_train_type": "anima-lora",
                        "output_name": "中文预设",
                "network_dim": 32,
                "enable_preview": True,
                "positive_prompts": "一名角色",
                "sample_width": 1024,
                "optimizer_type": "Muon",
                "bnb_percentile_clipping": 100,
                "bnb_min_8bit_size": 4096,
                "muon_momentum": 0.96,
                    },
                    "gpu_ids": [0],
                }

        response = asyncio.run(training_routes.export_training_config(_Request()))
        self.assertEqual(response.status, "success")
        self.assertEqual(response.data["filename"], "中文预设.yaml")
        UUID(response.data["document_id"])
        self.assertIn("kind: training", response.data["content"])
        self.assertNotIn("adapter_id:", response.data["content"])
        self.assertIn("parameters:", response.data["content"])
        self.assertIn("positive_prompts: 一名角色", response.data["content"])
        self.assertIn("network_dim: 32", response.data["content"])
        self.assertIn("sample_width: 1024", response.data["content"])
        self.assertNotIn("bnb_percentile_clipping:", response.data["content"])
        self.assertNotIn("bnb_min_8bit_size:", response.data["content"])
        self.assertIn("muon_momentum: 0.96", response.data["content"])

        parsed = asyncio.run(
            training_routes.parse_training_toml(TrainingTomlParseRequest(content=response.data["content"]))
        )
        self.assertEqual(parsed.status, "success")
        self.assertEqual(parsed.data["format"], "yaml")
        self.assertEqual(parsed.data["document_id"], response.data["document_id"])
        self.assertEqual(parsed.data["data"]["model_train_type"], "anima-lora")
