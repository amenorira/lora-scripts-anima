import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import toml

from backend.training.musubi_krea2 import KREA2_FIELDS, build_krea2_dataset_config, build_krea2_train_config, cache_manifest_path, get_krea2_cache_status, mark_cache_manifest, prepare_cache_manifest, validate_krea2_config
from backend.server.routes import training as training_routes
from backend.training import supervisor
from backend.tasks import TaskManager
from tests.helpers import json_request


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


class Krea2PreparationLifecycleTests(unittest.TestCase):
    def test_real_launcher_rejection_keeps_slot_through_manifest_rollback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            manager = TaskManager()
            settling, release = threading.Event(), threading.Event()

            def settle_manifest(config, status):
                settling.set()
                if not release.wait(5):
                    raise TimeoutError("manifest settlement was not released")
                mark_cache_manifest(config, status)

            async def exercise():
                loop = asyncio.get_running_loop()
                real_submit = loop.run_in_executor

                def submit(executor, func, *args):
                    if getattr(func, "__name__", "") == "_run":
                        raise RuntimeError("executor shutdown")
                    return real_submit(executor, func, *args)

                with patch.object(loop, "run_in_executor", side_effect=submit):
                    request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                    self.assertTrue(await asyncio.to_thread(settling.wait, 5))
                    self.assertIsNone(manager.reserve_task())
                    self.assertFalse(manager.begin_dataset_mutation())
                    release.set()
                    return await request

            with patch.object(training_routes, "tm", manager), \
                 patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(training_routes, "mark_cache_manifest", side_effect=settle_manifest), \
                 patch.object(supervisor, "_get_trainer_script", return_value=Path("trainer.py")), \
                 patch.object(supervisor, "get_engine", return_value=Mock(python_executable=None)), \
                 patch.object(supervisor, "save_config_snapshot"), \
                 patch.object(supervisor, "_build_train_env", return_value={}), \
                 patch.object(supervisor, "_read_run_meta", return_value={}), \
                 patch.object(supervisor, "_log_run_start"):
                try:
                    response = asyncio.run(exercise())
                finally:
                    release.set()

            self.assertEqual(response.status, "fail")
            self.assertIn("executor shutdown", response.message)
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})
            self.assertIsNotNone(manager.reserve_task())

    def test_cache_stop_or_http_cancel_after_manifest_settles_failed(self):
        for cancellation in ("stop", "http"):
            with self.subTest(cancellation=cancellation), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                config = krea2_config(root)
                entered, release = threading.Event(), threading.Event()
                manager = TaskManager()

                def write_run_info(*_args, **_kwargs):
                    entered.set()
                    if not release.wait(5):
                        raise TimeoutError("cache preparation was not released")

                async def exercise():
                    request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    task_id = next(iter(manager.tasks))
                    if cancellation == "stop":
                        manager.terminate_task(task_id)
                    else:
                        request.cancel()
                    self.assertIsNone(manager.reserve_task())
                    release.set()
                    if cancellation == "http":
                        with self.assertRaises(asyncio.CancelledError):
                            await request
                        return None
                    return await request

                with patch.object(training_routes, "tm", manager), \
                     patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                     patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                     patch.object(training_routes, "_write_run_info", side_effect=write_run_info), \
                     patch.object(training_routes, "run_train") as launch:
                    try:
                        response = asyncio.run(exercise())
                    finally:
                        release.set()

                if cancellation == "stop":
                    self.assertEqual(response.status, "fail")
                    self.assertEqual(response.message, "Training preparation cancelled / 训练准备已取消")
                launch.assert_not_called()
                self.assertIsNotNone(manager.reserve_task())
                manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
                self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})

    def test_cache_launcher_failure_marks_manifest_before_releasing_slot(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            manager = TaskManager()
            entered, release = threading.Event(), threading.Event()

            def settle_manifest(config, status):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("manifest settlement was not released")
                mark_cache_manifest(config, status)

            async def exercise():
                request = asyncio.create_task(training_routes.create_krea2_cache(json_request(dict(config))))
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                self.assertIsNone(manager.reserve_task())
                release.set()
                return await request

            with patch.object(training_routes, "tm", manager), \
                 patch.object(training_routes, "OUTPUT_DIR", root / "runs"), \
                 patch.object(training_routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(training_routes, "mark_cache_manifest", side_effect=settle_manifest), \
                 patch.object(training_routes, "run_train", return_value={"status": "error", "message": "launcher failed"}):
                try:
                    response = asyncio.run(exercise())
                finally:
                    release.set()

            self.assertEqual(response.status, "fail")
            self.assertEqual(response.message, "launcher failed")
            self.assertIsNotNone(manager.reserve_task())
            manifest = json.loads(cache_manifest_path(config["dataset_cache_dir"]).read_text(encoding="utf-8"))
            self.assertEqual(manifest["stages"], {"latents": "failed", "text_encoder": "failed"})


class Krea2CodecTests(unittest.TestCase):
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
            ), patch.object(training_routes, "AUTOSAVE_DIR", root / "config" / "autosave"), patch.object(
                training_routes, "tm", TaskManager()
            ):
                result = asyncio.run(training_routes._prepare_training(
                    training_routes._create_krea2_run, config, None, timestamp, dict(config),
                ))

            run_dirs = list((root / "runs").glob(f"krea2_test_{timestamp}_*"))
            self.assertEqual(len(run_dirs), 1)
            run_dir = run_dirs[0]
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
