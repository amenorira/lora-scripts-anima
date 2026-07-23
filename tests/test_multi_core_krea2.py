import asyncio
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import toml

from backend.training.core_registry import (
    TrainingProfileError,
    engine_pythonpaths,
    get_engine,
    profile_payload,
    resolve_training_profile,
)
from backend.training.field_registry import get_fields_json
from backend.training.step_estimator import estimate_training_steps
from backend.training.musubi_runtime import MUSUBI_RUNTIME_PACKAGES, shared_runtime_status, version_error
from backend.training.musubi_krea2 import (
    KREA2_FIELDS,
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
        runtime = {"ok": True, "errors": [], "versions": {}, "python": "main", "torch_path": "torch", "torch_cuda": "13.0"}
        with patch("backend.training.musubi_runtime.shared_runtime_status", return_value=runtime):
            payload = profile_payload()

        musubi = next(item for item in payload["engines"] if item["id"] == "musubi_tuner")
        self.assertTrue(musubi["available"])
        self.assertIsNone(musubi["python_executable"])
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

    def test_sample_and_turbo_fields_generate_only_real_musubi_flags(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            turbo = root / "models" / "turbo.safetensors"
            turbo.write_bytes(b"test")
            config.update(
                {
                    "enable_krea_samples": True,
                    "krea_sample_prompts": "A fox in snow. --w 1024 --h 1024 --s 8 --l 1 --d 0",
                    "turbo_dit": str(turbo),
                    "turbo_dit_cache": True,
                    "sample_every_n_epochs": 2,
                    "sample_every_n_steps": 50,
                    "sample_at_first": True,
                }
            )
            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(
                config,
                root / "run" / "dataset.toml",
                root / "output",
                root / "run" / "log",
                root / "run" / "sample_prompts.txt",
            )

        self.assertEqual(train["text_encoder"], config["text_encoder"])
        self.assertEqual(train["sample_prompts"], str(root / "run" / "sample_prompts.txt"))
        self.assertEqual(train["turbo_dit"], str(turbo))
        self.assertTrue(train["turbo_dit_cache"])
        self.assertEqual(train["sample_every_n_epochs"], 2)
        self.assertEqual(train["sample_every_n_steps"], 50)
        self.assertTrue(train["sample_at_first"])
        self.assertNotIn("krea_sample_prompts", train)

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
            ):
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

    def test_legacy_anima_named_cache_manifest_remains_readable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            cache = Path(config["dataset_cache_dir"])
            cache.mkdir()
            (cache / "portrait_0001x0001_krea2.safetensors").write_bytes(b"latent")
            (cache / "portrait_krea2_te.safetensors").write_bytes(b"text")
            prepare_cache_manifest(config)
            mark_cache_manifest(config, "completed")
            (cache / ".krea2-cache.json").rename(cache / ".anima-krea2-cache.json")

            status = get_krea2_cache_status(config)

        self.assertTrue(status["ready"])

    def test_preflight_uses_the_shared_main_runtime_contract(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            versions = {
                name: ("11.3.0" if expected == ">=11.3.0" else "0.0.0" if expected is None else expected)
                for name, expected in MUSUBI_RUNTIME_PACKAGES.items()
            }
            runtime = {
                "ok": True,
                "errors": [],
                "versions": versions,
                "python": "main",
                "torch_path": "main/torch",
                "torch_cuda": "13.0",
            }
            with patch("backend.training.musubi_krea2.shared_runtime_status", return_value=runtime):
                preflight = krea2_preflight(config, require_cache=False)

        self.assertTrue(preflight["ok"], preflight["errors"])
        self.assertEqual(preflight["runtime"]["python"], "main")

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
        self.assertEqual(paths[0], str(engine_pythonpaths("musubi_tuner")[0]))
        self.assertIsNone(get_engine("musubi_tuner").python_executable)
        self.assertNotIn("venv" + os.sep + "cores" + os.sep + "musubi", env["PYTHONPATH"])

    def test_musubi_shared_runtime_is_converged_by_both_launchers(self):
        windows = Path("tools/bootstrap_windows.ps1").read_text(encoding="utf-8")
        linux = Path("start.sh").read_text(encoding="utf-8")
        requirements = Path("requirements-musubi-krea2.txt").read_text(encoding="utf-8")

        self.assertIn("tools.ensure_musubi_runtime", windows)
        self.assertIn("tools.ensure_musubi_runtime", linux)
        self.assertIn("requirements-musubi-krea2.txt", windows)
        self.assertIn("requirements-musubi-krea2.txt", linux)
        self.assertIn("--upgrade-strategy", windows)
        self.assertIn("--upgrade-strategy", linux)
        self.assertEqual(windows.count("--verify-imports"), 1)
        self.assertEqual(linux.count("--verify-imports"), 1)
        self.assertNotIn("configure_musubi_overlay.py", windows)
        self.assertNotIn("configure_musubi_overlay.py", linux)
        self.assertNotIn("venv\\cores\\musubi", windows)
        self.assertNotIn("venv/cores/musubi", linux)
        self.assertIn("transformers==4.57.6", requirements)
        self.assertIn("tokenizers==0.22.2", requirements)


class MusubiRuntimeContractTests(unittest.TestCase):
    def test_shared_requirements_match_the_runtime_contract(self):
        from packaging.requirements import Requirement

        requirement_lines = Path("requirements-musubi-krea2.txt").read_text(encoding="utf-8").splitlines()
        requirements = {
            requirement.name.lower(): str(requirement.specifier)
            for raw_line in requirement_lines
            for line in (raw_line.split("#", 1)[0].strip(),)
            if line
            for requirement in (Requirement(line),)
        }
        expected = {
            name: "" if version is None else version if version.startswith(">=") else f"=={version}"
            for name, version in MUSUBI_RUNTIME_PACKAGES.items()
            if name not in {"torch", "torchvision"}
        }

        self.assertEqual(requirements, expected)

    def test_cuda_local_version_satisfies_musubi_minimum(self):
        self.assertIsNone(version_error("torch", ">=2.9.1", "2.10.0+cu130"))
        self.assertIsNone(version_error("torchvision", ">=0.24.1", "0.25.0+cu130"))
        self.assertIsNotNone(version_error("transformers", "4.57.6", "4.54.1"))

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
    def test_krea_ui_has_cache_and_core_registry_paths(self):
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        environment = Path("frontend/js/environment-core.js").read_text(encoding="utf-8")
        form = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("/api/training/krea2/cache", training_toml)
        self.assertIn("krea2-lora", training_toml)
        self.assertIn("/api/training/cores", environment)
        self.assertIn("runtime_errors", Path("frontend/js/environment-render.js").read_text(encoding="utf-8"))
        self.assertIn("prepareKrea2Cache()", form)

    def test_krea_preset_preview_has_no_fake_runtime_paths(self):
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        training_presets = Path("frontend/js/training-presets.js").read_text(encoding="utf-8")

        self.assertNotIn('<generated dataset.toml>', training_toml)
        self.assertNotIn('<managed run output directory>', training_toml)
        self.assertIn('model_train_type = "krea2-lora"', training_toml)
        self.assertIn("# Krea 2 preset (musubi-tuner)", training_toml)
        self.assertNotIn("Anima Krea 2", training_toml)
        self.assertIn("-krea2-preset.toml", training_presets)


if __name__ == "__main__":
    unittest.main()
