"""Exercise the vendored constructors used by the Anima shape inspector."""
import tempfile
import unittest
from pathlib import Path

from backend.training.shape_preview import inspect_network


def estimate(**updates):
    return inspect_network({
        "model_train_type": "anima-lora", "network_module": "networks.lora_anima",
        "network_dim": 32, "network_alpha": 16, "network_train_unet_only": True,
        "save_precision": "bf16", **updates,
    })


def group(result, suffix):
    return next(g for g in result["groups"] if g["name"].endswith(suffix))


class ShapePreviewTests(unittest.TestCase):
    def test_lokr_thresholds_are_per_layer(self):
        result = estimate(network_module="networks.lokr", train_adaln=True)
        self.assertTrue(group(result, "self_attn.q_proj")["w2Full"])
        self.assertFalse(group(result, "mlp.layer1")["w2Full"])
        self.assertFalse(group(result, "adaln_modulation_mlp.2")["w2Full"])

    def test_disabled_decompose_both_overrides_custom_argument(self):
        from backend.training.adapter import adapt_config

        config, _ = adapt_config({"model_train_type": "anima-lora",
                                  "network_module": "lycoris.kohya", "lycoris_algo": "lokr",
                                  "network_args_custom": "decompose_both=true", "decompose_both": False})
        self.assertFalse(any(arg.startswith("decompose_both=") for arg in config["network_args"]))

    def test_estimated_bytes_match_saved_safetensors(self):
        import importlib
        import torch
        from safetensors.torch import save_file

        cases = (("networks.lora_anima", "LoRAModule"), ("networks.loha", "LoHaModule"), ("networks.lokr", "LoKrModule"))
        for module_name, class_name in cases:
            with self.subTest(module=module_name), tempfile.TemporaryDirectory() as temp_dir:
                tmp_path = Path(temp_dir)
                result = estimate(network_module=module_name, network_args=["exclude_patterns=['.*']", "include_patterns=['x_embedder.*']"])
                self.assertEqual(result["moduleCount"], 1)
                cls = getattr(importlib.import_module(module_name), class_name)
                adapter = cls("lora_unet_x_embedder_proj_1", torch.nn.Linear(68, 2048, bias=False), lora_dim=32, alpha=16)
                del adapter.org_module
                state = {"lora_unet_x_embedder_proj_1." + key: value.to(torch.bfloat16) for key, value in adapter.state_dict().items()}
                path = tmp_path / "adapter.safetensors"
                save_file(state, str(path))
                self.assertEqual(path.stat().st_size, result["estimatedBytes"])

    def test_lycoris_serialization_with_dora_and_scalar(self):
        import importlib
        import torch
        from safetensors.torch import save_file

        cases = (("locon", "LoConModule"), ("loha", "LohaModule"), ("lokr", "LokrModule"))
        for algo, class_name in cases:
            with self.subTest(algo=algo), tempfile.TemporaryDirectory() as temp_dir:
                tmp_path = Path(temp_dir)
                preset = tmp_path / "single.toml"
                preset.write_text('unet_target_module = []\nunet_target_name = ["x_embedder.proj.1"]\n', encoding="utf-8")
                result = estimate(network_module="lycoris.kohya", lycoris_algo="lora" if algo == "locon" else algo,
                                  lycoris_preset=str(preset), dora_wd=True, use_scalar=True, rs_lora=True)
                cls = getattr(importlib.import_module(f"lycoris.modules.{algo}"), class_name)
                adapter = cls("lora_unet_x_embedder_proj_1", torch.nn.Linear(68, 2048, bias=False), lora_dim=32,
                              alpha=16, weight_decompose=True, use_scalar=True, rs_lora=True)
                state = {"lora_unet_x_embedder_proj_1." + key: value.to(torch.bfloat16) for key, value in adapter.state_dict().items()}
                path = tmp_path / "adapter.safetensors"
                save_file(state, str(path))
                self.assertEqual(path.stat().st_size, result["estimatedBytes"])
                self.assertEqual(sum(p.numel() for p in adapter.parameters()), result["params"])

    def test_unsupported_configs_are_explicit(self):
        for updates in ({"dim_from_weights": True}, {"network_module": "custom.module"}):
            with self.subTest(updates=updates):
                with self.assertRaises(ValueError):
                    estimate(**updates)


if __name__ == "__main__":
    unittest.main()
