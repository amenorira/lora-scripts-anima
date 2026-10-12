import unittest

from backend.training.adapter import adapt_config
from backend.training.validation import validate_scheduler_step_budget, validate_training_config
from tests.helpers import config_from_field_defaults


def config(**overrides):
    return config_from_field_defaults(
        model_train_type="anima-lora", network_module="networks.lora_anima",
        pretrained_model_name_or_path="model.safetensors", vae="vae.safetensors",
        qwen3="qwen3.safetensors", train_data_dir="train", optimizer_type="AdamW",
        **overrides,
    )


class SchedulerConfigTests(unittest.TestCase):
    def test_each_scheduler_validates_and_adapts_its_own_parameters(self):
        for scheduler, expected in (
            ("inverse_sqrt", {"lr_scheduler_timescale"}),
            ("cosine_with_min_lr", {"lr_scheduler_min_lr_ratio"}),
            ("warmup_stable_decay", {"lr_scheduler_min_lr_ratio", "lr_decay_steps"}),
        ):
            with self.subTest(scheduler=scheduler):
                source = config(lr_scheduler=scheduler, lr_scheduler_timescale="500",
                                lr_scheduler_min_lr_ratio="0.1", lr_decay_steps="0.2")
                self.assertEqual(validate_training_config(source), [])
                adapted, warnings = adapt_config(source)
                self.assertEqual(warnings, [])
                keys = {"lr_scheduler_timescale", "lr_scheduler_min_lr_ratio", "lr_decay_steps"}
                self.assertEqual(keys & adapted.keys(), expected)
                for key in expected:
                    self.assertIsInstance(adapted[key], (int, float))


    def test_rejects_invalid_active_scheduler_values(self):
        cases = (
            ("inverse_sqrt", "lr_scheduler_timescale", 0),
            ("inverse_sqrt", "lr_scheduler_timescale", 1.5),
            ("cosine_with_min_lr", "lr_scheduler_min_lr_ratio", 1.01),
            ("warmup_stable_decay", "lr_decay_steps", -1),
            ("warmup_stable_decay", "lr_decay_steps", 1.5),
            ("warmup_stable_decay", "lr_scheduler_num_cycles", 1.5),
        )
        for scheduler, key, value in cases:
            with self.subTest(scheduler=scheduler, key=key):
                errors = validate_training_config(config(lr_scheduler=scheduler, **{key: value}))
                self.assertTrue(any(key in error for error in errors), errors)
        source = config(lr_scheduler="constant", lr_scheduler_timescale=0, lr_decay_steps=-1)
        self.assertEqual(validate_training_config(source), [])


    def test_wsd_phases_fit_the_actual_scheduler_step_budget(self):
        source = {"lr_scheduler": "warmup_stable_decay", "lr_warmup_steps": 100, "lr_decay_steps": 400}
        self.assertEqual(validate_scheduler_step_budget(source, 2000), [])
        self.assertTrue(validate_scheduler_step_budget(source, 400))
        self.assertEqual(validate_scheduler_step_budget(source, 400, 2), [])
        source.update(lr_warmup_steps=0.6, lr_decay_steps=0.5)
        self.assertTrue(validate_scheduler_step_budget(source, 1000))
        source.update(lr_warmup_steps=0.1, lr_decay_steps=0.9)
        self.assertEqual(validate_scheduler_step_budget(source, 1000), [])


class PersistentWorkerTests(unittest.TestCase):
    def test_zero_workers_cannot_reach_the_trainer_with_persistence_enabled(self):
        for workers in (0, "0", 0.0, "0.00"):
            adapted, _ = adapt_config(config(max_data_loader_n_workers=workers, persistent_data_loader_workers=True))
            self.assertIs(adapted["persistent_data_loader_workers"], False)
