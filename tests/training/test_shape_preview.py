"""Exercise the vendored constructors used by the Anima shape inspector."""
import math
import logging

import pytest

from backend.training.shape_preview import inspect_network


@pytest.mark.parametrize("fail", [False, True])
def test_preview_logging_is_scoped_and_keeps_diagnostics(monkeypatch, caplog, fail):
    from backend.training import shape_preview

    logger = logging.getLogger("LyCORIS")
    previous_level = logging.root.manager.disable
    previous_filters = list(logger.filters)

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

    monkeypatch.setattr(shape_preview, "_inspect_network", constructor)
    with caplog.at_level(logging.INFO, logger="LyCORIS"):
        if fail:
            with pytest.raises(ValueError, match="Invalid configuration"):
                inspect_network({})
        else:
            assert inspect_network({}) == {"moduleCount": 1}
        assert [record.getMessage() for record in caplog.records] == ["Invalid rank setting", "Preview diagnostic"]
        assert logging.root.manager.disable == previous_level
        assert logger.filters == previous_filters
        logger.info("Training logging remains enabled")
        assert caplog.records[-1].getMessage() == "Training logging remains enabled"


def estimate(**updates):
    return inspect_network({
        "model_train_type": "anima-lora", "network_module": "networks.lora_anima",
        "network_dim": 32, "network_alpha": 16, "network_train_unet_only": True,
        "save_precision": "bf16", **updates,
    })


def group(result, suffix):
    return next(g for g in result["groups"] if g["name"].endswith(suffix))


@pytest.mark.parametrize("module", ["networks.lora_anima", "networks.loha", "networks.lokr"])
def test_native_scope_and_adaln(module):
    base = estimate(network_module=module)
    expanded = estimate(network_module=module, train_adaln=True)
    assert base["moduleCount"] == 280
    assert expanded["moduleCount"] == 448
    assert expanded["weightBytes"] > base["weightBytes"]
    assert not any(g["name"].startswith("final_layer") for g in expanded["groups"])
    assert group(expanded, "adaln_modulation_mlp.2")["out"] == 6144


@pytest.mark.parametrize("algo", ["lora", "loha", "lokr"])
def test_lycoris_scope_and_preset_reset(algo):
    args = dict(network_module="lycoris.kohya", lycoris_algo=algo, lycoris_preset="attn-mlp")
    assert estimate(**args, lycoris_anima_sd_default=True)["moduleCount"] == 280
    assert estimate(**args, lycoris_anima_sd_default=True, lycoris_anima_train_adaln=True)["moduleCount"] == 448
    full = estimate(**args)
    assert full["moduleCount"] == 454
    assert group(full, "x_embedder.proj.1")["in"] == 68
    assert group(full, "final_layer.linear")["out"] == 64
    assert group(full, "final_layer.adaln_modulation.2")["out"] == 4096
    assert group(full, "t_embedder.1.linear_2")["out"] == 6144


def test_lokr_thresholds_are_per_layer():
    result = estimate(network_module="networks.lokr", train_adaln=True)
    assert group(result, "self_attn.q_proj")["w2Full"]
    assert not group(result, "mlp.layer1")["w2Full"]
    assert not group(result, "adaln_modulation_mlp.2")["w2Full"]


@pytest.mark.parametrize("enabled", [False, True])
def test_decompose_both_toggle_matches_actual_matrices(enabled):
    result = estimate(network_module="lycoris.kohya", lycoris_algo="lokr",
                      network_dim=1, lokr_factor=4, decompose_both=enabled)
    selected = group(result, "self_attn.q_proj")
    assert selected["decomposeBoth"] is enabled
    assert ("lokr_w1_a" in selected["shapes"]) is enabled
    assert ("lokr_w1" in selected["shapes"]) is not enabled


def test_disabled_decompose_both_overrides_custom_argument():
    from backend.training.adapter import adapt_config

    config, _ = adapt_config({"model_train_type": "anima-lora",
                              "network_module": "lycoris.kohya", "lycoris_algo": "lokr",
                              "network_args_custom": "decompose_both=true", "decompose_both": False})
    assert not any(arg.startswith("decompose_both=") for arg in config["network_args"])


@pytest.mark.parametrize("algo", ["lora", "loha", "lokr"])
def test_scalar_is_folded_on_save_and_dora_is_counted(algo):
    args = dict(network_module="lycoris.kohya", lycoris_algo=algo, lycoris_preset="attn-mlp")
    base = estimate(**args)
    scalar = estimate(**args, use_scalar=True)
    dora = estimate(**args, dora_wd=True, wd_on_output=False)
    assert scalar["params"] == base["params"] + base["moduleCount"]
    assert scalar["weightBytes"] == base["weightBytes"]
    extra = sum(g["in"] * g["count"] for g in base["groups"])
    assert dora["params"] == base["params"] + extra
    assert dora["weightBytes"] == base["weightBytes"] + extra * 2


def test_rs_lokr_full_scale_and_fractional_alpha():
    result = estimate(network_module="lycoris.kohya", lycoris_algo="lokr", full_matrix=True, rs_lora=True)
    assert group(result, "self_attn.q_proj")["scale"] == pytest.approx(math.sqrt(32))
    assert group(estimate(network_alpha=0.5), "self_attn.q_proj")["scale"] == 0.5 / 32


def test_adapter_and_save_precision():
    base = estimate()
    adapter = estimate(network_args_custom="train_llm_adapter=true")
    assert adapter["moduleCount"] == base["moduleCount"] + 60
    assert not any(g["name"] == "llm_adapter.out_proj" for g in adapter["groups"])
    assert estimate(save_precision="float")["weightBytes"] == base["weightBytes"] * 2


def test_native_per_layer_dim_and_custom_include():
    result = estimate(network_args=["network_reg_dims=blocks.0.self_attn.q_proj=8", "include_patterns=['final_layer.*']"])
    assert result["moduleCount"] == 283
    selected = next(g for g in result["groups"] if "blocks.0.self_attn.q_proj" in g["paths"])
    assert selected["rank"] == 8
    assert selected["count"] == 1


@pytest.mark.parametrize("module_name,class_name", [("networks.lora_anima", "LoRAModule"), ("networks.loha", "LoHaModule"), ("networks.lokr", "LoKrModule")])
def test_estimated_bytes_match_saved_safetensors(tmp_path, module_name, class_name):
    import importlib
    import torch
    from safetensors.torch import save_file

    result = estimate(network_module=module_name, network_args=["exclude_patterns=['.*']", "include_patterns=['x_embedder.*']"])
    assert result["moduleCount"] == 1
    cls = getattr(importlib.import_module(module_name), class_name)
    adapter = cls("lora_unet_x_embedder_proj_1", torch.nn.Linear(68, 2048, bias=False), lora_dim=32, alpha=16)
    del adapter.org_module
    state = {"lora_unet_x_embedder_proj_1." + key: value.to(torch.bfloat16) for key, value in adapter.state_dict().items()}
    path = tmp_path / "adapter.safetensors"
    save_file(state, str(path))
    assert path.stat().st_size == result["estimatedBytes"]


@pytest.mark.parametrize("algo,class_name", [("locon", "LoConModule"), ("loha", "LohaModule"), ("lokr", "LokrModule")])
def test_lycoris_serialization_with_dora_and_scalar(tmp_path, algo, class_name):
    import importlib
    import torch
    from safetensors.torch import save_file

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
    assert path.stat().st_size == result["estimatedBytes"]
    assert sum(p.numel() for p in adapter.parameters()) == result["params"]


def test_custom_preset_algorithm_and_factor(tmp_path):
    preset = tmp_path / "preset.toml"
    preset.write_text('unet_target_module = []\nunet_target_name = ["blocks.0.self_attn.q_proj"]\n[name_algo_map."blocks.0.self_attn.q_proj"]\nalgo = "lokr"\ndim = 8\nfactor = 8\n', encoding="utf-8")
    result = estimate(network_module="lycoris.kohya", lycoris_algo="lora", lycoris_preset=str(preset))
    selected = next(g for g in result["groups"] if "blocks.0.self_attn.q_proj" in g["paths"])
    assert selected["algo"] == "lokr"
    assert selected["rank"] == 8
    assert selected["factor"] == 8


def test_text_encoder_scope():
    both = estimate(network_train_unet_only=False)
    text_only = estimate(network_train_unet_only=False, network_train_text_encoder_only=True)
    assert text_only["moduleCount"] > 0
    assert both["moduleCount"] == text_only["moduleCount"] + 280
    assert all(g["name"].startswith("qwen3.") for g in text_only["groups"])


@pytest.mark.parametrize("updates", [{"dim_from_weights": True}, {"network_module": "custom.module"}])
def test_unsupported_configs_are_explicit(updates):
    with pytest.raises(ValueError):
        estimate(**updates)
