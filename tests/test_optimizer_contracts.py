import inspect
import json
import shutil
import subprocess
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


class OptimizerFieldContractTests(unittest.TestCase):
    def test_registry_displays_constructor_defaults_and_recommendations(self):
        from pytorch_optimizer import CAME

        fields = fields_by_key()
        learning_rate = fields["learning_rate"]
        self.assertEqual(learning_rate["default"], "1e-4")
        self.assertEqual(
            float(auto_value_for(learning_rate, CAME_OPTIMIZER_TYPE)),
            inspect.signature(CAME).parameters["lr"].default,
        )
        self.assertEqual(auto_value_for(learning_rate, ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE), "3e-4")
        self.assertEqual(auto_value_for(learning_rate, PRODIGY_OPTIMIZER_TYPE), "1.0")
        self.assertEqual(auto_value_for(learning_rate, AUTOMAGIC_OPTIMIZER_TYPE), "1e-4")

        weight_decay = fields["weight_decay"]
        self.assertEqual(auto_value_for(weight_decay, "AdamW8bit"), 0.01)
        self.assertEqual(auto_value_for(weight_decay, "Lion8bit"), 0.0)
        self.assertEqual(auto_value_for(weight_decay, CAME_OPTIMIZER_TYPE), 0.0)

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

const field = { key: 'lr_scheduler', default: 'cosine_with_restarts' };
const rules = [
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'Prodigy', set: 'cosine', setIfDefault: true },
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'AdamWScheduleFree', set: 'constant', setIfDefault: false },
];
function autoContext(applied) {
  return Object.assign({}, core, {
    form: { optimizer_type: 'Prodigy', lr_scheduler: 'constant' },
    formDefaults: { lr_scheduler: 'constant' },
    _autoValueRules: rules,
    _autoValueApplied: applied,
    findFieldDef() { return field; },
  });
}
const previousAuto = autoContext({ lr_scheduler: 'constant' });
previousAuto._applyInitialAutoValues();
const explicitCustom = autoContext({});
explicitCustom._applyInitialAutoValues();

const weightField = { key: 'weight_decay', default: '' };
const weightContext = Object.assign({}, core, {
  form: { optimizer_type: 'AdamW', weight_decay: 0 },
  formDefaults: { weight_decay: '' },
  _autoValueApplied: {},
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
    _currentProfileFieldDefault() { return profileDefault; },
    setField(target, value) { this.form[target] = value; },
  });
  ctx.resetField(key);
  return {
    value: ctx.form[key],
    changed: String(ctx.form[key]) !== String(ctx.formDefaults[key]),
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
        self.assertEqual(state["previousAuto"], "cosine")
        self.assertEqual(state["explicitCustom"], "constant")
        self.assertEqual(state["explicitAlternateDefault"], 0)
        self.assertTrue(state["locked"])
        self.assertFalse(state["unlocked"])
        self.assertEqual(
            state["optimizerResets"],
            {
                "adamWeightDecay": {"value": 0.01, "changed": False},
                "prodigyGradClip": {"value": 0, "changed": False},
                "lionBetas": {"value": "0.9, 0.99", "changed": False},
                "automagicEps": {"value": "1e-30", "changed": False},
                "schedulefreeLearningRate": {"value": "3e-4", "changed": False},
                "adafactorScale": {"value": False, "changed": False},
            },
        )


if __name__ == "__main__":
    unittest.main()
