"""Exercise generated configs through musubi's real Krea2 network builder.

Usage: venv/Scripts/python.exe -B tools/dev/check_krea2_networks.py --device cuda
Add --block-swap to check both offloaders, --flash to exercise FlashAttention,
or --kernel-backend auto to check automatic LyCORIS kernel selection.
Uses small dimensions with real Krea2 classes; it does not load user checkpoints.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.runtime_paths import configure_test_paths
configure_test_paths()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--block-swap", action="store_true")
    parser.add_argument("--flash", action="store_true")
    parser.add_argument("--case", default="", help="Run one case by name")
    parser.add_argument("--kernel-backend", choices=("auto", "torch", "triton", "tilelang", "compile"), default="torch")
    options = parser.parse_args()
    os.environ["LYCORIS_KERNEL_BACKEND"] = options.kernel_backend
    os.environ["ANIMA_ENABLE_FLASH_ATTN"] = "1" if options.flash else "0"
    sys.path[:0] = [str(ROOT / "vendor/musubi-tuner/src"), str(ROOT / "vendor")]

    import torch
    from musubi_tuner.krea2.krea2_mmdit import SingleMMDiTConfig, SingleStreamDiT
    from backend.training.krea2_train import Krea2Trainer, krea2_setup_parser, setup_parser_common
    from musubi_tuner.modules.custom_offloading_utils import BlockSwapConfig
    from musubi_tuner.modules.fp8_optimization_utils import apply_fp8_monkey_patch
    from backend.training import toml_writer
    from backend.training.krea2_network import build_krea2_network_preset, KREA2_PRESET_FILENAME, linear_target_names, selected_targets
    from backend.training.musubi_krea2 import KREA2_FIELDS, validate_krea2_config, build_krea2_train_config

    torch.set_num_threads(2)
    device = torch.device(options.device)
    dtype = torch.bfloat16 if device.type == "cuda" else torch.float32
    results = []
    model_config = dict(features=32, tdim=16, txtdim=32, heads=2, multiplier=1,
                        patch=1, channels=4, kvheads=1, txtlayers=2, txtheads=2, txtkvheads=1)
    geometry = SingleStreamDiT(SingleMMDiTConfig(**model_config, layers=28))
    actual_names = {name for name, layer in geometry.named_modules() if isinstance(layer, torch.nn.Linear)}
    assert actual_names == set(linear_target_names()), actual_names.symmetric_difference(linear_target_names())
    del geometry

    cases = [
        ("lora-attention", {"krea_target_mode": "attention"}),
        ("locon-all", {"network_module": "lycoris.kohya", "lycoris_algo": "lora"}),
        ("locon-plus", {"network_module": "lycoris.kohya", "lycoris_algo": "lora", "enable_loraplus": True,
                        "loraplus_lr_ratio": 3}),
        ("locon-dropout", {"network_module": "lycoris.kohya", "lycoris_algo": "lora", "dropout": 0.2,
                           "rank_dropout": 0.1, "module_dropout": 0.1}),
        ("locon-dora", {"network_module": "lycoris.kohya", "lycoris_algo": "lora", "dora_wd": True,
                        "use_scalar": True, "rs_lora": True, "rank_dropout": 0.1,
                        "krea_target_mode": "attention_mlp"}),
        ("locon-custom", {"network_module": "lycoris.kohya", "lycoris_algo": "lora", "krea_target_mode": "custom",
                          "krea_target_include": "first\nlast\\.linear\nblocks\\..*",
                          "krea_target_exclude": ".*\\.mlp\\..*"}),
        ("lokr-all", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr"}),
        ("loha-all", {"network_module": "lycoris.kohya", "lycoris_algo": "loha"}),
        ("loha-dora", {"network_module": "lycoris.kohya", "lycoris_algo": "loha", "dora_wd": True,
                       "use_scalar": True, "rs_lora": True, "rank_dropout": 0.1,
                       "krea_target_mode": "attention_mlp"}),
        ("lokr-options", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr", "full_matrix": True,
                          "unbalanced_factorization": True, "use_scalar": True, "rs_lora": True,
                          "bypass_mode": True, "module_dropout": 0.1}),
        ("lokr-custom", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr", "lokr_factor": 8,
                         "decompose_both": True, "krea_target_mode": "custom",
                         "krea_target_include": "first\nlast\\.linear\nblocks\\..*", "krea_target_exclude": ".*\\.mlp\\..*"}),
        ("lokr-decompose", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr", "lokr_factor": 8,
                            "decompose_both": True, "network_dim": 1, "network_alpha": 1}),
        ("lokr-no-decompose", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr", "lokr_factor": 8,
                               "decompose_both": False, "network_dim": 1, "network_alpha": 1}),
        ("lokr-dora", {"network_module": "lycoris.kohya", "lycoris_algo": "lokr", "dora_wd": True,
                       "wd_on_output": False}),
    ]
    if device.type == "cuda":
        cases += [(f"{algo}-fp8", {"network_module": "lycoris.kohya", "lycoris_algo": algo,
                                   "fp8_base": True}) for algo in ("lora", "lokr", "loha")]
        cases += [("locon-int8", {"network_module": "lycoris.kohya", "lycoris_algo": "lora", "convrot_int8": True})]
    if options.block_swap:
        assert device.type == "cuda", "Block swapping needs CUDA"
        cases += [(f"{algo}-swap-{'h2d' if h2d else 'standard'}", {
            "network_module": "lycoris.kohya", "lycoris_algo": algo, "blocks_to_swap": 1,
            "block_swap_h2d_only": h2d, "block_swap_ring_size": 2,
            "use_pinned_memory_for_block_swap": True}) for algo in ("lora", "lokr", "loha") for h2d in (False, True)]

    for name, overrides in cases:
        if options.case and options.case != name:
            continue
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            form = {f["key"]: f["default"] for f in KREA2_FIELDS if "default" in f}
            form.update(network_dim=2, network_alpha=2, optimizer_type="AdamW")
            form.update(overrides)
            if options.flash:
                form["krea_attention_backend"] = "flash_attn"
            errors = validate_krea2_config(form)
            assert not errors, errors
            train = build_krea2_train_config(form, directory / "dataset.toml", directory, directory / "log")
            if form["network_module"] == "lycoris.kohya":
                (directory / KREA2_PRESET_FILENAME).write_text(toml_writer.dumps(build_krea2_network_preset(form)), encoding="utf-8")
            args = krea2_setup_parser(setup_parser_common()).parse_args([])
            for key, value in train.items():
                setattr(args, key, value)
            args.network_weights = None
            args.turbo_lora = None
            dimensions = {**model_config, **({"features": 256, "txtdim": 256} if form.get("convrot_int8") else {})}

            def create_base():
                torch.manual_seed(987)
                architecture = SingleMMDiTConfig(**dimensions, layers=4)
                base = SingleStreamDiT(architecture,
                    attn_mode="flash" if options.flash else "torch", split_attn=bool(options.flash)).to(dtype=dtype)
                base.requires_grad_(False)
                if form.get("convrot_int8"):
                    from safetensors.torch import save_file
                    from musubi_tuner.krea2.krea2_utils import load_krea2_dit
                    checkpoint = directory / "tiny-dit.safetensors"
                    save_file(base.state_dict(), str(checkpoint))
                    base = load_krea2_dit(str(checkpoint), device="cpu", dtype=dtype, config=architecture,
                                         convrot_int8=True, convrot_int8_bwd=args.convrot_int8_bwd)
                    base.requires_grad_(False)
                    assert any(p.dtype == torch.int8 for p in base.parameters())
                if form.get("fp8_base"):
                    sd = {}
                    for layer_name, layer in base.named_modules():
                        if layer_name.startswith("blocks.") and isinstance(layer, torch.nn.Linear):
                            weight = layer.weight.float()
                            scale = weight.abs().amax(dim=1, keepdim=True).clamp_min(1e-8) / 448
                            sd[f"{layer_name}.weight"] = (weight / scale).clamp(-448, 448).to(torch.float8_e4m3fn)
                            sd[f"{layer_name}.scale_weight"] = scale.to(dtype)
                    apply_fp8_monkey_patch(base, sd, use_scaled_mm=False)
                    base.load_state_dict(sd, strict=False, assign=True)
                return base

            accelerator = SimpleNamespace(device=device, print=lambda *a, **kw: None)
            base = create_base()
            expected_targets = {"lora_unet_" + layer_name.replace(".", "_")
                                for layer_name in selected_targets(form) if layer_name in dict(base.named_modules())}
            if form.get("blocks_to_swap"):
                base.enable_block_swap(1, BlockSwapConfig.from_args(args, device, supports_backward=True))
                base.move_to_device_except_swap_blocks(device)
            else:
                base.to(device)
            trainer = Krea2Trainer()
            network = trainer._build_network(args, accelerator, base, None, dtype).to(device=device, dtype=dtype)
            assert {layer.lora_name for layer in network.unet_loras} == expected_targets
            if name == "lokr-decompose":
                assert any(not layer.use_w1 for layer in network.unet_loras)
            elif name == "lokr-no-decompose":
                assert all(layer.use_w1 for layer in network.unet_loras)
            parameters, _ = network.prepare_optimizer_params(unet_lr=0.001)
            if form.get("enable_loraplus"):
                assert [group["lr"] for group in parameters] == [0.001, 0.003]
            optimizer = torch.optim.AdamW(parameters, lr=0.001)
            torch.manual_seed(543)
            inputs = (torch.randn(1, 4, 4, device=device, dtype=dtype),
                      torch.randn(1, 2, 2, dimensions["txtdim"], device=device, dtype=dtype),
                      torch.tensor([0.5], device=device), torch.zeros(1, 6, 3, device=device),
                      torch.ones(1, 6, device=device, dtype=torch.bool))
            losses = []
            for _ in range(2):
                base.train()
                network.train()
                if base.blocks_to_swap:
                    base.prepare_block_swap_before_forward()
                optimizer.zero_grad(set_to_none=True)
                loss = base(*inputs).float().square().mean()
                loss.backward()
                gradients = [p.grad for p in network.parameters() if p.grad is not None]
                assert torch.isfinite(loss) and gradients
                assert all(torch.isfinite(g).all() for g in gradients)
                assert any(g.abs().sum() > 0 for g in gradients)
                optimizer.step()
                losses.append(float(loss.detach()))
            base.eval()
            network.eval()
            if base.blocks_to_swap:
                base.switch_block_swap_for_inference()
            with torch.no_grad():
                expected = base(*inputs)
            weights = directory / "adapter.safetensors"
            network.save_weights(str(weights), torch.float32, {})
            # Restore through the same real builder; keep rank/scaling options.
            args.network_weights = str(weights)
            restored_base = create_base().to(device)
            restored = trainer._build_network(args, accelerator, restored_base, None, dtype).to(device=device, dtype=dtype)
            restored_base.eval()
            restored.eval()
            with torch.no_grad():
                actual = restored_base(*inputs)
            torch.testing.assert_close(actual, expected, atol=0.03 if device.type == "cuda" else 1e-5,
                                       rtol=0.03 if device.type == "cuda" else 1e-5)
            result = {"case": name, "targets": len(network.unet_loras), "loss": losses,
                      "forward_backward_optimizer": "passed", "save_reload": "passed"}
            results.append(result)
            print(json.dumps(result), flush=True)
            del optimizer, network, base, restored, restored_base
    output = ROOT / "cache/dev/krea2-network-audit"
    output.mkdir(parents=True, exist_ok=True)
    report = {"device": str(device), "torch": torch.__version__, "flash": options.flash,
              "kernel_backend": options.kernel_backend,
              "full_model_target_names": len(actual_names), "cases": results}
    assert results, f"Unknown case: {options.case}"
    suffix = f"-{options.kernel_backend}" if options.kernel_backend != "torch" else ""
    suffix += f"-{options.case}" if options.case else ""
    (output / f"runtime-{options.device}{'-flash' if options.flash else ''}{suffix}.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8")
    print(f"Passed {len(results)} cases", flush=True)


if __name__ == "__main__":
    main()
