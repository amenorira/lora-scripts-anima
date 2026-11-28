"""Regression tests for training path resolution with external ANIMA_DATA_DIR / overrides."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import tomllib
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from backend import constants
from backend.server.routes import training as training_routes
from backend.tasks import TaskManager
from backend.training.cache.krea2_cache import (
    get_krea2_cache_status,
    krea2_cache_files,
    mark_cache_manifest,
    prepare_cache_manifest,
)
from backend.training.cache.rebuild import delete_te_cache, sd_scripts_cache_files
from backend.training.config.adapter import adapt_config
from backend.training.config.moss_image import validate_model_files
from backend.training.config.musubi_krea2 import (
    KREA2_FIELDS,
    build_krea2_dataset_config,
    build_krea2_train_config,
    krea2_auto_cache_dir,
    validate_krea2_config,
)
from backend.training.config.storage_paths import (
    normalize_training_path,
    resolve_training_path,
)
from backend.training.core_registry import get_profile
from backend.training.datasets.crop_preview import inspect_crops
from backend.training.datasets.prompt_tags import inspect_prompt_tags
from backend.training.datasets.sd_dataset_config import build_sd_scripts_dataset_config
from backend.training.datasets.step_estimator import estimate_training_steps
from backend.training.execution import launch, launch_krea2, launch_sd_scripts, sd_scripts_preflight
from backend.training.execution.krea2_preflight import (
    inspect_krea2_checkpoint_format,
    krea2_preflight,
)
from backend.training.execution.preparation import TrainingPreparation
from backend.training.preview.config import normalize_loras

STORAGE_ENV_KEYS = (
    "ANIMA_DATA_DIR",
    "ANIMA_MODELS_DIR",
    "ANIMA_TRAIN_DIR",
    "ANIMA_OUTPUT_DIR",
    "ANIMA_CONFIG_DIR",
    "ANIMA_LOGS_DIR",
    "ANIMA_CACHE_DIR",
    "ANIMA_HF_CACHE_DIR",
)


@contextmanager
def storage_env(**overrides: str | Path | None):
    """Temporarily configure ANIMA_* storage env vars and refresh backend.constants."""
    saved = {key: os.environ.get(key) for key in STORAGE_ENV_KEYS}
    try:
        for key in STORAGE_ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in overrides.items():
            if value is not None:
                os.environ[key] = str(value)
        constants.refresh_storage_paths()
        yield
    finally:
        for key, old in saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        constants.refresh_storage_paths()


def _write_png(path: Path, size: tuple[int, int] = (64, 64)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color=(120, 140, 160)).save(path)


def _write_minimal_safetensors(path: Path, tensors: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = json.dumps(tensors).encode("utf-8")
    path.write_bytes(len(header).to_bytes(8, "little") + header + b"\x00" * 16)


def _krea2_default_form() -> dict:
    form = {field["key"]: field["default"] for field in KREA2_FIELDS if "default" in field}
    form["model_train_type"] = "krea2-lora"
    return form


class StoragePathHelperTests(unittest.TestCase):

    def test_default_local_install_preserves_relative_logical_strings(self):
        with storage_env():
            self.assertEqual(
                normalize_training_path("./models/anima-base-v1.0.safetensors", posix=True),
                "./models/anima-base-v1.0.safetensors",
            )
            self.assertEqual(normalize_training_path("./train", posix=True), "./train")
            self.assertEqual(normalize_training_path("./output", posix=True), "./output")
            self.assertEqual(normalize_training_path("./config/p.txt", posix=True), "./config/p.txt")
            self.assertEqual(normalize_training_path("./logs", posix=True), "./logs")
            self.assertEqual(normalize_training_path("stabilityai/sdxl", posix=True), "stabilityai/sdxl")

    def test_external_anima_data_dir_maps_logical_roots_and_preserves_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "ext_data"
            outside = Path(temp_dir) / "outside" / "custom.safetensors"
            with storage_env(ANIMA_DATA_DIR=ext):
                self.assertEqual(
                    Path(normalize_training_path("./models/a.safetensors")),
                    (ext / "models" / "a.safetensors").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path("models/a.safetensors")),
                    (ext / "models" / "a.safetensors").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path(r".\models\sub\a.safetensors")),
                    (ext / "models" / "sub" / "a.safetensors").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path("./train")),
                    (ext / "train").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path("./output")),
                    (ext / "output").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path("./config/prompts.txt")),
                    (ext / "config" / "prompts.txt").resolve(),
                )
                self.assertEqual(
                    Path(normalize_training_path("./logs")),
                    (ext / "logs").resolve(),
                )
                # Explicit absolute paths and HF repo IDs remain untouched.
                self.assertEqual(normalize_training_path(str(outside)), str(outside))
                self.assertEqual(normalize_training_path("org/repo-name"), "org/repo-name")

    def test_per_directory_override_only_rewrites_overridden_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            custom_models = Path(temp_dir) / "nvme_models"
            custom_output = Path(temp_dir) / "custom_out"
            outside = (Path(temp_dir) / "outside" / "file.safetensors").resolve()
            with storage_env(ANIMA_MODELS_DIR=custom_models):
                self.assertEqual(
                    Path(normalize_training_path("./models/a.safetensors")),
                    (custom_models / "a.safetensors").resolve(),
                )
                # Un-overridden roots stay relative as in default local install.
                self.assertEqual(normalize_training_path("./train"), "./train")
                self.assertEqual(normalize_training_path("./output"), "./output")
                # Direct resolve_training_path assertions (logical root, explicit absolute).
                self.assertEqual(
                    resolve_training_path("./models/a.safetensors"),
                    (custom_models / "a.safetensors").resolve(),
                )
                self.assertEqual(resolve_training_path(outside), outside)
            with storage_env(ANIMA_OUTPUT_DIR=custom_output):
                self.assertEqual(
                    resolve_training_path("./output/run1"),
                    (custom_output / "run1").resolve(),
                )


class SdScriptsExternalDataDirTests(unittest.TestCase):

    def _populate_external_anima(self, ext: Path) -> None:
        _write_minimal_safetensors(
            ext / "models" / "anima-base-v1.0.safetensors",
            {"blocks.0.attn.weight": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
        )
        _write_minimal_safetensors(
            ext / "models" / "qwen_image_vae.safetensors",
            {"vae.weight": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
        )
        _write_minimal_safetensors(
            ext / "models" / "qwen_3_06b_base.safetensors",
            {"te.weight": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
        )
        _write_minimal_safetensors(
            ext / "models" / "style_lora.safetensors",
            {"lora.weight": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
        )
        subset = ext / "train" / "3_extchar"
        _write_png(subset / "a.png")
        (subset / "a.txt").write_text("ext_tag_only, masterpiece", encoding="utf-8")
        _write_png(subset / "b.png")
        (subset / "b.txt").write_text("ext_tag_only, portrait", encoding="utf-8")
        reg_subset = ext / "train" / "reg_only" / "2_person"
        _write_png(reg_subset / "r.png")
        (ext / "config").mkdir(parents=True, exist_ok=True)
        (ext / "config" / "prompts.txt").write_text("1girl, solo --w 512 --h 512 --s 12\n", encoding="utf-8")

    def test_adapt_preflight_dataset_estimator_preview_and_launch_use_external_data_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "ext_data"
            outside_abs = (Path(temp_dir) / "outside" / "explicit.safetensors").resolve()
            outside_abs.parent.mkdir(parents=True, exist_ok=True)
            outside_abs.write_bytes(b"explicit")
            self._populate_external_anima(ext)

            with storage_env(ANIMA_DATA_DIR=ext):
                raw_config = {
                    "model_train_type": "anima-lora",
                    "pretrained_model_name_or_path": "./models/anima-base-v1.0.safetensors",
                    "vae": "./models/qwen_image_vae.safetensors",
                    "qwen3": "./models/qwen_3_06b_base.safetensors",
                    "train_data_dir": "./train",
                    "enable_reg_data": True,
                    "reg_data_dir": "./train/reg_only",
                    "output_dir": "./output",
                    "output_name": "ext_anima",
                    "logging_dir": "./logs",
                    "resume": "./output/prev_state",
                    "network_weights": str(outside_abs),
                    "base_weights": f"./models/style_lora.safetensors, {outside_abs}",
                    "sample_prompts": "./config/prompts.txt",
                    "t5xxl": "./models/t5xxl.safetensors",
                    "clip_l": "./models/clip_l.safetensors",
                    "clip_g": "./models/clip_g.safetensors",
                    "dataset_config": "./config/custom_dataset.toml",
                    "resolution": "1024,1024",
                    "enable_bucket": True,
                    "bucket_reso_steps": 16,
                    "min_bucket_reso": 256,
                    "max_bucket_reso": 2048,
                    "train_batch_size": 1,
                    "max_train_epochs": 2,
                    "gradient_accumulation_steps": 1,
                    "learning_rate": "1e-4",
                    "network_module": "networks.lora_anima",
                    "network_dim": 16,
                    "network_alpha": 16,
                    "optimizer_type": "AdamW8bit",
                    "lr_scheduler": "constant",
                    "mixed_precision": "bf16",
                    "save_precision": "bf16",
                    "cache_latents": True,
                    "cache_latents_to_disk": True,
                    "cache_text_encoder_outputs": True,
                    "cache_text_encoder_outputs_to_disk": False,
                    "enable_preview": True,
                    "preview_loras": [{"path": "./models/style_lora.safetensors", "multiplier": 0.8}],
                }

                # 1. Adapter resolves logical storage paths and leaves explicit absolute paths untouched.
                adapted, _ = adapt_config(dict(raw_config))
                self.assertEqual(
                    Path(adapted["pretrained_model_name_or_path"]),
                    (ext / "models" / "anima-base-v1.0.safetensors").resolve(),
                )
                self.assertEqual(Path(adapted["vae"]), (ext / "models" / "qwen_image_vae.safetensors").resolve())
                self.assertEqual(Path(adapted["qwen3"]), (ext / "models" / "qwen_3_06b_base.safetensors").resolve())
                self.assertEqual(Path(adapted["train_data_dir"]), (ext / "train").resolve())
                self.assertEqual(Path(adapted["reg_data_dir"]), (ext / "train" / "reg_only").resolve())
                self.assertEqual(Path(adapted["output_dir"]), (ext / "output").resolve())
                self.assertEqual(Path(adapted["logging_dir"]), (ext / "logs").resolve())
                self.assertEqual(Path(adapted["resume"]), (ext / "output" / "prev_state").resolve())
                self.assertEqual(Path(adapted["sample_prompts"]), (ext / "config" / "prompts.txt").resolve())
                self.assertEqual(Path(adapted["t5xxl"]), (ext / "models" / "t5xxl.safetensors").resolve())
                self.assertEqual(Path(adapted["clip_l"]), (ext / "models" / "clip_l.safetensors").resolve())
                self.assertEqual(Path(adapted["clip_g"]), (ext / "models" / "clip_g.safetensors").resolve())
                self.assertEqual(Path(adapted["dataset_config"]), (ext / "config" / "custom_dataset.toml").resolve())
                # Explicit absolute path preserved verbatim (modulo POSIX slash normalization in adapter).
                self.assertEqual(Path(adapted["network_weights"]), outside_abs)
                self.assertEqual(
                    [Path(p) for p in adapted["base_weights"]],
                    [(ext / "models" / "style_lora.safetensors").resolve(), outside_abs],
                )

                # 2. Preflight input file checks succeed with logical relative paths too.
                threads, error = asyncio.run(
                    sd_scripts_preflight.check_input_files(
                        {
                            "train_data_dir": "./train",
                            "reg_data_dir": "./train/reg_only",
                            "pretrained_model_name_or_path": "./models/anima-base-v1.0.safetensors",
                            "qwen3": "./models/qwen_3_06b_base.safetensors",
                            "vae": "./models/qwen_image_vae.safetensors",
                        },
                        "anima-lora",
                    )
                )
                self.assertIsNone(error)
                self.assertEqual(threads, 2)

                # 3. Step estimate, dataset config, crop preview, prompt tags, preview LoRAs all use external root.
                estimate = estimate_training_steps(
                    {
                        "model_train_type": "anima-lora",
                        "train_data_dir": "./train",
                        "resolution": "1024,1024",
                        "enable_bucket": False,
                        "train_batch_size": 1,
                        "max_train_epochs": 2,
                    }
                )
                self.assertEqual(estimate["original_images"], 2)
                self.assertEqual(estimate["repeated_samples"], 6)
                self.assertEqual(estimate["subsets"][0]["name"], "3_extchar")

                dataset_cfg = build_sd_scripts_dataset_config({"train_data_dir": "./train"}, {"3_extchar": 0.2})
                self.assertEqual(
                    Path(dataset_cfg["datasets"][0]["subsets"][0]["image_dir"]),
                    (ext / "train" / "3_extchar").resolve(),
                )

                crops = inspect_crops(
                    {
                        "model_train_type": "anima-lora",
                        "train_data_dir": "./train",
                        "resolution": "64,64",
                        "enable_bucket": False,
                    }
                )
                self.assertEqual(len(crops["items"]), 2)
                self.assertEqual(crops["items"][0]["name"], "3_extchar/a.png")

                tags = inspect_prompt_tags({"model_train_type": "anima-lora", "train_data_dir": "./train"})
                self.assertEqual(tags["image_count"], 2)
                self.assertEqual(tags["tags"][0]["tag"], "ext_tag_only")

                resolved_loras = normalize_loras(
                    [{"path": "./models/style_lora.safetensors", "multiplier": 0.7}],
                    check_files=True,
                )
                self.assertEqual(
                    Path(resolved_loras[0]["path"]),
                    (ext / "models" / "style_lora.safetensors").resolve(),
                )

                # 4. Cache scan & TE cache deletion resolve "./train" under external TRAIN_DIR.
                te_file = ext / "train" / "3_extchar" / "a_anima_te.npz"
                te_file.write_bytes(b"te")
                _, text_caches = sd_scripts_cache_files({"train_data_dir": "./train"}, "anima-lora")
                self.assertEqual(text_caches, {te_file.resolve()})
                deleted, delete_errors = delete_te_cache(["./train"])
                self.assertEqual(deleted, 1)
                self.assertEqual(delete_errors, [])
                self.assertFalse(te_file.exists())

                # 5. Full launch_sd_scripts.prepare_run resolves output_dir & writes TOML pointing to external paths.
                captured: dict = {}

                def fake_launcher(toml_file, trainer_file, gpu_ids, cpu_threads, **kwargs):
                    captured["toml_file"] = Path(toml_file)
                    captured["kwargs"] = kwargs
                    return {"status": "success", "data": {"task_id": kwargs["reserved_task"].task_id}}

                manager = TaskManager()
                task = manager.reserve_task()
                prep = TrainingPreparation(task, fake_launcher)
                launch_config = dict(raw_config)
                launch_config.pop("resume")
                launch_config.pop("t5xxl")
                launch_config.pop("clip_l")
                launch_config.pop("clip_g")
                launch_config.pop("dataset_config")
                launch_config["subset_timestep_offsets"] = {"3_extchar": 0.15}
                launch_config["preview_loras"] = []
                launch_config["enable_preview"] = False
                launch_config["sample_prompts"] = "./config/prompts.txt"

                result = asyncio.run(
                    launch_sd_scripts.prepare_run(
                        launch_config,
                        None,
                        "20261128-120000",
                        dict(launch_config),
                        prep,
                        get_profile("anima-lora"),
                    )
                )
                self.assertEqual(result["status"], "success", result)
                run_dir = Path(captured["kwargs"]["run_dir"])
                artifact_dir = Path(captured["kwargs"]["artifact_dir"])
                self.assertEqual(run_dir, artifact_dir)
                self.assertEqual(run_dir.parent, (ext / "output").resolve())
                self.assertEqual(captured["toml_file"].parent, (ext / "config" / "autosave").resolve())

                parsed_toml = tomllib.loads((run_dir / "config.toml").read_text(encoding="utf-8"))
                self.assertEqual(
                    Path(parsed_toml["pretrained_model_name_or_path"]),
                    (ext / "models" / "anima-base-v1.0.safetensors").resolve(),
                )
                self.assertEqual(Path(parsed_toml["train_data_dir"]), (ext / "train").resolve())
                self.assertEqual(Path(parsed_toml["reg_data_dir"]), (ext / "train" / "reg_only").resolve())
                self.assertEqual(Path(parsed_toml["network_weights"]), outside_abs)
                parsed_ds = tomllib.loads((run_dir / "dataset.toml").read_text(encoding="utf-8"))
                self.assertEqual(
                    Path(parsed_ds["datasets"][0]["subsets"][0]["image_dir"]),
                    (ext / "train" / "3_extchar").resolve(),
                )

    def test_preflight_does_not_fallback_to_repo_root_when_external_dir_is_empty(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "empty_ext"
            (ext / "models").mkdir(parents=True)
            (ext / "train").mkdir(parents=True)
            with storage_env(ANIMA_DATA_DIR=ext):
                _, error = asyncio.run(
                    sd_scripts_preflight.check_input_files(
                        {
                            "train_data_dir": "./train",
                            "pretrained_model_name_or_path": "./models/anima-base-v1.0.safetensors",
                            "qwen3": "./models/qwen_3_06b_base.safetensors",
                            "vae": "./models/qwen_image_vae.safetensors",
                        },
                        "anima-lora",
                    )
                )
                self.assertIsNotNone(error)
                self.assertEqual(error["data"]["errorCode"], "datasetUnavailable")

    def test_moss_validate_model_files_uses_external_models_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "ext_moss"
            for name in ("dit.safetensors", "te.safetensors", "vae.safetensors"):
                _write_minimal_safetensors(
                    ext / "models" / name,
                    {"w": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
                )
            (ext / "models" / "tok").mkdir(parents=True)
            with storage_env(ANIMA_DATA_DIR=ext):
                errors = validate_model_files(
                    {
                        "pretrained_model_name_or_path": "./models/dit.safetensors",
                        "text_encoder": "./models/te.safetensors",
                        "vae": "./models/vae.safetensors",
                        "tokenizer_cache_dir": "./models/tok",
                    }
                )
                self.assertEqual(errors, [])


class Krea2ExternalDataDirTests(unittest.TestCase):

    def _populate_external_krea2(self, ext: Path) -> None:
        bf16_header = {"layers.0.weight": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}}
        _write_minimal_safetensors(ext / "models" / "krea2_raw_bf16.safetensors", bf16_header)
        _write_minimal_safetensors(ext / "models" / "qwen_image_vae.safetensors", bf16_header)
        _write_minimal_safetensors(ext / "models" / "qwen3vl_4b_bf16.safetensors", bf16_header)
        _write_minimal_safetensors(ext / "models" / "krea2_turbo.safetensors", bf16_header)
        _write_png(ext / "train" / "portrait.png")
        (ext / "train" / "portrait.txt").write_text("a krea portrait", encoding="utf-8")

    def test_krea2_validation_preflight_cache_dataset_and_launch_use_external_data_dir(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "ext_krea2"
            outside_weights = (Path(temp_dir) / "outside" / "init_lora.safetensors").resolve()
            outside_weights.parent.mkdir(parents=True, exist_ok=True)
            outside_weights.write_bytes(b"lora")
            self._populate_external_krea2(ext)

            with storage_env(ANIMA_DATA_DIR=ext):
                form = _krea2_default_form()
                form["network_weights"] = str(outside_weights)

                # Inspect checkpoint format with relative path.
                fmt = inspect_krea2_checkpoint_format(Path("./models/krea2_raw_bf16.safetensors"))
                self.assertEqual(fmt["format"], "unquantized")

                # Step estimation with default ./train.
                est = estimate_training_steps(dict(form))
                self.assertEqual(est["original_images"], 1)

                # Validate normalizes logical paths and preserves explicit absolute path.
                cfg = dict(form)
                errors = validate_krea2_config(cfg)
                self.assertEqual(errors, [])
                self.assertEqual(Path(cfg["dit"]), (ext / "models" / "krea2_raw_bf16.safetensors").resolve())
                self.assertEqual(Path(cfg["vae"]), (ext / "models" / "qwen_image_vae.safetensors").resolve())
                self.assertEqual(Path(cfg["text_encoder"]), (ext / "models" / "qwen3vl_4b_bf16.safetensors").resolve())
                self.assertEqual(Path(cfg["train_data_dir"]), (ext / "train").resolve())
                self.assertEqual(Path(cfg["dataset_cache_dir"]), (ext / "train" / ".krea2-cache").resolve())
                self.assertEqual(Path(cfg["network_weights"]), outside_weights)

                # Preflight (cache creation mode) passes even with raw un-normalized form.
                with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}):
                    pf = krea2_preflight(dict(form), require_cache=False)
                self.assertTrue(pf["ok"], pf["errors"])
                self.assertEqual(pf["cache"]["image_count"], 1)

                # Dataset config & train config point to external storage root.
                ds_cfg = build_krea2_dataset_config(dict(form))
                self.assertEqual(Path(ds_cfg["datasets"][0]["image_directory"]), (ext / "train").resolve())
                self.assertEqual(Path(ds_cfg["datasets"][0]["cache_directory"]), (ext / "train" / ".krea2-cache").resolve())

                train_cfg = build_krea2_train_config(
                    dict(form),
                    ext / "output" / "run" / "dataset.toml",
                    ext / "output" / "run",
                    ext / "output" / "run" / "log",
                )
                self.assertEqual(Path(train_cfg["dit"]), (ext / "models" / "krea2_raw_bf16.safetensors").resolve())
                self.assertEqual(Path(train_cfg["vae"]), (ext / "models" / "qwen_image_vae.safetensors").resolve())
                self.assertEqual(Path(train_cfg["network_weights"]), outside_weights)

                # Simulate completed cache under external TRAIN_DIR/.krea2-cache, then launch training!
                prepare_cache_manifest(cfg)
                cache_dir = (ext / "train" / ".krea2-cache").resolve()
                (cache_dir / "portrait_1024x1024_kr2.safetensors").write_bytes(b"latent")
                (cache_dir / "portrait_kr2_te.safetensors").write_bytes(b"text")
                self.assertIsNone(mark_cache_manifest(cfg, "completed"))
                status = get_krea2_cache_status(dict(form))
                self.assertTrue(status["ready"], status)

                captured: dict = {}

                def fake_launcher(toml_file, trainer_file, gpu_ids, cpu_threads, **kwargs):
                    captured["toml_file"] = Path(toml_file)
                    captured["kwargs"] = kwargs
                    return {"status": "success", "data": {"task_id": kwargs["reserved_task"].task_id}}

                manager = TaskManager()
                task = manager.reserve_task()
                prep = TrainingPreparation(task, fake_launcher)
                with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}):
                    result = asyncio.run(launch.prepare_run(dict(form), prep))
                self.assertEqual(result["status"], "success", result)
                run_dir = Path(captured["kwargs"]["run_dir"])
                artifact_dir = Path(captured["kwargs"]["artifact_dir"])
                self.assertEqual(run_dir, artifact_dir)
                self.assertEqual(run_dir.parent, (ext / "output").resolve())
                self.assertEqual(captured["toml_file"].parent, (ext / "config" / "autosave").resolve())

                parsed_krea_toml = tomllib.loads((run_dir / "config.toml").read_text(encoding="utf-8"))
                self.assertEqual(Path(parsed_krea_toml["dit"]), (ext / "models" / "krea2_raw_bf16.safetensors").resolve())
                self.assertEqual(Path(parsed_krea_toml["vae"]), (ext / "models" / "qwen_image_vae.safetensors").resolve())
                self.assertEqual(Path(parsed_krea_toml["network_weights"]), outside_weights)
                parsed_krea_ds = tomllib.loads((run_dir / "dataset.toml").read_text(encoding="utf-8"))
                self.assertEqual(Path(parsed_krea_ds["datasets"][0]["image_directory"]), (ext / "train").resolve())
                self.assertEqual(Path(parsed_krea_ds["datasets"][0]["cache_directory"]), (ext / "train" / ".krea2-cache").resolve())

                # Verify prepare_cache detects existing cache under external TRAIN_DIR,
                # and with _cache_action="keep" passes external --vae and --text-encoder CLI args.
                cache_captured: dict = {}

                def fake_cache_launcher(dataset_file, script, gpu_ids, cpu_threads, **kwargs):
                    cache_captured["extra_args"] = kwargs["extra_args"]
                    cache_captured["run_dir"] = Path(kwargs["run_dir"])
                    return {"status": "success", "data": {"task_id": kwargs["reserved_task"].task_id}}

                manager2 = TaskManager()
                task2 = manager2.reserve_task()
                prep2 = TrainingPreparation(task2, fake_cache_launcher)
                with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}):
                    prompt_res = asyncio.run(launch_krea2.prepare_cache(dict(form), prep2))
                self.assertEqual(prompt_res["status"], "error")
                self.assertEqual(prompt_res["data"]["errorCode"], "trainingCacheFound")
                self.assertEqual(
                    [Path(d) for d in prompt_res["data"]["directories"]],
                    [(ext / "train" / ".krea2-cache").resolve()],
                )

                manager3 = TaskManager()
                task3 = manager3.reserve_task()
                prep3 = TrainingPreparation(task3, fake_cache_launcher)
                with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}):
                    cache_res = asyncio.run(
                        launch_krea2.prepare_cache({**form, "_cache_action": "keep"}, prep3)
                    )
                self.assertEqual(cache_res["status"], "success", cache_res)
                extra_args = cache_captured["extra_args"]
                self.assertEqual(
                    Path(extra_args[extra_args.index("--vae") + 1]),
                    (ext / "models" / "qwen_image_vae.safetensors").resolve(),
                )
                self.assertEqual(
                    Path(extra_args[extra_args.index("--text-encoder") + 1]),
                    (ext / "models" / "qwen3vl_4b_bf16.safetensors").resolve(),
                )


class TrainingRoutesExternalDataDirTests(unittest.TestCase):

    def test_routes_use_external_data_dir_for_default_logical_paths(self):
        from backend.server.routes import tagger
        from backend.tageditor import routes as editor
        from backend.tagger import captioning

        with tempfile.TemporaryDirectory() as temp_dir:
            ext = Path(temp_dir) / "ext_routes"
            (ext / "output").mkdir(parents=True)
            (ext / "config").mkdir(parents=True)
            (ext / "config" / "custom_prompt.txt").write_text("ext prompt {{knowledge}}", encoding="utf-8")
            subset = ext / "train" / "4_sample"
            _write_png(subset / "img.png")
            (subset / "img.txt").write_text("tag_route", encoding="utf-8")
            _write_minimal_safetensors(
                ext / "models" / "krea2_raw_bf16.safetensors",
                {"w": {"dtype": "BF16", "shape": [2, 2], "data_offsets": [0, 8]}},
            )

            app = FastAPI()
            app.include_router(training_routes.router, prefix="/api")
            app.include_router(tagger.router, prefix="/api")
            app.include_router(editor.router, prefix="/api")

            with storage_env(ANIMA_DATA_DIR=ext), \
                 patch.object(training_routes, "tm", TaskManager()), \
                 TestClient(app) as client:
                # 1. GET /api/training/output-path-info
                out_resp = client.get("/api/training/output-path-info", params={"path": "./output", "output_name": "demo"}).json()
                self.assertEqual(out_resp["status"], "success")
                self.assertEqual(Path(out_resp["data"]["base_dir"]), (ext / "output").resolve())
                self.assertTrue(out_resp["data"]["is_default"])
                self.assertTrue(out_resp["data"]["same_location"])

                # 2. POST /api/training/estimate
                est_resp = client.post(
                    "/api/training/estimate",
                    json={"model_train_type": "anima-lora", "train_data_dir": "./train", "resolution": "64,64", "enable_bucket": False},
                ).json()
                self.assertEqual(est_resp["status"], "success")
                self.assertEqual(est_resp["data"]["original_images"], 1)
                self.assertEqual(est_resp["data"]["repeated_samples"], 4)
                scanned = client.post("/api/tagger/source/scan", json={"path": "./train"}).json()["data"]
                edited = client.post("/api/tageditor/sessions", json={"dir": "./train"}).json()["data"]
                self.assertEqual(Path(scanned["path"]), ext / "train")
                self.assertEqual(Path(edited["dir"]), ext / "train")
                self.assertEqual((scanned["total"], edited["count"]), (1, 1))
                cap_opts = captioning.validate_options({"prompt_source": "file", "prompt_file": "./config/custom_prompt.txt"})
                self.assertEqual(captioning.resolve_prompt(cap_opts), "ext prompt {{knowledge}}")

                # 3. POST /api/training/krea2/model-format
                fmt_resp = client.post(
                    "/api/training/krea2/model-format",
                    json={"path": "./models/krea2_raw_bf16.safetensors"},
                ).json()
                self.assertEqual(fmt_resp["status"], "success")
                self.assertEqual(fmt_resp["data"]["format"], "unquantized")

                # 4. POST /api/training/krea2/cache-status
                cache_resp = client.post(
                    "/api/training/krea2/cache-status",
                    json={
                        "model_train_type": "krea2-lora",
                        "train_data_dir": "./train",
                        "dataset_cache_dir": "./train/.krea2-cache",
                        "resolution": "1024,1024",
                    },
                ).json()
                self.assertEqual(cache_resp["status"], "success")
                self.assertEqual(cache_resp["data"]["image_count"], 1)

                # 5. POST /api/training/dataset-repeat
                rep_resp = client.post(
                    "/api/training/dataset-repeat",
                    json={"dir": "./train", "changes": [{"name": "4_sample", "repeats": 9}]},
                ).json()
                self.assertEqual(rep_resp["status"], "success", rep_resp)
                self.assertTrue((ext / "train" / "9_sample").is_dir())
                self.assertFalse((ext / "train" / "4_sample").exists())


class DefaultLocalInstallPreservationTests(unittest.TestCase):

    def test_unset_anima_data_dir_keeps_relative_paths_in_generated_configs(self):
        with storage_env():
            adapted, _ = adapt_config(
                {
                    "model_train_type": "anima-lora",
                    "pretrained_model_name_or_path": "./models/anima-base-v1.0.safetensors",
                    "vae": "./models/qwen_image_vae.safetensors",
                    "qwen3": "./models/qwen_3_06b_base.safetensors",
                    "train_data_dir": "./train",
                    "output_dir": "./output",
                    "logging_dir": "./logs",
                    "output_name": "local_lora",
                    "resolution": "1024,1024",
                    "network_module": "networks.lora_anima",
                    "network_dim": 16,
                    "network_alpha": 16,
                    "optimizer_type": "AdamW8bit",
                    "learning_rate": "1e-4",
                }
            )
            self.assertEqual(adapted["pretrained_model_name_or_path"], "./models/anima-base-v1.0.safetensors")
            self.assertEqual(adapted["vae"], "./models/qwen_image_vae.safetensors")
            self.assertEqual(adapted["qwen3"], "./models/qwen_3_06b_base.safetensors")
            self.assertEqual(adapted["train_data_dir"], "./train")
            self.assertEqual(adapted["output_dir"], "./output")
            self.assertEqual(adapted["logging_dir"], "./logs")

            krea_form = _krea2_default_form()
            self.assertEqual(validate_krea2_config(krea_form), [])
            self.assertEqual(krea_form["dit"], "./models/krea2_raw_bf16.safetensors")
            self.assertEqual(krea_form["train_data_dir"], "./train")
            self.assertEqual(krea2_auto_cache_dir("./train"), str(Path("./train") / ".krea2-cache"))

    def test_krea2_cache_files_handles_relative_logical_paths_when_cwd_differs_from_repo_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_repo = Path(temp_dir) / "repo"
            other_cwd = Path(temp_dir) / "elsewhere"
            other_cwd.mkdir()
            train_dir = fake_repo / "train"
            cache_dir = train_dir / ".krea2-cache"
            cache_dir.mkdir(parents=True)
            _write_png(train_dir / "sample.png")
            (train_dir / "sample.txt").write_text("caption", encoding="utf-8")
            latent = cache_dir / "sample_1024x1024_kr2.safetensors"
            text = cache_dir / "sample_kr2_te.safetensors"
            latent.write_bytes(b"latent")
            text.write_bytes(b"text")

            saved_cwd = os.getcwd()
            try:
                os.chdir(other_cwd)
                with patch.object(constants, "REPO_ROOT", fake_repo), storage_env():
                    latents, texts = krea2_cache_files(
                        {"train_data_dir": "./train", "dataset_cache_dir": "./train/.krea2-cache"}
                    )
                    self.assertEqual(latents, {latent.resolve()})
                    self.assertEqual(texts, {text.resolve()})
            finally:
                os.chdir(saved_cwd)


if __name__ == "__main__":
    unittest.main()
