import asyncio
import tempfile
import unittest
from uuid import UUID
from pathlib import Path
from unittest.mock import patch

from backend.monitor import routes as monitor_routes
from backend.monitor import run_registry
from backend.training.training_config import (
    TRAINING_CONFIG_SCHEMA_VERSION,
    TrainingConfigError,
    build_training_config,
    extract_training_form,
    load_training_config,
    write_training_config,
)
from backend.training.optimizer_contracts import LORA_MUON_OPTIMIZER_TYPE


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
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "network_dim": 16,
                "network_alpha": 16,
                "max_grad_norm": 0,
                "inv_sqrt_steps": 5,
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
        self.assertEqual(restored["network_dim"], 16)
        self.assertEqual(restored["network_alpha"], 16)
        self.assertEqual(restored["max_grad_norm"], 0)
        self.assertEqual(restored["inv_sqrt_steps"], 5)
        self.assertNotIn("runtime", loaded)

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

    def test_schema_v2_lora_muon_fields_migrate_before_field_filtering(self):
        document = {
            "kind": "training",
            "schema_version": 2,
            "profile": {"id": "anima-lora"},
            "parameters": {
                "optimizer": {
                    "optimizer_type": {
                        "selected": LORA_MUON_OPTIMIZER_TYPE,
                        "options": {
                            "lora_muon_momentum": 0.85,
                            "lora_muon_ns_steps": 6,
                        },
                    }
                }
            },
        }

        restored = extract_training_form(document)

        self.assertEqual(restored["momentum"], 0.85)
        self.assertEqual(restored["ns_steps"], 6)
        self.assertNotIn("lora_muon_momentum", restored)
        self.assertNotIn("lora_muon_ns_steps", restored)

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
