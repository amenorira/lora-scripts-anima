import tempfile
import unittest
from uuid import UUID
from pathlib import Path

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
