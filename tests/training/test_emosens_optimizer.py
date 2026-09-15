import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from backend.training.adapter import adapt_config
from backend.training.field_registry import (
    EMOSENS_OPTIMIZER_TYPE,
    get_fields_json,
)
from backend.training.supervisor import _build_train_env
from backend.training.validation import get_emosens_conflicts, validate_training_config
from tests.helpers import config_from_field_defaults


def valid_emosens_config() -> dict:
    config = config_from_field_defaults()
    config.update(
        {
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "pretrained_model_name_or_path": "model.safetensors",
            "vae": "vae.safetensors",
            "qwen3": "qwen3.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,768",
            "output_name": "test",
            "output_dir": "output",
            "optimizer_type": EMOSENS_OPTIMIZER_TYPE,
            "learning_rate": "0.1",
            "gradient_accumulation_steps": 1,
            "mixed_precision": "bf16",
        }
    )
    return config


class EmoSensFieldContractTests(unittest.TestCase):
    def test_registry_exposes_constraints_and_recommendations(self):
        sections = get_fields_json()["sections"]
        fields = {
            field["key"]: field
            for section in sections
            for field in section["fields"]
        }
        optimizer_options = [
            option
            for group in fields["optimizer_type"]["groups"]
            for option in group["options"]
        ]
        self.assertTrue(any(option["v"] == EMOSENS_OPTIMIZER_TYPE for option in optimizer_options))
        self.assertNotIn("lr_scheduler_type", fields)

        accumulation = fields["gradient_accumulation_steps"]
        self.assertEqual(accumulation["autoValue"][0]["set"], 1)
        self.assertEqual(accumulation["readonlyIf"]["eq"], EMOSENS_OPTIMIZER_TYPE)
        self.assertEqual(
            accumulation["readonlyIf"]["reasonKey"],
            "field.gradient_accumulation_steps_emosensLocked",
        )

        learning_rate_rules = fields["learning_rate"]["autoValue"]
        emo_rules = [
            rule
            for rule in learning_rate_rules
            if rule.get("when") == EMOSENS_OPTIMIZER_TYPE
            or (
                isinstance(rule.get("watch"), dict)
                and rule["watch"].get("optimizer_type") == EMOSENS_OPTIMIZER_TYPE
            )
        ]
        self.assertEqual([rule["set"] for rule in emo_rules], ["0.1", "1.0"])
        self.assertTrue(all(rule["setIfDefault"] for rule in emo_rules))

        max_grad_norm = fields["max_grad_norm"]
        emo_rules = [
            rule
            for rule in max_grad_norm.get("autoValue", [])
            if rule.get("when") == EMOSENS_OPTIMIZER_TYPE
            or (
                isinstance(rule.get("watch"), dict)
                and rule["watch"].get("optimizer_type") == EMOSENS_OPTIMIZER_TYPE
            )
        ]
        self.assertEqual(emo_rules, [])
        self.assertNotIn("readonlyIf", max_grad_norm)

class EmoSensValidationTests(unittest.TestCase):
    def test_accepts_single_gpu_bf16_or_no_precision(self):
        for precision in ("bf16", "no"):
            with self.subTest(precision=precision):
                config = valid_emosens_config()
                config["mixed_precision"] = precision
                self.assertEqual(validate_training_config(config, gpu_ids=[0]), [])

    def test_rejects_unsupported_execution_modes(self):
        cases = (
            ({"gradient_accumulation_steps": 2}, [0], "gradient_accumulation_steps"),
            ({"mixed_precision": "fp16"}, [0], "mixed_precision"),
            ({}, [0, 1], "one GPU"),
        )
        for updates, gpu_ids, expected in cases:
            with self.subTest(expected=expected):
                config = valid_emosens_config()
                config.update(updates)
                errors = validate_training_config(config, gpu_ids=gpu_ids)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_rejects_non_positive_or_non_finite_learning_rate(self):
        for value in (0, -0.1, "nan", "invalid"):
            with self.subTest(value=value):
                config = valid_emosens_config()
                config["learning_rate"] = value
                errors = validate_training_config(config)
                self.assertTrue(any("learning_rate" in error for error in errors), errors)

    def test_conflict_helper_does_not_restrict_gradient_clipping(self):
        config = valid_emosens_config()
        config["max_grad_norm"] = 0.7
        self.assertEqual(get_emosens_conflicts(config, [0]), [])


class EmoSensAdapterTests(unittest.TestCase):
    def test_threshold_and_switches_reach_optimizer(self):
        for threshold in (0, 0.0001, 2.0):
            config = valid_emosens_config()
            config.update(stopcoef=threshold, notify=False, use_shadow=True)
            self.assertEqual(validate_training_config(config, gpu_ids=[0]), [])
            adapted, _ = adapt_config(config)
            args = dict(item.split("=", 1) for item in adapted["optimizer_args"])
            self.assertEqual(float(args["stopcoef"]), threshold)
            self.assertIn("notify=False", adapted["optimizer_args"])
            self.assertIn("use_shadow=True", adapted["optimizer_args"])
            self.assertNotIn("notify", adapted)
            self.assertNotIn("use_shadow", adapted)

    def test_sets_recommended_lr_only_for_missing_value(self):
        cases = (
            ("anima-lora", "1e-4", "1e-4"),
            ("sdxl-lora", "1e-4", "1e-4"),
            ("anima-lora", None, 0.1),
            ("sdxl-lora", None, 1.0),
        )
        for model_type, learning_rate, expected in cases:
            with self.subTest(model_type=model_type, learning_rate=learning_rate):
                config = {
                    "model_train_type": model_type,
                    "optimizer_type": EMOSENS_OPTIMIZER_TYPE,
                }
                if learning_rate is not None:
                    config["learning_rate"] = learning_rate
                adapted, _ = adapt_config(config)
                self.assertEqual(adapted["learning_rate"], expected)
                self.assertNotIn("lr_scheduler_type", adapted)
                self.assertEqual(adapted["lr_scheduler"], "constant")
                self.assertEqual(adapted["lr_warmup_steps"], 0)

    def test_preserves_explicit_learning_rate_and_gradient_clipping(self):
        for model_type, learning_rate in (("anima-lora", "0.2"), ("sdxl-lora", "0.5")):
            with self.subTest(model_type=model_type):
                adapted, warnings = adapt_config(
                    {
                        "model_train_type": model_type,
                        "optimizer_type": EMOSENS_OPTIMIZER_TYPE,
                        "learning_rate": learning_rate,
                        "max_grad_norm": 0.7,
                    }
                )
                self.assertEqual(adapted["learning_rate"], learning_rate)
                self.assertEqual(adapted["max_grad_norm"], 0.7)
                self.assertFalse(any("learning_rate auto-adjusted" in warning for warning in warnings))


@unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
class EmoSensFrontendTests(unittest.TestCase):
    def test_switches_serialize_as_python_booleans(self):
        script = r"""
global.window = {};
require('./frontend/js/constants.js');
require('./frontend/js/training-toml.js');
const mixin = window.trainingTomlMixin;
mixin.findFieldDef = () => null;
const args = mixin._buildOptimizerArgs.call(mixin, {
  optimizer_type: 'vendor.emo_optimizer.emosens.EmoSens',
  stopcoef: 0, notify: false, use_shadow: true,
});
console.log(JSON.stringify(args));
"""
        result = subprocess.run(["node", "-e", script], capture_output=True,
                                text=True, check=True, cwd=Path.cwd())
        args = json.loads(result.stdout)
        self.assertIn("notify=False", args)
        self.assertIn("use_shadow=True", args)
        self.assertIn("stopcoef=0", args)

    def test_recommendation_order_custom_value_and_constraint_notifications(self):
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const mixin = window.trainingCoreMixin;
const optimizer = 'vendor.emo_optimizer.emosens.EmoSens';
const field = { key: 'learning_rate', default: '1e-4' };
const rules = [
  { target: 'learning_rate', watch: { optimizer_type: optimizer, model_train_type: 'anima-lora' }, set: '0.1', setIfDefault: true },
  { target: 'learning_rate', watch: 'optimizer_type', when: optimizer, set: '1.0', setIfDefault: true },
];
function makeContext(modelType, learningRate, source) {
  return Object.assign({}, mixin, {
    form: { optimizer_type: optimizer, model_train_type: modelType, learning_rate: learningRate },
    formDefaults: { learning_rate: '1e-4' },
    _autoValueRules: rules,
    _fieldSources: { learning_rate: source },
    _profileFieldSources: {},
    _allSections() { return [{ fields: [field] }]; },
  });
}
const anima = makeContext('anima-lora', '1e-4', 'default');
anima._applyInitialAutoValues();
const sdxl = makeContext('sdxl-lora', '1e-4', 'default');
sdxl._applyInitialAutoValues();
const previousRecommendation = makeContext('anima-lora', '1.0', 'auto');
previousRecommendation._applyInitialAutoValues();
const custom = makeContext('anima-lora', '0.2', 'user');
custom._applyInitialAutoValues();

const toasts = [];
const constrained = Object.assign({}, mixin, {
  form: {
    optimizer_type: optimizer,
    gradient_accumulation_steps: 3,
    mixed_precision: 'fp16',
    gpu_ids: [0, 1],
  },
  t(key) {
    return {
      'field.emosensAdjustedValue': '{parameter} from {value} to {required}',
      'field.emosensAutoAdjusted': 'adjusted: {details}',
      'field.emosensConstraintSeparator': '; ',
      'field.emosensMultiGpuConflict': 'gpu_ids={value}; one GPU',
    }[key] || key;
  },
  toast(message) { toasts.push(message); },
});
constrained._enforceEmosensUiConstraints('optimizer_type');

const watcherRaceToasts = [];
const watcherRaceForm = new Proxy({
  optimizer_type: 'AdamW8bit',
  gradient_accumulation_steps: 3,
  mixed_precision: 'fp16',
}, {
  set(target, key, value) {
    target[key] = value;
    if (key === 'optimizer_type' && value === optimizer) {
      // Mirrors the synchronous auto-value watcher in the mounted Alpine form.
      target.gradient_accumulation_steps = 1;
      target.mixed_precision = 'bf16';
    }
    return true;
  },
});
const watcherRace = Object.assign({}, mixin, {
  form: watcherRaceForm,
  formDefaults: {},
  formErrors: {},
  findFieldDef() { return null; },
  _allShowIfKeys() { return []; },
  pushHistory() {},
  updateTomlDebounced() {},
  t(key) {
    return {
      'field.emosensAdjustedValue': '{parameter} from {value} to {required}',
      'field.emosensAutoAdjusted': 'adjusted: {details}',
      'field.emosensConstraintSeparator': '; ',
      'field.emosensMultiGpuConflict': 'gpu_ids={value}; one GPU',
    }[key] || key;
  },
  toast(message) { watcherRaceToasts.push(message); },
});
watcherRace.setField('optimizer_type', optimizer);
console.log(JSON.stringify({
  anima: anima.form.learning_rate,
  sdxl: sdxl.form.learning_rate,
  previousRecommendation: previousRecommendation.form.learning_rate,
  custom: custom.form.learning_rate,
  accumulation: constrained.form.gradient_accumulation_steps,
  precision: constrained.form.mixed_precision,
  toasts,
  watcherRaceToasts,
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
        self.assertEqual(state["anima"], "0.1")
        self.assertEqual(state["sdxl"], "1.0")
        self.assertEqual(state["previousRecommendation"], "0.1")
        self.assertEqual(state["custom"], "0.2")
        self.assertEqual(state["accumulation"], 1)
        self.assertEqual(state["precision"], "bf16")
        self.assertTrue(any("gradient_accumulation_steps" in item for item in state["toasts"]))
        self.assertTrue(any("mixed_precision" in item for item in state["toasts"]))
        self.assertTrue(any("gpu_ids=0,1" in item for item in state["toasts"]))
        self.assertTrue(any("gradient_accumulation_steps" in item for item in state["watcherRaceToasts"]))
        self.assertTrue(any("mixed_precision" in item for item in state["watcherRaceToasts"]))


class EmoSensWindowsTests(unittest.TestCase):
    def test_real_steps_and_state_resume(self):
        # Isolate upstream's global Tensor.backward hook from the test process.
        script = r"""
import copy
import torch
from vendor.emo_optimizer.emosens import EmoSens
for lr, ceiling in [(0.1, 3e-4), (1.0, 3e-3), (10.0, 3e-3), (1e-5, 3e-7)]:
    p = torch.nn.Parameter(torch.tensor([1.0, 2.0], dtype=torch.float64))
    opt = EmoSens([p], lr=lr, notify=False)
    assert abs(opt.max_lim - ceiling) < 1e-12
    loss = p.square().mean()
    loss.backward()
    assert opt._manual_loss == loss.item()
    opt.step()
    assert 1e-8 <= opt.param_groups[0]['lr'] <= ceiling
    assert torch.isfinite(p).all() and not torch.equal(p, torch.tensor([1.0, 2.0]))
    saved = copy.deepcopy(opt.state_dict())
    q = torch.nn.Parameter(p.detach().clone())
    resumed = EmoSens([q], lr=lr, notify=False)
    resumed.load_state_dict(copy.deepcopy(saved))
    for param, optimizer in [(p, opt), (q, resumed)]:
        optimizer.zero_grad()
        param.square().mean().backward()
        optimizer.step()
    torch.testing.assert_close(p, q, rtol=0, atol=0)
    assert opt.param_groups[0]['lr'] == resumed.param_groups[0]['lr']
print('verified')
"""
        result = subprocess.run([sys.executable, "-c", script], cwd=Path.cwd(),
                                env=_build_train_env("artifacts", "task-id"),
                                capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertIn(b"verified", result.stdout)

    def test_unmodified_upstream_import_uses_training_utf8_environment(self):
        env = _build_train_env("artifacts", "task-id")
        result = subprocess.run(
            [sys.executable, "-c", "import vendor.emo_optimizer.emosens; print('ok')"],
            cwd=Path.cwd(),
            env=env,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("cp936", errors="replace"))
        self.assertIn(b"ok", result.stdout)

    def test_training_subprocess_forces_utf8(self):
        env = _build_train_env("artifacts", "task-id")
        self.assertEqual(env["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(env["PYTHONUTF8"], "1")


if __name__ == "__main__":
    unittest.main()
