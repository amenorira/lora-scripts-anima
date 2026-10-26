"""Krea UI controls must survive native serialization and use real network shapes."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from backend.training.config_import import import_native_training_form
from backend.training.musubi_krea2 import (
    KREA2_FIELDS, _krea2_checkpoint_format_errors, build_krea2_train_config, validate_krea2_config,
)
from tests.training.test_multi_core_krea2 import krea2_config

ROOT = Path(__file__).resolve().parents[2]


class Krea2UIContractsTests(unittest.TestCase):
    def test_fused_adamw_split_attention_and_loraplus_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            base = krea2_config(Path(temp))
            for fused in ("auto", "true", "false"):
                for backend, split, expected in (("sdpa", "auto", False), ("flash_attn", "auto", True),
                                                  ("sdpa", "true", True), ("flash_attn", "false", False)):
                    with self.subTest(fused=fused, backend=backend, split=split):
                        form = {**base, "optimizer_type": "AdamW", "krea_adamw_fused": fused,
                                "krea_attention_backend": backend, "krea_split_attn": split,
                                "enable_loraplus": True, "loraplus_lr_ratio": 4.5}
                        self.assertEqual(validate_krea2_config(form), [])
                        native = build_krea2_train_config(form, "dataset.toml", "output", "log")
                        self.assertEqual(native["split_attn"], expected)
                        self.assertEqual([arg for arg in native.get("optimizer_args", []) if arg.startswith("fused=")],
                                         [] if fused == "auto" else [f"fused={fused == 'true'}"])
                        self.assertIn("loraplus_lr_ratio=4.5", native["network_args"])
                        restored = import_native_training_form(native, profile_id="krea2-lora")
                        self.assertEqual(restored.get("krea_adamw_fused", "auto"), fused)
                        self.assertEqual(restored["krea_split_attn"], "true" if expected else "false")
                        self.assertTrue(restored["enable_loraplus"])
                        self.assertEqual(restored["loraplus_lr_ratio"], 4.5)
            automatic = import_native_training_form({"optimizer_type": "AdamW", "optimizer_args": ["fused=None"]},
                                                     profile_id="krea2-lora")
            self.assertEqual(automatic.get("krea_adamw_fused", "auto"), "auto")

    def test_old_loraplus_args_migrate_and_cache_options_stay_out_of_training_toml(self):
        with tempfile.TemporaryDirectory() as temp:
            form = krea2_config(Path(temp))
            form.update(network_args_custom="loraplus_lr_ratio=3\nrank_dropout=0.1",
                        krea_latent_cache_device="cpu", krea_text_cache_device="cpu",
                        krea_latent_cache_batch_size=4, krea_cache_num_workers=3,
                        krea_cache_reuse=False, krea_cache_vae_tiling=True)
            self.assertEqual(validate_krea2_config(form), [])
            self.assertTrue(form["enable_loraplus"])
            self.assertEqual(form["loraplus_lr_ratio"], 3)
            native = build_krea2_train_config(form, "dataset.toml", "output", "log")
            self.assertEqual(native["network_args"].count("loraplus_lr_ratio=3.0"), 1)
            self.assertFalse(any("cache" in key for key in native))

    def test_new_controls_export_and_restore_native_values(self):
        with tempfile.TemporaryDirectory() as temp:
            form = krea2_config(Path(temp))
            form.update(network_alpha=1.5, network_weights="adapter.safetensors", dim_from_weights=True,
                        scale_weight_norms=1.2, timestep_sampling="flux_shift", sigmoid_scale=1.2,
                        min_timestep=100, max_timestep=850, preserve_distribution_shape=True,
                        num_timestep_buckets=8, convrot_int8=True, convrot_int8_bwd="int8",
                        save_every_n_steps=20, save_last_n_steps=80, save_state=True, save_last_n_steps_state=40,
                        enable_krea_samples=True, krea_sample_prompts="a cat --l 1 --s 8",
                        turbo_lora="turbo.safetensors", turbo_lora_multiplier=0.8)
            for scheduler in ("warmup_stable_decay", "piecewise_constant"):
                form.update(lr_scheduler=scheduler, warmup_type="cosine", decay_type="1-sqrt", step_rules="1:100,0.5")
                self.assertEqual(validate_krea2_config(form), [])
                native = build_krea2_train_config(form, "dataset.toml", "output", "log", "prompts.txt")
                for key in ("network_alpha", "network_weights", "dim_from_weights", "scale_weight_norms",
                            "timestep_sampling", "sigmoid_scale", "min_timestep", "max_timestep",
                            "preserve_distribution_shape", "num_timestep_buckets", "convrot_int8", "convrot_int8_bwd",
                            "save_last_n_steps", "save_last_n_steps_state", "turbo_lora", "turbo_lora_multiplier"):
                    self.assertEqual(native[key], form[key], key)
                restored = import_native_training_form(native, profile_id="krea2-lora")
                for key in (("warmup_type", "decay_type") if scheduler == "warmup_stable_decay" else ("step_rules",)):
                    self.assertEqual(restored[key], form[key])
                if scheduler == "piecewise_constant":
                    self.assertNotIn("lr_warmup_steps", native)
            form.update(timestep_sampling="sigma", convrot_int8=False, enable_krea_samples=False)
            native = build_krea2_train_config(form, "dataset.toml", "output", "log")
            for key in ("discrete_flow_shift", "sigmoid_scale", "preserve_distribution_shape", "num_timestep_buckets",
                        "convrot_int8", "convrot_int8_bwd", "turbo_lora", "turbo_lora_multiplier"):
                self.assertNotIn(key, native)

    def test_incompatible_combinations_are_rejected(self):
        cases = [
            ({"convrot_int8": True, "fp8_base": True}, "convrot_int8"),
            ({"convrot_int8": True, "convrot_int8_bwd": "fp32"}, "convrot_int8_bwd"),
            ({"convrot_int8": True, "turbo_dit": "turbo.safetensors"}, "turbo_dit"),
            ({"turbo_dit": "turbo.safetensors", "turbo_lora": "lora.safetensors"}, "turbo_lora"),
            ({"min_timestep": 900, "max_timestep": 100}, "min_timestep/max_timestep"),
            ({"num_timestep_buckets": 1}, "num_timestep_buckets"),
            ({"dim_from_weights": True}, "dim_from_weights"),
            ({"lr_scheduler": "piecewise_constant", "step_rules": "1:100,0.5:50,0"}, "step_rules"),
            ({"krea_adamw_fused": "yes"}, "krea_adamw_fused"),
            ({"krea_attention_backend": "xformers", "krea_split_attn": "false"}, "krea_split_attn"),
            ({"krea_latent_cache_device": "unknown"}, "krea_latent_cache_device"),
            ({"krea_latent_cache_batch_size": 0}, "krea_latent_cache_batch_size"),
            ({"krea_cache_num_workers": 0}, "krea_cache_num_workers"),
            ({"enable_loraplus": True, "loraplus_lr_ratio": float("nan")}, "loraplus_lr_ratio"),
            ({"enable_loraplus": True, "loraplus_lr_ratio": 0}, "loraplus_lr_ratio"),
            ({"enable_loraplus": True, "dim_from_weights": True, "network_weights": "adapter.safetensors"}, "dim_from_weights"),
        ]
        with tempfile.TemporaryDirectory() as temp:
            base = krea2_config(Path(temp))
            for changes, key in cases:
                with self.subTest(changes=changes):
                    form = {**base, "enable_krea_samples": True, "krea_sample_prompts": "cat", **changes}
                    self.assertTrue(any(key in error for error in validate_krea2_config(form)))

    def test_checkpoint_format_preflight_and_download_defaults_agree(self):
        from tools.download_anima_model import MODEL_FILES
        defaults = {field["key"]: field["default"] for field in KREA2_FIELDS}
        for key in ("dit", "text_encoder", "vae"):
            self.assertIn(Path(defaults[key]).name, [item[2] for item in MODEL_FILES])
        self.assertTrue(defaults["dit"].endswith("_bf16.safetensors"))
        self.assertTrue(defaults["text_encoder"].endswith("_bf16.safetensors"))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "tiny.safetensors"
            def write_header(tensors):
                header = json.dumps(tensors).encode()
                path.write_bytes(len(header).to_bytes(8, "little") + header)
            write_header({"blocks.0.attn.wq.weight": {"dtype": "F8_E4M3"}, "blocks.0.attn.wq.weight_scale": {"dtype": "F32"}})
            self.assertTrue(_krea2_checkpoint_format_errors(path, "dit", {"fp8_base": True}))
            self.assertTrue(_krea2_checkpoint_format_errors(path, "text_encoder", {}))
            write_header({"blocks.0.attn.wq.weight": {"dtype": "BF16"}})
            self.assertEqual(_krea2_checkpoint_format_errors(path, "dit", {}), [])
            write_header({"blocks.0.attn.wq.weight": {"dtype": "I8"}, "blocks.0.attn.wq.comfy_quant": {"dtype": "U8"}})
            self.assertTrue(_krea2_checkpoint_format_errors(path, "dit", {}))
            self.assertEqual(_krea2_checkpoint_format_errors(path, "dit", {"convrot_int8": True}), [])

    def test_real_shapes_match_target_selection_and_do_not_leak_between_profiles(self):
        # The production worker imports both engines in one process. Exercise that
        # exact boundary without adding their top-level packages to the test runner.
        code = '''
from tools.runtime_paths import configure_test_paths
configure_test_paths()
from backend.training.shape_preview import inspect_network
from backend.training.krea2_network import selected_targets
base = dict(model_train_type="anima-lora", network_module="networks.lora_anima", network_dim=4,
            network_alpha=4, network_train_unet_only=True, save_precision="bf16")
anima = inspect_network(base)
krea = dict(base, model_train_type="krea2-lora", network_module="networks.lora_krea2", network_alpha=1.5)
for mode in ("all", "attention", "attention_mlp", "custom"):
    form = dict(krea, krea_target_mode=mode, krea_target_include=r"blocks\\.0\\..*", krea_target_exclude=r".*\\.mlp\\..*")
    result = inspect_network(form)
    names = {name for group in result["groups"] for name in group["paths"]}
    assert names == set(selected_targets(form)), (mode, names)
    assert result["moduleCount"] == len(names)
    assert result["params"] == sum((g["in"] + g["out"]) * 4 * g["count"] for g in result["groups"])
    assert all(g["alpha"] == 1.5 and g["scale"] == 1.5 / 4 for g in result["groups"])
for algo in ("lora", "loha", "lokr"):
    form = dict(krea, network_module="lycoris.kohya", lycoris_algo=algo, krea_target_mode="attention", dora_wd=True)
    result = inspect_network(form)
    assert result["moduleCount"] == 140
    assert all(g["algo"] == algo and "dora_scale" in g["shapes"] for g in result["groups"])
    assert result["estimatedBytes"] > result["weightBytes"] > 0
assert inspect_network(base) == anima
'''
        result = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8", timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
