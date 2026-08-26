import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from importlib.metadata import PackageNotFoundError
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
    image_files,
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
        self.assertEqual(musubi["version"]["describe"], "v0.3.4-7-g8934cfb")
        self.assertTrue(any(item["id"] == "krea2-lora" for item in payload["profiles"]))
        lycoris = next(item for item in payload["adapters"] if item["id"] == "lycoris")
        self.assertTrue(lycoris["mounted"])
        self.assertEqual(lycoris["host_engine_id"], "sd_scripts")
        self.assertEqual(lycoris["version"]["describe"], "v3.4.0-0-ga72bb1b")


class Krea2CodecTests(unittest.TestCase):
    def test_registry_has_no_advanced_field_classification(self):
        self.assertTrue(all("advanced" not in field for field in KREA2_FIELDS))

    def test_registry_keeps_krea_fields_out_of_sd_adapter_schema(self):
        fields = get_fields_json()
        all_fields = [field for section in fields["sections"] for field in section["fields"]]
        dit = next(field for field in all_fields if field["key"] == "dit")

        self.assertEqual(dit["profiles"], ["krea2-lora"])

    def test_registry_provides_downloaded_krea_model_paths(self):
        defaults = {field["key"]: field.get("default") for field in KREA2_FIELDS}

        self.assertEqual(defaults["dit"], "./models/krea2_raw_fp8_scaled.safetensors")
        self.assertEqual(defaults["vae"], "./models/qwen_image_vae.safetensors")
        self.assertEqual(defaults["text_encoder"], "./models/qwen3vl_4b_fp8_scaled.safetensors")

    def test_registry_exposes_one_scaled_fp8_control_and_describes_krea_options(self):
        fields = {field["key"]: field for field in KREA2_FIELDS}

        self.assertIn("fp8_base", fields)
        self.assertNotIn("fp8_scaled", fields)
        self.assertEqual(fields["fp8_base"]["desc_key"], "field.krea_fp8_base")

        expected_options = {
            "timestep_sampling": 6,
            "lr_scheduler": 10,
            "krea_attention_backend": 4,
        }
        for key, count in expected_options.items():
            with self.subTest(field=key):
                options = fields[key]["options"]
                self.assertEqual(len(options), count)
                self.assertTrue(all(option.get("dk") for option in options), options)

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

    def test_krea_timestep_and_weighting_options_reach_musubi_config(self):
        sampling_modes = ("uniform", "sigmoid", "sigma", "shift", "krea2_shift", "logsnr")
        weighting_schemes = ("none", "sigma_sqrt", "cosmap", "logit_normal", "mode")

        for sampling in sampling_modes:
            for weighting in weighting_schemes:
                with self.subTest(sampling=sampling, weighting=weighting), tempfile.TemporaryDirectory() as temp_dir:
                    root = Path(temp_dir)
                    config = krea2_config(root)
                    config["timestep_sampling"] = sampling
                    config["weighting_scheme"] = weighting

                    self.assertEqual(validate_krea2_config(config), [])
                    train = build_krea2_train_config(
                        config,
                        root / "run" / "dataset.toml",
                        root / "artifact",
                        root / "run" / "log",
                    )

                    self.assertEqual(train["timestep_sampling"], sampling)
                    self.assertEqual(train["weighting_scheme"], weighting)

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

    def test_shift_is_positive_for_shift_and_sigma_sampling(self):
        for sampling in ("shift", "sigma"):
            for value in (0, -1, float("nan"), float("inf")):
                with self.subTest(sampling=sampling, value=value), tempfile.TemporaryDirectory() as temp_dir:
                    config = krea2_config(Path(temp_dir))
                    config["timestep_sampling"] = sampling
                    config["discrete_flow_shift"] = value
                    errors = validate_krea2_config(config)
                    self.assertTrue(any("discrete_flow_shift" in error for error in errors), errors)

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

    def test_train_toml_uses_only_krea_parser_flags(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config["network_args_custom"] = "exclude_patterns=['.*']"
            config["krea_optimizer_weight_decay"] = 0.01
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

    def test_optimizer_menu_uses_mechanism_groups_and_exact_order(self):
        fields = get_fields_json()
        optimizer_fields = [
            field
            for section in fields["sections"]
            for field in section["fields"]
            if field["key"] == "optimizer_type" and field.get("profiles") == ["krea2-lora"]
        ]
        scheduler_fields = [
            field
            for section in fields["sections"]
            for field in section["fields"]
            if field["key"] == "lr_scheduler" and field.get("profiles") == ["krea2-lora"]
        ]

        self.assertEqual(len(optimizer_fields), 1)
        optimizer_groups = {
            group["labelKey"]: [option["v"] for option in group["options"]]
            for group in optimizer_fields[0]["groups"]
        }
        self.assertEqual(
            optimizer_groups,
            {
                "opt.optimizer_group_baseline": [
                    "adamw8bit",
                    "AdamW",
                    "bitsandbytes.optim.PagedAdamW8bit",
                ],
                "opt.optimizer_group_stable": [
                    "pytorch_optimizer.CAME",
                ],
                "opt.optimizer_group_fast": [
                    "bitsandbytes.optim.Lion8bit",
                    "bitsandbytes.optim.PagedLion8bit",
                    "pytorch_optimizer.Lion",
                ],
                "opt.optimizer_group_autolr": [
                    "AdaFactor",
                    "prodigyopt.Prodigy",
                    "prodigyplus.ProdigyPlusScheduleFree",
                    "schedulefree.AdamWScheduleFree",
                ],
            },
        )
        optimizer_values = set().union(*optimizer_groups.values())
        self.assertEqual(len(optimizer_values), 11)
        self.assertFalse(
            {
                "torch.optim.Adam",
                "torch.optim.RAdam",
                "torch.optim.NAdam",
                "torch.optim.SGD",
            }
            & optimizer_values
        )
        self.assertNotIn("__custom__", optimizer_values)

        self.assertEqual(len(scheduler_fields), 1)
        scheduler_values = {option["v"] for option in scheduler_fields[0]["options"]}
        self.assertTrue({"inverse_sqrt", "cosine_with_min_lr", "warmup_stable_decay"}.issubset(scheduler_values))
        # trainer_base calls lr_scheduler.step() without a metric, so exposing
        # ReduceLROnPlateau would produce a valid-looking form that fails mid-run.
        self.assertNotIn("reduce_lr_on_plateau", scheduler_values)
        self.assertNotIn("cosine_warmup_with_min_lr", scheduler_values)

    def test_guided_optimizer_and_scheduler_controls_map_to_real_musubi_flags(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "optimizer_type": "bitsandbytes.optim.PagedAdamW8bit",
                    "krea_optimizer_weight_decay": 0.02,
                    "krea_optimizer_betas": "0.9, 0.999",
                    "krea_optimizer_eps": "1e-8",
                    "lr_scheduler": "cosine_with_min_lr",
                    "lr_scheduler_num_cycles": 3,
                    "lr_scheduler_min_lr_ratio": 0.05,
                }
            )

            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")

        self.assertEqual(train["optimizer_type"], "bitsandbytes.optim.PagedAdamW8bit")
        self.assertEqual(train["lr_scheduler"], "cosine_with_min_lr")
        self.assertEqual(train["lr_scheduler_num_cycles"], 3)
        self.assertEqual(train["lr_scheduler_min_lr_ratio"], 0.05)
        self.assertEqual(
            train["optimizer_args"],
            ["weight_decay=0.02", "betas=(0.9, 0.999)", "eps=1e-08"],
        )

    def test_removed_optimizer_selector_uses_generic_unsupported_validation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            config["optimizer_type"] = "removed.optimizer"
            errors = validate_krea2_config(config)
            with self.assertRaisesRegex(ValueError, "only the built-in Krea 2 optimizer list"):
                build_krea2_train_config(
                    config,
                    Path(temp_dir) / "dataset.toml",
                    Path(temp_dir) / "output",
                    Path(temp_dir) / "log",
                )

        self.assertTrue(any(error.startswith("optimizer_type: only the built-in") for error in errors))

    def test_cosine_with_min_lr_gets_an_explicit_safe_floor_for_old_presets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config["lr_scheduler"] = "cosine_with_min_lr"

            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")

        self.assertEqual(config["lr_scheduler_min_lr_ratio"], 0.0)
        self.assertEqual(train["lr_scheduler_min_lr_ratio"], 0.0)

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

    def test_prodigyplus_uses_internal_scheduler_and_only_supported_guided_args(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config = krea2_config(root)
            config.update(
                {
                    "optimizer_type": "prodigyplus.ProdigyPlusScheduleFree",
                    "krea_optimizer_weight_decay": 0.02,
                    "krea_optimizer_betas": "0.9, 0.99",
                    "krea_optimizer_eps": "1e-8",
                    "krea_prodigy_d_coef": "1.5",
                    "krea_prodigy_d0": "1e-5",
                    "krea_prodigyplus_use_stableadamw": True,
                    "lr_scheduler": "cosine",
                    "lr_warmup_steps": 10,
                    "max_grad_norm": 0.5,
                    # This field belongs to AdamWScheduleFree alone. A stale
                    # or direct value must not become an invalid ProdigyPlus
                    # constructor argument.
                    "krea_schedulefree_warmup_steps": 25,
                }
            )

            self.assertEqual(validate_krea2_config(config), [])
            train = build_krea2_train_config(config, root / "dataset.toml", root / "output", root / "log")

        self.assertEqual(config["lr_scheduler"], "constant")
        self.assertEqual(config["lr_warmup_steps"], 0)
        self.assertEqual(config["max_grad_norm"], 0.0)
        self.assertEqual(
            train["optimizer_args"],
            [
                "weight_decay=0.02",
                "betas=(0.9, 0.99)",
                "eps=1e-08",
                "d_coef=1.5",
                "d0=1e-05",
                "use_stableadamw=True",
            ],
        )
        self.assertFalse(any(arg.startswith("warmup_steps=") for arg in train["optimizer_args"]))

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

    def test_optimizer_specific_guided_args_reject_invalid_shapes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            config.update({"optimizer_type": "AdamW", "krea_optimizer_betas": "0.9, 0.999, 0.9999"})
            errors = validate_krea2_config(config)

            came = krea2_config(Path(temp_dir) / "came")
            came.update({"optimizer_type": "pytorch_optimizer.CAME", "krea_optimizer_betas": "0.9, 0.999"})
            came_errors = validate_krea2_config(came)

            prodigyplus = krea2_config(Path(temp_dir) / "prodigyplus")
            prodigyplus.update(
                {"optimizer_type": "prodigyplus.ProdigyPlusScheduleFree", "krea_prodigy_d0": "0"}
            )
            prodigyplus_errors = validate_krea2_config(prodigyplus)

        self.assertTrue(any("krea_optimizer_betas: requires 2 values" in error for error in errors))
        self.assertTrue(any("krea_optimizer_betas: requires 3 values" in error for error in came_errors))
        self.assertTrue(any(error.startswith("krea_prodigy_d0: value is out of range") for error in prodigyplus_errors))

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

    def test_preflight_explains_when_a_selected_shared_optimizer_is_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config = krea2_config(Path(temp_dir))
            config["optimizer_type"] = "pytorch_optimizer.CAME"
            runtime = {"ok": True, "errors": [], "versions": {}, "python": "main"}
            with patch("backend.training.musubi_krea2.shared_runtime_status", return_value=runtime), patch(
                "backend.training.musubi_krea2.importlib.metadata.version",
                side_effect=PackageNotFoundError,
            ):
                preflight = krea2_preflight(config, require_cache=False)

        self.assertFalse(preflight["ok"])
        self.assertTrue(any("pytorch-optimizer" in error for error in preflight["errors"]))

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
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_fields_follow_explicit_or_conditional_layout_parents(self):
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const ctx = Object.assign({}, window.trainingCoreMixin);
const fields = [
  { key: 'optimizer_type', keepChildrenPosition: true },
  { key: 'learning_rate' },
  { key: 'scheduler' },
  { key: 'weight_decay', layoutParent: 'optimizer_type' },
  { key: 'stable_a', showIf: { key: 'optimizer_type', eq: 'Stable' } },
  { key: 'stable_b', showIf: { key: 'optimizer_type', eq: 'Stable' } },
  { key: 'came_parent', showIf: { key: 'optimizer_type', eq: 'CAME' } },
  { key: 'came_child', showIf: [
    { key: 'optimizer_type', eq: 'CAME' },
    { key: 'came_parent', eq: true },
  ] },
];
console.log(JSON.stringify(ctx._orderFieldsByDependencies(fields).map(field => field.key)));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        self.assertEqual(
            json.loads(result.stdout),
            [
                "optimizer_type",
                "learning_rate",
                "scheduler",
                "weight_decay",
                "stable_a",
                "stable_b",
                "came_parent",
                "came_child",
            ],
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_field_reset_updates_the_changed_state_baseline(self):
        source = Path("frontend/js/training-core.js").read_text(encoding="utf-8")
        reset_body = source.split("resetField(key) {", 1)[1].split("\n  },", 1)[0]
        self.assertIn("this.formDefaults[key] = value;", reset_body)

    def test_hidden_conditional_fields_remove_all_border_width(self):
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")
        hidden_rule = css.split(".field-conditional.field-hidden {", 1)[1].split("}", 1)[0]

        self.assertIn("border-width: 0 !important;", hidden_rule)

    def test_krea_ui_has_cache_and_core_registry_paths(self):
        training_toml = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        environment = Path("frontend/js/environment-core.js").read_text(encoding="utf-8")
        form = Path("frontend/index.html").read_text(encoding="utf-8")

        self.assertIn("/api/training/krea2/cache", training_toml)
        self.assertIn("krea2-lora", training_toml)
        self.assertIn("/api/training/cores", environment)
        self.assertIn("runtime_errors", Path("frontend/js/environment-render.js").read_text(encoding="utf-8"))
        self.assertIn("prepareKrea2Cache()", form)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_all_parameter_previews_are_grouped_self_describing_and_route_to_the_right_core(self):
        script = r"""
global.window = {};
global.document = { getElementById() { return { innerHTML: '' }; } };
window.OPTIMIZER_DEFAULTS = {};
window.getVisibleSections = () => [
  {
    key: 'model',
    fields: [
      { key: 'model_train_type', hidden: true },
      { key: 'model_path' },
    ],
  },
  { key: 'network', fields: [{ key: 'network_dim' }] },
  { key: 'empty', fields: [{ key: 'empty_value' }] },
];
require('./frontend/js/training-toml.js');

function previewFor(type) {
  const ctx = Object.assign({}, window.trainingTomlMixin, {
    form: {
      model_train_type: type,
      model_path: `./models/${type}.safetensors`,
      network_dim: 32,
      empty_value: '',
    },
    _fieldShowIfMet() { return true; },
    _coerceNum(value) { return value; },
    findFieldDef() { return null; },
    esc(value) { return String(value); },
    t(key, fallback) { return fallback || key; },
  });
  ctx.updateToml();
  return { type, toml: ctx.tomlRaw, title: ctx.parameterPreviewTitle() };
}

console.log(JSON.stringify([
  previewFor('sdxl-lora'),
  previewFor('anima-lora'),
  previewFor('krea2-lora'),
]));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        previews = json.loads(result.stdout)
        expected_engines = {
            "sdxl-lora": "sd_scripts",
            "anima-lora": "sd_scripts",
            "krea2-lora": "musubi_tuner",
        }
        expected_titles = {
            "sdxl-lora": "SDXL Parameter Preview",
            "anima-lora": "Anima Parameter Preview",
            "krea2-lora": "Krea 2 Parameter Preview",
        }
        for preview in previews:
            config = toml.loads(preview["toml"])
            train_type = preview["type"]
            self.assertEqual(config["model_train_type"], train_type)
            self.assertIn("# --- model ---", preview["toml"])
            self.assertIn("# --- network ---", preview["toml"])
            self.assertNotIn("# --- empty ---", preview["toml"])
            self.assertEqual(preview["title"], expected_titles[train_type])
            profile = resolve_training_profile(config)
            self.assertEqual(profile.engine_id, expected_engines[train_type])

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
    def test_krea_profile_resets_incompatible_shared_select_values(self):
        script = r"""
global.window = {};
window.getVisibleSections = () => [{
  fields: [
    { key: 'timestep_sampling', type: 'select', default: 'shift', options: [{ v: 'shift' }, { v: 'krea2_shift' }] },
    { key: 'weighting_scheme', type: 'select', default: 'none', options: [{ v: 'none' }] },
  ],
}];
require('./frontend/js/training-core.js');
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: { timestep_sampling: 'sigmoid', weighting_scheme: 'uniform' },
});
const defaults = ctx._buildFormDefaults('krea2-lora');
ctx._normalizeProfileSelectValues('krea2-lora', defaults);
console.log(JSON.stringify(ctx.form));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        form = json.loads(result.stdout)
        self.assertEqual(form["timestep_sampling"], "shift")
        self.assertEqual(form["weighting_scheme"], "none")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_krea_profile_fills_blank_model_paths_without_overwriting_custom_paths(self):
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: {
    dit: '',
    vae: 'D:/custom/vae.safetensors',
    text_encoder: null,
  },
});
ctx._applyKrea2ModelDefaults(ctx.form, {
  dit: './models/krea2_raw_fp8_scaled.safetensors',
  vae: './models/qwen_image_vae.safetensors',
  text_encoder: './models/qwen3vl_4b_fp8_scaled.safetensors',
});
console.log(JSON.stringify(ctx.form));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        form = json.loads(result.stdout)
        self.assertEqual(form["dit"], "./models/krea2_raw_fp8_scaled.safetensors")
        self.assertEqual(form["vae"], "D:/custom/vae.safetensors")
        self.assertEqual(form["text_encoder"], "./models/qwen3vl_4b_fp8_scaled.safetensors")

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_training_type_switch_initializes_conditions_in_one_dom_pass(self):
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const makeRow = (id, attrs) => ({
  id,
  attrs,
  isConnected: true,
  classList: { contains() { return false; } },
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
});
const rows = [
  makeRow('single', { 'data-show-if-key': 'mode', 'data-show-if-eq': 'fast' }),
  makeRow('all', {
    'data-show-if-all': JSON.stringify([
      { key: 'enabled', eq: true },
      { key: 'mode', neq: 'slow' },
    ]),
  }),
  makeRow('any', {
    'data-show-if-any': JSON.stringify([
      [{ key: 'mode', eq: 'slow' }],
      [{ key: 'enabled', eq: false }],
    ]),
  }),
];
let queryCount = 0;
global.document = {
  getElementById() {
    return {
      querySelectorAll(selector) {
        if (selector !== '[data-show-if-all],[data-show-if-any],[data-show-if-key]') {
          throw new Error('unexpected selector: ' + selector);
        }
        queryCount += 1;
        return rows;
      },
    };
  },
};
const applied = {};
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: { mode: 'fast', enabled: true },
  _setConditionalState(row, visible) { applied[row.id] = visible; },
});
ctx._syncAllConditionalFields();
console.log(JSON.stringify({ queryCount, applied }));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["queryCount"], 1)
        self.assertEqual(state["applied"], {"single": True, "all": True, "any": False})

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_training_type_ui_switch_yields_a_frame_before_rebuilding(self):
        script = r"""
global.window = {};
const frames = [];
global.requestAnimationFrame = callback => {
  frames.push(callback);
  return frames.length;
};
const classes = new Set();
const formElement = {
  classList: {
    add(value) { classes.add(value); },
    remove(value) { classes.delete(value); },
  },
  setAttribute() {},
  removeAttribute() {},
};
global.document = {
  getElementById(id) { return id === 'trainForm' ? formElement : null; },
};
require('./frontend/js/training-core.js');
const switches = [];
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: { model_train_type: 'anima-lora' },
  formDefaults: { model_train_type: 'anima-lora' },
  switchTrainType(value) {
    switches.push(value);
    this.form = { model_train_type: value };
  },
});
ctx.setField('model_train_type', 'krea2-lora');
const beforeFrames = {
  type: ctx.form.model_train_type,
  switches: switches.slice(),
  queued: frames.length,
  fading: classes.has('train-type-switching'),
};
frames.shift()();
const afterFirstFrame = {
  type: ctx.form.model_train_type,
  switches: switches.slice(),
  queued: frames.length,
};
frames.shift()();
const afterCommitFrame = {
  type: ctx.form.model_train_type,
  switches: switches.slice(),
  queued: frames.length,
};
frames.shift()();
console.log(JSON.stringify({
  beforeFrames,
  afterFirstFrame,
  afterCommitFrame,
  fadingAfterPaint: classes.has('train-type-switching'),
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
        self.assertEqual(state["beforeFrames"]["type"], "anima-lora")
        self.assertEqual(state["beforeFrames"]["switches"], [])
        self.assertEqual(state["beforeFrames"]["queued"], 1)
        self.assertTrue(state["beforeFrames"]["fading"])
        self.assertEqual(state["afterFirstFrame"]["switches"], [])
        self.assertEqual(state["afterCommitFrame"]["switches"], ["krea2-lora"])
        self.assertEqual(state["afterCommitFrame"]["type"], "krea2-lora")
        self.assertFalse(state["fadingAfterPaint"])

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_training_type_ui_switch_uses_ready_panel_without_waiting_for_frames(self):
        script = r"""
global.window = {};
const frames = [];
global.requestAnimationFrame = callback => {
  frames.push(callback);
  return frames.length;
};
global.document = { getElementById() { return null; } };
require('./frontend/js/training-core.js');
const switches = [];
const readyPanel = {
  dataset: { panelLocale: '', fieldsRevision: '0' },
  getAttribute(name) { return name === 'data-panel-ready' ? '1' : null; },
};
const ctx = Object.assign({}, window.trainingCoreMixin, {
  form: { model_train_type: 'anima-lora' },
  formDefaults: { model_train_type: 'anima-lora' },
  _trainTypePanelCache: new Map([['krea2-lora', readyPanel]]),
  switchTrainType(value) {
    switches.push(value);
    this.form = { model_train_type: value };
  },
});
ctx.setField('model_train_type', 'krea2-lora');
console.log(JSON.stringify({
  type: ctx.form.model_train_type,
  switches,
  queuedFrames: frames.length,
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
        self.assertEqual(state["type"], "krea2-lora")
        self.assertEqual(state["switches"], ["krea2-lora"])
        self.assertEqual(state["queuedFrames"], 0)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_krea_config_preview_uses_the_shared_toml_highlighter(self):
        script = r"""
global.window = {};
const preview = { innerHTML: '', textContent: 'must-not-be-used' };
global.document = {
  getElementById(id) { return id === 'tomlPreview' ? preview : null; },
};
window.getVisibleSections = () => [{
  key: 'base',
  fields: [
    { key: 'model_train_type' },
    { key: 'learning_rate' },
    { key: 'output_name' },
  ],
}];
require('./frontend/js/training-toml.js');
const ctx = Object.assign({}, window.trainingTomlMixin, {
  form: {
    model_train_type: 'krea2-lora',
    learning_rate: 0.0001,
    output_name: 'safe<&',
  },
  _fieldShowIfMet() { return true; },
  _coerceNum(value) { return value; },
  esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  t() { return 'none'; },
});
ctx._updateKrea2Toml();
console.log(JSON.stringify(preview));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            check=True,
            text=True,
        )
        preview = json.loads(result.stdout)
        self.assertIn('class="toml-line-content toml-comment"', preview["innerHTML"])
        self.assertIn('data-param-key="learning_rate"', preview["innerHTML"])
        self.assertIn('data-param-key="output_name"', preview["innerHTML"])
        self.assertIn('class="toml-key"', preview["innerHTML"])
        self.assertIn('class="toml-num"', preview["innerHTML"])
        self.assertIn('class="toml-str"', preview["innerHTML"])
        self.assertIn("safe&lt;&amp;", preview["innerHTML"])
        self.assertEqual(preview["textContent"], "must-not-be-used")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_toml_change_reveal_uses_decelerating_scroll_then_flashes_text_content(self):
        script = r"""
global.window = {};
const frames = [];
window.matchMedia = () => ({ matches: false });
window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
window.cancelAnimationFrame = () => {};
require('./frontend/js/training-toml.js');

const classEvents = [];
const content = {
  offsetWidth: 80,
  classList: {
    remove(name) { classEvents.push(`remove:${name}`); },
    add(name) { classEvents.push(`add:${name}`); },
  },
};
const line = {
  dataset: { paramKey: 'learning_rate' },
  getBoundingClientRect() { return { top: 900, bottom: 920, height: 20 }; },
  querySelector(selector) { return selector === '.toml-line-content' ? content : null; },
};
const samples = [];
let currentTop = 0;
const preview = {
  clientHeight: 300,
  scrollHeight: 1000,
  get scrollTop() { return currentTop; },
  set scrollTop(value) { currentTop = value; samples.push(value); },
  getBoundingClientRect() { return { top: 0, bottom: 300 }; },
  querySelectorAll() { return [line]; },
};
const ctx = Object.assign({}, window.trainingTomlMixin, {
  form: { model_train_type: 'sdxl-lora' },
  _tomlPreviewUserScrollUntil: 0,
  _tomlPreviewScrollFrame: null,
});
ctx._revealTomlPreviewChange(preview, 'learning_rate');
let timestamp = 0;
while (frames.length > 0) {
  const frame = frames.shift();
  frame(timestamp);
  timestamp += 50;
}
const positive = samples.filter(value => value > 0);
const deltas = positive.map((value, index) => index === 0 ? value : value - positive[index - 1]);
console.log(JSON.stringify({
  finalTop: currentTop,
  samples,
  firstDelta: deltas[0],
  lastDelta: deltas[deltas.length - 1],
  classEvents,
  networkAlias: ctx._tomlPreviewOutputKey('loraplus_lr_ratio'),
  optimizerAlias: ctx._tomlPreviewOutputKey('weight_decay'),
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
        self.assertEqual(state["finalTop"], 700)
        self.assertGreater(len(state["samples"]), 3)
        self.assertGreater(state["firstDelta"], state["lastDelta"])
        self.assertEqual(
            state["classEvents"],
            ["remove:toml-change-flash", "add:toml-change-flash"],
        )
        self.assertEqual(state["networkAlias"], "network_args")
        self.assertEqual(state["optimizerAlias"], "optimizer_args")

    def test_toml_change_animation_is_scoped_to_text_content(self):
        css = Path("frontend/css/app.css").read_text(encoding="utf-8")
        training_core = Path("frontend/js/training-core.js").read_text(encoding="utf-8")

        self.assertIn("#tomlPreview .toml-line-content.toml-change-flash", css)
        self.assertIn("@keyframes toml-devtools-change", css)
        self.assertIn("box-decoration-break: clone", css)
        self.assertIn("queueTomlPreviewChange(key)", training_core)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_merged_args_flash_only_the_changed_key_value_token(self):
        script = r"""
global.window = {};
require('./frontend/js/training-toml.js');
const events = [];
const makeToken = (key, label = key) => ({
  dataset: { tomlArgKey: key },
  offsetWidth: 40,
  classList: {
    remove(name) { events.push(`${label}:remove:${name}`); },
    add(name) { events.push(`${label}:add:${name}`); },
  },
});
const oldAlgo = makeToken('algo', 'algo-old');
const algo = makeToken('algo');
const conv = makeToken('conv_dim');
const lineContent = makeToken('line');
const line = {
  querySelector(selector) { return selector === '.toml-line-content' ? lineContent : null; },
  querySelectorAll(selector) { return selector === '[data-toml-arg-key]' ? [oldAlgo, conv, algo] : []; },
};
const ctx = Object.assign({}, window.trainingTomlMixin, {
  form: { model_train_type: 'sdxl-lora' },
  esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
});
const html = ctx._highlightToml([
  'network_args = ["algo=loha", "conv_dim=8"]',
  'optimizer_args = ["weight_decay=0.02", "eps=1e-8"]',
]);
ctx._flashTomlLine(line, ctx._tomlPreviewArgTarget('lycoris_algo').argKey);
console.log(JSON.stringify({
  html,
  events,
  lycoris: ctx._tomlPreviewArgTarget('lycoris_algo'),
  weightDecay: ctx._tomlPreviewArgTarget('weight_decay'),
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
        self.assertIn('data-toml-arg-key="algo"', state["html"])
        self.assertIn('data-toml-arg-key="conv_dim"', state["html"])
        self.assertIn('data-toml-arg-key="weight_decay"', state["html"])
        self.assertEqual(
            state["events"],
            ["algo:remove:toml-change-flash", "algo:add:toml-change-flash"],
        )
        self.assertEqual(state["lycoris"], {"paramKey": "network_args", "argKey": "algo"})
        self.assertEqual(
            state["weightDecay"],
            {"paramKey": "optimizer_args", "argKey": "weight_decay"},
        )


if __name__ == "__main__":
    unittest.main()
