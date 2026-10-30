import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from safetensors.torch import save_file

from backend.training.preview.config import normalize_loras, prepare_config, read_config
from backend.training.preview.compat import check_source, PreviewCompatibilityError
from backend.training.preview.lora import LoRAManager, PreviewLoRAError


class TinyDiT(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = torch.nn.ModuleList([torch.nn.Module()])
        self.layers[0].proj = torch.nn.Module()
        for name in ("q", "k", "v"):
            setattr(self.layers[0].proj, name, torch.nn.Linear(4, 3, bias=False))


class PreviewLoRATests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.saved_files = 0
        self.model = TinyDiT()

    def file(self, name="one", base="diffusion_model.layers.0.proj.q", rank=2, out=3,
             suffixes=("lora_down.weight", "lora_up.weight"), alpha=2):
        state = {base + "." + suffixes[0]: torch.arange(rank * 4).reshape(rank, 4).float() / 10,
                 base + "." + suffixes[1]: torch.arange(out * rank).reshape(out, rank).float() / 10}
        if alpha is not None:
            state[base + ".alpha"] = torch.tensor(float(alpha))
        self.saved_files += 1
        path = Path(self.temp.name) / f"{name}-{self.saved_files}.safetensors"
        save_file(state, path)
        return str(path), state

    def test_multiple_adapters_preserve_training_branch_optimizer_and_saved_keys(self):
        path1, state1 = self.file()
        path2, state2 = self.file("two", base="lora_unet_layers_0_proj_q", alpha=4)
        layer = self.model.layers[0].proj.q
        trained = torch.nn.Parameter(torch.ones(3) * 0.1)
        original = layer.forward
        layer.forward = lambda x: original(x) + trained
        original_forward = layer.forward
        optimizer = torch.optim.SGD([trained], lr=0.01)
        x = torch.ones(2, 4)
        layer(x).sum().backward()
        optimizer.step()
        optimizer.zero_grad()
        before = copy.deepcopy(self.model.state_dict())
        trained_before = trained.detach().clone()
        manager = LoRAManager([{"path": path1, "multiplier": 0.5},
                               {"path": path2, "multiplier": -0.25}], "moss_image")
        baseline = layer(x).detach()
        expected = baseline.clone()
        for state, base, scale in [(state1, "diffusion_model.layers.0.proj.q", 0.5),
                                   (state2, "lora_unet_layers_0_proj_q", -0.5)]:
            expected += x @ state[base + ".lora_down.weight"].T @ state[base + ".lora_up.weight"].T * scale
        with manager.activate(manager.prepare(self.model), "cpu"), torch.no_grad():
            torch.testing.assert_close(layer(x), expected)
            self.assertEqual(set(before), set(self.model.state_dict()))
            self.assertEqual(len(optimizer.param_groups[0]["params"]), 1)
        self.assertIs(layer.forward, original_forward)
        torch.testing.assert_close(trained, trained_before)
        for key, value in before.items():
            torch.testing.assert_close(self.model.state_dict()[key], value, rtol=0, atol=0)
        layer(x).sum().backward()
        optimizer.step()
        self.assertFalse(torch.equal(trained, trained_before))

    def test_formats_and_missing_alpha_for_both_models(self):
        x = torch.ones(1, 4)
        layer = self.model.layers[0].proj.q
        baseline = layer(x)
        for architecture in ("moss_image", "anima"):
            for suffixes in (("lora_down.weight", "lora_up.weight"),
                             ("lora_A.weight", "lora_B.weight"),
                             ("lora_A.default.weight", "lora_B.default.weight")):
                path, state = self.file(suffixes=suffixes, alpha=None)
                manager = LoRAManager([{"path": path, "multiplier": 1}], architecture)
                with manager.activate(manager.prepare(self.model), "cpu"):
                    expected = baseline + x @ state["diffusion_model.layers.0.proj.q." + suffixes[0]].T @ state["diffusion_model.layers.0.proj.q." + suffixes[1]].T
                    torch.testing.assert_close(layer(x), expected)
                self.assertNotIn("forward", layer.__dict__)

    def test_fused_moss_qkv_is_split_along_up_output(self):
        path, state = self.file(base="diffusion_model.layers.0.proj.qkv", out=9)
        manager = LoRAManager([{"path": path, "multiplier": 1}], "moss_image")
        prepared = manager.prepare(self.model)
        self.assertEqual(len(prepared), 3)
        for index, projection in enumerate(("q", "k", "v")):
            branch = prepared[getattr(self.model.layers[0].proj, projection)][0]
            torch.testing.assert_close(branch.up, state["diffusion_model.layers.0.proj.qkv.lora_up.weight"][index * 3:(index + 1) * 3])

    def test_invalid_second_adapter_does_not_patch_any_layer(self):
        good, _ = self.file()
        for kwargs in ({"base": "diffusion_model.missing"}, {"out": 4},
                       {"base": "lora_te_layers_0_self_attn_q_proj"}, {"alpha": float("nan")}):
            bad, _ = self.file("bad", **kwargs)
            manager = LoRAManager([{"path": good, "multiplier": 1}, {"path": bad, "multiplier": 1}], "anima")
            with self.assertRaises(PreviewLoRAError):
                manager.prepare(self.model)
            self.assertNotIn("forward", self.model.layers[0].proj.q.__dict__)

    def test_partial_and_unsupported_weights_are_rejected(self):
        _, state = self.file()
        for index, key in enumerate(("diffusion_model.layers.0.proj.q.lora_up.weight", None)):
            invalid = dict(state)
            if key:
                invalid.pop(key)
            else:
                invalid["diffusion_model.layers.0.proj.q.unknown_adapter_tensor"] = torch.ones(3)
            path = Path(self.temp.name) / f"invalid-{index}.safetensors"
            save_file(invalid, path)
            with self.assertRaises(PreviewLoRAError):
                LoRAManager([{"path": path, "multiplier": 1}], "anima").prepare(self.model)

    def test_exception_and_zero_strength_restore_forward(self):
        path, _ = self.file()
        manager = LoRAManager([{"path": path, "multiplier": 0}], "anima")
        with self.assertRaisesRegex(ValueError, "sample"):
            with manager.activate(manager.prepare(self.model), "cpu"):
                self.assertNotIn("forward", self.model.layers[0].proj.q.__dict__)
                raise ValueError("sample failed")
        self.assertFalse(manager._active)

    def test_empty_and_disabled_adapters_skip_model_inspection_and_weight_loading(self):
        for architecture in ("anima", "moss_image"):
            for rows in ([], [{"path": "missing.safetensors", "multiplier": 0}]):
                with self.subTest(architecture=architecture, rows=rows):
                    manager = LoRAManager(rows, architecture)
                    layer = self.model.layers[0].proj.q
                    x = torch.ones(1, 4)
                    expected = layer(x)
                    with patch.object(self.model, "named_modules", side_effect=AssertionError("unexpected model inspection")), \
                         patch.object(manager, "_weights", side_effect=AssertionError("unexpected weight loading")):
                        self.assertFalse(manager.needs_text_encoder)
                        plan = manager.prepare(self.model, self.model)
                        self.assertEqual(plan, {})
                        with manager.activate(plan, "cpu"):
                            torch.testing.assert_close(layer(x), expected, rtol=0, atol=0)
                    self.assertNotIn("forward", layer.__dict__)

    def test_fp32_branch_survives_sampler_autocast(self):
        path, _ = self.file(alpha=2)
        self.model.to(torch.bfloat16)
        manager = LoRAManager([{"path": path, "multiplier": 1}], "moss_image")
        x = torch.ones(1, 4, dtype=torch.bfloat16)
        layer = self.model.layers[0].proj.q
        baseline = layer(x)
        branches = manager.prepare(self.model)
        branch = branches[layer][0]
        expected = baseline + (x.float() @ branch.down.T @ branch.up.T).to(baseline.dtype)
        with manager.activate(branches, "cpu"), torch.autocast("cpu", dtype=torch.bfloat16):
            torch.testing.assert_close(layer(x), expected, rtol=0, atol=0)

    def test_configuration_is_profile_scoped_and_round_trips_yaml(self):
        from backend.training.config.training_config import build_training_config, extract_training_form
        from backend.training.config.adapter import adapt_config

        path, _ = self.file()
        rows = [{"path": path, "multiplier": -0.5}, {"path": path, "multiplier": 0}]
        for profile in ("anima-lora", "moss-image-lora"):
            form = {"model_train_type": profile, "enable_preview": True, "preview_loras": rows}
            restored = extract_training_form(build_training_config(form, profile_id=profile))
            self.assertEqual(restored["preview_loras"], rows)
            adapted, _ = adapt_config(form)
            self.assertNotIn("preview_loras", adapted)
            config = prepare_config(form, profile)
            target = Path(self.temp.name) / "preview.json"
            target.write_text(json.dumps(config), encoding="utf-8")
            self.assertEqual(read_config(target), config)
        self.assertIsNone(prepare_config({"enable_preview": False, "preview_loras": rows}, "anima-lora"))
        self.assertIsNone(prepare_config({"enable_preview": True, "preview_loras": rows}, "sdxl-lora"))

    def test_invalid_config_and_upstream_contract(self):
        for value in ({}, [None], [{"path": ""}], [{"path": "x.invalid"}],
                      [{"path": "x.safetensors", "multiplier": value} for value in (True, "", "nan", "inf")]):
            with self.assertRaises(ValueError):
                normalize_loras(value)
        for architecture in ("anima", "moss_image"):
            check_source(architecture)
        with self.assertRaises(PreviewCompatibilityError):
            check_source("anima", self.temp.name)

    def test_disabled_rows_need_no_files_or_compatibility_hook(self):
        rows = [{"path": "missing.invalid", "multiplier": 0}, {"path": "", "multiplier": 0}]
        self.assertEqual(normalize_loras(rows, check_files=True), rows)
        with patch("backend.training.preview.compat.check_source", side_effect=AssertionError("must skip")):
            self.assertIsNone(prepare_config({"enable_preview": True, "preview_loras": rows}, "anima-lora"))

    def test_import_validation_rejects_invalid_lists_and_preserves_incomplete_drafts(self):
        from backend.training.config.training_config import build_training_config, extract_training_form, TrainingConfigError

        for value in ({"path": "one"}, [None], [{"path": 12}], [{"multiplier": True}]):
            document = build_training_config({"enable_preview": True, "preview_loras": value}, profile_id="anima-lora")
            with self.assertRaises(TrainingConfigError):
                extract_training_form(document)
        rows = [{"path": "", "multiplier": ""}, {"path": "", "multiplier": 1}]
        document = build_training_config({"enable_preview": True, "preview_loras": rows}, profile_id="anima-lora")
        self.assertEqual(extract_training_form(document)["preview_loras"], rows)

    def test_comfy_text_encoder_aliases_match_moss_and_generic_names(self):
        text_encoder = torch.nn.Module()
        text_encoder.proj = torch.nn.Linear(4, 3, bias=False)
        x = torch.ones(1, 4)
        baseline = text_encoder.proj(x)
        for prefix in ("text_encoders.qwen35_9b.transformer.model.", "text_encoders.transformer.model."):
            path, state = self.file(base=prefix + "proj")
            manager = LoRAManager([{"path": path, "multiplier": 0.5}], "moss_image")
            expected = baseline + x @ state[prefix + "proj.lora_down.weight"].T @ state[prefix + "proj.lora_up.weight"].T * 0.5
            with manager.activate(manager.prepare(self.model, text_encoder), "cpu"):
                torch.testing.assert_close(text_encoder.proj(x), expected)

    def test_fused_input_axis_dora_reads_prior_q_k_v_states(self):
        q_path, q_state = self.file()
        dora_path, state = self.file("fused-dora", base="diffusion_model.layers.0.proj.qkv", out=9)
        state["diffusion_model.layers.0.proj.qkv.dora_scale"] = torch.rand(1, 4) + 0.5
        save_file(state, dora_path)
        targets = [getattr(self.model.layers[0].proj, name) for name in ("q", "k", "v")]
        original = torch.cat([target.weight.detach() for target in targets])
        prefix = original.clone()
        prefix[:3] += q_state["diffusion_model.layers.0.proj.q.lora_up.weight"] @ q_state["diffusion_model.layers.0.proj.q.lora_down.weight"] * 0.5
        key = "diffusion_model.layers.0.proj.qkv."
        merged = prefix + state[key + "lora_up.weight"] @ state[key + "lora_down.weight"]
        normalized = merged * state[key + "dora_scale"] / merged.norm(dim=0, keepdim=True)
        expected = prefix + (normalized - prefix) * 0.4
        x = torch.randn(2, 4)
        manager = LoRAManager([{"path": q_path, "multiplier": 0.5}, {"path": dora_path, "multiplier": 0.4}], "moss_image")
        with manager.activate(manager.prepare(self.model), "cpu"):
            actual = torch.cat([target(x) for target in targets], dim=-1)
            torch.testing.assert_close(actual, torch.nn.functional.linear(x, expected), rtol=1e-5, atol=1e-6)
        torch.testing.assert_close(torch.cat([target.weight for target in targets]), original, rtol=0, atol=0)

    def test_legacy_torch_weights_are_loaded_as_tensors_only(self):
        _, state = self.file()
        path = Path(self.temp.name) / "legacy.pt"
        torch.save({"state_dict": state}, path)
        rows = normalize_loras([{"path": str(path), "multiplier": 1}], check_files=True)
        manager = LoRAManager(rows, "anima")
        self.assertTrue(manager.prepare(self.model))

    def test_allocation_failure_leaves_model_unmodified(self):
        from backend.training.preview.adapters import Adapter

        path, _ = self.file()
        manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
        prepared = manager.prepare(self.model)
        with patch.object(Adapter, "to", side_effect=RuntimeError("allocation failed")):
            with self.assertRaisesRegex(RuntimeError, "allocation"):
                with manager.activate(prepared, "cpu"):
                    self.fail("preview must not start after allocation failure")
        self.assertNotIn("forward", self.model.layers[0].proj.q.__dict__)
        self.assertFalse(manager._active)
