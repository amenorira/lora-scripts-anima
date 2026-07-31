import json
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.monitor import artifacts
from backend.tasks import TaskManager
from backend.training.adapter import adapt_config
from backend.training.field_registry import FIELDS, get_all_fields
from backend.training.step_estimator import StepEstimateError, estimate_training_steps
from backend.training.validation import validate_training_config
from backend.utils.train_utils import count_images


def valid_anima_config() -> dict:
    config = {
        field["key"]: field["default"]
        for field in FIELDS
        if "default" in field
    }
    config.update({
        "model_train_type": "anima-lora",
        "network_module": "networks.lora_anima",
        "pretrained_model_name_or_path": "model.safetensors",
        "vae": "vae.safetensors",
        "qwen3": "qwen3.safetensors",
        "train_data_dir": "train",
        "resolution": "1024,768",
        "output_name": "test",
        "output_dir": "output",
    })
    return config


class TrainingValidationTests(unittest.TestCase):
    def test_valid_anima_config(self):
        self.assertEqual(validate_training_config(valid_anima_config()), [])

    def test_rejects_unsafe_anima_values(self):
        cases = {
            "blocks_to_swap": 9,
            "rank_dropout": 1,
            "caption_dropout_rate": 1.01,
            "caption_tag_dropout_rate": -0.01,
            "vae_chunk_size": 3,
            "qwen3_max_token_length": 0,
        }
        for key, value in cases.items():
            with self.subTest(key=key):
                config = valid_anima_config()
                config[key] = value
                errors = validate_training_config(config)
                self.assertTrue(any(key in error for error in errors), errors)

    def test_validates_resolution_by_train_type(self):
        config = valid_anima_config()
        config["resolution"] = "1000,1024"
        self.assertTrue(any("resolution" in error for error in validate_training_config(config)))

        config["resolution"] = "1008,1024"
        self.assertEqual(validate_training_config(config), [])

        config["model_train_type"] = "sdxl-lora"
        self.assertTrue(any("resolution" in error for error in validate_training_config(config)))

        config["network_module"] = "networks.lora"
        config["resolution"] = "1056,1024"
        self.assertEqual(validate_training_config(config), [])

    def test_validates_bucket_step_by_train_type(self):
        config = valid_anima_config()
        for step in (16, 32, 64):
            with self.subTest(train_type="anima-lora", step=step):
                candidate = dict(config, bucket_reso_steps=step)
                self.assertEqual(validate_training_config(candidate), [])

        config.update(model_train_type="sdxl-lora", network_module="networks.lora", resolution="1024,1024")
        for step in (16, 48):
            with self.subTest(train_type="sdxl-lora", step=step):
                errors = validate_training_config(dict(config, bucket_reso_steps=step))
                self.assertTrue(any("bucket_reso_steps" in error for error in errors), errors)
        for step in (32, 64):
            with self.subTest(train_type="sdxl-lora", step=step):
                self.assertEqual(validate_training_config(dict(config, bucket_reso_steps=step)), [])

    def test_text_cache_caption_contracts_are_profile_specific(self):
        anima = valid_anima_config()
        anima["caption_dropout_rate"] = 0.1
        self.assertEqual(validate_training_config(anima), [])

        for key, value in (("shuffle_caption", True), ("caption_tag_dropout_rate", 0.1)):
            with self.subTest(train_type="anima-lora", key=key):
                errors = validate_training_config(dict(valid_anima_config(), **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)

        sdxl = dict(
            valid_anima_config(),
            model_train_type="sdxl-lora",
            network_module="networks.lora",
            resolution="1024,1024",
        )
        for key, value in (
            ("caption_dropout_rate", 0.1),
            ("shuffle_caption", True),
            ("caption_tag_dropout_rate", 0.1),
        ):
            with self.subTest(train_type="sdxl-lora", key=key):
                errors = validate_training_config(dict(sdxl, **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)

    def test_adapter_does_not_silently_clear_caption_conflicts(self):
        config = valid_anima_config()
        config.update(shuffle_caption=True, caption_tag_dropout_rate=0.1)

        adapted, warnings = adapt_config(config)

        self.assertTrue(adapted["shuffle_caption"])
        self.assertEqual(adapted["caption_tag_dropout_rate"], 0.1)
        self.assertFalse(any("cleared by backend" in warning for warning in warnings))

    def test_keep_tokens_is_emitted_only_when_caption_tag_randomization_is_active(self):
        cases = (
            (False, 0, False),
            (True, 0, True),
            (False, 0.1, True),
            (True, 0.1, True),
        )
        for shuffle, dropout, expected_keep_tokens in cases:
            with self.subTest(shuffle=shuffle, dropout=dropout):
                adapted, _ = adapt_config(
                    {
                        "model_train_type": "anima-lora",
                        "shuffle_caption": shuffle,
                        "caption_tag_dropout_rate": dropout,
                        "keep_tokens": 3,
                    }
                )
                self.assertEqual("keep_tokens" in adapted, expected_keep_tokens)
                self.assertEqual("caption_tag_dropout_rate" in adapted, dropout > 0)
                if expected_keep_tokens:
                    self.assertEqual(adapted["keep_tokens"], 3)

    def test_dylora_block_size_must_be_a_positive_integer_divisor(self):
        base = valid_anima_config()
        base.update(network_module="lycoris.kohya", lycoris_algo="dylora", network_dim=30)
        for block_size in (0, -1, 1.5, 4):
            with self.subTest(block_size=block_size):
                errors = validate_training_config(dict(base, block_size=block_size))
                self.assertTrue(any("block_size" in error for error in errors), errors)

        self.assertEqual(validate_training_config(dict(base, block_size=5)), [])


class TrainingFieldSchemaTests(unittest.TestCase):
    @staticmethod
    def _lookup(messages: dict, key: str):
        value = messages
        for part in key.split("."):
            if not isinstance(value, dict) or part not in value:
                return None
            value = value[part]
        return value

    @staticmethod
    def _walk(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from TrainingFieldSchemaTests._walk(child)
        elif isinstance(value, list):
            for child in value:
                yield from TrainingFieldSchemaTests._walk(child)

    def test_all_field_i18n_references_exist_in_both_locales(self):
        reference_keys = {
            item[key]
            for item in self._walk(get_all_fields())
            if isinstance(item, dict)
            for key in ("desc_key", "hint_key", "readonly_reason_key", "reason_key", "dk", "label_key")
            if isinstance(item.get(key), str) and item[key]
        }
        reference_keys.update(
            hint_key
            for field in get_all_fields()
            for hint_key in (field.get("hint_key_by") or {}).get("values", {}).values()
        )
        for locale in ("zh-CN", "en-US"):
            messages = json.loads(Path(f"frontend/i18n/{locale}.json").read_text(encoding="utf-8"))
            for key in reference_keys:
                with self.subTest(locale=locale, key=key):
                    value = self._lookup(messages, key)
                    self.assertIsInstance(value, str)
                    self.assertTrue(value.strip())

    def test_visible_field_titles_do_not_contain_explanations(self):
        messages = json.loads(Path("frontend/i18n/zh-CN.json").read_text(encoding="utf-8"))
        explanation_markers = (
            "；",
            "。",
            "不可用",
            "不支持",
            "仅在",
            "仅 ",
            "需配合",
            "留空",
            "默认",
            "互斥",
            "开启后",
            "关闭后",
            "0=",
            "-1=",
            "（仅",
            "（可选",
            "（默认",
            "（不",
            "（需",
            "（多行",
            "（训练前",
            "（低显存",
        )

        for field in get_all_fields():
            if field.get("hidden"):
                continue
            title_keys = [field["desc_key"]]
            for suffix in ("_sdxl", "_anima"):
                key = f'{field["desc_key"]}{suffix}'
                if self._lookup(messages, key) is not None:
                    title_keys.append(key)
            for key in title_keys:
                title = self._lookup(messages, key)
                with self.subTest(field=field["key"], title_key=key, title=title):
                    self.assertFalse(
                        any(marker in title for marker in explanation_markers),
                        f"Move behavior, applicability, defaults, and side effects from {key} to a hint: {title}",
                    )

        caption_tag_dropout = next(
            field for field in get_all_fields() if field["key"] == "caption_tag_dropout_rate"
        )
        self.assertEqual(caption_tag_dropout.get("hint_key"), "field.caption_tag_dropout_rateHint")

        keep_tokens = next(field for field in get_all_fields() if field["key"] == "keep_tokens")
        self.assertEqual(
            keep_tokens["show_if_any"],
            [
                [{"key": "shuffle_caption", "eq": True}],
                [{"key": "caption_tag_dropout_rate", "neq": 0}],
            ],
        )
        self.assertTrue(keep_tokens["omit_default"])
        self.assertEqual(caption_tag_dropout["default"], 0)
        self.assertTrue(caption_tag_dropout["omit_default"])

    def test_field_conditions_reference_registered_keys(self):
        fields = get_all_fields()
        registered = {field["key"] for field in fields}
        for field in fields:
            for attr in ("show_if", "show_if_any", "readonly_if", "readonly_if_any"):
                for item in self._walk(field.get(attr)):
                    key = item.get("key") if isinstance(item, dict) else None
                    if key:
                        with self.subTest(field=field["key"], attr=attr, key=key):
                            self.assertIn(key, registered)

    def test_select_defaults_are_declared_options(self):
        for field in get_all_fields():
            if field.get("type") != "select" or "default" not in field:
                continue
            options = list(field.get("options") or [])
            for group in field.get("groups") or []:
                options.extend(group.get("options") or [])
            values = {option.get("v") for option in options if "v" in option}
            if values:
                with self.subTest(field=field["key"], default=field["default"]):
                    self.assertIn(field["default"], values)

    def test_normalizes_numeric_strings(self):
        config = valid_anima_config()
        config["blocks_to_swap"] = "8"
        self.assertEqual(validate_training_config(config), [])
        self.assertEqual(config["blocks_to_swap"], 8)

        config["model_train_type"] = "sdxl-lora"
        config["network_module"] = "networks.lora"
        config["max_token_length"] = "225"
        config["resolution"] = "1024,1024"
        self.assertEqual(validate_training_config(config), [])
        self.assertEqual(config["max_token_length"], 225)

    def test_rejects_network_module_from_other_train_type(self):
        config = valid_anima_config()
        config["network_module"] = "networks.lora"
        errors = validate_training_config(config)
        self.assertTrue(any("network_module" in error for error in errors))

    def test_base_weight_multiplier_count_must_match(self):
        config = valid_anima_config()
        config["base_weights"] = "a.safetensors,b.safetensors"
        config["base_weights_multiplier"] = "1"
        errors = validate_training_config(config)
        self.assertTrue(any("base_weights_multiplier" in error for error in errors))


class TaskManagerTests(unittest.TestCase):
    def test_created_task_reserves_concurrency_slot(self):
        manager = TaskManager(max_concurrent=1)
        self.assertIsNotNone(manager.create_task(["noop"]))
        self.assertIsNone(manager.create_task(["noop"]))


class ScanOptimizationTests(unittest.TestCase):
    def test_count_images_stops_at_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for index in range(205):
                (root / f"{index}.png").touch()
            self.assertEqual(count_images(root, stop_after=201), 201)
            self.assertEqual(count_images(root), 205)

    def test_preview_scan_uses_known_output_locations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir) / "output"
            run_dir = output_root / "run"
            sample_dir = run_dir / "sample"
            unrelated_dir = run_dir / "other"
            sample_dir.mkdir(parents=True)
            unrelated_dir.mkdir()
            (sample_dir / "sample.png").touch()
            (run_dir / "root.png").touch()
            (unrelated_dir / "unrelated.png").touch()

            with patch.object(artifacts, "OUTPUT_DIR", output_root), patch.object(
                artifacts, "REPO_ROOT", Path(temp_dir)
            ):
                previews = artifacts.newest_previews(str(run_dir), force_refresh=True)

            self.assertEqual({item["name"] for item in previews}, {"sample.png", "root.png"})


class TrainingStepEstimatorTests(unittest.TestCase):
    @staticmethod
    def _write_images(directory: Path, count: int, size: tuple[int, int]) -> None:
        directory.mkdir(parents=True)
        for index in range(count):
            Image.new("RGB", size, "white").save(directory / f"{index}.png")

    @staticmethod
    def _config(train_dir: Path, **overrides) -> dict:
        config = {
            "train_data_dir": str(train_dir),
            "resolution": "512,512",
            "enable_bucket": False,
            "bucket_no_upscale": True,
            "min_bucket_reso": 256,
            "max_bucket_reso": 1024,
            "bucket_reso_steps": 64,
            "train_batch_size": 3,
            "gradient_accumulation_steps": 2,
            "max_train_epochs": 4,
        }
        config.update(overrides)
        return config

    def test_fixed_resolution_counts_images_repeats_batch_and_accumulation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "5_character", 2, (512, 768))
            self._write_images(root / "2_outfit", 3, (768, 512))
            self._write_images(root / "invalid_folder", 4, (512, 512))
            Image.new("RGB", (512, 512), "white").save(root / "root.png")

            estimate = estimate_training_steps(self._config(root))

            self.assertEqual(estimate["original_images"], 5)
            self.assertEqual(estimate["repeated_samples"], 16)
            self.assertEqual(estimate["batches_per_epoch"], 6)
            self.assertEqual(estimate["steps_per_epoch"], 3)
            self.assertEqual(estimate["total_steps"], 12)
            self.assertEqual(
                [(subset["name"], subset["image_count"], subset["repeats"]) for subset in estimate["subsets"]],
                [("2_outfit", 3, 2), ("5_character", 2, 5)],
            )

    def test_bucket_batches_round_up_each_bucket_like_sd_scripts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portrait = root / "2_portrait"
            landscape = root / "3_landscape"
            self._write_images(portrait, 3, (512, 768))
            self._write_images(landscape, 2, (768, 512))
            config = self._config(
                root,
                enable_bucket=True,
                train_batch_size=4,
                gradient_accumulation_steps=2,
                max_train_epochs=5,
            )

            estimate = estimate_training_steps(config)

            self.assertEqual(estimate["repeated_samples"], 12)
            self.assertEqual(estimate["bucket_count"], 2)
            self.assertEqual([bucket["sample_count"] for bucket in estimate["buckets"]], [6, 6])
            self.assertEqual([bucket["batch_count"] for bucket in estimate["buckets"]], [2, 2])
            self.assertEqual(estimate["batches_per_epoch"], 4)
            self.assertEqual(estimate["steps_per_epoch"], 2)
            self.assertEqual(estimate["total_steps"], 10)

            from library.config_util import DreamBoothSubsetParams
            from library.dreambooth_dataset import DreamBoothDataset
            from library.subset import DreamBoothSubset

            subsets = [
                DreamBoothSubset(
                    **asdict(
                        DreamBoothSubsetParams(
                            image_dir=str(portrait), num_repeats=2, class_tokens="portrait"
                        )
                    )
                ),
                DreamBoothSubset(
                    **asdict(
                        DreamBoothSubsetParams(
                            image_dir=str(landscape), num_repeats=3, class_tokens="landscape"
                        )
                    )
                ),
            ]
            dataset = DreamBoothDataset(
                subsets=subsets,
                is_training_dataset=True,
                batch_size=4,
                resolution=(512, 512),
                network_multiplier=1.0,
                enable_bucket=True,
                min_bucket_reso=256,
                max_bucket_reso=1024,
                bucket_reso_steps=64,
                bucket_no_upscale=True,
                prior_loss_weight=1.0,
                train_inpainting=False,
                debug_dataset=False,
                validation_split=0.0,
                validation_seed=0,
                resize_interpolation=None,
            )
            dataset.make_buckets()

            self.assertEqual(estimate["batches_per_epoch"], len(dataset))

    def test_gpu_processes_follow_sd_scripts_ceiling_order(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "1_character", 17, (512, 512))

            estimate = estimate_training_steps(
                self._config(
                    root,
                    train_batch_size=2,
                    gradient_accumulation_steps=2,
                    max_train_epochs=3,
                    gpu_ids=[0, 1],
                )
            )

            self.assertEqual(estimate["batches_per_epoch"], 9)
            self.assertEqual(estimate["gpu_processes"], 2)
            self.assertEqual(estimate["steps_per_epoch"], 3)
            self.assertEqual(estimate["total_steps"], 9)

    def test_rejects_dataset_without_repeat_folders(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self._write_images(root / "character", 1, (512, 512))

            with self.assertRaises(StepEstimateError):
                estimate_training_steps(self._config(root))

    def test_missing_dataset_exposes_localizable_error_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing_dataset"

            with self.assertRaises(StepEstimateError) as context:
                estimate_training_steps(self._config(missing))

            self.assertEqual(context.exception.code, "datasetNotFound")
            self.assertEqual(context.exception.params, {"path": str(missing)})


class MonitorFrontendContractTests(unittest.TestCase):
    def test_training_field_schema_script_is_cache_busted(self):
        index_html = Path("frontend/index.html").read_text(encoding="utf-8")
        self.assertRegex(index_html, r'/anima-ui/js/config\.js\?v=[^"\s]+')

    def test_leaving_history_clears_cached_logs(self):
        monitor_core = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")
        reset_body = monitor_core.split("resetRunDetailState() {", 1)[1].split("\n  },", 1)[0]

        self.assertIn("this.logLines = [];", reset_body)
        self.assertIn("this.logFullLines = [];", reset_body)
        self.assertIn("this._logSliceRequestSeq++;", reset_body)

    def test_route_exit_uses_history_state_reset(self):
        app_js = Path("frontend/js/app.js").read_text(encoding="utf-8")
        self.assertIn("this.resetRunDetailState();", app_js)

    def test_step_estimate_refreshes_with_form_and_before_training(self):
        training_core = Path("frontend/js/training-core.js").read_text(encoding="utf-8")
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")

        watcher = training_core.split("self._formWatcher = self.$watch('form'", 1)[1].split("});", 1)[0]
        scheduled_refresh = training_core.split("scheduleStepEstimate() {", 1)[1].split("\n  },", 1)[0]
        forced_refresh = training_core.split("async refreshStepEstimate(force) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("self.scheduleStepEstimate();", watcher)
        self.assertIn("fetch('/api/training/estimate'", training_core)
        self.assertIn("stepEstimate.errors.${code}", training_core)
        self.assertIn('x-text="stepEstimateErrorText()"', training_core)
        self.assertIn("const estimate = await this.refreshStepEstimate(true);", training_toml)
        self.assertEqual(scheduled_refresh.count("this.stepEstimate = null;"), 1)
        self.assertEqual(forced_refresh.count("this.stepEstimate = null;"), 1)
        self.assertIn("effectiveBatch:", training_core)


@unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
class TrainingFormFrontendTests(unittest.TestCase):
    def test_profile_constraints_and_caption_cache_interlocks(self):
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const mixin = window.trainingCoreMixin;
const bucketField = {
  key: 'bucket_reso_steps', type: 'number', min: 16, step: 16,
  constraintsByGroup: { sdxl: { min: 32, step: 32 }, anima: { min: 16, step: 16 } },
};
function context(modelType, form) {
  const toasts = [];
  const ctx = Object.assign({}, mixin, {
    form: Object.assign({ model_train_type: modelType }, form),
    formDefaults: {}, formErrors: {},
    findFieldDef(key) { return key === 'bucket_reso_steps' ? bucketField : null; },
    _allShowIfKeys() { return []; },
    queueTomlPreviewChange() {}, pushHistory() {}, updateTomlDebounced() {},
    scheduleOutputPathInfo() {}, toast(message) { toasts.push(message); },
    t(key) { return key; },
  });
  ctx.toasts = toasts;
  return ctx;
}
const sdxl = context('sdxl-lora', { bucket_reso_steps: 64 });
const anima = context('anima-lora', { bucket_reso_steps: 32 });
sdxl.stepField('bucket_reso_steps', -32);
anima.stepField('bucket_reso_steps', -16);

const sdxlCaption = context('sdxl-lora', {
  cache_text_encoder_outputs: true, cache_text_encoder_outputs_to_disk: true,
  caption_dropout_rate: 0, caption_tag_dropout_rate: 0, shuffle_caption: false,
});
sdxlCaption.setField('caption_dropout_rate', 0.1);
const animaCaption = context('anima-lora', {
  cache_text_encoder_outputs: true, cache_text_encoder_outputs_to_disk: true,
  caption_dropout_rate: 0, caption_tag_dropout_rate: 0, shuffle_caption: false,
});
animaCaption.setField('caption_dropout_rate', 0.1);
const blocked = context('sdxl-lora', {
  cache_text_encoder_outputs: false, cache_text_encoder_outputs_to_disk: false,
  caption_dropout_rate: 0.1, caption_tag_dropout_rate: 0, shuffle_caption: false,
});
blocked.setField('cache_text_encoder_outputs', true);
const latentDisk = context('anima-lora', {
  cache_latents: false, cache_latents_to_disk: false,
});
latentDisk.setField('cache_latents_to_disk', true);
const latentAfterEnable = {
  memory: latentDisk.form.cache_latents,
  disk: latentDisk.form.cache_latents_to_disk,
};
latentDisk.setField('cache_latents_to_disk', false);
const latentAfterDisable = {
  memory: latentDisk.form.cache_latents,
  disk: latentDisk.form.cache_latents_to_disk,
};

console.log(JSON.stringify({
  sdxlRule: sdxl._numberConstraints(bucketField),
  animaRule: anima._numberConstraints(bucketField),
  sdxlStep: sdxl.form.bucket_reso_steps,
  animaStep: anima.form.bucket_reso_steps,
  sdxlCache: sdxlCaption.form.cache_text_encoder_outputs,
  sdxlDiskCache: sdxlCaption.form.cache_text_encoder_outputs_to_disk,
  animaCache: animaCaption.form.cache_text_encoder_outputs,
  blockedCache: blocked.form.cache_text_encoder_outputs,
  blockedToasts: blocked.toasts.length,
  latentAfterEnable,
  latentAfterDisable,
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
        payload = json.loads(result.stdout)
        self.assertEqual(payload["sdxlRule"]["min"], 32)
        self.assertEqual(payload["sdxlRule"]["step"], 32)
        self.assertEqual(payload["animaRule"]["min"], 16)
        self.assertEqual(payload["sdxlStep"], 32)
        self.assertEqual(payload["animaStep"], 16)
        self.assertFalse(payload["sdxlCache"])
        self.assertFalse(payload["sdxlDiskCache"])
        self.assertTrue(payload["animaCache"])
        self.assertFalse(payload["blockedCache"])
        self.assertEqual(payload["blockedToasts"], 1)
        self.assertEqual(payload["latentAfterEnable"], {"memory": True, "disk": True})
        self.assertEqual(payload["latentAfterDisable"], {"memory": True, "disk": False})

if __name__ == "__main__":
    unittest.main()
