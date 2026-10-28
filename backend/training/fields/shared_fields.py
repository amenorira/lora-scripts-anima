"""Common training controls shared by sd-scripts and Musubi profiles.

Only equivalent UI metadata belongs here. Profiles explicitly retain their
defaults, export targets, supported options and optimizer-specific rules.
Every constructed field owns its nested metadata to avoid cross-profile edits.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any


_FIELDS = {
    "train_batch_size": {"type": "number", "section": "training", "min": 1, "hint_key": "field.train_batch_sizeHint"},
    "gradient_accumulation_steps": {"type": "number", "section": "training", "min": 1, "hint_key": "field.gradient_accumulation_stepsHint"},
    "gradient_checkpointing": {"type": "toggle", "section": "training", "hint_key": "field.gradient_checkpointingHint"},
    "seed": {"type": "number", "section": "training", "hint_key": "field.seedHint"},
    "mixed_precision": {
        "type": "select",
        "section": "training",
        "hint_key": "field.mixed_precisionHint",
        "options": [
            {"v": "bf16", "l": "bf16", "dk": "opt.mixed_precision_bf16"},
            {"v": "fp16", "l": "fp16", "dk": "opt.mixed_precision_fp16"},
            {"v": "no", "l": "no", "dk": "opt.mixed_precision_no"},
        ],
    },
    "save_precision": {
        "type": "select",
        "section": "save",
        "hint_key": "field.save_precisionHint",
        "options": [
            {"v": "bf16", "l": "bf16", "dk": "opt.save_precision_bf16"},
            {"v": "fp16", "l": "fp16", "dk": "opt.save_precision_fp16"},
            {"v": "float", "l": "float", "dk": "opt.save_precision_float"},
        ],
    },
    "compile_backend": {
        "type": "select",
        "section": "performance",
        "show_if": {"key": "compile", "eq": True},
        "options": [
            {"v": "inductor", "l": "inductor", "dk": "opt.compile_backend_inductor"},
            {"v": "eager", "l": "eager", "dk": "opt.compile_backend_eager"},
            {"v": "cudagraphs", "l": "cudagraphs", "dk": "opt.compile_backend_cudagraphs"},
        ],
    },
    "compile_mode": {
        "type": "select",
        "section": "performance",
        "show_if": {"key": "compile", "eq": True},
        "options": [
            {"v": "default", "l": "default", "dk": "opt.compile_mode_default"},
            {"v": "reduce-overhead", "l": "reduce-overhead", "dk": "opt.compile_mode_reduce_overhead"},
            {"v": "max-autotune", "l": "max-autotune", "dk": "opt.compile_mode_max_autotune"},
            {
                "v": "max-autotune-no-cudagraphs",
                "l": "max-autotune-no-cudagraphs",
                "dk": "opt.compile_mode_max_autotune_no_cudagraphs",
            },
        ],
    },
    "compile_dynamic": {
        "type": "select",
        "section": "performance",
        "show_if": {"key": "compile", "eq": True},
        "options": [
            {"v": "auto", "l": "auto", "dk": "opt.compile_dynamic_auto"},
            {"v": "true", "l": "true", "dk": "opt.compile_dynamic_true"},
            {"v": "false", "l": "false", "dk": "opt.compile_dynamic_false"},
        ],
    },
    "compile_fullgraph": {
        "type": "toggle",
        "section": "performance",
        "show_if": {"key": "compile", "eq": True},
        "hint_key": "field.compile_fullgraphHint",
    },
    "compile_cache_size_limit": {
        "type": "number",
        "section": "performance",
        "show_if": {"key": "compile", "eq": True},
        "hint_key": "field.compile_cache_size_limitHint",
    },
    "max_data_loader_n_workers": {
        "type": "number",
        "section": "performance",
        "min": 0,
        "step": 1,
        "hint_key": "field.max_data_loader_n_workersHint",
    },
    "persistent_data_loader_workers": {
        "type": "toggle",
        "section": "performance",
        "hint_key": "field.persistent_data_loader_workersHint",
        "readonly_if": {
            "key": "max_data_loader_n_workers",
            "eq": 0,
            "reason_key": "field.persistent_data_loader_workersLocked",
        },
    },
    "cuda_allow_tf32": {"type": "toggle", "section": "performance", "hint_key": "field.cuda_allow_tf32Hint"},
    "cuda_cudnn_benchmark": {"type": "toggle", "section": "performance", "hint_key": "field.cuda_cudnn_benchmarkHint"},
    "save_every_n_epochs": {"type": "number", "section": "save", "min": 1},
    "save_every_n_steps": {"type": "number", "section": "save", "min": 1, "hint_key": "field.save_every_n_stepsHint"},
    "save_last_n_epochs": {"type": "number", "section": "save", "min": 1, "hint_key": "field.save_last_n_epochsHint"},
    "save_state": {"type": "toggle", "section": "save", "hint_key": "field.save_stateHint"},
    "save_last_n_epochs_state": {
        "type": "number",
        "section": "save",
        "min": 1,
        "show_if": {"key": "save_state", "eq": True},
        "hint_key": "field.save_last_n_epochs_stateHint",
    },
    "save_state_on_train_end": {"type": "toggle", "section": "save", "hint_key": "field.save_state_on_train_endHint"},
    "output_dir": {"type": "text", "section": "save", "role": "file-folder", "required": True},
    "output_name": {"type": "text", "section": "save", "required": True},
    "resume": {"type": "text", "section": "model", "hint_key": "field.resumeHint", "role": "file-folder"},
    "bucket_no_upscale": {
        "type": "toggle",
        "section": "model",
        "hint_key": "field.bucket_no_upscaleHint",
        "show_if": {"key": "enable_bucket", "eq": True},
    },
    "enable_bucket": {"type": "toggle", "section": "model", "hint_key": "field.enable_bucketHint"},
    "block_swap_ring_size": {
        "type": "number",
        "min": 1,
        "step": 1,
        "section": "performance",
        "hint_key": "field.block_swap_ring_sizeHint",
        "show_if": [{"key": "blocks_to_swap", "neq": 0}, {"key": "block_swap_h2d_only", "eq": True}],
    },
    "lycoris_kernel_backend": {
        "type": "select",
        "section": "network",
        "show_if": {"key": "network_module", "eq": "lycoris.kohya"},
        "hint_key": "field.lycoris_kernel_backendHint",
        "options": [
            {"v": "auto", "l": "auto", "dk": "opt.lycoris_kernel_backend_auto"},
            {"v": "triton", "l": "triton", "dk": "opt.lycoris_kernel_backend_triton"},
            {"v": "tilelang", "l": "tilelang", "dk": "opt.lycoris_kernel_backend_tilelang"},
            {"v": "compile", "l": "compile", "dk": "opt.lycoris_kernel_backend_compile"},
            {"v": "torch", "l": "torch", "dk": "opt.lycoris_kernel_backend_torch"},
        ],
    },
    "network_dim": {
        "type": "number",
        "section": "network",
        "hint_key": "field.network_dimHint",
        "min": 1,
        "step": 1,
        "doc_slug": "network-parameters",
        "doc_anchor": "dimension",
    },
    "network_alpha": {
        "type": "number",
        "section": "network",
        "hint_key": "field.network_alphaHint",
        "min": 1,
        "step": 1,
        "doc_slug": "network-parameters",
        "doc_anchor": "alpha",
    },
    "network_dropout": {
        "type": "number",
        "section": "network",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "hint_key": "field.network_dropoutHint",
        "doc_slug": "network-parameters",
        "doc_anchor": "dropout",
    },
    "rank_dropout": {
        "type": "number",
        "section": "network",
        "min": 0,
        "max": 0.99,
        "step": 0.01,
        "hint_key": "field.rank_dropoutHint",
        "doc_slug": "network-parameters",
        "doc_anchor": "dropout",
    },
    "module_dropout": {
        "type": "number",
        "section": "network",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "hint_key": "field.module_dropoutHint",
        "doc_slug": "network-parameters",
        "doc_anchor": "dropout",
    },
    "lokr_factor": {
        "type": "number",
        "section": "network",
        "min": -1,
        "step": 1,
        "hint_key": "field.lokr_factorHint",
        "doc_slug": "network-parameters",
        "doc_anchor": "lokr-factor",
    },
}


def shared_training_field(key: str, **profile: Any) -> dict[str, Any]:
    return deepcopy({"key": key, "desc_key": f"field.{key}", **_FIELDS[key], **profile})
