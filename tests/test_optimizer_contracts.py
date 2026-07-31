import inspect
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

import torch

from backend.training.adapter import adapt_config
from backend.training.field_registry import FIELDS, get_fields_json
from backend.training.optimizer_contracts import (
    ADAFACTOR_OPTIMIZER_TYPE,
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    AUTOMAGIC_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)
from backend.training.optimizer_metadata import (
    KREA2_PROFILE,
    SD_SCRIPTS_PROFILE,
    optimizer_beta_hint_map,
    optimizer_beta_lengths,
    optimizer_entries,
    optimizer_groups,
)
from backend.training.validation import validate_training_config


def valid_config(optimizer_type: str, train_type: str = "anima-lora") -> dict:
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update(
        {
            "model_train_type": train_type,
            "network_module": (
                "networks.lora_anima" if train_type == "anima-lora" else "networks.lora"
            ),
            "pretrained_model_name_or_path": "model.safetensors",
            "vae": "vae.safetensors",
            "qwen3": "qwen3.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,1024",
            "output_name": "test",
            "output_dir": "output",
            "optimizer_type": optimizer_type,
            "gradient_accumulation_steps": 1,
            "mixed_precision": "bf16",
        }
    )
    if optimizer_type in {PRODIGY_OPTIMIZER_TYPE, PRODIGYPLUS_OPTIMIZER_TYPE}:
        config["learning_rate"] = "1.0"
    return config


def fields_by_key() -> dict[str, dict]:
    return {
        field["key"]: field
        for section in get_fields_json()["sections"]
        for field in section["fields"]
    }


def auto_value_for(field: dict, optimizer_type: str) -> object:
    for rule in field.get("autoValue", []):
        if rule.get("when") == optimizer_type:
            return rule["set"]
    raise AssertionError(f"No autoValue for {field['key']} and {optimizer_type}")


def contextual_auto_value_for(
    field: dict, optimizer_type: str, train_type: str, **conditions: object
) -> object:
    expected = {
        "optimizer_type": optimizer_type,
        "model_train_type": train_type,
        **conditions,
    }
    for rule in field.get("autoValue", []):
        if rule.get("watch") == expected:
            return rule["set"]
    raise AssertionError(
        f"No contextual autoValue for {field['key']} and {expected!r}"
    )


class OptimizerFieldContractTests(unittest.TestCase):
    def test_optimizer_metadata_defines_exact_selectors_groups_and_beta_contracts(self):
        self.assertEqual(
            [entry.selector for entry in optimizer_entries(SD_SCRIPTS_PROFILE)],
            [
                "AdamW",
                "AdamW8bit",
                "PagedAdamW8bit",
                STABLE_ADAMW_OPTIMIZER_TYPE,
                "Lion",
                "Lion8bit",
                "PagedLion8bit",
                ADAFACTOR_OPTIMIZER_TYPE,
                CAME_OPTIMIZER_TYPE,
                PRODIGY_OPTIMIZER_TYPE,
                PRODIGYPLUS_OPTIMIZER_TYPE,
                ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                AUTOMAGIC_OPTIMIZER_TYPE,
                "vendor.emo_optimizer.emosens.EmoSens",
            ],
        )
        self.assertEqual(len(optimizer_entries(KREA2_PROFILE)), 11)

        expected_group_order = [
            "opt.optimizer_group_adamw",
            "opt.optimizer_group_sign",
            "opt.optimizer_group_factorized",
            "opt.optimizer_group_adaptive",
            "opt.optimizer_group_experimental",
        ]
        self.assertEqual(
            [group["label_key"] for group in optimizer_groups(SD_SCRIPTS_PROFILE)],
            expected_group_order,
        )
        self.assertEqual(
            [group["label_key"] for group in optimizer_groups(KREA2_PROFILE)],
            expected_group_order[:-1],
        )

        for profile in (SD_SCRIPTS_PROFILE, KREA2_PROFILE):
            lengths = optimizer_beta_lengths(profile)
            hints = optimizer_beta_hint_map(profile)
            beta_entries = {
                entry.selector: entry
                for entry in optimizer_entries(profile)
                if entry.beta_arity is not None
            }
            self.assertEqual(set(lengths), set(beta_entries))
            self.assertEqual(set(hints), set(beta_entries))
            for selector, entry in beta_entries.items():
                with self.subTest(profile=profile, selector=selector):
                    self.assertEqual(lengths[selector], {entry.beta_arity})
                    self.assertEqual(hints[selector], entry.beta_hint_key)
                    self.assertTrue(entry.description_key.startswith("opt.optimizer_type_"))

    def test_registry_displays_product_defaults_and_anima_recommendations(self):
        from pytorch_optimizer import StableAdamW

        fields = fields_by_key()
        learning_rate = fields["learning_rate"]
        self.assertEqual(learning_rate["default"], "1e-4")
        self.assertEqual(auto_value_for(learning_rate, CAME_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE), "3e-4")
        self.assertEqual(auto_value_for(learning_rate, PRODIGY_OPTIMIZER_TYPE), "1.0")
        self.assertEqual(auto_value_for(learning_rate, AUTOMAGIC_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, STABLE_ADAMW_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(
            contextual_auto_value_for(learning_rate, "AdamW8bit", "anima-lora"),
            "2e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(learning_rate, "Lion8bit", "anima-lora"),
            "5e-6",
        )
        self.assertEqual(
            contextual_auto_value_for(learning_rate, CAME_OPTIMIZER_TYPE, "anima-lora"),
            "1.5e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, STABLE_ADAMW_OPTIMIZER_TYPE, "anima-lora"
            ),
            "2e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "anima-lora"
            ),
            "1e-4",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate,
                ADAFACTOR_OPTIMIZER_TYPE,
                "anima-lora",
                adafactor_relative_step=False,
            ),
            "2e-5",
        )

        scheduler = fields["lr_scheduler"]
        self.assertEqual(scheduler["hintKey"], "field.lr_schedulerHint")
        self.assertTrue(
            any(
                rule.get("watch") == "model_train_type"
                and rule.get("when") == "anima-lora"
                and rule.get("set") == "constant"
                for rule in scheduler["autoValue"]
            )
        )

        weight_decay = fields["weight_decay"]
        self.assertEqual(auto_value_for(weight_decay, "AdamW8bit"), 0.01)
        self.assertEqual(auto_value_for(weight_decay, "Lion8bit"), 0.0)
        self.assertEqual(auto_value_for(weight_decay, CAME_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(auto_value_for(weight_decay, STABLE_ADAMW_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(inspect.signature(StableAdamW).parameters["weight_decay"].default, 0.01)

        self.assertEqual(auto_value_for(fields["betas"], STABLE_ADAMW_OPTIMIZER_TYPE), "0.9, 0.99")
        self.assertEqual(auto_value_for(fields["eps"], STABLE_ADAMW_OPTIMIZER_TYPE), "1e-8")
        self.assertTrue(fields["stableadamw_kahan_sum"]["default"])
        self.assertTrue(fields["stableadamw_kahan_sum"]["advanced"])
        self.assertTrue(fields["stableadamw_weight_decouple"]["default"])
        self.assertEqual(fields["bnb_percentile_clipping"]["default"], 100)
        self.assertEqual(fields["bnb_min_8bit_size"]["default"], 4096)

        self.assertEqual(fields["prodigy_d0"]["default"], "1e-6")
        self.assertEqual(fields["schedulefree_warmup_steps"]["default"], 0)
        self.assertTrue(fields["adafactor_relative_step"]["default"])
        self.assertEqual(fields["adafactor_eps"]["default"], "1e-30, 1e-3")

    def test_registry_exports_nested_readonly_groups(self):
        max_grad_norm = fields_by_key()["max_grad_norm"]
        groups = max_grad_norm["readonlyIfAny"]
        stable_group = next(group for group in groups if isinstance(group, list))
        self.assertEqual(
            {condition["key"] for condition in stable_group},
            {"optimizer_type", "prodigyplus_use_stableadamw"},
        )
        self.assertEqual(max_grad_norm["min"], 0)


class OptimizerValidationTests(unittest.TestCase):
    def test_rejects_negative_or_non_finite_global_gradient_clip(self):
        for value in (-1, "-0.1", "inf"):
            with self.subTest(value=value):
                config = valid_config("AdamW")
                config["max_grad_norm"] = value
                errors = validate_training_config(config)
                self.assertTrue(any("max_grad_norm" in error for error in errors), errors)

    def test_validates_optimizer_specific_parameter_domains(self):
        cases = (
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999"}, "exactly 3"),
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999, 1.1"}, "item 2"),
            (PRODIGY_OPTIMIZER_TYPE, {"prodigy_d0": "0"}, "d0"),
            ("AdamW", {"weight_decay": -0.01}, "weight_decay"),
            ("AdamW8bit", {"optimizer_args": ["optim_bits=8"]}, "one of"),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, {"schedulefree_warmup_steps": 1.5}, "integer"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9"}, "exactly 2"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9, 1.0"}, "item 1"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"eps": "-1e-8"}, "eps"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"stableadamw_kahan_sum": "yes"}, "true or false"),
            ("AdamW8bit", {"bnb_percentile_clipping": 0}, "percentile_clipping"),
            ("Lion8bit", {"bnb_percentile_clipping": 101}, "percentile_clipping"),
            ("PagedAdamW8bit", {"bnb_min_8bit_size": -1}, "min_8bit_size"),
        )
        for optimizer_type, updates, expected in cases:
            with self.subTest(optimizer_type=optimizer_type, updates=updates):
                config = valid_config(optimizer_type)
                config.update(updates)
                errors = validate_training_config(config)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_rejects_unknown_arguments_for_known_optimizers(self):
        config = valid_config("AdamW")
        config["optimizer_args"] = ["silently_ignored_option=1"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

        config = valid_config(STABLE_ADAMW_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["unknown_stability_knob=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_real_sd_scripts_factory_instantiates_stableadamw(self):
        sd_scripts = Path("vendor/sd-scripts").resolve()
        sys.path.insert(0, str(sd_scripts))
        try:
            from library.optimizer import get_optimizer

            args = type(
                "Args",
                (),
                {
                    "optimizer_type": STABLE_ADAMW_OPTIMIZER_TYPE,
                    "use_8bit_adam": False,
                    "use_lion_optimizer": False,
                    "fused_backward_pass": False,
                    "gradient_accumulation_steps": 1,
                    "learning_rate": 1e-4,
                    "optimizer_args": [
                        "betas=(0.9,0.99)",
                        "eps=1e-8",
                        "weight_decay=0",
                        "weight_decouple=True",
                        "kahan_sum=True",
                    ],
                },
            )()
            parameter = torch.nn.Parameter(torch.ones(2))
            _, _, optimizer = get_optimizer(args, [parameter])
        finally:
            sys.path.remove(str(sd_scripts))

        self.assertEqual(type(optimizer).__name__, "StableAdamW")
        self.assertEqual(optimizer.param_groups[0]["weight_decay"], 0)
        self.assertEqual(optimizer.param_groups[0]["betas"], (0.9, 0.99))

        config = valid_config("AdamW8bit")
        config["optimizer_args"] = ["fused=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_rejects_prodigyplus_fused_modes(self):
        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["fused_back_pass=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("skip all updates" in error for error in errors), errors)

        config["optimizer_args"] = ["fused_backward_pass=False"]
        errors = validate_training_config(config)
        self.assertTrue(any("not a valid optimizer argument" in error for error in errors), errors)

        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["fused_backward_pass"] = True
        errors = validate_training_config(config)
        self.assertTrue(any("fused_backward_pass" in error for error in errors), errors)

    def test_prodigyplus_upstream_fused_flag_skips_regular_step(self):
        from prodigyplus import ProdigyPlusScheduleFree

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = ProdigyPlusScheduleFree(
            [parameter], lr=1.0, fused_back_pass=True
        )
        parameter.square().backward()
        before = parameter.detach().clone()
        optimizer.step()
        self.assertTrue(torch.equal(parameter.detach(), before))


class OptimizerAdapterTests(unittest.TestCase):
    def test_stableadamw_keeps_external_training_controls_and_loraplus(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": STABLE_ADAMW_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 20,
                "max_grad_norm": 1,
                "enable_loraplus": True,
                "loraplus_lr_ratio": 2,
                "weight_decay": 0,
                "stableadamw_kahan_sum": True,
                "stableadamw_weight_decouple": True,
            }
        )
        self.assertEqual(adapted["lr_scheduler"], "cosine")
        self.assertEqual(adapted["lr_warmup_steps"], 20)
        self.assertEqual(adapted["max_grad_norm"], 1)
        self.assertIn("loraplus_lr_ratio=2", adapted["network_args"])
        self.assertIn("weight_decay=0", adapted["optimizer_args"])
        self.assertIn("kahan_sum=True", adapted["optimizer_args"])
        self.assertEqual(warnings, [])

    def test_bitsandbytes_form_controls_only_apply_to_supported_optimizers(self):
        values = {
            "bnb_percentile_clipping": 99,
            "bnb_min_8bit_size": 16384,
        }
        for optimizer_type in ("AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"):
            adapted, _ = adapt_config({"optimizer_type": optimizer_type, **values})
            self.assertIn("percentile_clipping=99", adapted["optimizer_args"])
            self.assertIn("min_8bit_size=16384", adapted["optimizer_args"])

        adapted, _ = adapt_config({"optimizer_type": "AdamW", **values})
        self.assertNotIn("optimizer_args", adapted)

    def test_came_fixed_decay_requires_decoupled_weight_decay(self):
        coupled, _ = adapt_config(
            {
                "optimizer_type": CAME_OPTIMIZER_TYPE,
                "weight_decay": 0.02,
                "came_weight_decouple": False,
                "came_fixed_decay": True,
            }
        )
        decoupled, _ = adapt_config(
            {
                "optimizer_type": CAME_OPTIMIZER_TYPE,
                "weight_decay": 0.02,
                "came_weight_decouple": True,
                "came_fixed_decay": True,
            }
        )

        self.assertIn("weight_decouple=False", coupled["optimizer_args"])
        self.assertNotIn("fixed_decay=True", coupled["optimizer_args"])
        self.assertIn("weight_decouple=True", decoupled["optimizer_args"])
        self.assertIn("fixed_decay=True", decoupled["optimizer_args"])

    def test_adafactor_relative_and_manual_modes(self):
        relative, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 50,
                "max_grad_norm": 1,
                "adafactor_relative_step": True,
                "adafactor_scale_parameter": True,
                "adafactor_warmup_init": False,
                "adafactor_clip_threshold": 1.0,
                "adafactor_eps": "1e-30, 1e-3",
            }
        )
        self.assertEqual(relative["lr_scheduler"], "constant")
        self.assertEqual(relative["lr_warmup_steps"], 0)
        self.assertEqual(relative["max_grad_norm"], 0)
        self.assertIn("relative_step=True", relative["optimizer_args"])
        self.assertIn("eps=1e-30, 1e-3", relative["optimizer_args"])
        self.assertTrue(any("relative_step" in warning for warning in warnings), warnings)

        manual, _ = adapt_config(
            {
                "model_train_type": "sdxl-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 25,
                "max_grad_norm": 1,
                "adafactor_relative_step": False,
                "adafactor_scale_parameter": False,
            }
        )
        self.assertEqual(manual["lr_scheduler"], "cosine")
        self.assertEqual(manual["lr_warmup_steps"], 25)
        self.assertEqual(manual["max_grad_norm"], 0)
        self.assertIn("relative_step=False", manual["optimizer_args"])
        self.assertIn("scale_parameter=False", manual["optimizer_args"])

    def test_adafactor_warmup_init_enables_relative_step(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "adafactor_relative_step": False,
                "adafactor_warmup_init": True,
                "lr_scheduler": "linear",
                "lr_warmup_steps": 10,
            }
        )
        self.assertIn("relative_step=True", adapted["optimizer_args"])
        self.assertNotIn("relative_step=False", adapted["optimizer_args"])
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertTrue(any("warmup_init=True" in warning for warning in warnings), warnings)

    def test_schedulefree_uses_internal_warmup(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                "learning_rate": "0.0025",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "schedulefree_warmup_steps": 250,
            }
        )
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertIn("warmup_steps=250", adapted["optimizer_args"])
        self.assertTrue(any("external lr_warmup_steps" in warning for warning in warnings))

    def test_prodigy_injects_warmup_safeguard(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGY_OPTIMIZER_TYPE,
                "learning_rate": "0.5",
                "unet_lr": "0.25",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "prodigy_safeguard_warmup": False,
                "max_grad_norm": 1,
            }
        )
        self.assertEqual(adapted["learning_rate"], 1.0)
        self.assertEqual(adapted["unet_lr"], 1.0)
        self.assertIn("safeguard_warmup=True", adapted["optimizer_args"])
        self.assertNotIn("safeguard_warmup=False", adapted["optimizer_args"])
        self.assertTrue(any("gradient clipping" in warning for warning in warnings), warnings)

    def test_prodigyplus_gradient_clip_branches(self):
        cases = (
            ({}, 0),
            ({"prodigyplus_use_stableadamw": False, "eps": "1e-8"}, 1),
            ({"prodigyplus_use_stableadamw": False, "eps": "None"}, 0),
        )
        for updates, expected in cases:
            with self.subTest(updates=updates):
                config = {
                    "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                    "learning_rate": "1.0",
                    "lr_scheduler": "constant",
                    "max_grad_norm": 1,
                }
                config.update(updates)
                adapted, _ = adapt_config(config)
                self.assertEqual(adapted["max_grad_norm"], expected)

    def test_adapter_sanitizes_prodigyplus_fused_flags(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                "learning_rate": "1.0",
                "optimizer_args": [
                    "fused_back_pass=True",
                    "fused_backward_pass=False",
                ],
                "fused_backward_pass": True,
            }
        )
        self.assertIn("fused_back_pass=False", adapted["optimizer_args"])
        self.assertFalse(
            any(item.startswith("fused_backward_pass=") for item in adapted["optimizer_args"])
        )
        self.assertNotIn("fused_backward_pass", adapted)
        self.assertTrue(any("fused" in warning for warning in warnings), warnings)

    def test_optimizer_contracts_apply_to_anima_and_sdxl(self):
        for train_type in ("anima-lora", "sdxl-lora"):
            with self.subTest(train_type=train_type):
                adapted, _ = adapt_config(
                    {
                        "model_train_type": train_type,
                        "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                        "learning_rate": "0.0025",
                        "lr_scheduler": "linear",
                        "lr_warmup_steps": 5,
                        "schedulefree_warmup_steps": 20,
                    }
                )
                self.assertEqual(adapted["lr_scheduler"], "constant")
                self.assertEqual(adapted["lr_warmup_steps"], 0)
                self.assertIn("warmup_steps=20", adapted["optimizer_args"])


@unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
class OptimizerFrontendTests(unittest.TestCase):
    def test_dynamic_beta_hints_match_main_form_and_preset_editor(self):
        fields = fields_by_key()
        betas_field = fields["betas"]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
require('./frontend/js/training-presets.js');
const messages = {
  'field.betasHint_adam': 'adam beta mechanism',
  'field.betasHint_lion': 'lion beta mechanism',
  'field.betasHint_came': 'came beta mechanism',
};
const core = window.trainingCoreMixin;
const presets = window.trainingPresetsMixin;
const ctx = Object.assign({}, core, {
  form: { model_train_type: 'anima-lora', optimizer_type: 'AdamW' },
  t(key) { return messages[key] || key; },
});
const field = __FIELD__;
const mainAdam = ctx._resolveFieldHintText(field, ctx.form, 'anima-lora');
ctx.form.optimizer_type = 'Lion';
const mainLion = ctx._resolveFieldHintText(field, ctx.form, 'anima-lora');

const preset = Object.assign({}, core, presets, {
  presetEditor: {
    meta: { train_type: 'anima-lora' },
    entries: [
      { key: 'optimizer_type', value: 'pytorch_optimizer.CAME' },
      { key: 'betas', value: '0.9, 0.999, 0.9999', def: field },
    ],
  },
  t(key) { return messages[key] || key; },
});
const presetCame = preset.presetFieldHint(preset.presetEditor.entries[1]);
console.log(JSON.stringify({ mainAdam, mainLion, presetCame }));
""".replace("__FIELD__", json.dumps(betas_field))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        self.assertEqual(
            json.loads(result.stdout),
            {
                "mainAdam": "adam beta mechanism",
                "mainLion": "lion beta mechanism",
                "presetCame": "came beta mechanism",
            },
        )

    def test_anima_optimizer_automatic_values_preserve_explicit_values(self):
        fields = fields_by_key()
        rules = []
        for key in ("learning_rate", "lr_scheduler"):
            for rule in fields[key].get("autoValue", []):
                rules.append({"target": key, **rule})

        script = r"""
global.window = {};
require('./frontend/js/constants.js');
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;

function apply(modelType, optimizerType, learningRate, scheduler, source = 'default') {
  const fields = {
    learning_rate: { key: 'learning_rate', default: '1e-4' },
    lr_scheduler: { key: 'lr_scheduler', default: 'cosine_with_restarts' },
  };
  const ctx = Object.assign({}, core, {
    form: {
      model_train_type: modelType,
      optimizer_type: optimizerType,
      learning_rate: learningRate,
      lr_scheduler: scheduler,
    },
    formDefaults: {
      learning_rate: '1e-4',
      lr_scheduler: 'cosine_with_restarts',
    },
    _autoValueRules: rules,
    _fieldSources: {
      learning_rate: source,
      lr_scheduler: source,
    },
    _profileFieldSources: {},
    findFieldDef(key) { return fields[key]; },
  });
  ctx._applyInitialAutoValues();
  return {
    learning_rate: ctx.form.learning_rate,
    lr_scheduler: ctx.form.lr_scheduler,
  };
}

console.log(JSON.stringify({
  animaAdam: apply('anima-lora', 'AdamW8bit', '1e-4', 'cosine_with_restarts'),
  animaCame: apply('anima-lora', 'pytorch_optimizer.CAME', '1e-4', 'cosine_with_restarts'),
  animaLion: apply('anima-lora', 'Lion8bit', '1e-4', 'cosine_with_restarts'),
  sdxlLion: apply('sdxl-lora', 'Lion8bit', '1e-4', 'cosine_with_restarts'),
  custom: apply('anima-lora', 'pytorch_optimizer.CAME', '7e-5', 'cosine', 'user'),
}));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["animaAdam"],
            {"learning_rate": "2e-5", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["animaCame"],
            {"learning_rate": "1.5e-5", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["animaLion"],
            {"learning_rate": "5e-6", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["sdxlLion"],
            {"learning_rate": "2e-5", "lr_scheduler": "cosine_with_restarts"},
        )
        self.assertEqual(
            state["custom"],
            {"learning_rate": "7e-5", "lr_scheduler": "cosine"},
        )

    def test_field_provenance_controls_optimizer_transitions(self):
        fields = fields_by_key()
        rules = [
            {"target": key, **rule}
            for key in ("learning_rate", "lr_scheduler")
            for rule in fields[key].get("autoValue", [])
        ]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;
const fields = {
  learning_rate: { key: 'learning_rate', default: '1e-4', type: 'text' },
  lr_scheduler: { key: 'lr_scheduler', default: 'cosine_with_restarts', type: 'select' },
  optimizer_type: { key: 'optimizer_type', default: 'AdamW8bit', type: 'select' },
};
const ctx = Object.assign({}, core, {
  form: {
    model_train_type: 'anima-lora',
    optimizer_type: 'AdamW8bit',
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  },
  formDefaults: {
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  },
  formErrors: {},
  _autoValueRules: rules,
  _fieldSources: { learning_rate: 'default', lr_scheduler: 'default' },
  _profileFieldSources: {},
  findFieldDef(key) { return fields[key] || null; },
  queueTomlPreviewChange() {},
  pushHistory() {},
  _allShowIfKeys() { return []; },
  _currentProfileFieldDefault(key) { return fields[key] ? fields[key].default : ''; },
  updateTomlDebounced() {},
  scheduleOutputPathInfo() {},
  t(_key, fallback) { return fallback || ''; },
});
ctx._applyInitialAutoValues();
const fresh = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.form.optimizer_type = 'pytorch_optimizer.CAME';
ctx._applyInitialAutoValues();
const came = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.form.optimizer_type = 'Lion';
ctx._applyInitialAutoValues();
const lion = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.setField('learning_rate', '2e-5');
ctx.setField('lr_scheduler', 'cosine_with_restarts');
ctx.form.optimizer_type = 'AdamW8bit';
ctx._applyInitialAutoValues();
const manual = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.resetField('learning_rate');
const reset = { value: ctx.form.learning_rate, source: ctx._fieldSources.learning_rate };
console.log(JSON.stringify({ fresh, came, lion, manual, reset }));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            (state["fresh"]["learning_rate"], state["fresh"]["lr_scheduler"]),
            ("2e-5", "constant"),
        )
        self.assertEqual(
            (state["came"]["learning_rate"], state["came"]["lr_scheduler"]),
            ("1.5e-5", "constant"),
        )
        self.assertEqual(
            (state["lion"]["learning_rate"], state["lion"]["lr_scheduler"]),
            ("5e-6", "constant"),
        )
        self.assertEqual(
            (state["manual"]["learning_rate"], state["manual"]["lr_scheduler"]),
            ("2e-5", "cosine_with_restarts"),
        )
        self.assertEqual(state["manual"]["sources"]["learning_rate"], "user")
        self.assertEqual(state["manual"]["sources"]["lr_scheduler"], "user")
        self.assertEqual(state["reset"], {"value": "2e-5", "source": "auto"})

    def test_same_value_user_input_and_reset_persist_provenance(self):
        fields = fields_by_key()
        rules = [
            {"target": "learning_rate", **rule}
            for rule in fields["learning_rate"].get("autoValue", [])
        ]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;
let persistCalls = 0;
const field = { key: 'learning_rate', default: '1e-4', type: 'text' };
const ctx = Object.assign({}, core, {
  form: {
    model_train_type: 'anima-lora',
    optimizer_type: 'AdamW8bit',
    learning_rate: '2e-5',
  },
  formDefaults: { learning_rate: '2e-5' },
  formErrors: {},
  _autoValueRules: rules,
  _fieldSources: { learning_rate: 'auto' },
  _profileFieldSources: {},
  findFieldDef() { return field; },
  queueTomlPreviewChange() {},
  pushHistory() {},
  _allShowIfKeys() { return []; },
  _currentProfileFieldDefault() { return '1e-4'; },
  updateTomlDebounced() {},
  updateToml() {},
  scheduleOutputPathInfo() {},
  _persistProfileFieldSources() { persistCalls += 1; },
  t(_key, fallback) { return fallback || ''; },
});

ctx.setField('learning_rate', '2e-5');
const sameValueUser = {
  value: ctx.form.learning_rate,
  source: ctx._fieldSources.learning_rate,
  persistCalls,
};

ctx.resetField('learning_rate');
const sameValueReset = {
  value: ctx.form.learning_rate,
  source: ctx._fieldSources.learning_rate,
  persistCalls,
};

console.log(JSON.stringify({ sameValueUser, sameValueReset }));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["sameValueUser"],
            {"value": "2e-5", "source": "user", "persistCalls": 1},
        )
        self.assertEqual(
            state["sameValueReset"],
            {"value": "2e-5", "source": "auto", "persistCalls": 3},
        )

    def test_import_and_preset_keys_remain_explicit(self):
        fields = fields_by_key()
        visible_fields = [
            fields["model_train_type"],
            fields["optimizer_type"],
            fields["learning_rate"],
            fields["lr_scheduler"],
        ]
        rules = [
            {"target": key, **rule}
            for key in ("learning_rate", "lr_scheduler")
            for rule in fields[key].get("autoValue", [])
        ]
        script = r"""
global.window = {};
window.getVisibleSections = () => [{ key: 'optimizer', fields: __FIELDS__ }];
require('./frontend/js/training-core.js');
require('./frontend/js/training-presets.js');
const core = window.trainingCoreMixin;
const presets = window.trainingPresetsMixin;
const rules = __RULES__;

function makeContext() {
  const ctx = Object.assign({}, core, presets, {
    currentRoute: '',
    trainTypes: [{ v: 'anima-lora' }, { v: 'sdxl-lora' }],
    form: {
      model_train_type: 'anima-lora',
      optimizer_type: 'AdamW8bit',
      learning_rate: '1e-4',
      lr_scheduler: 'cosine_with_restarts',
    },
    formDefaults: {},
    formHistory: [],
    _profileFormDrafts: {},
    _profileFieldSources: {},
    _fieldSources: {},
    _activeTrainType: 'anima-lora',
    _autoValueRules: rules,
    updateToml() {},
    renderTrainingForm() {},
    updateReadonlyStates() {},
    rebuildForm() { this._applyInitialAutoValues(); },
    toastWithAction() {},
    toast() {},
    t(_key, fallback) { return fallback || ''; },
    $nextTick(fn) { fn(); },
  });
  const defaults = ctx._buildFormDefaults('anima-lora');
  ctx.formDefaults = { ...defaults };
  ctx._replaceProfileFieldSources('anima-lora', defaults);
  return ctx;
}

async function imported(data) {
  const ctx = makeContext();
  await ctx._applyImportedFlatConfig({ model_train_type: 'anima-lora', ...data });
  return {
    learning_rate: ctx.form.learning_rate,
    lr_scheduler: ctx.form.lr_scheduler,
    lrSource: ctx._fieldSources.learning_rate,
    schedulerSource: ctx._fieldSources.lr_scheduler,
  };
}

(async () => {
  const cameExplicit = await imported({
    optimizer_type: 'pytorch_optimizer.CAME',
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  });
  const cameLegacy = await imported({
    optimizer_type: 'pytorch_optimizer.CAME',
    learning_rate: '2e-4',
  });
  const stableExplicit = await imported({
    optimizer_type: 'pytorch_optimizer.StableAdamW',
    learning_rate: '1e-4',
  });
  const missingValues = await imported({ optimizer_type: 'pytorch_optimizer.CAME' });

  const preset = makeContext();
  preset.applyPreset({
    metadata: { name: 'explicit' },
    data: {
      optimizer_type: 'pytorch_optimizer.CAME',
      learning_rate: '1e-4',
      lr_scheduler: 'cosine_with_restarts',
    },
  });

  const selective = makeContext();
  Object.assign(selective.form, {
    optimizer_type: 'pytorch_optimizer.CAME',
    learning_rate: '1.5e-5',
    lr_scheduler: 'constant',
  });
  selective.formDefaults = { ...selective.form };
  selective._fieldSources = { learning_rate: 'auto', lr_scheduler: 'auto' };
  selective._profileFieldSources = {
    'anima-lora': { learning_rate: 'auto', lr_scheduler: 'auto' },
  };
  selective.presetEditor = { entries: [
    { key: 'learning_rate', value: '1e-4' },
    { key: 'lr_scheduler', value: 'cosine_with_restarts' },
  ] };
  selective.applyPresetDiffSelected(['learning_rate', 'lr_scheduler']);
  const selectiveApplied = {
    learning_rate: selective.form.learning_rate,
    lr_scheduler: selective.form.lr_scheduler,
    defaultLearningRate: selective.formDefaults.learning_rate,
    lrSource: selective._fieldSources.learning_rate,
  };
  selective.undoApplyPreset();
  const selectiveUndone = {
    learning_rate: selective.form.learning_rate,
    lr_scheduler: selective.form.lr_scheduler,
    lrSource: selective._fieldSources.learning_rate,
  };
  selective.form.optimizer_type = 'Lion8bit';
  selective._applyInitialAutoValues();

  console.log(JSON.stringify({
    cameExplicit,
    cameLegacy,
    stableExplicit,
    missingValues,
    preset: {
      learning_rate: preset.form.learning_rate,
      lr_scheduler: preset.form.lr_scheduler,
      lrSource: preset._fieldSources.learning_rate,
      schedulerSource: preset._fieldSources.lr_scheduler,
    },
    selectiveApplied,
    selectiveUndone,
    selectiveAfterSwitch: selective.form.learning_rate,
  }));
})().catch(error => { console.error(error); process.exit(1); });
""".replace("__FIELDS__", json.dumps(visible_fields)).replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["cameExplicit"],
            {
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine_with_restarts",
                "lrSource": "import",
                "schedulerSource": "import",
            },
        )
        self.assertEqual(state["cameLegacy"]["learning_rate"], "2e-4")
        self.assertEqual(state["cameLegacy"]["lrSource"], "import")
        self.assertEqual(state["stableExplicit"]["learning_rate"], "1e-4")
        self.assertEqual(state["stableExplicit"]["lrSource"], "import")
        self.assertEqual(
            (state["missingValues"]["learning_rate"], state["missingValues"]["lr_scheduler"]),
            ("1.5e-5", "constant"),
        )
        self.assertEqual(state["missingValues"]["lrSource"], "auto")
        self.assertEqual(state["missingValues"]["schedulerSource"], "auto")
        self.assertEqual(
            state["preset"],
            {
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine_with_restarts",
                "lrSource": "preset",
                "schedulerSource": "preset",
            },
        )
        self.assertEqual(
            state["selectiveApplied"],
            {
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine_with_restarts",
                "defaultLearningRate": "1e-4",
                "lrSource": "preset",
            },
        )
        self.assertEqual(
            state["selectiveUndone"],
            {
                "learning_rate": "1.5e-5",
                "lr_scheduler": "constant",
                "lrSource": "auto",
            },
        )
        self.assertEqual(state["selectiveAfterSwitch"], "5e-6")

    def test_legacy_drafts_and_placeholder_use_registry_provenance(self):
        fields = fields_by_key()
        visible_fields = [
            fields["model_train_type"],
            fields["optimizer_type"],
            fields["learning_rate"],
            fields["lr_scheduler"],
        ]
        script = r"""
global.window = {};
window.getVisibleSections = () => [{ key: 'optimizer', fields: __FIELDS__ }];
const storage = new Map();
global.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, value); },
};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const ctx = Object.assign({}, core, {
  currentRoute: 'train-anima',
  trainTypes: [{ v: 'anima-lora' }, { v: 'sdxl-lora' }],
  form: { model_train_type: 'anima-lora' },
  _activeTrainType: 'anima-lora',
  _profileFieldSources: {},
  _fieldSources: {},
});
const defaults = ctx._buildFormDefaults('anima-lora');
const legacyDraft = {
  ...defaults,
  optimizer_type: 'pytorch_optimizer.CAME',
  learning_rate: '1e-4',
  lr_scheduler: 'cosine_with_restarts',
};
ctx._activateProfileFieldSources('anima-lora', defaults, legacyDraft, true);
const legacySources = { ...ctx._fieldSources };
ctx.form = { ...legacyDraft };
ctx.setupAutoValueWatchers = function() {
  this._autoValueRules = [];
  window.getVisibleSections('anima-lora').forEach(section => section.fields.forEach(field => {
    (field.autoValue || []).forEach(rule => this._autoValueRules.push({
      target: rule.setTarget || field.key,
      watch: rule.watch,
      when: rule.when,
      set: rule.set,
      setIfDefault: rule.setIfDefault === true,
    }));
  }));
  this._applyInitialAutoValues();
};
ctx.setupAutoValueWatchers();
const preserved = { learning_rate: ctx.form.learning_rate, lr_scheduler: ctx.form.lr_scheduler };

ctx._fieldSources.learning_rate = 'user';
ctx._fieldSources.lr_scheduler = 'auto';
ctx._captureProfileFieldSources('anima-lora');
ctx._persistProfileFieldSources();
const reloaded = Object.assign({}, core, {
  currentRoute: 'train-anima',
  trainTypes: ctx.trainTypes,
})._loadProfileFieldSources('train-anima');

const learningRateField = __LR_FIELD__;
const placeholders = ctx._optimizerAutoValueMap(learningRateField, 'anima-lora');
console.log(JSON.stringify({
  legacySources,
  preserved,
  reloaded,
  placeholders,
  storageKey: ctx._profileFieldSourceStorageKey(),
}));
""".replace("__FIELDS__", json.dumps(visible_fields)).replace(
            "__LR_FIELD__", json.dumps(fields["learning_rate"])
        )

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["legacySources"]["learning_rate"], "saved")
        self.assertEqual(state["legacySources"]["lr_scheduler"], "saved")
        self.assertEqual(
            state["preserved"],
            {"learning_rate": "1e-4", "lr_scheduler": "cosine_with_restarts"},
        )
        self.assertEqual(
            state["reloaded"]["anima-lora"]["learning_rate"], "user"
        )
        self.assertEqual(
            state["reloaded"]["anima-lora"]["lr_scheduler"], "auto"
        )
        self.assertEqual(
            state["storageKey"], "anima-form-profile-sources-v1-train-anima"
        )
        self.assertEqual(state["placeholders"]["AdamW8bit"], "2e-5")
        self.assertEqual(state["placeholders"][CAME_OPTIMIZER_TYPE], "1.5e-5")
        self.assertEqual(state["placeholders"]["Lion"], "5e-6")
        self.assertEqual(
            state["placeholders"][ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE], "1e-4"
        )
        constants = Path("frontend/js/constants.js").read_text(encoding="utf-8")
        self.assertNotIn("ANIMA_OPTIMIZER_LR_DEFAULTS", constants)

    def test_default_omission_auto_value_provenance_and_readonly_groups(self):
        script = r"""
global.window = {};
require('./frontend/js/constants.js');
require('./frontend/js/training-core.js');
require('./frontend/js/training-toml.js');
const core = window.trainingCoreMixin;
const toml = window.trainingTomlMixin;

function args(form) {
  const ctx = Object.assign({}, core, toml, {
    form,
    findFieldDef() { return null; },
    _fieldShowIfMet() { return true; },
  });
  return ctx._buildOptimizerArgs(form);
}

const schedulefreeDefaults = args({
  optimizer_type: 'AdamWScheduleFree',
  weight_decay: 0,
  betas: '0.9, 0.999',
  eps: '1e-8',
  schedulefree_warmup_steps: 0,
});
const schedulefreeCustom = args({
  optimizer_type: 'AdamWScheduleFree',
  schedulefree_warmup_steps: 250,
});
const adafactorDefaults = args({
  optimizer_type: 'AdaFactor',
  weight_decay: 0,
  adafactor_relative_step: true,
  adafactor_scale_parameter: true,
  adafactor_warmup_init: false,
  adafactor_clip_threshold: 1,
  adafactor_eps: '1e-30, 1e-3',
});
const adafactorCustom = args({
  optimizer_type: 'AdaFactor',
  adafactor_relative_step: false,
  adafactor_scale_parameter: false,
});
const automagicDefaults = args({
  optimizer_type: 'vendor.automagic_optimizer.integration.Automagic3',
  automagic_min_lr: '1e-8',
  automagic_max_lr: '1e3',
  automagic_beta2: 0.999,
  automagic_clip_threshold: 1,
  automagic_polarity_history: 8,
  automagic_fused: false,
  eps: '1e-30',
  weight_decay: 0,
});
const stableDefaults = args({
  optimizer_type: 'pytorch_optimizer.StableAdamW',
  betas: '0.9, 0.99',
  eps: '1e-8',
  weight_decay: 0,
  stableadamw_kahan_sum: true,
  stableadamw_weight_decouple: true,
});
const stableCustom = args({
  optimizer_type: 'pytorch_optimizer.StableAdamW',
  weight_decay: 0.02,
  stableadamw_kahan_sum: false,
  stableadamw_weight_decouple: false,
});
const bnbDefaults = args({
  optimizer_type: 'AdamW8bit',
  bnb_percentile_clipping: 100,
  bnb_min_8bit_size: 4096,
});
const bnbCustom = args({
  optimizer_type: 'AdamW8bit',
  bnb_percentile_clipping: 99,
  bnb_min_8bit_size: 16384,
});

const field = { key: 'lr_scheduler', default: 'cosine_with_restarts' };
const rules = [
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'Prodigy', set: 'cosine', setIfDefault: true },
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'AdamWScheduleFree', set: 'constant', setIfDefault: false },
];
function autoContext(source) {
  return Object.assign({}, core, {
    form: { optimizer_type: 'Prodigy', lr_scheduler: 'constant' },
    formDefaults: { lr_scheduler: 'constant' },
    _autoValueRules: rules,
    _fieldSources: { lr_scheduler: source },
    _profileFieldSources: {},
    findFieldDef() { return field; },
  });
}
const previousAuto = autoContext('auto');
previousAuto._applyInitialAutoValues();
const explicitCustom = autoContext('user');
explicitCustom._applyInitialAutoValues();

const weightField = { key: 'weight_decay', default: '' };
const weightContext = Object.assign({}, core, {
  form: { optimizer_type: 'AdamW', weight_decay: 0 },
  formDefaults: { weight_decay: '' },
  _fieldSources: { weight_decay: 'user' },
  _profileFieldSources: {},
  _autoValueRules: [
    { target: 'weight_decay', watch: 'optimizer_type', when: 'AdamW', set: 0.01, setIfDefault: true },
    { target: 'weight_decay', watch: 'optimizer_type', when: 'Lion', set: 0, setIfDefault: true },
  ],
  findFieldDef() { return weightField; },
});
weightContext._applyInitialAutoValues();

const readonly = Object.assign({}, core, {
  form: {
    optimizer_type: 'prodigyplus.ProdigyPlusScheduleFree',
    prodigyplus_use_stableadamw: true,
    eps: '1e-8',
  },
});
const clauses = [
  { key: 'optimizer_type', eq: 'AdaFactor' },
  [
    { key: 'optimizer_type', eq: 'prodigyplus.ProdigyPlusScheduleFree' },
    { key: 'prodigyplus_use_stableadamw', eq: true },
  ],
];
const locked = readonly._readonlyIfAnyMet(clauses);
readonly.form.prodigyplus_use_stableadamw = false;
const unlocked = readonly._readonlyIfAnyMet(clauses);

function resetWithRule({ form, key, profileDefault, expected, rules }) {
  const ctx = Object.assign({}, core, {
    form: { model_train_type: 'anima-lora', ...form },
    formDefaults: { [key]: expected },
    _autoValueRules: rules.map(rule => ({ target: key, ...rule })),
    _fieldSources: { [key]: 'user' },
    _profileFieldSources: {},
    _currentProfileFieldDefault() { return profileDefault; },
    setField(target, value) {
      this.form[target] = value;
      this._setFieldSource(target, 'user');
    },
    updateToml() {},
  });
  ctx.resetField(key);
  return {
    value: ctx.form[key],
    changed: String(ctx.form[key]) !== String(ctx.formDefaults[key]),
    source: ctx._fieldSources[key],
  };
}

const optimizerResets = {
  adamWeightDecay: resetWithRule({
    form: { optimizer_type: 'AdamW', weight_decay: 0.2 },
    key: 'weight_decay', profileDefault: '', expected: 0.01,
    rules: [{ watch: 'optimizer_type', when: 'AdamW', set: 0.01, setIfDefault: true }],
  }),
  prodigyGradClip: resetWithRule({
    form: { optimizer_type: 'Prodigy', max_grad_norm: 1 },
    key: 'max_grad_norm', profileDefault: 1, expected: 0,
    rules: [{ watch: 'optimizer_type', when: 'Prodigy', set: 0, setIfDefault: true }],
  }),
  lionBetas: resetWithRule({
    form: { optimizer_type: 'Lion', betas: '0.8, 0.9' },
    key: 'betas', profileDefault: '', expected: '0.9, 0.99',
    rules: [{ watch: 'optimizer_type', when: 'Lion', set: '0.9, 0.99', setIfDefault: true }],
  }),
  automagicEps: resetWithRule({
    form: { optimizer_type: 'vendor.automagic_optimizer.integration.Automagic3', eps: '1e-8' },
    key: 'eps', profileDefault: '', expected: '1e-30',
    rules: [{ watch: 'optimizer_type', when: 'vendor.automagic_optimizer.integration.Automagic3', set: '1e-30', setIfDefault: true }],
  }),
  schedulefreeLearningRate: resetWithRule({
    form: { optimizer_type: 'AdamWScheduleFree', learning_rate: '1e-4' },
    key: 'learning_rate', profileDefault: '1e-4', expected: '3e-4',
    rules: [{ watch: 'optimizer_type', when: 'AdamWScheduleFree', set: '3e-4', setIfDefault: true }],
  }),
  adafactorScale: resetWithRule({
    form: { optimizer_type: 'AdaFactor', adafactor_relative_step: false, adafactor_scale_parameter: true },
    key: 'adafactor_scale_parameter', profileDefault: true, expected: false,
    rules: [{ watch: 'adafactor_relative_step', when: false, set: false }],
  }),
};

console.log(JSON.stringify({
  schedulefreeDefaults,
  schedulefreeCustom,
  adafactorDefaults,
  adafactorCustom,
  automagicDefaults,
  stableDefaults,
  stableCustom,
  bnbDefaults,
  bnbCustom,
  previousAuto: previousAuto.form.lr_scheduler,
  explicitCustom: explicitCustom.form.lr_scheduler,
  explicitAlternateDefault: weightContext.form.weight_decay,
  locked,
  unlocked,
  optimizerResets,
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["schedulefreeDefaults"], [])
        self.assertEqual(state["schedulefreeCustom"], ["warmup_steps=250"])
        self.assertEqual(state["adafactorDefaults"], [])
        self.assertEqual(
            state["adafactorCustom"],
            ["relative_step=False", "scale_parameter=False"],
        )
        self.assertEqual(state["automagicDefaults"], [])
        self.assertEqual(state["stableDefaults"], ["weight_decay=0"])
        self.assertEqual(
            state["stableCustom"],
            ["weight_decay=0.02", "kahan_sum=False", "weight_decouple=False"],
        )
        self.assertEqual(state["bnbDefaults"], [])
        self.assertEqual(
            state["bnbCustom"],
            ["percentile_clipping=99", "min_8bit_size=16384"],
        )
        self.assertEqual(state["previousAuto"], "cosine")
        self.assertEqual(state["explicitCustom"], "constant")
        self.assertEqual(state["explicitAlternateDefault"], 0)
        self.assertTrue(state["locked"])
        self.assertFalse(state["unlocked"])
        self.assertEqual(
            state["optimizerResets"],
            {
                "adamWeightDecay": {"value": 0.01, "changed": False, "source": "auto"},
                "prodigyGradClip": {"value": 0, "changed": False, "source": "auto"},
                "lionBetas": {"value": "0.9, 0.99", "changed": False, "source": "auto"},
                "automagicEps": {"value": "1e-30", "changed": False, "source": "auto"},
                "schedulefreeLearningRate": {"value": "3e-4", "changed": False, "source": "auto"},
                "adafactorScale": {"value": False, "changed": False, "source": "auto"},
            },
        )


if __name__ == "__main__":
    unittest.main()
