import itertools
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.training.adapter import adapt_config
from backend.training.field_registry import get_fields_json
from backend.training.metrics_config import training_metrics_environment
from backend.training.musubi_krea2 import KREA2_FIELDS, build_krea2_train_config
from backend.training.training_config import build_training_config, extract_training_form


KEYS = ("log_grad_norm", "log_grad_clipped", "log_timestep_loss", "log_timestep_count")


class MetricsConfigTests(unittest.TestCase):
    def test_all_defaults_are_off_and_children_are_nested_before_save_state(self):
        section = next(s for s in get_fields_json()["sections"] if s["key"] == "save")
        for profile in ("anima-lora", "sdxl-lora", "krea2-lora"):
            fields = [f for f in section["fields"] if
                      (profile in f["profiles"] if "profiles" in f else profile != "krea2-lora")]
            indexed = {f["key"]: f for f in fields}
            keys = [f["key"] for f in fields]
            for key in KEYS:
                self.assertIs(indexed[key]["default"], False)
                self.assertEqual(indexed[key]["target"], "ui")
                self.assertLess(keys.index(key), keys.index("save_state"))
            self.assertEqual(indexed["log_grad_clipped"]["showIf"], {"key": "log_grad_norm", "eq": True})
            self.assertEqual(indexed["log_timestep_count"]["showIf"], {"key": "log_timestep_loss", "eq": True})

    def test_flags_are_explicit_and_parent_gated_for_every_combination(self):
        self.assertEqual(set(training_metrics_environment({}).values()), {"0"})
        for values in itertools.product((False, True), repeat=4):
            grad, clip, loss, count = values
            env = training_metrics_environment(dict(zip(KEYS, values)))
            self.assertEqual(env["ANIMA_TRAIN_METRICS"], str(int(grad or loss)))
            self.assertEqual(env["ANIMA_TRAIN_METRICS_GRAD_NORM"], str(int(grad)))
            self.assertEqual(env["ANIMA_TRAIN_METRICS_GRAD_CLIPPED"], str(int(grad and clip)))
            self.assertEqual(env["ANIMA_TRAIN_METRICS_TIMESTEP_LOSS"], str(int(loss)))
            self.assertEqual(env["ANIMA_TRAIN_METRICS_TIMESTEP_COUNT"], str(int(loss and count)))
        self.assertEqual(set(training_metrics_environment(dict.fromkeys(KEYS, "false")).values()), {"0"})

    def test_yaml_round_trip_preserves_enabled_and_disabled_children(self):
        for profile in ("anima-lora", "sdxl-lora", "krea2-lora"):
            for child in (True, False):
                form = dict(zip(KEYS, (True, child, True, child)), model_train_type=profile)
                document = build_training_config(form, profile_id=profile)
                restored = extract_training_form(document)
                for key in KEYS:
                    self.assertIs(restored[key], form[key])
                save = document["parameters"]["save"]
                self.assertEqual(save["log_grad_norm"]["options"]["log_grad_clipped"], child)
                self.assertEqual(save["log_timestep_loss"]["options"]["log_timestep_count"], child)

    def test_switches_never_leak_into_native_engine_configs(self):
        form = dict.fromkeys(KEYS, True)
        for profile in ("anima-lora", "sdxl-lora"):
            adapted, warnings = adapt_config({**form, "model_train_type": profile})
            self.assertFalse(set(KEYS) & adapted.keys())
            self.assertFalse(any(key in warning for warning in warnings for key in KEYS))
        defaults = {f["key"]: f["default"] for f in KREA2_FIELDS if "default" in f}
        config = build_krea2_train_config({**defaults, **form}, "dataset.toml", "output", "log")
        self.assertFalse(set(KEYS) & config.keys())


class MetricsLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_form_switches_reach_each_profile_launcher_without_toml_leaks(self):
        import tomllib
        from backend.server.routes import training as routes
        from backend.tasks import TaskManager
        from tests.helpers import valid_training_config
        from tests.training.test_multi_core_krea2 import krea2_config

        for profile in ("anima-lora", "sdxl-lora", "krea2-lora"):
            for parents in (False, True):
                with self.subTest(profile=profile, parents=parents), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    if profile == "krea2-lora":
                        form = krea2_config(root)
                    else:
                        form = valid_training_config(profile, output_dir=str(root / "artifacts"))
                        for key in ("pretrained_model_name_or_path", "vae", "qwen3"):
                            model_path = root / f"{key}.safetensors"
                            model_path.write_bytes(b"test fixture")
                            form[key] = str(model_path)
                    form.update(zip(KEYS, (parents, True, parents, True)))
                    with ExitStack() as stack:
                        for name, value in (("tm", TaskManager()), ("OUTPUT_DIR", root / "runs"),
                                            ("AUTOSAVE_DIR", root / "autosave")):
                            stack.enter_context(patch.object(routes, name, value))
                        stack.enter_context(patch.object(routes.os, "getcwd", return_value=str(root)))
                        stack.enter_context(patch("backend.training.validate_training_config", return_value=[]))
                        stack.enter_context(patch.object(routes, "check_te_cache", return_value=[]))
                        stack.enter_context(patch.object(routes, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}))
                        stack.enter_context(patch.object(routes.train_utils, "validate_data_dir", return_value=True))
                        stack.enter_context(patch.object(routes.train_utils, "validate_model", return_value=(True, "")))
                        stack.enter_context(patch.object(routes.train_utils, "count_images", return_value=1))
                        stack.enter_context(patch.object(routes, "estimate_training_steps", return_value={"total_steps": 10, "gpu_processes": 1}))
                        stack.enter_context(patch.object(routes, "get_sample_prompts", return_value=""))
                        launch = stack.enter_context(patch.object(routes, "run_train", return_value={"status": "success"}))
                        result = await routes._prepare_training(routes._create_toml_file_reserved, dict(form))
                    self.assertEqual(result["status"], "success", result)
                    self.assertEqual(launch.call_args.kwargs["extra_env"], training_metrics_environment(form))
                    native = tomllib.loads(Path(launch.call_args.args[0]).read_text(encoding="utf-8"))
                    self.assertFalse(set(KEYS) & native.keys())
