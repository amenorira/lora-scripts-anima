import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import toml

from backend.training.core_registry import TrainingProfileError, resolve_training_profile
from backend.training.step_estimator import estimate_training_steps
from backend.training.musubi_runtime import MUSUBI_RUNTIME_PACKAGES, shared_runtime_status
from backend.training.musubi_krea2 import (
    KREA2_FIELDS,
    build_krea2_dataset_config,
    build_krea2_train_config,
    get_krea2_cache_status,
    image_files,
    mark_cache_manifest,
    prepare_cache_manifest,
    validate_krea2_config,
)
from backend.server.routes import training as training_routes


def krea2_config(root: Path) -> dict:
    config = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
    models = root / "models"
    models.mkdir(parents=True)
    for name in ("raw.safetensors", "vae.safetensors", "qwen3vl.safetensors"):
        (models / name).write_bytes(b"test")
    train = root / "train"
    train.mkdir()
    (train / "portrait.png").write_bytes(b"not-decoded-by-schema-tests")
    (train / "portrait.txt").write_text("a portrait", encoding="utf-8")
    config.update(
        {
            "model_train_type": "krea2-lora",
            "dit": str(models / "raw.safetensors"),
            "vae": str(models / "vae.safetensors"),
            "text_encoder": str(models / "qwen3vl.safetensors"),
            "train_data_dir": str(train),
            "dataset_cache_dir": str(train / ".krea2-cache"),
            "output_dir": str(root / "output"),
            "output_name": "krea2_test",
        }
    )
    return config


def krea_field_visible(field: dict, values: dict) -> bool:
    def matches(condition: dict) -> bool:
        current = values.get(condition["key"])
        if "eq" in condition:
            return current == condition["eq"] or current in condition.get("_or", [])
        if "neq" in condition:
            return current not in (condition["neq"], None, "")
        return True

    show_if = field.get("show_if")
    if isinstance(show_if, list) and not all(matches(condition) for condition in show_if):
        return False
    if isinstance(show_if, dict) and not matches(show_if):
        return False
    show_if_any = field.get("show_if_any")
    if show_if_any and not any(
        all(matches(condition) for condition in group) for group in show_if_any
    ):
        return False
    return True


class CoreRegistryTests(unittest.TestCase):
    def test_rejects_adapter_or_engine_cross_wiring(self):
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile({"model_train_type": "krea2-lora", "engine_id": "sd_scripts"})
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile(
                {"model_train_type": "sdxl-lora", "adapter_id": "lycoris", "network_module": "networks.lora"}
            )


class Krea2CodecTests(unittest.TestCase):
    def test_legacy_fp8_payload_is_normalized_and_both_flags_are_serialized_together(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update({"fp8_base": True, "fp8_scaled": False})

            self.assertEqual(validate_krea2_config(config), [])
            enabled = build_krea2_train_config(
                config, root / "dataset.toml", root / "output", root / "log"
            )

            config.update({"fp8_base": False, "fp8_scaled": True})
            self.assertEqual(validate_krea2_config(config), [])
            disabled = build_krea2_train_config(
                config, root / "dataset.toml", root / "output", root / "log"
            )

        self.assertTrue(config["fp8_scaled"] is False)
        self.assertTrue(enabled["fp8_base"])
        self.assertTrue(enabled["fp8_scaled"])
        self.assertNotIn("fp8_base", disabled)
        self.assertNotIn("fp8_scaled", disabled)

    def test_generates_separate_dataset_and_train_tomls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)

            self.assertEqual(validate_krea2_config(config), [])
            dataset = build_krea2_dataset_config(config)
            train = build_krea2_train_config(config, root / "run" / "dataset.toml", root / "artifact", root / "run" / "log")

        self.assertEqual(dataset["general"]["resolution"], [1024, 1024])
        self.assertEqual(dataset["datasets"][0]["cache_directory"], config["dataset_cache_dir"])
        self.assertEqual(train["network_module"], "networks.lora_krea2")
        self.assertNotIn("text_encoder", train)
        self.assertNotIn("train_batch_size", train)
        self.assertNotIn("save_model_as", train)
        self.assertNotIn("attn_mode", train)
        self.assertEqual(train["sigmoid_scale"], 1.0)
        self.assertTrue(train["sdpa"])

    def test_krea_timestep_field_visibility_matches_serialized_parameters(self):
        fields = {field["key"]: field for field in KREA2_FIELDS}
        sampling_modes = ("uniform", "sigmoid", "sigma", "shift", "krea2_shift", "logsnr")
        weighting_schemes = ("none", "sigma_sqrt", "cosmap", "logit_normal", "mode")

        for sampling in sampling_modes:
            for weighting in weighting_schemes:
                with self.subTest(sampling=sampling, weighting=weighting), tempfile.TemporaryDirectory() as temp_dir:
                    root = Path(temp_dir)
                    config = krea2_config(root)
                    config.update(
                        {
                            "timestep_sampling": sampling,
                            "weighting_scheme": weighting,
                            "logit_mean": 0.37,
                            "logit_std": 0.83,
                            "mode_scale": 1.77,
                        }
                    )
                    self.assertEqual(validate_krea2_config(config), [])
                    train = build_krea2_train_config(
                        config,
                        root / "dataset.toml",
                        root / "output",
                        root / "log",
                    )

                    uses_logit = sampling == "logsnr" or (
                        sampling == "sigma" and weighting == "logit_normal"
                    )
                    uses_mode = sampling == "sigma" and weighting == "mode"
                    self.assertEqual(krea_field_visible(fields["logit_mean"], config), uses_logit)
                    self.assertEqual(krea_field_visible(fields["logit_std"], config), uses_logit)
                    self.assertEqual(krea_field_visible(fields["mode_scale"], config), uses_mode)
                    self.assertEqual("logit_mean" in train, uses_logit)
                    self.assertEqual("logit_std" in train, uses_logit)
                    self.assertEqual("mode_scale" in train, uses_mode)

    def test_cache_directory_is_automatically_nested_under_its_dataset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config["dataset_cache_dir"] = str(root / "somewhere-else")

            self.assertEqual(validate_krea2_config(config), [])
            expected_cache = Path(config["train_data_dir"]) / ".krea2-cache"
            dataset = build_krea2_dataset_config(config)
            expected_cache.mkdir()
            (expected_cache / "not-a-training-image.png").write_bytes(b"cache artifact")

            images = image_files(config["train_data_dir"], config["dataset_cache_dir"])

        self.assertEqual(Path(config["dataset_cache_dir"]), expected_cache)
        self.assertEqual(Path(dataset["datasets"][0]["cache_directory"]), expected_cache)
        self.assertEqual([path.name for path in images], ["portrait.png"])

    def test_step_duration_and_scheduler_fields_map_to_musubi(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "krea_training_duration_mode": "steps",
                    "max_train_steps": 321,
                    "lr_scheduler": "cosine_with_restarts",
                    "lr_warmup_steps": "0.1",
                    "lr_decay_steps": 20,
                    "lr_scheduler_num_cycles": 2,
                    "max_grad_norm": 0.5,
                }
            )
            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")
            estimate = estimate_training_steps(config)

        self.assertEqual(train["max_train_steps"], 321)
        self.assertNotIn("max_train_epochs", train)
        self.assertEqual(train["lr_scheduler"], "cosine_with_restarts")
        self.assertEqual(train["lr_warmup_steps"], 0.1)
        self.assertEqual(train["lr_decay_steps"], 20)
        self.assertEqual(train["lr_scheduler_num_cycles"], 2)
        self.assertEqual(train["max_grad_norm"], 0.5)
        self.assertEqual(estimate["total_steps"], 321)

    def test_optimizer_alias_and_internal_scheduler_are_normalized(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "optimizer_type": "Prodigy",
                    "lr_scheduler": "cosine",
                    "lr_warmup_steps": 10,
                }
            )
            self.assertEqual(validate_krea2_config(config), [])
            self.assertEqual(config["optimizer_type"], "prodigyopt.Prodigy")

            config = krea2_config(root / "schedulefree")
            config.update(
                {
                    "optimizer_type": "schedulefree.AdamWScheduleFree",
                    "lr_scheduler": "cosine",
                    "lr_warmup_steps": 10,
                    "krea_schedulefree_warmup_steps": 25,
                }
            )
            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")

            legacy = krea2_config(root / "legacy")
            legacy.update({"optimizer_type": "torch.optim.SGD"})
            self.assertEqual(validate_krea2_config(legacy), [])
            legacy_train = build_krea2_train_config(
                legacy, root / "legacy-dataset.toml", root / "legacy-output", root / "legacy-log"
            )

        self.assertEqual(config["lr_scheduler"], "constant")
        self.assertEqual(config["lr_warmup_steps"], 0)
        self.assertEqual(train["optimizer_args"], ["warmup_steps=25"])
        self.assertEqual(legacy_train["optimizer_type"], "torch.optim.SGD")

    def test_final_state_save_is_independent_from_periodic_state_saves(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "save_state": False,
                    "save_state_on_train_end": True,
                }
            )
            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(
                config,
                root / "dataset.toml",
                root / "output",
                root / "log",
            )

        self.assertNotIn("save_state", train)
        self.assertTrue(train["save_state_on_train_end"])

    def test_rejects_arbitrary_optimizer_and_scheduler_injection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            config.update(
                {
                    "optimizer_type": "__custom__",
                    "krea_optimizer_custom_type": "bitsandbytes.optim.LAMB8bit",
                    "krea_optimizer_args": "weight_decay=0.01",
                    "krea_lr_scheduler_type": "CosineAnnealingLR",
                    "krea_lr_scheduler_args": "T_max=100",
                }
            )
            errors = validate_krea2_config(config)
            with self.assertRaisesRegex(ValueError, "only the built-in Krea 2 optimizer list"):
                build_krea2_train_config(
                    config,
                    Path(temp_dir) / "dataset.toml",
                    Path(temp_dir) / "output",
                    Path(temp_dir) / "log",
                )

        self.assertTrue(any(error.startswith("optimizer_type: only the built-in") for error in errors))
        self.assertTrue(any(error.startswith("krea_optimizer_custom_type:") for error in errors))
        self.assertTrue(any(error.startswith("krea_optimizer_args:") for error in errors))
        self.assertTrue(any(error.startswith("krea_lr_scheduler_type:") for error in errors))
        self.assertTrue(any(error.startswith("krea_lr_scheduler_args:") for error in errors))

    def test_rejects_unsafe_turbo_and_h2d_block_swap_combinations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "enable_krea_samples": True,
                    "krea_sample_prompts": "A fox in snow.",
                    "turbo_dit": str(root / "models" / "turbo.safetensors"),
                    "blocks_to_swap": 1,
                }
            )
            errors = validate_krea2_config(config)
            self.assertTrue(any("turbo_dit: cannot be combined" in error for error in errors))

            config = krea2_config(root / "h2d")
            config.update({"blocks_to_swap": 1, "block_swap_h2d_only": True, "gradient_checkpointing": False})
            errors = validate_krea2_config(config)

        self.assertTrue(any("block_swap_h2d_only: requires gradient_checkpointing" in error for error in errors))

    def test_launch_writes_managed_krea_sample_prompt_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "enable_krea_samples": True,
                    "krea_sample_prompts": "# stable regression prompt\nA fox in snow. --w 1024 --h 1024 --s 8 --l 1 --d 0",
                }
            )
            timestamp = "20260723-153000"
            with patch(
                "backend.server.routes.training.krea2_preflight",
                return_value={"ok": True, "errors": [], "cache": {"ready": True}},
            ), patch(
                "backend.server.routes.training.run_train", return_value={"status": "success"}
            ), patch.object(training_routes, "OUTPUT_DIR", root / "runs"), patch(
                "backend.server.routes.training.os.getcwd", return_value=str(root)
            ), patch.object(training_routes, "AUTOSAVE_DIR", root / "config" / "autosave"):
                result = asyncio.run(training_routes._create_krea2_run(config, None, timestamp))

            run_dir = root / "runs" / f"krea2_test_{timestamp}"
            prompt_file = run_dir / "sample_prompts.txt"
            train_config = toml.loads((run_dir / "config.toml").read_text(encoding="utf-8"))
            prompt_text = prompt_file.read_text(encoding="utf-8")
            points_to_prompt_file = os.path.samefile(train_config["sample_prompts"], prompt_file)

        self.assertEqual(result["status"], "success")
        self.assertEqual(
            prompt_text,
            "# stable regression prompt\nA fox in snow. --w 1024 --h 1024 --s 8 --l 1 --d 0\n",
        )
        self.assertTrue(points_to_prompt_file)
        self.assertEqual(train_config["text_encoder"], config["text_encoder"])
        self.assertNotIn("krea_sample_prompts", train_config)

    def test_cache_manifest_detects_caption_changes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            (cache / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
            (cache / "portrait_krea2_te.safetensors").write_bytes(b"text")
            prepare_cache_manifest(config)
            mark_cache_manifest(config, "completed")

            self.assertTrue(get_krea2_cache_status(config)["ready"])
            (Path(config["train_data_dir"]) / "portrait.txt").write_text("changed portrait caption", encoding="utf-8")
            self.assertFalse(get_krea2_cache_status(config)["ready"])


class MusubiRuntimeContractTests(unittest.TestCase):
    def test_fast_status_checks_metadata_without_importing_training_stack(self):
        versions = {
            name: (
                "2.10.0+cu130"
                if name == "torch"
                else "0.25.0+cu130"
                if name == "torchvision"
                else "11.3.0"
                if expected == ">=11.3.0"
                else "0.0.0"
                if expected is None
                else expected
            )
            for name, expected in MUSUBI_RUNTIME_PACKAGES.items()
        }
        with patch("backend.training.musubi_runtime.installed_versions", return_value=versions), patch(
            "backend.training.musubi_runtime.importlib.import_module"
        ) as import_module:
            status = shared_runtime_status(verify_imports=False)

        self.assertTrue(status["ok"], status["errors"])
        self.assertFalse(status["imports_verified"])
        self.assertIsNone(status["torch_path"])
        import_module.assert_not_called()

    def test_fast_status_rejects_cpu_torch_metadata(self):
        versions = {
            name: (
                "2.10.0"
                if name == "torch"
                else "0.25.0+cu130"
                if name == "torchvision"
                else "11.3.0"
                if expected == ">=11.3.0"
                else "0.0.0"
                if expected is None
                else expected
            )
            for name, expected in MUSUBI_RUNTIME_PACKAGES.items()
        }
        with patch("backend.training.musubi_runtime.installed_versions", return_value=versions):
            status = shared_runtime_status(verify_imports=False)

        self.assertFalse(status["ok"])
        self.assertTrue(any("torch must be a CUDA wheel" in error for error in status["errors"]))


class MultiCoreFrontendContractTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_flat_config_import_switches_profile_before_filtering_fields(self):
        script = r"""
global.window = {};
const storage = new Map([
  ['anima-form-train-basic', JSON.stringify({
    model_train_type: 'anima-lora',
    qwen3: './models/stale-qwen.safetensors',
  })],
]);
global.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, value); },
};
window.getVisibleSections = type => [{
  key: 'model',
  fields: type === 'sdxl-lora'
    ? [
        { key: 'model_train_type' },
        { key: 'pretrained_model_name_or_path' },
        { key: 'network_module' },
        { key: 'xformers' },
      ]
    : [{ key: 'model_train_type' }, { key: 'qwen3' }],
}];
require('./frontend/js/training-core.js');
require('./frontend/js/training-config-io.js');
const events = [];
const tickQueue = [];
const ctx = Object.assign({}, window.trainingCoreMixin, window.trainingConfigIoMixin, {
  currentRoute: 'train-basic',
  trainTypes: [{ v: 'sdxl-lora' }, { v: 'anima-lora' }, { v: 'krea2-lora' }],
  form: { model_train_type: 'anima-lora', qwen3: './models/old-qwen.safetensors' },
  _activeTrainType: 'anima-lora',
  _profileFormDrafts: {},
  _profileFieldSources: {},
  _fieldSources: {},
  switchTrainType(type) {
    events.push(`switch:${type}`);
    this.form = { model_train_type: type, network_module: 'networks.lora' };
    this._activeTrainType = type;
    this.$nextTick(() => {
      events.push(`switch-tick:${type}`);
      this.form.network_module = 'networks.lora';
    });
  },
  $nextTick(callback) { tickQueue.push(callback); },
  _buildFormDefaults(type) {
    events.push(`defaults:${type}`);
    return type === 'sdxl-lora'
      ? {
          model_train_type: type,
          pretrained_model_name_or_path: './models/default.safetensors',
          network_module: 'networks.lora',
          xformers: false,
        }
      : { model_train_type: type, qwen3: './models/default-qwen.safetensors' };
  },
  _normalizeProfileSelectValues() {},
  _syncKrea2CacheDir() {},
  _captureProfileDraft() {},
  updateToml() {},
  rebuildForm() {},
});
const importing = ctx._applyImportedFlatConfig({
  model_train_type: 'sdxl-lora',
  pretrained_model_name_or_path: './models/imported.safetensors',
  network_module: 'lycoris.kohya',
  xformers: true,
  qwen3: './models/must-not-leak.safetensors',
  unknown_field: 123,
});
while (tickQueue.length > 0) tickQueue.shift()();
importing.then(() => console.log(JSON.stringify({
  events,
  form: ctx.form,
  persisted: JSON.parse(storage.get('anima-form-train-basic')),
})));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["events"][0], "switch:sdxl-lora")
        self.assertEqual(state["events"][1], "switch-tick:sdxl-lora")
        self.assertEqual(state["events"][2], "defaults:sdxl-lora")
        self.assertEqual(state["form"]["model_train_type"], "sdxl-lora")
        self.assertEqual(state["form"]["pretrained_model_name_or_path"], "./models/imported.safetensors")
        self.assertEqual(state["form"]["network_module"], "lycoris.kohya")
        self.assertTrue(state["form"]["xformers"])
        self.assertNotIn("qwen3", state["form"])
        self.assertNotIn("unknown_field", state["form"])
        self.assertEqual(state["persisted"], state["form"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_training_profiles_keep_independent_drafts_and_reset_from_registry_defaults(self):
        script = r"""
global.window = {};
const profileFields = {
  'anima-lora': [
    { key: 'learning_rate', type: 'text', default: 'anima-default' },
    { key: 'optimizer_type', type: 'select', default: 'AnimaOpt', options: [{ v: 'AnimaOpt' }] },
  ],
  'sdxl-lora': [
    { key: 'learning_rate', type: 'text', default: 'sdxl-default' },
    { key: 'optimizer_type', type: 'select', default: 'SDXLOpt', options: [{ v: 'SDXLOpt' }] },
  ],
  'krea2-lora': [
    { key: 'learning_rate', type: 'text', default: 'krea-default' },
    { key: 'optimizer_type', type: 'select', default: 'KreaOpt', options: [{ v: 'KreaOpt' }] },
    { key: 'dit', type: 'text', default: './models/raw.safetensors' },
    { key: 'vae', type: 'text', default: './models/vae.safetensors' },
    { key: 'text_encoder', type: 'text', default: './models/text.safetensors' },
  ],
};
window.getVisibleSections = type => [{ key: 'test', fields: profileFields[type] }];
window.t = (_key, fallback) => fallback;
require('./frontend/js/training-core.js');
const noop = () => {};
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: {
    model_train_type: 'anima-lora',
    learning_rate: 'anima-custom',
    optimizer_type: 'AnimaOpt',
  },
  formDefaults: {},
  _profileFormDrafts: {},
  _profileFieldSources: {},
  _fieldSources: { learning_rate: 'user', optimizer_type: 'default' },
  _activeTrainType: 'anima-lora',
  currentRoute: '',
  renderTrainingForm: noop,
  setupAutoValueWatchers: noop,
  setupShowIfWatchers: noop,
  setupReadonlyWatchers: noop,
  updateToml: noop,
  rebuildForm: noop,
  toast: noop,
  t: (_key, fallback) => fallback || '',
  $nextTick: fn => fn(),
});
ctx.switchTrainType('krea2-lora');
const kreaFirst = { ...ctx.form };
ctx.form.learning_rate = 'krea-custom';
ctx._setFieldSource('learning_rate', 'user');
ctx.switchTrainType('sdxl-lora');
const sdxlFirst = { ...ctx.form };
ctx.switchTrainType('anima-lora');
const animaRestored = { ...ctx.form };
const animaSource = ctx._fieldSources.learning_rate;
ctx.switchTrainType('krea2-lora');
const kreaRestored = { ...ctx.form };
const kreaSource = ctx._fieldSources.learning_rate;
ctx.formDefaults.learning_rate = 'imported-baseline';
ctx.form.learning_rate = 'edited-after-import';
ctx.setField = (key, value) => { ctx.form[key] = value; };
ctx.resetField('learning_rate');
const kreaFieldReset = ctx.form.learning_rate;
const kreaFieldResetSource = ctx._fieldSources.learning_rate;
ctx.formDefaults.learning_rate = 'polluted-default';
ctx.form.learning_rate = 'polluted-value';
ctx.resetAllParams();
const kreaReset = { form: { ...ctx.form }, defaults: { ...ctx.formDefaults } };
const kreaResetSource = ctx._fieldSources.learning_rate;
console.log(JSON.stringify({
  kreaFirst, sdxlFirst, animaRestored, animaSource, kreaRestored, kreaSource,
  kreaFieldReset, kreaFieldResetSource, kreaReset, kreaResetSource,
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["kreaFirst"]["learning_rate"], "krea-default")
        self.assertEqual(state["sdxlFirst"]["learning_rate"], "sdxl-default")
        self.assertEqual(state["animaRestored"]["learning_rate"], "anima-custom")
        self.assertEqual(state["animaSource"], "user")
        self.assertEqual(state["kreaRestored"]["learning_rate"], "krea-custom")
        self.assertEqual(state["kreaSource"], "user")
        self.assertEqual(state["kreaFieldReset"], "krea-default")
        self.assertEqual(state["kreaFieldResetSource"], "default")
        self.assertEqual(state["kreaReset"]["form"]["learning_rate"], "krea-default")
        self.assertEqual(state["kreaReset"]["defaults"]["learning_rate"], "krea-default")
        self.assertEqual(state["kreaResetSource"], "default")


if __name__ == "__main__":
    unittest.main()
