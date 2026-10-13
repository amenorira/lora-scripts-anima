import unittest
import ast

from backend.training.adapter import adapt_config
from backend.training.validation import validate_scheduler_step_budget, validate_training_config
from tests.helpers import config_from_field_defaults
from backend.training.scheduler_config import extract_scheduler_form, parse_step_rules
from backend.training.training_config import build_training_config, extract_training_form, dump_training_config, parse_training_config_text


def config(**overrides):
    return config_from_field_defaults(
        model_train_type="anima-lora", network_module="networks.lora_anima",
        pretrained_model_name_or_path="model.safetensors", vae="vae.safetensors",
        qwen3="qwen3.safetensors", train_data_dir="train", optimizer_type="AdamW",
        **overrides,
    )


class SchedulerConfigTests(unittest.TestCase):
    def test_guided_scheduler_args_round_trip_without_top_level_leakage(self):
        for profile in ("anima-lora", "sdxl-lora"):
            for scheduler, fields in (
                ("warmup_stable_decay", {"warmup_type": "1-sqrt", "decay_type": "linear"}),
                ("piecewise_constant", {"step_rules": "2:1000,0.5:1600,0"}),
            ):
                with self.subTest(profile=profile, scheduler=scheduler):
                    source = config(lr_scheduler=scheduler, **fields)
                    source["model_train_type"] = profile
                    adapted, warnings = adapt_config(source)
                    self.assertEqual(warnings, [])
                    args = {k: ast.literal_eval(v) for k, v in
                            (item.split("=", 1) for item in adapted["lr_scheduler_args"])}
                    self.assertEqual(args, fields)
                    self.assertFalse(set(fields) & adapted.keys())
                    self.assertEqual({k: extract_scheduler_form(adapted)[k] for k in fields}, fields)
                    document = build_training_config(source, profile_id=profile)
                    restored = extract_training_form(parse_training_config_text(dump_training_config(document)))
                    self.assertEqual({k: restored[k] for k in fields}, fields)

    def test_piecewise_rules_reject_ambiguous_or_nonfinite_values(self):
        for value in ("", None, "1:100", "1:0,0.1", "1:100,0.5:100,0.1", "1:200,0.5:100,0.1",
                      "1:1.5,0.1", "1:1e3,0.1", "-1:100,0.1", "nan", "inf", "1e309", "1:100,",
                      "1:9007199254740992,0.1", "1，0.1", "0x10"):
            with self.subTest(value=value):
                errors = validate_training_config(config(lr_scheduler="piecewise_constant", step_rules=value))
                self.assertTrue(any("step_rules" in error for error in errors), errors)
                with self.assertRaises(ValueError):
                    adapt_config(config(lr_scheduler="piecewise_constant", step_rules=value))
        self.assertEqual(parse_step_rules(" 2 : 1000 , 5e-1 : 1600 , 0 "), ([(1000, 2.0), (1600, 0.5)], 0.0))
        self.assertEqual(parse_step_rules("1"), ([], 1.0))

    def test_inactive_guided_fields_and_raw_args_cannot_change_other_schedulers(self):
        source = config(lr_scheduler="constant", warmup_type="invalid", decay_type="invalid", step_rules="invalid")
        self.assertEqual(validate_training_config(source), [])
        adapted, _ = adapt_config(source)
        self.assertNotIn("lr_scheduler_args", adapted)
        source.update(lr_scheduler="warmup_stable_decay", optimizer_type="AdamWScheduleFree",
                      warmup_type="linear", decay_type="cosine")
        adapted, _ = adapt_config(source)
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertNotIn("lr_scheduler_args", adapted)

    def test_piecewise_disables_warmup_and_native_imports_recover_fields(self):
        source = config(lr_scheduler="piecewise_constant", step_rules=" 1 : 100 , 0.1 ", lr_warmup_steps=50)
        adapted, _ = adapt_config(source)
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertEqual(adapted["lr_scheduler_args"], ["step_rules='1:100,0.1'"])
        native = {"lr_scheduler": "warmup_stable_decay", "lr_scheduler_args": ['warmup_type="cosine"', 'decay_type="1-sqrt"']}
        adapted, _ = adapt_config(native)
        self.assertEqual(extract_scheduler_form(adapted)["decay_type"], "1-sqrt")
        native["warmup_type"] = "linear"
        self.assertEqual(extract_scheduler_form(native)["warmup_type"], "linear")

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
