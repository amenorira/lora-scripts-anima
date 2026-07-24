"""Krea 2 profile codec, cache contract, and runtime preflight.

Krea 2 is intentionally kept outside the sd-scripts adapter. Its dataset TOML,
two-stage cache, model arguments, and attention flags are musubi-tuner
semantics and must never inherit sd-scripts-only values.
"""
from __future__ import annotations

import ast
import hashlib
import importlib.metadata
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from backend.training.core_registry import MUSUBI_TUNER_DIR
from backend.training.musubi_runtime import MUSUBI_RUNTIME_PACKAGES, shared_runtime_status


KREA2_TRAINER_FILE = "./vendor/musubi-tuner/krea2_train_network.py"
KREA2_CACHE_RUNNER_FILE = "./backend/training/krea2_cache_runner.py"
KREA2_PROFILE_ID = "krea2-lora"
KREA2_NETWORK_MODULE = "networks.lora_krea2"
KREA2_AUTO_CACHE_DIR_NAME = ".krea2-cache"
KREA2_CACHE_MANIFEST_NAME = ".krea2-cache.json"
_LEGACY_KREA2_CACHE_MANIFEST_NAMES = (".anima-krea2-cache.json",)

_IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
_ATTENTION_FLAGS = {
    "sdpa": "sdpa",
    "flash_attn": "flash_attn",
    "sage_attn": "sage_attn",
    "xformers": "xformers",
}
_KREA2_TRAINING_DURATIONS = {"epochs", "steps"}
_KREA2_LR_SCHEDULERS = {
    "constant",
    "constant_with_warmup",
    "linear",
    "cosine",
    "cosine_with_restarts",
    "polynomial",
    "inverse_sqrt",
    "cosine_with_min_lr",
    "warmup_stable_decay",
    # Kept for old saved presets.  musubi selects this internally for
    # AdaFactor relative-step mode; it is deliberately not offered as a
    # general UI scheduler.
    "adafactor",
    "rex",
}
_KREA2_COMPILE_MODES = {"default", "reduce-overhead", "max-autotune", "max-autotune-no-cudagraphs"}
_KREA2_COMPILE_DYNAMIC_VALUES = {"auto", "true", "false"}
_KREA2_PRODIGYPLUS_OPTIMIZER = "prodigyplus.ProdigyPlusScheduleFree"
# musubi recognizes optimizer classes ending in ``ScheduleFree`` and supplies
# its own no-op scheduler for them.  That does *not* mean each such class
# accepts AdamWScheduleFree's ``warmup_steps`` constructor argument.
_KREA2_INTERNAL_SCHEDULER_OPTIMIZERS = frozenset(
    {"schedulefree.AdamWScheduleFree", _KREA2_PRODIGYPLUS_OPTIMIZER}
)
_KREA2_SCHEDULEFREE_WARMUP_OPTIMIZERS = frozenset({"schedulefree.AdamWScheduleFree"})
_KREA2_PRODIGY_OPTIMIZERS = frozenset({"prodigyopt.Prodigy", _KREA2_PRODIGYPLUS_OPTIMIZER})
_KREA2_BETA_LENGTHS: dict[str, set[int]] = {
    "adamw8bit": {2},
    "AdamW": {2},
    "bitsandbytes.optim.PagedAdamW8bit": {2},
    "bitsandbytes.optim.AdEMAMix8bit": {3},
    "bitsandbytes.optim.PagedAdEMAMix8bit": {3},
    "bitsandbytes.optim.Lion8bit": {2},
    "bitsandbytes.optim.PagedLion8bit": {2},
    "pytorch_optimizer.CAME": {3},
    "pytorch_optimizer.Lion": {2},
    "prodigyopt.Prodigy": {2},
    _KREA2_PRODIGYPLUS_OPTIMIZER: {2},
    "schedulefree.AdamWScheduleFree": {2},
    "torch.optim.Adam": {2},
    "torch.optim.RAdam": {2},
    "torch.optim.NAdam": {2},
}
_KREA2_BETA_OPTIMIZERS = set(_KREA2_BETA_LENGTHS)
_KREA2_EPS_OPTIMIZERS = {
    "adamw8bit",
    "AdamW",
    "bitsandbytes.optim.PagedAdamW8bit",
    "bitsandbytes.optim.AdEMAMix8bit",
    "bitsandbytes.optim.PagedAdEMAMix8bit",
    "prodigyopt.Prodigy",
    _KREA2_PRODIGYPLUS_OPTIMIZER,
    "schedulefree.AdamWScheduleFree",
    "torch.optim.Adam",
    "torch.optim.RAdam",
    "torch.optim.NAdam",
}
_KREA2_MIN_LR_RATIO_SCHEDULERS = {"cosine_with_min_lr", "warmup_stable_decay", "rex"}
_KREA2_NUM_CYCLES_SCHEDULERS = {"cosine_with_restarts", "cosine_with_min_lr", "warmup_stable_decay"}
_KREA2_LEGACY_OPTIMIZER_ALIASES = {
    # These bare values were valid selectors in the sd-scripts form, but
    # musubi resolves non-dotted names from torch.optim.  Translate only the
    # known values to their real musubi-importable class paths.
    "pagedadamw8bit": "bitsandbytes.optim.PagedAdamW8bit",
    "lion": "pytorch_optimizer.Lion",
    "lion8bit": "bitsandbytes.optim.Lion8bit",
    "pagedlion8bit": "bitsandbytes.optim.PagedLion8bit",
    "prodigy": "prodigyopt.Prodigy",
    "prodigyplus": _KREA2_PRODIGYPLUS_OPTIMIZER,
    "prodigyplusschedulefree": _KREA2_PRODIGYPLUS_OPTIMIZER,
    "adamwschedulefree": "schedulefree.AdamWScheduleFree",
    "came": "pytorch_optimizer.CAME",
}
_KREA2_VISIBLE_OPTIMIZERS = frozenset(
    {
        "adamw8bit",
        "AdamW",
        "AdaFactor",
        "bitsandbytes.optim.PagedAdamW8bit",
        "bitsandbytes.optim.Lion8bit",
        "bitsandbytes.optim.PagedLion8bit",
        "bitsandbytes.optim.AdEMAMix8bit",
        "bitsandbytes.optim.PagedAdEMAMix8bit",
        "pytorch_optimizer.CAME",
        "pytorch_optimizer.Lion",
        "prodigyopt.Prodigy",
        _KREA2_PRODIGYPLUS_OPTIMIZER,
        "schedulefree.AdamWScheduleFree",
    }
)
# These generic torch optimizers were visible in the first Krea 2 release.
# Keep them launch-compatible for saved presets, but do not offer new tasks a
# half-configured SGD/Adam-family surface in the curated selector.
_KREA2_HIDDEN_LEGACY_OPTIMIZERS = frozenset(
    {"torch.optim.Adam", "torch.optim.RAdam", "torch.optim.NAdam", "torch.optim.SGD"}
)
_KREA2_CURATED_OPTIMIZERS = _KREA2_VISIBLE_OPTIMIZERS | _KREA2_HIDDEN_LEGACY_OPTIMIZERS
_KREA2_OPTIONAL_OPTIMIZER_PACKAGES = {
    "pytorch_optimizer.": "pytorch-optimizer",
    "prodigyopt.": "prodigyopt",
    "prodigyplus.": "prodigy-plus-schedule-free",
    "schedulefree.": "schedulefree",
}
# Compatibility alias for integrations which imported the previous private
# constant. The authoritative contract now lives in musubi_runtime and is
# shared by launchers, the Environment tab, and Krea preflight.
_MUSUBI_RUNTIME_PACKAGES = MUSUBI_RUNTIME_PACKAGES


# Kept separate from the legacy FIELDS registry. field_registry.get_fields_json
# merges these definitions for the frontend, while the sd-scripts adapter only
# sees legacy fields.
KREA2_FIELDS: list[dict[str, Any]] = [
    {
        "key": "dit",
        "type": "text",
        "default": "./models/krea2_raw_fp8_scaled.safetensors",
        "section": "model",
        "desc_key": "field.krea_dit",
        "hint_key": "field.krea_ditHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "vae",
        "type": "text",
        "default": "./models/qwen_image_vae.safetensors",
        "section": "model",
        "desc_key": "field.krea_vae",
        "hint_key": "field.krea_vaeHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "text_encoder",
        "type": "text",
        "default": "./models/qwen3vl_4b_fp8_scaled.safetensors",
        "section": "model",
        "desc_key": "field.krea_text_encoder",
        "hint_key": "field.krea_text_encoderHint",
        "role": "file-model",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "train_data_dir",
        "type": "text",
        "default": "./train",
        "section": "model",
        "desc_key": "field.train_data_dir",
        "role": "file-folder",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "dataset_cache_dir",
        "type": "text",
        "default": "./train/.krea2-cache",
        "section": "model",
        "desc_key": "field.krea_dataset_cache_dir",
        "hint_key": "field.krea_dataset_cache_dirHint",
        "role": "file-folder",
        "required": True,
        "readonly": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "caption_extension",
        "type": "text",
        "default": ".txt",
        "section": "model",
        "desc_key": "field.krea_caption_extension",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "resolution",
        "type": "text",
        "default": "1024,1024",
        "section": "model",
        "desc_key": "field.resolution",
        "hint_key": "field.krea_resolutionHint",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "enable_bucket",
        "type": "toggle",
        "default": True,
        "section": "model",
        "desc_key": "field.enable_bucket",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "bucket_no_upscale",
        "type": "toggle",
        "default": True,
        "section": "model",
        "desc_key": "field.bucket_no_upscale",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_num_repeats",
        "type": "number",
        "default": 1,
        "section": "model",
        "desc_key": "field.krea_num_repeats",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_module",
        "type": "select",
        "default": KREA2_NETWORK_MODULE,
        "section": "network",
        "desc_key": "field.network_module",
        "options": [{"v": KREA2_NETWORK_MODULE, "l": KREA2_NETWORK_MODULE}],
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_dim",
        "type": "number",
        "default": 32,
        "section": "network",
        "desc_key": "field.network_dim",
        "min": 1,
        "max": 256,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_alpha",
        "type": "number",
        "default": 32,
        "section": "network",
        "desc_key": "field.network_alpha",
        "min": 1,
        "max": 256,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_dropout",
        "type": "number",
        "default": 0,
        "section": "network",
        "desc_key": "field.network_dropout",
        "min": 0,
        "max": 0.5,
        "step": 0.01,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "network_args_custom",
        "type": "textarea",
        "default": "",
        "section": "network",
        "desc_key": "field.krea_network_args",
        "hint_key": "field.krea_network_argsHint",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_training_duration_mode",
        "type": "select",
        "default": "epochs",
        "section": "training",
        "desc_key": "field.krea_training_duration_mode",
        "options": [
            {"v": "epochs", "l": "epochs"},
            {"v": "steps", "l": "steps"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_train_epochs",
        "type": "number",
        "default": 16,
        "section": "training",
        "desc_key": "field.max_train_epochs",
        "min": 1,
        "step": 1,
        "show_if": {"key": "krea_training_duration_mode", "eq": "epochs"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_train_steps",
        "type": "number",
        "default": 1600,
        "section": "training",
        "desc_key": "field.krea_max_train_steps",
        "min": 1,
        "step": 1,
        "show_if": {"key": "krea_training_duration_mode", "eq": "steps"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "train_batch_size",
        "type": "number",
        "default": 1,
        "section": "training",
        "desc_key": "field.train_batch_size",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "gradient_accumulation_steps",
        "type": "number",
        "default": 1,
        "section": "training",
        "desc_key": "field.gradient_accumulation_steps",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "gradient_checkpointing",
        "type": "toggle",
        "default": True,
        "section": "training",
        "desc_key": "field.gradient_checkpointing",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "gradient_checkpointing_cpu_offload",
        "type": "toggle",
        "default": False,
        "section": "training",
        "desc_key": "field.krea_gradient_checkpointing_cpu_offload",
        "hint_key": "field.krea_gradient_checkpointing_cpu_offloadHint",
        "show_if": {"key": "gradient_checkpointing", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "learning_rate",
        "type": "text",
        "default": "1e-4",
        "section": "optimizer",
        "desc_key": "field.learning_rate",
        "required": True,
        # These are constructor defaults/recommendations from the concrete
        # classes installed in the shared runtime.  They apply only while the
        # user has not supplied a different learning rate.
        "auto_value": [
            {"watch": "optimizer_type", "when": "bitsandbytes.optim.Lion8bit", "set": "1e-4", "set_if_default": True},
            {"watch": "optimizer_type", "when": "bitsandbytes.optim.PagedLion8bit", "set": "1e-4", "set_if_default": True},
            {"watch": "optimizer_type", "when": "pytorch_optimizer.Lion", "set": "1e-4", "set_if_default": True},
            {"watch": "optimizer_type", "when": "pytorch_optimizer.CAME", "set": "2e-4", "set_if_default": True},
            {"watch": "optimizer_type", "when": "prodigyopt.Prodigy", "set": "1.0", "set_if_default": True},
            {"watch": "optimizer_type", "when": _KREA2_PRODIGYPLUS_OPTIMIZER, "set": "1.0", "set_if_default": True},
            {"watch": "optimizer_type", "when": "schedulefree.AdamWScheduleFree", "set": "0.0025", "set_if_default": True},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "seed",
        "type": "number",
        "default": 42,
        "section": "training",
        "desc_key": "field.seed",
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "mixed_precision",
        "type": "select",
        "default": "bf16",
        "section": "training",
        "desc_key": "field.mixed_precision",
        "options": [
            {"v": "bf16", "l": "bf16"},
            {"v": "fp16", "l": "fp16"},
            {"v": "no", "l": "no"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "timestep_sampling",
        "type": "select",
        "default": "shift",
        "section": "training",
        "desc_key": "field.krea_timestep_sampling",
        "options": [
            {"v": "uniform", "l": "uniform"},
            {"v": "sigmoid", "l": "sigmoid"},
            {"v": "sigma", "l": "sigma"},
            {"v": "shift", "l": "shift"},
            {"v": "krea2_shift", "l": "krea2_shift"},
            {"v": "logsnr", "l": "logsnr"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "discrete_flow_shift",
        "type": "number",
        "default": 2.5,
        "section": "training",
        "desc_key": "field.discrete_flow_shift",
        "min": 0.01,
        "step": 0.01,
        "show_if": {"key": "timestep_sampling", "eq": "shift", "_or": ["sigma"]},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "sigmoid_scale",
        "type": "number",
        "default": 1.0,
        "step": 0.001,
        "section": "training",
        "desc_key": "field.sigmoid_scale",
        "show_if": {"key": "timestep_sampling", "eq": "sigmoid", "_or": ["shift", "krea2_shift"]},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "weighting_scheme",
        "type": "select",
        "default": "none",
        "section": "training",
        "desc_key": "field.krea_weighting_scheme",
        "options": [
            {"v": "none", "l": "none"},
            {"v": "sigma_sqrt", "l": "sigma_sqrt"},
            {"v": "cosmap", "l": "cosmap"},
            {"v": "logit_normal", "l": "logit_normal"},
            {"v": "mode", "l": "mode"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "logit_mean",
        "type": "number",
        "default": 0.0,
        "step": 0.01,
        "section": "training",
        "desc_key": "field.logit_mean",
        "show_if": {"key": "timestep_sampling", "eq": "sigma", "_or": ["logsnr"]},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "logit_std",
        "type": "number",
        "default": 1.0,
        "step": 0.01,
        "section": "training",
        "desc_key": "field.logit_std",
        "show_if": {"key": "timestep_sampling", "eq": "sigma", "_or": ["logsnr"]},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "mode_scale",
        "type": "number",
        "default": 1.29,
        "step": 0.01,
        "section": "training",
        "desc_key": "field.mode_scale",
        "show_if": {"key": "timestep_sampling", "eq": "sigma"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "optimizer_type",
        "type": "select",
        "default": "adamw8bit",
        "section": "optimizer",
        "desc_key": "field.optimizer_type",
        # parser_common.py documents the first three short names, while
        # trainer_base.py can technically import arbitrary optimizer classes.
        # Deliberately expose only the audited shared-runtime allowlist: an
        # unsupported optimizer can otherwise fail after the expensive cache
        # and model-load stages.  The base group is intentionally small; less
        # common but validated variants live under Advanced.
        "groups": [
            {
                "label_key": "opt.krea_optimizer_group_recommended",
                "options": [
                    {"v": "adamw8bit", "l": "AdamW 8-bit", "dk": "opt.krea_optimizer_adamw8bit"},
                    {"v": "AdamW", "l": "AdamW", "dk": "opt.krea_optimizer_adamw"},
                    {"v": "AdaFactor", "l": "AdaFactor", "dk": "opt.krea_optimizer_adafactor"},
                    {
                        "v": "bitsandbytes.optim.PagedAdamW8bit",
                        "l": "PagedAdamW8bit",
                        "dk": "opt.krea_optimizer_paged_adamw8bit",
                    },
                    {
                        "v": "bitsandbytes.optim.Lion8bit",
                        "l": "Lion8bit",
                        "dk": "opt.krea_optimizer_lion8bit",
                    },
                    {"v": "pytorch_optimizer.CAME", "l": "CAME", "dk": "opt.krea_optimizer_came"},
                    {"v": "prodigyopt.Prodigy", "l": "Prodigy", "dk": "opt.krea_optimizer_prodigy"},
                    {
                        "v": _KREA2_PRODIGYPLUS_OPTIMIZER,
                        "l": "ProdigyPlusScheduleFree",
                        "dk": "opt.krea_optimizer_prodigyplus",
                    },
                    {
                        "v": "schedulefree.AdamWScheduleFree",
                        "l": "AdamWScheduleFree",
                        "dk": "opt.krea_optimizer_schedulefree",
                    },
                ],
            },
            {
                "label_key": "opt.krea_optimizer_group_advanced",
                "options": [
                    {
                        "v": "bitsandbytes.optim.PagedLion8bit",
                        "l": "PagedLion8bit",
                        "dk": "opt.krea_optimizer_paged_lion8bit",
                    },
                    {"v": "pytorch_optimizer.Lion", "l": "Lion", "dk": "opt.krea_optimizer_lion"},
                    {
                        "v": "bitsandbytes.optim.AdEMAMix8bit",
                        "l": "AdEMAMix8bit",
                        "dk": "opt.krea_optimizer_ademamix8bit",
                    },
                    {
                        "v": "bitsandbytes.optim.PagedAdEMAMix8bit",
                        "l": "PagedAdEMAMix8bit",
                        "dk": "opt.krea_optimizer_paged_ademamix8bit",
                    },
                ],
            },
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_grad_norm",
        "type": "number",
        "default": 1.0,
        "section": "optimizer",
        "desc_key": "field.max_grad_norm",
        "min": 0,
        "step": 0.1,
        "auto_value": [
            {
                "watch": {"optimizer_type": _KREA2_PRODIGYPLUS_OPTIMIZER, "krea_prodigyplus_use_stableadamw": True},
                "set": 0,
            }
        ],
        "readonly_if_any": [
            [
                {"key": "optimizer_type", "eq": _KREA2_PRODIGYPLUS_OPTIMIZER},
                {"key": "krea_prodigyplus_use_stableadamw", "eq": True},
            ]
        ],
        "readonly_reason_key": "field.max_grad_norm_optimizerLocked",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_scheduler",
        "type": "select",
        "default": "constant",
        "section": "optimizer",
        "desc_key": "field.lr_scheduler",
        "options": [
            {"v": "constant", "l": "constant"},
            {"v": "constant_with_warmup", "l": "constant_with_warmup"},
            {"v": "linear", "l": "linear"},
            {"v": "cosine", "l": "cosine"},
            {"v": "cosine_with_restarts", "l": "cosine_with_restarts"},
            {"v": "polynomial", "l": "polynomial"},
            {"v": "inverse_sqrt", "l": "inverse_sqrt"},
            {"v": "cosine_with_min_lr", "l": "cosine_with_min_lr"},
            {"v": "warmup_stable_decay", "l": "warmup_stable_decay"},
            {"v": "rex", "l": "rex"},
        ],
        "auto_value": [
            {"watch": "optimizer_type", "when": "schedulefree.AdamWScheduleFree", "set": "constant"},
            {"watch": "optimizer_type", "when": _KREA2_PRODIGYPLUS_OPTIMIZER, "set": "constant"},
            {
                "watch": {"optimizer_type": "AdaFactor", "krea_adafactor_relative_step": True},
                "set": "constant",
            },
        ],
        "readonly_if_any": [
            {"key": "optimizer_type", "eq": "schedulefree.AdamWScheduleFree"},
            {"key": "optimizer_type", "eq": _KREA2_PRODIGYPLUS_OPTIMIZER},
            [
                {"key": "optimizer_type", "eq": "AdaFactor"},
                {"key": "krea_adafactor_relative_step", "eq": True},
            ],
        ],
        "readonly_reason_key": "field.krea_lr_scheduler_internalLocked",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_warmup_steps",
        "type": "text",
        "default": "0",
        "section": "optimizer",
        "desc_key": "field.lr_warmup_steps",
        "hint_key": "field.krea_ratio_or_stepsHint",
        "show_if": {"key": "lr_scheduler", "neq": "constant"},
        "auto_value": [
            {"watch": "optimizer_type", "when": "schedulefree.AdamWScheduleFree", "set": 0},
            {"watch": "optimizer_type", "when": _KREA2_PRODIGYPLUS_OPTIMIZER, "set": 0},
            {
                "watch": {"optimizer_type": "AdaFactor", "krea_adafactor_relative_step": True},
                "set": 0,
            },
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_decay_steps",
        "type": "text",
        "default": "0",
        "section": "optimizer",
        "desc_key": "field.krea_lr_decay_steps",
        "hint_key": "field.krea_ratio_or_stepsHint",
        "show_if": {"key": "lr_scheduler", "eq": "warmup_stable_decay"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_scheduler_num_cycles",
        "type": "number",
        "default": 1,
        "section": "optimizer",
        "desc_key": "field.lr_scheduler_num_cycles",
        "min": 1,
        "step": 1,
        "show_if": {
            "key": "lr_scheduler",
            "eq": "cosine_with_restarts",
            "_or": ["cosine_with_min_lr", "warmup_stable_decay"],
        },
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_scheduler_power",
        "type": "number",
        "default": 1.0,
        "section": "optimizer",
        "desc_key": "field.lr_scheduler_power",
        "min": 0.01,
        "step": 0.1,
        "show_if": {"key": "lr_scheduler", "eq": "polynomial"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_scheduler_timescale",
        "type": "number",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_lr_scheduler_timescale",
        "hint_key": "field.krea_lr_scheduler_timescaleHint",
        "min": 1,
        "step": 1,
        "show_if": {"key": "lr_scheduler", "eq": "inverse_sqrt"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "lr_scheduler_min_lr_ratio",
        "type": "number",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_lr_scheduler_min_lr_ratio",
        "hint_key": "field.krea_lr_scheduler_min_lr_ratioHint",
        "min": 0,
        "max": 1,
        "step": 0.001,
        "show_if": {
            "key": "lr_scheduler",
            "eq": "cosine_with_min_lr",
            "_or": ["warmup_stable_decay", "rex"],
        },
        # transformers requires an explicit floor for cosine_with_min_lr.
        # Keep the normal cosine behavior (0) as the first-use default while
        # preserving a user-entered floor across scheduler changes.
        "auto_value": [
            {"watch": "lr_scheduler", "when": "cosine_with_min_lr", "set": 0.0, "set_if_default": True}
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_optimizer_weight_decay",
        "type": "number",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_optimizer_weight_decay",
        "hint_key": "field.krea_optimizer_weight_decayHint",
        "min": 0,
        "step": 0.001,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_optimizer_betas",
        "type": "text",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_optimizer_betas",
        "hint_key": "field.krea_optimizer_betasHint",
        "show_if": {
            "key": "optimizer_type",
            "eq": "adamw8bit",
            "_or": [
                "AdamW",
                "bitsandbytes.optim.PagedAdamW8bit",
                "bitsandbytes.optim.AdEMAMix8bit",
                "bitsandbytes.optim.PagedAdEMAMix8bit",
                "bitsandbytes.optim.Lion8bit",
                "bitsandbytes.optim.PagedLion8bit",
                "pytorch_optimizer.CAME",
                "pytorch_optimizer.Lion",
                "prodigyopt.Prodigy",
                _KREA2_PRODIGYPLUS_OPTIMIZER,
                "schedulefree.AdamWScheduleFree",
                "torch.optim.Adam",
                "torch.optim.RAdam",
                "torch.optim.NAdam",
            ],
        },
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_optimizer_eps",
        "type": "text",
        "default": "",
        "section": "optimizer",
        "desc_key": "field.krea_optimizer_eps",
        "hint_key": "field.krea_optimizer_epsHint",
        "show_if": {
            "key": "optimizer_type",
            "eq": "adamw8bit",
            "_or": [
                "AdamW",
                "bitsandbytes.optim.PagedAdamW8bit",
                "bitsandbytes.optim.AdEMAMix8bit",
                "bitsandbytes.optim.PagedAdEMAMix8bit",
                "prodigyopt.Prodigy",
                _KREA2_PRODIGYPLUS_OPTIMIZER,
                "schedulefree.AdamWScheduleFree",
                "torch.optim.Adam",
                "torch.optim.RAdam",
                "torch.optim.NAdam",
            ],
        },
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_prodigy_d_coef",
        "type": "text",
        "default": "1.0",
        "section": "optimizer",
        "desc_key": "field.krea_prodigy_d_coef",
        "show_if": {
            "key": "optimizer_type",
            "eq": "prodigyopt.Prodigy",
            "_or": [_KREA2_PRODIGYPLUS_OPTIMIZER],
        },
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_prodigy_d0",
        "type": "text",
        "default": "1e-6",
        "section": "optimizer",
        "desc_key": "field.krea_prodigy_d0",
        "show_if": {
            "key": "optimizer_type",
            "eq": "prodigyopt.Prodigy",
            "_or": [_KREA2_PRODIGYPLUS_OPTIMIZER],
        },
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_prodigyplus_use_stableadamw",
        "type": "toggle",
        "default": True,
        "section": "optimizer",
        "desc_key": "field.prodigyplus_use_stableadamw",
        "hint_key": "field.prodigyplus_use_stableadamwHint",
        "show_if": {"key": "optimizer_type", "eq": _KREA2_PRODIGYPLUS_OPTIMIZER},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_schedulefree_warmup_steps",
        "type": "number",
        "default": 0,
        "section": "optimizer",
        "desc_key": "field.krea_schedulefree_warmup_steps",
        "hint_key": "field.krea_schedulefree_warmup_stepsHint",
        "min": 0,
        "step": 1,
        "show_if": {"key": "optimizer_type", "eq": "schedulefree.AdamWScheduleFree"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_adafactor_relative_step",
        "type": "toggle",
        "default": True,
        "section": "optimizer",
        "desc_key": "field.krea_adafactor_relative_step",
        "hint_key": "field.krea_adafactor_relative_stepHint",
        "show_if": {"key": "optimizer_type", "eq": "AdaFactor"},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_adafactor_scale_parameter",
        "type": "toggle",
        "default": True,
        "section": "optimizer",
        "desc_key": "field.krea_adafactor_scale_parameter",
        "show_if": {"key": "optimizer_type", "eq": "AdaFactor"},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_adafactor_warmup_init",
        "type": "toggle",
        "default": False,
        "section": "optimizer",
        "desc_key": "field.krea_adafactor_warmup_init",
        "hint_key": "field.krea_adafactor_warmup_initHint",
        "show_if": [
            {"key": "optimizer_type", "eq": "AdaFactor"},
            {"key": "krea_adafactor_relative_step", "eq": True},
        ],
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_adafactor_clip_threshold",
        "type": "number",
        "default": 1.0,
        "section": "optimizer",
        "desc_key": "field.krea_adafactor_clip_threshold",
        "min": 0.00000001,
        "step": 0.1,
        "show_if": {"key": "optimizer_type", "eq": "AdaFactor"},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_adafactor_eps",
        "type": "text",
        "default": "1e-30, 1e-3",
        "section": "optimizer",
        "desc_key": "field.krea_adafactor_eps",
        "hint_key": "field.krea_adafactor_epsHint",
        "show_if": {"key": "optimizer_type", "eq": "AdaFactor"},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_attention_backend",
        "type": "select",
        "default": "sdpa",
        "section": "performance",
        "desc_key": "field.krea_attention_backend",
        "options": [
            {"v": "sdpa", "l": "SDPA"},
            {"v": "flash_attn", "l": "FlashAttention"},
            {"v": "sage_attn", "l": "SageAttention"},
            {"v": "xformers", "l": "xFormers"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "blocks_to_swap",
        "type": "number",
        "default": 0,
        "section": "performance",
        "desc_key": "field.krea_blocks_to_swap",
        "min": 0,
        "max": 26,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "use_pinned_memory_for_block_swap",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_use_pinned_memory_for_block_swap",
        "hint_key": "field.krea_use_pinned_memory_for_block_swapHint",
        "show_if": {"key": "blocks_to_swap", "neq": 0},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "block_swap_h2d_only",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_block_swap_h2d_only",
        "hint_key": "field.krea_block_swap_h2d_onlyHint",
        "show_if": {"key": "blocks_to_swap", "neq": 0},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "block_swap_ring_size",
        "type": "number",
        "default": 2,
        "section": "performance",
        "desc_key": "field.krea_block_swap_ring_size",
        "min": 1,
        "step": 1,
        "show_if": [
            {"key": "blocks_to_swap", "neq": 0},
            {"key": "block_swap_h2d_only", "eq": True},
        ],
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "fp8_base",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_fp8_base",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "fp8_scaled",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.krea_fp8_scaled",
        "show_if": {"key": "fp8_base", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.compile",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile_backend",
        "type": "select",
        "default": "inductor",
        "section": "performance",
        "desc_key": "field.compile_backend",
        "show_if": {"key": "compile", "eq": True},
        "advanced": True,
        "options": [
            {"v": "inductor", "l": "inductor"},
            {"v": "eager", "l": "eager"},
            {"v": "cudagraphs", "l": "cudagraphs"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile_mode",
        "type": "select",
        "default": "default",
        "section": "performance",
        "desc_key": "field.compile_mode",
        "show_if": {"key": "compile", "eq": True},
        "advanced": True,
        "options": [
            {"v": "default", "l": "default"},
            {"v": "reduce-overhead", "l": "reduce-overhead"},
            {"v": "max-autotune", "l": "max-autotune"},
            {"v": "max-autotune-no-cudagraphs", "l": "max-autotune-no-cudagraphs"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile_dynamic",
        "type": "select",
        "default": "auto",
        "section": "performance",
        "desc_key": "field.compile_dynamic",
        "show_if": {"key": "compile", "eq": True},
        "advanced": True,
        "options": [
            {"v": "auto", "l": "auto"},
            {"v": "true", "l": "true"},
            {"v": "false", "l": "false"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile_fullgraph",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.compile_fullgraph",
        "show_if": {"key": "compile", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "compile_cache_size_limit",
        "type": "number",
        "default": "",
        "section": "performance",
        "desc_key": "field.compile_cache_size_limit",
        "min": 1,
        "step": 1,
        "show_if": {"key": "compile", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "persistent_data_loader_workers",
        "type": "toggle",
        "default": True,
        "section": "performance",
        "desc_key": "field.persistent_data_loader_workers",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "max_data_loader_n_workers",
        "type": "number",
        "default": 2,
        "section": "performance",
        "desc_key": "field.max_data_loader_n_workers",
        "min": 0,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "cuda_allow_tf32",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.cuda_allow_tf32",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "cuda_cudnn_benchmark",
        "type": "toggle",
        "default": False,
        "section": "performance",
        "desc_key": "field.cuda_cudnn_benchmark",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "text_cache_batch_size",
        "type": "number",
        "default": 1,
        "section": "performance",
        "desc_key": "field.krea_text_cache_batch_size",
        "min": 1,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "output_name",
        "type": "text",
        "default": "krea2_lora",
        "section": "save",
        "desc_key": "field.output_name",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "output_dir",
        "type": "text",
        "default": "./output",
        "section": "save",
        "desc_key": "field.output_dir",
        "role": "file-folder",
        "required": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_model_as",
        "type": "select",
        "default": "safetensors",
        "section": "save",
        "desc_key": "field.save_model_as",
        "options": [{"v": "safetensors", "l": "safetensors"}],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_precision",
        "type": "select",
        "default": "bf16",
        "section": "save",
        "desc_key": "field.save_precision",
        "options": [
            {"v": "bf16", "l": "bf16"},
            {"v": "fp16", "l": "fp16"},
            {"v": "float", "l": "float"},
        ],
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_every_n_epochs",
        "type": "number",
        "default": 1,
        "section": "save",
        "desc_key": "field.save_every_n_epochs",
        "min": 1,
        "step": 1,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_every_n_steps",
        "type": "number",
        "default": "",
        "section": "save",
        "desc_key": "field.save_every_n_steps",
        "min": 1,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_last_n_epochs",
        "type": "number",
        "default": "",
        "section": "save",
        "desc_key": "field.save_last_n_epochs",
        "min": 1,
        "step": 1,
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_state",
        "type": "toggle",
        "default": False,
        "section": "save",
        "desc_key": "field.save_state",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_last_n_epochs_state",
        "type": "number",
        "default": "",
        "section": "save",
        "desc_key": "field.save_last_n_epochs_state",
        "min": 1,
        "step": 1,
        "show_if": {"key": "save_state", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "save_state_on_train_end",
        "type": "toggle",
        "default": False,
        "section": "save",
        "desc_key": "field.save_state_on_train_end",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "resume",
        "type": "text",
        "default": "",
        "section": "save",
        "desc_key": "field.resume",
        "role": "file-folder",
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "enable_krea_samples",
        "type": "toggle",
        "default": False,
        "section": "preview",
        "desc_key": "field.enable_krea_samples",
        "hint_key": "field.enable_krea_samplesHint",
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "krea_sample_prompts",
        "type": "textarea",
        "default": "",
        "section": "preview",
        "desc_key": "field.krea_sample_prompts",
        "hint_key": "field.krea_sample_promptsHint",
        "show_if": {"key": "enable_krea_samples", "eq": True},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "sample_every_n_epochs",
        "type": "number",
        "default": 1,
        "section": "preview",
        "desc_key": "field.sample_every_n_epochs",
        "min": 1,
        "step": 1,
        "show_if": {"key": "enable_krea_samples", "eq": True},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "sample_every_n_steps",
        "type": "number",
        "default": "",
        "section": "preview",
        "desc_key": "field.sample_every_n_steps",
        "min": 1,
        "step": 1,
        "show_if": {"key": "enable_krea_samples", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "sample_at_first",
        "type": "toggle",
        "default": False,
        "section": "preview",
        "desc_key": "field.sample_at_first",
        "show_if": {"key": "enable_krea_samples", "eq": True},
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "turbo_dit",
        "type": "text",
        "default": "",
        "section": "preview",
        "desc_key": "field.krea_turbo_dit",
        "hint_key": "field.krea_turbo_ditHint",
        "role": "file-model",
        "show_if": {"key": "enable_krea_samples", "eq": True},
        "profiles": [KREA2_PROFILE_ID],
    },
    {
        "key": "turbo_dit_cache",
        "type": "toggle",
        "default": False,
        "section": "preview",
        "desc_key": "field.krea_turbo_dit_cache",
        "hint_key": "field.krea_turbo_dit_cacheHint",
        "show_if": [
            {"key": "enable_krea_samples", "eq": True},
            {"key": "turbo_dit", "neq": ""},
        ],
        "advanced": True,
        "profiles": [KREA2_PROFILE_ID],
    },
]


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def krea2_auto_cache_dir(train_data_dir: Any) -> str:
    """Return Krea's deterministic cache directory for one source dataset."""

    raw_path = str(train_data_dir or "").strip()
    return str(Path(raw_path) / KREA2_AUTO_CACHE_DIR_NAME) if raw_path else ""


def _as_int(config: dict[str, Any], key: str, errors: list[str], minimum: int = 0) -> int | None:
    value = config.get(key)
    try:
        number = int(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be an integer / 必须是整数")
        return None
    if isinstance(value, bool) or number < minimum:
        errors.append(f"{key}: must be >= {minimum} / 不能小于 {minimum}")
        return None
    config[key] = number
    return number


def _as_float(
    config: dict[str, Any], key: str, errors: list[str], minimum: float | None = None
) -> float | None:
    value = config.get(key)
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be a number / 必须是数字")
        return None
    if not math.isfinite(number) or (minimum is not None and number < minimum):
        suffix = f" >= {minimum}" if minimum is not None else " finite"
        errors.append(f"{key}: must be{suffix} / 数值无效")
        return None
    config[key] = number
    return number


def _as_steps_or_ratio(config: dict[str, Any], key: str, errors: list[str]) -> int | float | None:
    """Normalize musubi's integer-step or fractional-ratio scheduler values."""

    value = config.get(key)
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{key}: must be a non-negative step count or ratio / 必须是非负步数或比例")
        return None
    if not math.isfinite(number) or number < 0:
        errors.append(f"{key}: must be non-negative and finite / 必须是非负有限数")
        return None
    if number >= 1 and not number.is_integer():
        errors.append(f"{key}: values >= 1 must be whole steps / 大于等于 1 时必须是整数步数")
        return None
    normalized: int | float = int(number) if number >= 1 and number.is_integer() else number
    config[key] = normalized
    return normalized


def _has_krea2_sample_prompts(value: Any) -> bool:
    """Return whether a musubi prompt file would contain at least one prompt."""

    if not isinstance(value, str):
        return False
    return any(line.strip() and not line.lstrip().startswith("#") for line in value.splitlines())


def parse_krea2_resolution(value: Any) -> tuple[int, int]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        parts = value
    else:
        parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 2:
        raise ValueError("resolution must be width,height / 分辨率必须为 宽,高")
    try:
        width, height = (int(parts[0]), int(parts[1]))
    except (TypeError, ValueError) as exc:
        raise ValueError("resolution must contain two integers / 分辨率必须为两个整数") from exc
    if width < 16 or height < 16 or width % 16 or height % 16:
        raise ValueError("resolution must be positive multiples of 16 / 分辨率必须为 16 的正整数倍")
    return width, height


def _split_args(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, str):
        return []
    return [line.strip() for line in value.splitlines() if line.strip()]


def _normalize_numeric_literal(
    config: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    """Normalize an optional numeric Python literal used in optimizer args."""

    if _is_empty(config.get(key)):
        return None
    try:
        value = ast.literal_eval(str(config[key]).strip())
        number = float(value)
    except (SyntaxError, ValueError, TypeError):
        errors.append(f"{key}: must be a numeric Python literal / 必须是数字 Python 字面量")
        return None
    if not math.isfinite(number) or (minimum is not None and number < minimum) or (
        maximum is not None and number > maximum
    ):
        errors.append(f"{key}: value is out of range / 数值超出有效范围")
        return None
    config[key] = number
    return number


def _normalize_numeric_tuple(
    config: dict[str, Any],
    key: str,
    errors: list[str],
    *,
    lengths: set[int],
    minimum: float | None = None,
    maximum: float | None = None,
) -> tuple[float, ...] | None:
    """Normalize a comma-separated/tuple numeric literal for musubi kwargs."""

    if _is_empty(config.get(key)):
        return None
    try:
        value = ast.literal_eval(str(config[key]).strip())
    except (SyntaxError, ValueError):
        errors.append(f"{key}: must use comma-separated Python numbers / 必须使用逗号分隔的 Python 数字")
        return None
    if not isinstance(value, (tuple, list)) or len(value) not in lengths:
        expected = "/".join(str(length) for length in sorted(lengths))
        errors.append(f"{key}: requires {expected} values / 需要 {expected} 个数值")
        return None
    try:
        numbers = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        errors.append(f"{key}: values must be numeric / 每个值必须是数字")
        return None
    if any(
        not math.isfinite(number)
        or (minimum is not None and number < minimum)
        or (maximum is not None and number > maximum)
        for number in numbers
    ):
        errors.append(f"{key}: value is out of range / 数值超出有效范围")
        return None
    config[key] = numbers
    return numbers


def _replace_musubi_arg(arguments: list[str], key: str, literal: str) -> None:
    """Set a guided argument, overriding the same key from raw advanced text."""

    prefix = f"{key}="
    arguments[:] = [item for item in arguments if not item.lstrip().startswith(prefix)]
    arguments.append(f"{key}={literal}")


def _build_krea2_optimizer_args(config: dict[str, Any]) -> list[str]:
    """Build optimizer args only from the audited guided Krea controls."""

    arguments: list[str] = []
    optimizer_type = str(config.get("optimizer_type") or "adamw8bit")

    if not _is_empty(config.get("krea_optimizer_weight_decay")):
        _replace_musubi_arg(arguments, "weight_decay", repr(float(config["krea_optimizer_weight_decay"])))
    if optimizer_type in _KREA2_BETA_OPTIMIZERS and not _is_empty(config.get("krea_optimizer_betas")):
        _replace_musubi_arg(arguments, "betas", repr(tuple(config["krea_optimizer_betas"])))
    if optimizer_type in _KREA2_EPS_OPTIMIZERS and not _is_empty(config.get("krea_optimizer_eps")):
        _replace_musubi_arg(arguments, "eps", repr(float(config["krea_optimizer_eps"])))

    if optimizer_type in _KREA2_PRODIGY_OPTIMIZERS:
        _replace_musubi_arg(arguments, "d_coef", repr(float(config.get("krea_prodigy_d_coef", 1.0))))
        _replace_musubi_arg(arguments, "d0", repr(float(config.get("krea_prodigy_d0", 1e-6))))
        if optimizer_type == _KREA2_PRODIGYPLUS_OPTIMIZER:
            _replace_musubi_arg(
                arguments,
                "use_stableadamw",
                "True" if bool(config.get("krea_prodigyplus_use_stableadamw", True)) else "False",
            )
    elif optimizer_type == "AdaFactor":
        _replace_musubi_arg(
            arguments,
            "relative_step",
            "True" if bool(config.get("krea_adafactor_relative_step", True)) else "False",
        )
        _replace_musubi_arg(
            arguments,
            "scale_parameter",
            "True" if bool(config.get("krea_adafactor_scale_parameter", True)) else "False",
        )
        _replace_musubi_arg(
            arguments,
            "warmup_init",
            "True" if bool(config.get("krea_adafactor_warmup_init", False)) else "False",
        )
        _replace_musubi_arg(
            arguments,
            "clip_threshold",
            repr(float(config.get("krea_adafactor_clip_threshold", 1.0))),
        )
        _replace_musubi_arg(
            arguments,
            "eps",
            repr(tuple(config.get("krea_adafactor_eps", (1e-30, 1e-3)))),
        )
    elif optimizer_type in _KREA2_SCHEDULEFREE_WARMUP_OPTIMIZERS and int(
        config.get("krea_schedulefree_warmup_steps", 0)
    ):
        _replace_musubi_arg(arguments, "warmup_steps", str(int(config["krea_schedulefree_warmup_steps"])))

    return arguments


def _normalize_krea2_optimizer_type(config: dict[str, Any], errors: list[str]) -> str:
    """Resolve legacy aliases into an audited optimizer allowlist entry."""

    requested = str(config.get("optimizer_type") or "").strip()
    if not requested:
        errors.append("optimizer_type: required / 必填")
        return ""

    lowered = requested.lower()
    if lowered == "adamw8bit":
        requested = "adamw8bit"
    elif lowered == "adamw":
        requested = "AdamW"
    elif lowered == "adafactor":
        requested = "AdaFactor"
    elif lowered in _KREA2_LEGACY_OPTIMIZER_ALIASES:
        requested = _KREA2_LEGACY_OPTIMIZER_ALIASES[lowered]
    if requested not in _KREA2_CURATED_OPTIMIZERS:
        errors.append(
            "optimizer_type: only the built-in Krea 2 optimizer list is supported "
            "/ 当前仅支持内置的 Krea 2 优化器列表"
        )
        return ""

    config["optimizer_type"] = requested
    return requested


def _selected_optional_optimizer_package(optimizer_type: Any) -> str | None:
    """Return the distribution required by a curated non-musubi optimizer."""

    value = str(optimizer_type or "")
    return next(
        (package for prefix, package in _KREA2_OPTIONAL_OPTIMIZER_PACKAGES.items() if value.startswith(prefix)),
        None,
    )


def image_files(directory: str | Path, cache_dir: str | Path | None = None) -> list[Path]:
    root = Path(directory)
    if not root.is_dir():
        return []
    excluded = Path(cache_dir).resolve() if cache_dir else None
    paths: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in _IMAGE_EXTENSIONS:
            continue
        try:
            if excluded is not None and path.resolve().is_relative_to(excluded):
                continue
        except OSError:
            continue
        paths.append(path)
    return sorted(paths)


def _path_identity(path_value: Any) -> dict[str, Any]:
    path = Path(str(path_value or ""))
    try:
        stat = path.stat()
    except OSError:
        return {"path": str(path), "missing": True}
    return {"path": str(path.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def krea2_cache_fingerprint(config: dict[str, Any]) -> str:
    """Fingerprint inputs that make Krea latent or text caches stale."""

    cache_dir = config.get("dataset_cache_dir")
    root = Path(str(config.get("train_data_dir") or ""))
    entries: list[dict[str, Any]] = []
    for image in image_files(root, cache_dir):
        try:
            stat = image.stat()
        except OSError:
            continue
        caption = image.with_suffix(str(config.get("caption_extension") or ".txt"))
        item: dict[str, Any] = {
            "image": str(image.relative_to(root)).replace("\\", "/"),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
        try:
            caption_stat = caption.stat()
            item["caption"] = {
                "exists": True,
                "size": caption_stat.st_size,
                "mtime_ns": caption_stat.st_mtime_ns,
            }
        except OSError:
            item["caption"] = {"exists": False}
        entries.append(item)

    width, height = parse_krea2_resolution(config.get("resolution", "1024,1024"))
    payload = {
        "schema": 1,
        "dataset": entries,
        "resolution": [width, height],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_no_upscale": bool(config.get("bucket_no_upscale", True)),
        "caption_extension": str(config.get("caption_extension") or ".txt"),
        "vae": _path_identity(config.get("vae")),
        "text_encoder": _path_identity(config.get("text_encoder")),
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cache_manifest_path(cache_dir: str | Path) -> Path:
    return Path(cache_dir) / KREA2_CACHE_MANIFEST_NAME


def _read_cache_manifest(cache_dir: str | Path) -> tuple[dict[str, Any], Path]:
    """Read the current manifest first, with a one-way compatibility fallback.

    Earlier builds called the Krea-specific cache file ``.anima-krea2-cache``.
    That was only an application-owned filename, never an upstream model
    setting, but it incorrectly suggested an Anima/Krea relationship.  Keep
    old cache metadata readable so renaming it does not make users recache.
    """

    directory = Path(cache_dir)
    paths = (cache_manifest_path(directory),) + tuple(
        directory / name for name in _LEGACY_KREA2_CACHE_MANIFEST_NAMES
    )
    for path in paths:
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(manifest, dict):
            return manifest, path
    return {}, cache_manifest_path(directory)


def prepare_cache_manifest(config: dict[str, Any]) -> dict[str, Any]:
    """Persist a pending cache request before the worker process starts."""

    cache_dir = Path(str(config["dataset_cache_dir"]))
    cache_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": 1,
        "profile": KREA2_PROFILE_ID,
        "fingerprint": krea2_cache_fingerprint(config),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "stages": {"latents": "pending", "text_encoder": "pending"},
    }
    cache_manifest_path(cache_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def mark_cache_manifest(config: dict[str, Any], status: str) -> None:
    """Mark a full two-stage cache pipeline completed or failed."""

    path = cache_manifest_path(config["dataset_cache_dir"])
    manifest, _ = _read_cache_manifest(config["dataset_cache_dir"])
    if not manifest:
        manifest = prepare_cache_manifest(config)
    stage_state = "completed" if status == "completed" else "failed"
    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    manifest["stages"] = {"latents": stage_state, "text_encoder": stage_state}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def get_krea2_cache_status(config: dict[str, Any]) -> dict[str, Any]:
    """Inspect cache files and their fingerprint without importing musubi."""

    cache_dir = Path(str(config.get("dataset_cache_dir") or ""))
    images = image_files(config.get("train_data_dir") or "", cache_dir)
    latent_files = []
    text_files = []
    if cache_dir.is_dir():
        latent_files = [
            path
            for path in cache_dir.glob("*_krea2.safetensors")
            if not path.name.endswith("_krea2_te.safetensors")
        ]
        text_files = list(cache_dir.glob("*_krea2_te.safetensors"))

    manifest, _ = _read_cache_manifest(cache_dir)

    try:
        fingerprint = krea2_cache_fingerprint(config)
    except (TypeError, ValueError):
        fingerprint = ""
    matches = bool(fingerprint and manifest.get("fingerprint") == fingerprint)
    stages = manifest.get("stages") if isinstance(manifest.get("stages"), dict) else {}
    expected = len(images)
    ready = (
        expected > 0
        and matches
        and stages.get("latents") == "completed"
        and stages.get("text_encoder") == "completed"
        and len(latent_files) >= expected
        and len(text_files) >= expected
    )
    return {
        "cache_dir": str(cache_dir),
        "image_count": expected,
        "latent_count": len(latent_files),
        "text_encoder_count": len(text_files),
        "fingerprint_matches": matches,
        "stages": stages,
        "ready": ready,
    }


def validate_krea2_config(config: dict[str, Any]) -> list[str]:
    """Validate and normalize the strict Krea 2 UI payload."""

    # Keep old saved Krea presets and direct API callers compatible with newer
    # optional controls.  The browser normally supplies these defaults, but a
    # persisted preset may predate a field we added later.
    for key, default in {
        "krea_training_duration_mode": "epochs",
        "optimizer_type": "adamw8bit",
        "max_grad_norm": 1.0,
        "lr_scheduler": "constant",
        "lr_warmup_steps": 0,
        "lr_decay_steps": 0,
        "lr_scheduler_num_cycles": 1,
        "lr_scheduler_power": 1.0,
        "krea_prodigy_d_coef": "1.0",
        "krea_prodigy_d0": "1e-6",
        "krea_prodigyplus_use_stableadamw": True,
        "krea_schedulefree_warmup_steps": 0,
        "krea_adafactor_relative_step": True,
        "krea_adafactor_scale_parameter": True,
        "krea_adafactor_warmup_init": False,
        "krea_adafactor_clip_threshold": 1.0,
        "krea_adafactor_eps": "1e-30, 1e-3",
        "compile_mode": "default",
        "compile_dynamic": "auto",
        "block_swap_ring_size": 2,
        "enable_krea_samples": False,
        "sample_every_n_epochs": 1,
    }.items():
        config.setdefault(key, default)

    # Keep every cache beside the dataset that produced it.  This is a UI and
    # launch invariant rather than an optional musubi argument: a stale preset
    # or direct API call must not scatter Krea cache files elsewhere.
    automatic_cache_dir = krea2_auto_cache_dir(config.get("train_data_dir"))
    if automatic_cache_dir:
        config["dataset_cache_dir"] = automatic_cache_dir

    errors: list[str] = []
    for key in (
        "dit",
        "vae",
        "text_encoder",
        "train_data_dir",
        "dataset_cache_dir",
        "caption_extension",
        "output_name",
        "output_dir",
    ):
        if _is_empty(config.get(key)):
            errors.append(f"{key}: required / 必填")

    if config.get("network_module", KREA2_NETWORK_MODULE) != KREA2_NETWORK_MODULE:
        errors.append(
            f"network_module: Krea 2 requires {KREA2_NETWORK_MODULE} / Krea 2 必须使用指定 LoRA 模块"
        )
    else:
        config["network_module"] = KREA2_NETWORK_MODULE

    try:
        width, height = parse_krea2_resolution(config.get("resolution", ""))
        config["resolution"] = f"{width},{height}"
    except ValueError as exc:
        errors.append(f"resolution: {exc}")

    caption_extension = str(config.get("caption_extension") or "")
    if caption_extension and not caption_extension.startswith("."):
        errors.append("caption_extension: must start with '.' / 必须以 '.' 开头")

    duration_mode = str(config.get("krea_training_duration_mode", "epochs"))
    if duration_mode not in _KREA2_TRAINING_DURATIONS:
        errors.append("krea_training_duration_mode: unsupported value / 不支持的选项")
    else:
        config["krea_training_duration_mode"] = duration_mode

    optimizer_type = _normalize_krea2_optimizer_type(config, errors)
    adafactor_relative_step = bool(config.get("krea_adafactor_relative_step", True))

    # musubi's trainer returns an internal dummy scheduler for ScheduleFree,
    # and switches to its own AdafactorSchedule in relative-step mode.  Keep
    # the persisted config honest rather than displaying external settings
    # that the upstream training loop will ignore.
    internal_scheduler = optimizer_type in _KREA2_INTERNAL_SCHEDULER_OPTIMIZERS or (
        optimizer_type == "AdaFactor" and adafactor_relative_step
    )
    if internal_scheduler:
        config["lr_scheduler"] = "constant"
        config["lr_warmup_steps"] = 0

    for key, minimum in (
        ("network_dim", 1),
        ("network_alpha", 1),
        ("train_batch_size", 1),
        ("gradient_accumulation_steps", 1),
        ("krea_num_repeats", 1),
        ("blocks_to_swap", 0),
        ("max_data_loader_n_workers", 0),
        ("text_cache_batch_size", 1),
    ):
        _as_int(config, key, errors, minimum)
    if duration_mode == "steps":
        _as_int(config, "max_train_steps", errors, 1)
    else:
        _as_int(config, "max_train_epochs", errors, 1)

    for key, minimum in (
        ("block_swap_ring_size", 1),
        ("save_every_n_steps", 1),
        ("save_last_n_epochs", 1),
        ("save_last_n_epochs_state", 1),
        ("sample_every_n_steps", 1),
    ):
        if not _is_empty(config.get(key)):
            _as_int(config, key, errors, minimum)
    if isinstance(config.get("blocks_to_swap"), int) and config["blocks_to_swap"] > 26:
        errors.append("blocks_to_swap: Krea 2 maximum is 26 / Krea 2 最大值为 26")

    for key, minimum in (
        ("network_dropout", 0.0),
        ("discrete_flow_shift", 0.01),
        ("learning_rate", 0.0),
        ("max_grad_norm", 0.0),
        ("lr_scheduler_power", 0.01),
    ):
        if key == "discrete_flow_shift" and config.get("timestep_sampling", "shift") != "shift":
            continue
        if key == "lr_scheduler_power" and str(config.get("lr_scheduler", "constant")) != "polynomial":
            continue
        number = _as_float(config, key, errors, minimum)
        if key == "network_dropout" and number is not None and number > 0.5:
            errors.append("network_dropout: must be <= 0.5 / 不能大于 0.5")
        if key == "learning_rate" and number is not None and number <= 0:
            errors.append("learning_rate: must be > 0 / 必须大于 0")
    if not _is_empty(config.get("sigmoid_scale")):
        _as_float(config, "sigmoid_scale", errors)
    if not _is_empty(config.get("logit_mean")):
        _as_float(config, "logit_mean", errors)
    if not _is_empty(config.get("logit_std")):
        _as_float(config, "logit_std", errors, 0.0)
    if not _is_empty(config.get("mode_scale")):
        _as_float(config, "mode_scale", errors)

    for key in ("lr_warmup_steps", "lr_decay_steps"):
        if not _is_empty(config.get(key)):
            _as_steps_or_ratio(config, key, errors)
    scheduler_name = str(config.get("lr_scheduler", "constant"))
    # get_cosine_with_min_lr_schedule_with_warmup rejects a missing floor;
    # use zero to match an ordinary cosine schedule for direct API callers and
    # old presets that naturally predate this guided field.
    if scheduler_name == "cosine_with_min_lr" and _is_empty(config.get("lr_scheduler_min_lr_ratio")):
        config["lr_scheduler_min_lr_ratio"] = 0.0
    if scheduler_name == "constant":
        try:
            has_warmup = float(config.get("lr_warmup_steps", 0) or 0) != 0
        except (TypeError, ValueError):
            has_warmup = False
        if has_warmup:
            errors.append("lr_warmup_steps: constant scheduler does not accept warmup / constant 调度器不支持预热")
    if scheduler_name in _KREA2_NUM_CYCLES_SCHEDULERS:
        _as_int(config, "lr_scheduler_num_cycles", errors, 1)
    if scheduler_name == "inverse_sqrt" and not _is_empty(config.get("lr_scheduler_timescale")):
        _as_int(config, "lr_scheduler_timescale", errors, 1)
    if scheduler_name in _KREA2_MIN_LR_RATIO_SCHEDULERS and not _is_empty(
        config.get("lr_scheduler_min_lr_ratio")
    ):
        ratio = _as_float(config, "lr_scheduler_min_lr_ratio", errors, 0.0)
        if ratio is not None and ratio > 1.0:
            errors.append("lr_scheduler_min_lr_ratio: must be <= 1 / 不能大于 1")

    if not _is_empty(config.get("krea_optimizer_weight_decay")):
        _as_float(config, "krea_optimizer_weight_decay", errors, 0.0)
    if not _is_empty(config.get("krea_optimizer_betas")):
        if optimizer_type not in _KREA2_BETA_OPTIMIZERS:
            errors.append("krea_optimizer_betas: not supported by the selected optimizer / 当前优化器不支持 betas")
        else:
            _normalize_numeric_tuple(
                config,
                "krea_optimizer_betas",
                errors,
                lengths=_KREA2_BETA_LENGTHS[optimizer_type],
                minimum=0.0,
                maximum=0.999999999,
            )
    if not _is_empty(config.get("krea_optimizer_eps")):
        if optimizer_type not in _KREA2_EPS_OPTIMIZERS:
            errors.append("krea_optimizer_eps: not supported by the selected optimizer / 当前优化器不支持 eps")
        else:
            _normalize_numeric_literal(config, "krea_optimizer_eps", errors, minimum=1e-30)

    if optimizer_type in _KREA2_PRODIGY_OPTIMIZERS:
        _normalize_numeric_literal(config, "krea_prodigy_d_coef", errors, minimum=1e-30)
        _normalize_numeric_literal(config, "krea_prodigy_d0", errors, minimum=1e-30)
        if optimizer_type == _KREA2_PRODIGYPLUS_OPTIMIZER:
            config["krea_prodigyplus_use_stableadamw"] = bool(
                config.get("krea_prodigyplus_use_stableadamw", True)
            )
            # ProdigyPlus' StableAdamW update scaling already handles this
            # role.  Sending a second, external clip changes the intended
            # update rule, so normalize old presets and direct callers too.
            if config["krea_prodigyplus_use_stableadamw"]:
                config["max_grad_norm"] = 0.0

    if optimizer_type == "AdaFactor":
        _as_float(config, "krea_adafactor_clip_threshold", errors, 0.00000001)
        _normalize_numeric_tuple(
            config,
            "krea_adafactor_eps",
            errors,
            lengths={2},
            minimum=1e-30,
        )
    if optimizer_type in _KREA2_SCHEDULEFREE_WARMUP_OPTIMIZERS:
        _as_int(config, "krea_schedulefree_warmup_steps", errors, 0)

    for key, message in (
        ("krea_optimizer_custom_type", "custom optimizer classes are not supported / 不支持自定义优化器类"),
        ("krea_optimizer_args", "raw optimizer args are not supported; use the guided fields / 不支持原始优化器参数，请使用界面字段"),
        ("krea_lr_scheduler_type", "custom scheduler classes are not supported / 不支持自定义学习率调度器类"),
        ("krea_lr_scheduler_args", "raw scheduler args are not supported; use the guided fields / 不支持原始调度器参数，请使用界面字段"),
    ):
        if not _is_empty(config.get(key)):
            errors.append(f"{key}: {message}")
    if not _is_empty(config.get("compile_cache_size_limit")):
        _as_int(config, "compile_cache_size_limit", errors, 1)

    if str(config.get("mixed_precision", "bf16")) not in {"bf16", "fp16", "no"}:
        errors.append("mixed_precision: unsupported value / 不支持的选项")
    if str(config.get("timestep_sampling", "shift")) not in {
        "uniform", "sigmoid", "sigma", "shift", "krea2_shift", "logsnr"
    }:
        errors.append("timestep_sampling: unsupported value / 不支持的选项")
    if str(config.get("weighting_scheme", "none")) not in {
        "none", "sigma_sqrt", "cosmap", "logit_normal", "mode"
    }:
        errors.append("weighting_scheme: unsupported value / 不支持的选项")
    if str(config.get("krea_attention_backend", "sdpa")) not in _ATTENTION_FLAGS:
        errors.append("krea_attention_backend: unsupported value / 不支持的选项")
    if str(config.get("lr_scheduler", "constant")) not in _KREA2_LR_SCHEDULERS:
        errors.append("lr_scheduler: unsupported value / 不支持的选项")
    if str(config.get("lr_scheduler", "constant")) == "adafactor":
        errors.append(
            "lr_scheduler: adafactor is managed internally; select AdaFactor relative-step mode instead "
            "/ adafactor 由内部管理，请改用 AdaFactor 相对步长模式"
        )
    if str(config.get("compile_mode", "default")) not in _KREA2_COMPILE_MODES:
        errors.append("compile_mode: unsupported value / 不支持的选项")
    if str(config.get("compile_dynamic", "auto")) not in _KREA2_COMPILE_DYNAMIC_VALUES:
        errors.append("compile_dynamic: unsupported value / 不支持的选项")
    if config.get("fp8_base") and not config.get("fp8_scaled"):
        errors.append("fp8_scaled: Krea 2 requires scaled FP8 with fp8_base / fp8_base 必须同时启用 fp8_scaled")
    if config.get("gradient_checkpointing_cpu_offload") and not config.get("gradient_checkpointing"):
        errors.append(
            "gradient_checkpointing_cpu_offload: requires gradient_checkpointing / 必须同时启用 gradient_checkpointing"
        )
    if config.get("block_swap_h2d_only"):
        if int(config.get("blocks_to_swap") or 0) < 1:
            errors.append("block_swap_h2d_only: requires blocks_to_swap > 0 / 需要至少换出一个块")
        if not config.get("gradient_checkpointing"):
            errors.append("block_swap_h2d_only: requires gradient_checkpointing / 必须启用 gradient_checkpointing")

    samples_enabled = bool(config.get("enable_krea_samples", False))
    if samples_enabled:
        if not _has_krea2_sample_prompts(config.get("krea_sample_prompts")):
            errors.append("krea_sample_prompts: at least one non-comment prompt is required / 至少需要一条非注释提示词")
        _as_int(config, "sample_every_n_epochs", errors, 1)
        turbo_dit = str(config.get("turbo_dit") or "").strip()
        if config.get("turbo_dit_cache") and not turbo_dit:
            errors.append("turbo_dit_cache: requires turbo_dit / 必须先指定 Turbo DiT")
        if turbo_dit and int(config.get("blocks_to_swap") or 0) > 0:
            errors.append("turbo_dit: cannot be combined with blocks_to_swap / 不能与 blocks_to_swap 同时使用")

    return errors


def build_krea2_dataset_config(config: dict[str, Any]) -> dict[str, Any]:
    """Build musubi's separate dataset TOML object from the visible Krea form."""

    width, height = parse_krea2_resolution(config["resolution"])
    return {
        "general": {
            "resolution": [width, height],
            "caption_extension": str(config["caption_extension"]),
            "batch_size": int(config["train_batch_size"]),
            "enable_bucket": bool(config.get("enable_bucket", True)),
            "bucket_no_upscale": bool(config.get("bucket_no_upscale", True)),
        },
        "datasets": [
            {
                "image_directory": str(config["train_data_dir"]),
                "cache_directory": str(config["dataset_cache_dir"]),
                "num_repeats": int(config.get("krea_num_repeats", 1)),
            }
        ],
    }


def build_krea2_train_config(
    config: dict[str, Any],
    dataset_config_path: str | Path,
    output_dir: str | Path,
    logging_dir: str | Path,
    sample_prompts_path: str | Path | None = None,
) -> dict[str, Any]:
    """Encode only musubi Krea 2 flags into the flat training TOML."""

    optimizer_type = str(config.get("optimizer_type", "adamw8bit"))
    # Normal launch paths call validate_krea2_config first, but keep this
    # serialization boundary closed for direct integrations as well.
    if optimizer_type not in _KREA2_CURATED_OPTIMIZERS:
        raise ValueError(
            "optimizer_type: only the built-in Krea 2 optimizer list is supported "
            "/ 当前仅支持内置的 Krea 2 优化器列表"
        )

    # Batch size belongs solely to the musubi dataset TOML. Keep unsupported
    # legacy sd-scripts keys out of this file: musubi's config loader retains
    # unknown keys silently, which would otherwise make a displayed setting
    # look effective when it is not.
    result: dict[str, Any] = {
        "dit": str(config["dit"]),
        "vae": str(config["vae"]),
        "dataset_config": str(dataset_config_path),
        "network_module": KREA2_NETWORK_MODULE,
        "network_dim": int(config["network_dim"]),
        "network_alpha": int(config["network_alpha"]),
        "network_dropout": float(config.get("network_dropout", 0)),
        "gradient_accumulation_steps": int(config["gradient_accumulation_steps"]),
        "gradient_checkpointing": bool(config.get("gradient_checkpointing", False)),
        "learning_rate": float(config["learning_rate"]),
        "max_grad_norm": float(config.get("max_grad_norm", 1.0)),
        "seed": int(config.get("seed", 42)),
        "mixed_precision": str(config.get("mixed_precision", "bf16")),
        "timestep_sampling": str(config.get("timestep_sampling", "shift")),
        "weighting_scheme": str(config.get("weighting_scheme", "none")),
        "optimizer_type": optimizer_type,
        "lr_scheduler": str(config.get("lr_scheduler", "constant")),
        "output_dir": str(output_dir),
        "output_name": str(config["output_name"]),
        "logging_dir": str(logging_dir),
        "save_precision": str(config.get("save_precision", "bf16")),
        "save_every_n_epochs": int(config.get("save_every_n_epochs", 1)),
        "max_data_loader_n_workers": int(config.get("max_data_loader_n_workers", 2)),
    }
    if str(config.get("krea_training_duration_mode", "epochs")) == "steps":
        result["max_train_steps"] = int(config["max_train_steps"])
    else:
        result["max_train_epochs"] = int(config["max_train_epochs"])
    if result["timestep_sampling"] == "shift":
        result["discrete_flow_shift"] = float(config.get("discrete_flow_shift", 2.5))
    if result["timestep_sampling"] == "sigma":
        result["discrete_flow_shift"] = float(config.get("discrete_flow_shift", 2.5))
    if result["timestep_sampling"] in {"sigmoid", "shift", "krea2_shift"}:
        result["sigmoid_scale"] = float(config.get("sigmoid_scale", 1.0))
    if result["timestep_sampling"] in {"sigma", "logsnr"}:
        result["logit_mean"] = float(config.get("logit_mean", 0.0))
        result["logit_std"] = float(config.get("logit_std", 1.0))
    if result["timestep_sampling"] == "sigma":
        result["mode_scale"] = float(config.get("mode_scale", 1.29))
    if not _is_empty(config.get("lr_warmup_steps")) and float(config["lr_warmup_steps"]) != 0:
        result["lr_warmup_steps"] = config["lr_warmup_steps"]
    if not _is_empty(config.get("lr_decay_steps")) and float(config["lr_decay_steps"]) != 0:
        result["lr_decay_steps"] = config["lr_decay_steps"]
    if result["lr_scheduler"] in _KREA2_NUM_CYCLES_SCHEDULERS:
        result["lr_scheduler_num_cycles"] = int(config.get("lr_scheduler_num_cycles", 1))
    if result["lr_scheduler"] == "polynomial":
        result["lr_scheduler_power"] = float(config.get("lr_scheduler_power", 1.0))
    if result["lr_scheduler"] == "inverse_sqrt" and not _is_empty(config.get("lr_scheduler_timescale")):
        result["lr_scheduler_timescale"] = int(config["lr_scheduler_timescale"])
    if result["lr_scheduler"] in _KREA2_MIN_LR_RATIO_SCHEDULERS and not _is_empty(
        config.get("lr_scheduler_min_lr_ratio")
    ):
        result["lr_scheduler_min_lr_ratio"] = float(config["lr_scheduler_min_lr_ratio"])
    if bool(config.get("persistent_data_loader_workers", True)):
        result["persistent_data_loader_workers"] = True
    if bool(config.get("save_state", False)):
        result["save_state"] = True
    if bool(config.get("save_state_on_train_end", False)):
        result["save_state_on_train_end"] = True
    if not _is_empty(config.get("resume")):
        result["resume"] = str(config["resume"])
    for key in ("save_every_n_steps", "save_last_n_epochs", "save_last_n_epochs_state"):
        if not _is_empty(config.get(key)):
            result[key] = int(config[key])
    if int(config.get("blocks_to_swap", 0)) > 0:
        result["blocks_to_swap"] = int(config["blocks_to_swap"])
        if bool(config.get("use_pinned_memory_for_block_swap", False)):
            result["use_pinned_memory_for_block_swap"] = True
        if bool(config.get("block_swap_h2d_only", False)):
            result["block_swap_h2d_only"] = True
            result["block_swap_ring_size"] = int(config.get("block_swap_ring_size", 2))
    if bool(config.get("fp8_base", False)):
        result["fp8_base"] = True
        result["fp8_scaled"] = True
    if bool(config.get("compile", False)):
        result["compile"] = True
        result["compile_backend"] = str(config.get("compile_backend", "inductor"))
        result["compile_mode"] = str(config.get("compile_mode", "default"))
        result["compile_dynamic"] = str(config.get("compile_dynamic", "auto"))
        if bool(config.get("compile_fullgraph", False)):
            result["compile_fullgraph"] = True
        if not _is_empty(config.get("compile_cache_size_limit")):
            result["compile_cache_size_limit"] = int(config["compile_cache_size_limit"])
    if bool(config.get("gradient_checkpointing_cpu_offload", False)):
        result["gradient_checkpointing_cpu_offload"] = True
    if bool(config.get("cuda_allow_tf32", False)):
        result["cuda_allow_tf32"] = True
    if bool(config.get("cuda_cudnn_benchmark", False)):
        result["cuda_cudnn_benchmark"] = True

    attention = str(config.get("krea_attention_backend", "sdpa"))
    result[_ATTENTION_FLAGS[attention]] = True
    if attention != "sdpa":
        result["split_attn"] = True

    network_args = _split_args(config.get("network_args_custom"))
    if network_args:
        result["network_args"] = network_args
    optimizer_args = _build_krea2_optimizer_args(config)
    if optimizer_args:
        result["optimizer_args"] = optimizer_args
    if bool(config.get("enable_krea_samples", False)):
        if sample_prompts_path is None:
            raise ValueError("sample_prompts_path is required when Krea sampling is enabled")
        result["text_encoder"] = str(config["text_encoder"])
        result["sample_prompts"] = str(sample_prompts_path)
        result["sample_every_n_epochs"] = int(config.get("sample_every_n_epochs", 1))
        if not _is_empty(config.get("sample_every_n_steps")):
            result["sample_every_n_steps"] = int(config["sample_every_n_steps"])
        if bool(config.get("sample_at_first", False)):
            result["sample_at_first"] = True
        if not _is_empty(config.get("turbo_dit")):
            result["turbo_dit"] = str(config["turbo_dit"])
            if bool(config.get("turbo_dit_cache", False)):
                result["turbo_dit_cache"] = True
    return result


def krea2_preflight(config: dict[str, Any], require_cache: bool = True) -> dict[str, Any]:
    """Check runtime, dependency, local model and cache readiness before launch."""

    errors: list[str] = []
    script = MUSUBI_TUNER_DIR / "krea2_train_network.py"
    package_dir = MUSUBI_TUNER_DIR / "src" / "musubi_tuner"
    if not script.is_file() or not package_dir.is_dir():
        errors.append(
            f"musubi-tuner source is not installed / musubi-tuner 源码未安装: {MUSUBI_TUNER_DIR}"
        )

    runtime = shared_runtime_status()
    errors.extend(runtime["errors"])

    optional_optimizer_package = _selected_optional_optimizer_package(config.get("optimizer_type"))
    if optional_optimizer_package:
        try:
            importlib.metadata.version(optional_optimizer_package)
        except importlib.metadata.PackageNotFoundError:
            errors.append(
                f"Selected optimizer requires {optional_optimizer_package}, but it is not installed in the shared "
                f"training environment / 所选优化器需要 {optional_optimizer_package}，但共享训练环境未安装"
            )

    for key, label in (("dit", "Krea 2 RAW DiT"), ("vae", "Qwen-Image VAE"), ("text_encoder", "Qwen3-VL text encoder")):
        path = Path(str(config.get(key) or ""))
        if not path.is_file():
            errors.append(f"{label} not found / 模型文件不存在: {path}")
    if require_cache and bool(config.get("enable_krea_samples", False)) and not _is_empty(config.get("turbo_dit")):
        turbo_path = Path(str(config["turbo_dit"]))
        if not turbo_path.is_file():
            errors.append(f"Krea 2 Turbo DiT not found / Turbo 模型文件不存在: {turbo_path}")

    images = image_files(config.get("train_data_dir") or "", config.get("dataset_cache_dir"))
    if not images:
        errors.append("Dataset directory has no supported images / 数据集目录没有可用图片")

    cache_status = get_krea2_cache_status(config)
    if require_cache and not cache_status["ready"]:
        errors.append(
            "Krea 2 latent/text caches are missing or stale; prepare both caches before training / "
            "Krea 2 latent 与文本缓存缺失或已失效，请先生成缓存"
        )

    return {"ok": not errors, "errors": errors, "cache": cache_status, "runtime": runtime}


def estimate_krea2_steps(config: dict[str, Any]) -> dict[str, Any]:
    """Return a transparent, non-sd-scripts estimate for the Krea profile."""

    try:
        parse_krea2_resolution(config.get("resolution", "1024,1024"))
    except ValueError as exc:
        raise ValueError(f"resolution: {exc}") from exc
    images = image_files(config["train_data_dir"], config.get("dataset_cache_dir"))
    if not images:
        raise ValueError("Dataset directory has no supported images / 数据集路径不存在或无图片")

    try:
        repeats = int(config.get("krea_num_repeats", 1))
        batch_size = int(config.get("train_batch_size", 1))
        accumulation = int(config.get("gradient_accumulation_steps", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("batch size, repeats and accumulation must be integers / 批量、重复和累积必须为整数") from exc
    if min(repeats, batch_size, accumulation) < 1:
        raise ValueError("batch size, repeats and accumulation must be positive / 批量、重复和累积必须大于 0")
    gpu_ids = config.get("gpu_ids")
    gpu_processes = len(gpu_ids) if isinstance(gpu_ids, (list, tuple)) and gpu_ids else 1
    repeated_samples = len(images) * repeats
    batches = math.ceil(repeated_samples / batch_size)
    steps_per_epoch = math.ceil(batches / gpu_processes / accumulation)
    duration_mode = str(config.get("krea_training_duration_mode", "epochs"))
    if duration_mode == "steps":
        try:
            total_steps = int(config.get("max_train_steps", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_train_steps must be an integer / 最大训练步数必须为整数") from exc
        if total_steps < 1:
            raise ValueError("max_train_steps must be positive / 最大训练步数必须大于 0")
        epochs = math.ceil(total_steps / steps_per_epoch)
    else:
        try:
            epochs = int(config.get("max_train_epochs", 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("max_train_epochs must be an integer / 最大训练轮数必须为整数") from exc
        if epochs < 1:
            raise ValueError("max_train_epochs must be positive / 最大训练轮数必须大于 0")
        total_steps = steps_per_epoch * epochs
    return {
        "engine_id": "musubi_tuner",
        "approximate": bool(config.get("enable_bucket", True)),
        "original_images": len(images),
        "repeated_samples": repeated_samples,
        "subsets": [{"name": Path(config["train_data_dir"]).name, "image_count": len(images), "repeats": repeats}],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_count": 1,
        "batches_per_epoch": batches,
        "batch_size": batch_size,
        "gradient_accumulation_steps": accumulation,
        "gpu_processes": gpu_processes,
        "effective_batch": batch_size * accumulation * gpu_processes,
        "steps_per_epoch": steps_per_epoch,
        "max_train_epochs": epochs,
        "max_train_steps": total_steps,
        "total_steps": total_steps,
    }
