import tempfile
import unittest
from uuid import UUID
from pathlib import Path

from backend.training.config.training_config import (
    TRAINING_CONFIG_SCHEMA_VERSION,
    build_training_config,
    dump_training_config,
    extract_training_form,
    load_training_config,
    parse_training_config_text,
    write_training_config,
)
from backend.training.config.optimizer_contracts import LORA_MUON_OPTIMIZER_TYPE


class TrainingConfigYamlTests(unittest.TestCase):
    def test_quality_prompt_choice_and_text_round_trip_separately_from_positive_prompts(self):
        for profile in ("anima-lora", "sdxl-lora", "moss-image-lora", "krea2-lora"):
            for enabled in (False, True):
                form = {"model_train_type": profile, "enable_quality_prompts": enabled,
                        "quality_prompts": "custom quality", "positive_prompts": "raw prompt",
                        "enable_preview": True}
                if profile == "krea2-lora":
                    form.update(enable_krea_samples=True, krea_sample_prompts="raw prompt")
                restored = extract_training_form(parse_training_config_text(dump_training_config(
                    build_training_config(form, profile_id=profile))))
                self.assertEqual(restored["enable_quality_prompts"], enabled)
                self.assertEqual(restored["quality_prompts"], "custom quality")
                key = "krea_sample_prompts" if profile == "krea2-lora" else "positive_prompts"
                self.assertEqual(restored[key], "raw prompt")

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

    def test_existing_folded_prompt_is_read_as_one_value(self):
        content = """\
kind: training
schema_version: 2
profile:
  id: anima-lora
parameters:
  preview:
    enable_preview:
      enabled: true
      options:
        positive_prompts: masterpiece, best quality,
          long hair, blue eyes
"""
        restored = extract_training_form(parse_training_config_text(content))
        self.assertEqual(restored["positive_prompts"], "masterpiece, best quality, long hair, blue eyes")

    def test_unknown_misc_parameters_round_trip_without_reinterpreting_dict_values(self):
        form = {"model_train_type": "anima-lora", "network_dim": 16,
                "future_flag": 42, "future_options": {"network_dim": 999, "enabled": True}}
        document = build_training_config(form, profile_id="anima-lora")
        restored = extract_training_form(document)
        self.assertEqual(restored["future_flag"], 42)
        self.assertEqual(restored["future_options"], form["future_options"])
        self.assertEqual(restored["network_dim"], 16)
        document["parameters"]["misc"]["network_dim"] = 888
        self.assertEqual(extract_training_form(document)["network_dim"], 16)

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
