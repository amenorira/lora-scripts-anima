"""Krea UI controls must survive native serialization and use real network shapes."""
from pathlib import Path
import tempfile
import unittest

from backend.training.config.config_import import import_native_training_form
from backend.training.config.musubi_krea2 import build_krea2_train_config, validate_krea2_config
from tests.training.test_multi_core_krea2 import krea2_config

ROOT = Path(__file__).resolve().parents[2]


class Krea2UIContractsTests(unittest.TestCase):


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
