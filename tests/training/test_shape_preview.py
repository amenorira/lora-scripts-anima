"""Exercise the vendored constructors used by the Anima shape inspector."""
import logging
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.shape_preview import inspect_network


class _ListHandler(logging.Handler):
    """Collects records at INFO and above, mirroring what reaches the console."""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.records = []

    def emit(self, record):
        self.records.append(record)


def estimate(**updates):
    return inspect_network({
        "model_train_type": "anima-lora", "network_module": "networks.lora_anima",
        "network_dim": 32, "network_alpha": 16, "network_train_unet_only": True,
        "save_precision": "bf16", **updates,
    })


def group(result, suffix):
    return next(g for g in result["groups"] if g["name"].endswith(suffix))


class ShapePreviewTests(unittest.TestCase):
    def test_preview_logging_is_scoped_and_keeps_diagnostics(self):
        from backend.training import shape_preview

        logger = logging.getLogger("LyCORIS")
        root = logging.getLogger()
        for fail in (False, True):
            with self.subTest(fail=fail):
                previous_disable = logging.root.manager.disable
                previous_filters = list(logger.filters)
                previous_level = logger.level
                # lycoris 导入后把 LyCORIS logger 设为 propagate=False 并挂自己的
                # handler；这里显式接管，使捕获不依赖测试执行顺序。
                previous_propagate = logger.propagate
                previous_handlers = list(logger.handlers)
                previous_root_handlers = list(root.handlers)
                handler = _ListHandler()
                root.handlers = []
                root.addHandler(handler)
                logger.handlers = []
                logger.propagate = True
                logger.setLevel(logging.INFO)

                def constructor(form):
                    logger.info("Create LyCORIS Module")
                    logger.warning("UNet: No modules matched the following target module classes: ['OtherModel']")
                    logger.warning("lora_dim 32 is too large for dim=2048 and factor=-1, using full matrix mode.")
                    logging.getLogger("networks.lokr").warning("LoKr: lora_dim 32 is large for dim=2048 and factor=-1, using full matrix mode.")
                    logger.warning("Invalid rank setting")
                    logger.error("Preview diagnostic")
                    if fail:
                        raise ValueError("Invalid configuration")
                    return {"moduleCount": 1}

                try:
                    with patch.object(shape_preview, "_inspect_network", new=constructor):
                        if fail:
                            with self.assertRaisesRegex(ValueError, "Invalid configuration"):
                                inspect_network({})
                        else:
                            self.assertEqual(inspect_network({}), {"moduleCount": 1})
                    self.assertEqual(
                        [record.getMessage() for record in handler.records],
                        ["Invalid rank setting", "Preview diagnostic"],
                    )
                    self.assertEqual(logging.root.manager.disable, previous_disable)
                    self.assertEqual(logger.filters, previous_filters)
                    logger.info("Training logging remains enabled")
                    self.assertEqual(handler.records[-1].getMessage(), "Training logging remains enabled")
                finally:
                    root.handlers = previous_root_handlers
                    logger.handlers = previous_handlers
                    logger.propagate = previous_propagate
                    logger.setLevel(previous_level)

    def test_native_scope_and_adaln(self):
        for module in ("networks.lora_anima", "networks.loha", "networks.lokr"):
            with self.subTest(module=module):
                base = estimate(network_module=module)
                expanded = estimate(network_module=module, train_adaln=True)
                self.assertEqual(base["moduleCount"], 280)
                self.assertEqual(expanded["moduleCount"], 448)
                self.assertGreater(expanded["weightBytes"], base["weightBytes"])
                self.assertFalse(any(g["name"].startswith("final_layer") for g in expanded["groups"]))
                self.assertEqual(group(expanded, "adaln_modulation_mlp.2")["out"], 6144)

    def test_lycoris_scope_and_preset_reset(self):
        for algo in ("lora", "loha", "lokr"):
            with self.subTest(algo=algo):
                args = dict(network_module="lycoris.kohya", lycoris_algo=algo, lycoris_preset="attn-mlp")
                self.assertEqual(estimate(**args, lycoris_anima_sd_default=True)["moduleCount"], 280)
                self.assertEqual(estimate(**args, lycoris_anima_sd_default=True, lycoris_anima_train_adaln=True)["moduleCount"], 448)
                full = estimate(**args)
                self.assertEqual(full["moduleCount"], 454)
                self.assertEqual(group(full, "x_embedder.proj.1")["in"], 68)
                self.assertEqual(group(full, "final_layer.linear")["out"], 64)
                self.assertEqual(group(full, "final_layer.adaln_modulation.2")["out"], 4096)
                self.assertEqual(group(full, "t_embedder.1.linear_2")["out"], 6144)

    def test_lokr_thresholds_are_per_layer(self):
        result = estimate(network_module="networks.lokr", train_adaln=True)
        self.assertTrue(group(result, "self_attn.q_proj")["w2Full"])
        self.assertFalse(group(result, "mlp.layer1")["w2Full"])
        self.assertFalse(group(result, "adaln_modulation_mlp.2")["w2Full"])

    def test_decompose_both_toggle_matches_actual_matrices(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                result = estimate(network_module="lycoris.kohya", lycoris_algo="lokr",
                                  network_dim=1, lokr_factor=4, decompose_both=enabled)
                selected = group(result, "self_attn.q_proj")
                self.assertIs(selected["decomposeBoth"], enabled)
                self.assertEqual("lokr_w1_a" in selected["shapes"], enabled)
                self.assertNotEqual("lokr_w1" in selected["shapes"], enabled)

    def test_disabled_decompose_both_overrides_custom_argument(self):
        from backend.training.adapter import adapt_config

        config, _ = adapt_config({"model_train_type": "anima-lora",
                                  "network_module": "lycoris.kohya", "lycoris_algo": "lokr",
                                  "network_args_custom": "decompose_both=true", "decompose_both": False})
        self.assertFalse(any(arg.startswith("decompose_both=") for arg in config["network_args"]))

    def test_scalar_is_folded_on_save_and_dora_is_counted(self):
        for algo in ("lora", "loha", "lokr"):
            with self.subTest(algo=algo):
                args = dict(network_module="lycoris.kohya", lycoris_algo=algo, lycoris_preset="attn-mlp")
                base = estimate(**args)
                scalar = estimate(**args, use_scalar=True)
                dora = estimate(**args, dora_wd=True, wd_on_output=False)
                self.assertEqual(scalar["params"], base["params"] + base["moduleCount"])
                self.assertEqual(scalar["weightBytes"], base["weightBytes"])
                extra = sum(g["in"] * g["count"] for g in base["groups"])
                self.assertEqual(dora["params"], base["params"] + extra)
                self.assertEqual(dora["weightBytes"], base["weightBytes"] + extra * 2)

    def test_rs_lokr_full_scale_and_fractional_alpha(self):
        result = estimate(network_module="lycoris.kohya", lycoris_algo="lokr", full_matrix=True, rs_lora=True)
        self.assertTrue(math.isclose(group(result, "self_attn.q_proj")["scale"], math.sqrt(32), rel_tol=1e-6))
        self.assertEqual(group(estimate(network_alpha=0.5), "self_attn.q_proj")["scale"], 0.5 / 32)

    def test_adapter_and_save_precision(self):
        base = estimate()
        adapter = estimate(network_args_custom="train_llm_adapter=true")
        self.assertEqual(adapter["moduleCount"], base["moduleCount"] + 60)
        self.assertFalse(any(g["name"] == "llm_adapter.out_proj" for g in adapter["groups"]))
        self.assertEqual(estimate(save_precision="float")["weightBytes"], base["weightBytes"] * 2)

    def test_native_per_layer_dim_and_custom_include(self):
        result = estimate(network_args=["network_reg_dims=blocks.0.self_attn.q_proj=8", "include_patterns=['final_layer.*']"])
        self.assertEqual(result["moduleCount"], 283)
        selected = next(g for g in result["groups"] if "blocks.0.self_attn.q_proj" in g["paths"])
        self.assertEqual(selected["rank"], 8)
        self.assertEqual(selected["count"], 1)

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

    def test_custom_preset_algorithm_and_factor(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            preset = tmp_path / "preset.toml"
            preset.write_text('unet_target_module = []\nunet_target_name = ["blocks.0.self_attn.q_proj"]\n[name_algo_map."blocks.0.self_attn.q_proj"]\nalgo = "lokr"\ndim = 8\nfactor = 8\n', encoding="utf-8")
            result = estimate(network_module="lycoris.kohya", lycoris_algo="lora", lycoris_preset=str(preset))
            selected = next(g for g in result["groups"] if "blocks.0.self_attn.q_proj" in g["paths"])
            self.assertEqual(selected["algo"], "lokr")
            self.assertEqual(selected["rank"], 8)
            self.assertEqual(selected["factor"], 8)

    def test_text_encoder_scope(self):
        both = estimate(network_train_unet_only=False)
        text_only = estimate(network_train_unet_only=False, network_train_text_encoder_only=True)
        self.assertGreater(text_only["moduleCount"], 0)
        self.assertEqual(both["moduleCount"], text_only["moduleCount"] + 280)
        self.assertTrue(all(g["name"].startswith("qwen3.") for g in text_only["groups"]))

    def test_unsupported_configs_are_explicit(self):
        for updates in ({"dim_from_weights": True}, {"network_module": "custom.module"}):
            with self.subTest(updates=updates):
                with self.assertRaises(ValueError):
                    estimate(**updates)


if __name__ == "__main__":
    unittest.main()
