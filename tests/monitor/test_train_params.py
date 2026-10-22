import unittest

from backend.monitor.training import extract_train_params


class TrainParamsTests(unittest.TestCase):
    def test_krea_runtime_fields_use_own_labels_without_losing_runtime_only_keys(self):
        config = {"dit": "dit.safetensors", "text_encoder": "qwen.safetensors",
                  "max_train_steps": 200, "dataset_config": "dataset.toml", "sdpa": True}
        for profile in ("krea2-lora", ""):
            rows = extract_train_params(config, profile)
            fields = {row["key"]: row for row in rows}
            self.assertEqual(len(rows), len(fields))
            self.assertEqual(set(fields), set(config))
            self.assertEqual(fields["text_encoder"]["desc_key"], "field.krea_text_encoder")
            self.assertEqual(fields["dit"]["desc_key"], "field.krea_dit")

    def test_moss_label_and_unknown_legacy_values_are_not_guessed(self):
        self.assertEqual(extract_train_params({"text_encoder": "model"}, "moss-image-lora")[0]["desc_key"],
                         "field.text_encoder_moss")
        legacy = extract_train_params({"text_encoder": "unknown", "custom_runtime": False})
        self.assertTrue(all(row.get("label_raw") == row["key"] for row in legacy))
        self.assertEqual(legacy[1]["value"], "false")
