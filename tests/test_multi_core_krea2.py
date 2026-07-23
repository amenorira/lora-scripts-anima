import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.core_registry import (
    MAIN_VENV_SITE_PACKAGES,
    MUSUBI_VENV_SITE_PACKAGES,
    TrainingProfileError,
    profile_payload,
    resolve_training_profile,
)
from backend.training.field_registry import get_fields_json
from backend.training.step_estimator import estimate_training_steps
from backend.training.musubi_krea2 import (
    KREA2_FIELDS,
    _MUSUBI_RUNTIME_PACKAGES,
    build_krea2_dataset_config,
    build_krea2_train_config,
    get_krea2_cache_status,
    krea2_preflight,
    mark_cache_manifest,
    prepare_cache_manifest,
    validate_krea2_config,
)
from backend.training.supervisor import _build_train_env
from backend.training.validation import validate_training_config


def krea2_config(root: Path) -> dict:
    config = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
    models = root / "models"
    models.mkdir()
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
            "dataset_cache_dir": str(root / "cache"),
            "output_dir": str(root / "output"),
            "output_name": "krea2_test",
        }
    )
    return config


class CoreRegistryTests(unittest.TestCase):
    def test_lycoris_is_first_class_but_mounted_on_sd_scripts(self):
        config = {"model_train_type": "anima-lora", "adapter_id": "lycoris"}

        profile = resolve_training_profile(config)

        self.assertEqual(profile.engine_id, "sd_scripts")
        self.assertEqual(config["adapter_id"], "lycoris")
        self.assertEqual(config["network_module"], "lycoris.kohya")

    def test_rejects_adapter_or_engine_cross_wiring(self):
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile({"model_train_type": "krea2-lora", "engine_id": "sd_scripts"})
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile(
                {"model_train_type": "sdxl-lora", "adapter_id": "lycoris", "network_module": "networks.lora"}
            )

    def test_capabilities_expose_engines_profiles_and_adapters(self):
        payload = profile_payload()

        self.assertTrue(any(item["id"] == "musubi_tuner" for item in payload["engines"]))
        self.assertTrue(any(item["id"] == "krea2-lora" for item in payload["profiles"]))
        lycoris = next(item for item in payload["adapters"] if item["id"] == "lycoris")
        self.assertTrue(lycoris["mounted"])
        self.assertEqual(lycoris["host_engine_id"], "sd_scripts")


class Krea2CodecTests(unittest.TestCase):
    def test_registry_keeps_krea_fields_out_of_sd_adapter_schema(self):
        fields = get_fields_json()
        all_fields = [field for section in fields["sections"] for field in section["fields"]]
        dit = next(field for field in all_fields if field["key"] == "dit")

        self.assertEqual(dit["profiles"], ["krea2-lora"])

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
        self.assertTrue(train["sdpa"])

    def test_train_toml_uses_only_krea_parser_flags(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config["network_args_custom"] = "exclude_patterns=['.*']"
            config["krea_optimizer_args"] = "weight_decay=0.01"
            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")

        parser_source = "\n".join(
            (
                Path("vendor/musubi-tuner/src/musubi_tuner/training/parser_common.py").read_text(encoding="utf-8"),
                Path("vendor/musubi-tuner/src/musubi_tuner/krea2_train_network.py").read_text(encoding="utf-8"),
            )
        )
        parser_flags = set(re.findall(r"--([a-zA-Z0-9_]+)", parser_source))
        self.assertTrue(set(train).issubset(parser_flags), set(train) - parser_flags)

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

    def test_preflight_uses_the_isolated_musubi_runtime(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            versions = {
                name: ("11.3.0" if expected == ">=11.3.0" else "0.0.0" if expected is None else expected)
                for name, expected in _MUSUBI_RUNTIME_PACKAGES.items()
            }
            with patch("backend.training.musubi_krea2._musubi_runtime_versions", return_value=(versions, None)):
                preflight = krea2_preflight(config, require_cache=False)

        self.assertTrue(preflight["ok"], preflight["errors"])

    def test_generic_validation_and_step_api_dispatch_to_krea_codec(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            self.assertEqual(validate_training_config(dict(config)), [])
            estimate = estimate_training_steps(dict(config))

        self.assertEqual(estimate["engine_id"], "musubi_tuner")
        self.assertEqual(estimate["original_images"], 1)


class MultiCoreSupervisorTests(unittest.TestCase):
    def test_musubi_environment_excludes_sd_scripts_hook(self):
        with patch.dict(
            os.environ,
            {"PYTHONPATH": "", "LORA_SCRIPTS_TRUE_LR_LOGGING": "1"},
            clear=False,
        ):
            env = _build_train_env("artifact", "task", engine_id="musubi_tuner")

        self.assertNotIn("LORA_SCRIPTS_TRUE_LR_LOGGING", env)
        self.assertIn("vendor" + os.sep + "musubi-tuner" + os.sep + "src", env["PYTHONPATH"])
        paths = env["PYTHONPATH"].split(os.pathsep)
        self.assertLess(paths.index(str(MUSUBI_VENV_SITE_PACKAGES)), paths.index(str(MAIN_VENV_SITE_PACKAGES)))

    def test_musubi_overlay_is_configured_by_both_launchers(self):
        windows = Path("tools/bootstrap_windows.ps1").read_text(encoding="utf-8")
        linux = Path("start.sh").read_text(encoding="utf-8")
        overlay_helper = Path("tools/configure_musubi_overlay.py").read_text(encoding="utf-8")

        self.assertIn("configure_musubi_overlay.py", windows)
        self.assertIn("configure_musubi_overlay.py", linux)
        self.assertIn("requirements-musubi-krea2.txt", windows)
        self.assertIn("requirements-musubi-krea2.txt", linux)
        self.assertIn("anima_host_venv.pth", overlay_helper)


class MultiCoreFrontendContractTests(unittest.TestCase):
    def test_krea_ui_has_cache_and_core_registry_paths(self):
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        environment = Path("frontend/js/environment-core.js").read_text(encoding="utf-8")
        form = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("/api/training/krea2/cache", training_toml)
        self.assertIn("krea2-lora", training_toml)
        self.assertIn("/api/training/cores", environment)
        self.assertIn("prepareKrea2Cache()", form)


if __name__ == "__main__":
    unittest.main()
