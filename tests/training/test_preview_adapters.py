"""Numerical format compatibility, including mixed algorithms and magnitudes."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import torch
import torch.nn.functional as F
from safetensors.torch import save_file

from backend.training.preview.lora import LoRAManager
from backend.training.preview.rebuild import parse_rebuild
from backend.training.preview.adapters import parse_adapter


class AdapterFormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.saved_files = 0
        self.model = torch.nn.Module()
        self.model.proj = torch.nn.Linear(8, 8, bias=False)

    def save(self, name, weights):
        self.saved_files += 1
        path = Path(self.temp.name) / f"{name}-{self.saved_files}.safetensors"
        save_file({"lora_unet_proj." + key: tensor.contiguous() for key, tensor in weights.items()}, path)
        return str(path)

    def test_mixed_lora_loha_lokr_full_and_decomposed_match_dense_reference(self):
        for architecture in ("anima", "moss_image"):
            groups = [
                ({"lora_down.weight": torch.randn(2, 8), "lora_up.weight": torch.randn(8, 2), "alpha": torch.tensor(1.)}, "lora"),
                ({"hada_w1_a": torch.randn(8, 2), "hada_w1_b": torch.randn(2, 8),
                  "hada_w2_a": torch.randn(8, 2), "hada_w2_b": torch.randn(2, 8), "alpha": torch.tensor(3.)}, "loha"),
                ({"lokr_w1": torch.randn(2, 2), "lokr_w2": torch.randn(4, 4), "alpha": torch.tensor(99.)}, "full-lokr"),
                ({"lokr_w1_a": torch.randn(2, 1), "lokr_w1_b": torch.randn(1, 2),
                  "lokr_w2_a": torch.randn(4, 1), "lokr_w2_b": torch.randn(1, 4), "alpha": torch.tensor(0.7)}, "decomposed-lokr"),
            ]
            rows = []
            total = torch.zeros(8, 8)
            for index, (w, kind) in enumerate(groups):
                strength = (index + 1) * 0.15 * (-1 if index % 2 else 1)
                rows.append({"path": self.save(kind, w), "multiplier": strength})
                if kind == "lora":
                    delta = w["lora_up.weight"] @ w["lora_down.weight"] * 0.5
                elif kind == "loha":
                    delta = (w["hada_w1_a"] @ w["hada_w1_b"]) * (w["hada_w2_a"] @ w["hada_w2_b"]) * 1.5
                elif kind == "full-lokr":
                    delta = torch.kron(w["lokr_w1"], w["lokr_w2"])
                else:
                    delta = torch.kron(w["lokr_w1_a"] @ w["lokr_w1_b"], w["lokr_w2_a"] @ w["lokr_w2_b"]) * 0.7
                total += delta * strength
            x = torch.randn(2, 3, 8)
            baseline = self.model.proj(x)
            manager = LoRAManager(rows, architecture)
            with manager.activate(manager.prepare(self.model), "cpu"):
                torch.testing.assert_close(self.model.proj(x), baseline + F.linear(x, total), rtol=1e-5, atol=1e-5)

    def test_dora_magnitudes_and_strength_match_normalized_weight(self):
        down, up = torch.randn(2, 8), torch.randn(8, 2)
        magnitude = torch.rand(8, 1) + 0.5
        path = self.save("dora", {"lora_down.weight": down, "lora_up.weight": up,
                                  "dora_scale": magnitude, "alpha": torch.tensor(2.)})
        base = self.model.proj.weight.detach()
        full = base + up @ down
        normalized = full * magnitude / full.norm(dim=1, keepdim=True)
        x = torch.randn(2, 8)
        for strength in (0, 0.4, 1, -0.5):
            manager = LoRAManager([{"path": path, "multiplier": strength}], "anima")
            with manager.activate(manager.prepare(self.model), "cpu"):
                torch.testing.assert_close(self.model.proj(x), F.linear(x, base + (normalized - base) * strength), rtol=1e-5, atol=1e-5)

    def test_lokr_keeps_factors_compressed_and_slices_before_projection(self):
        a, b = torch.randn(5, 2), torch.randn(2, 3)
        c, d = torch.randn(4, 2), torch.randn(2, 2)
        x = torch.randn(2, 3, 6)
        for first_full in (False, True):
            for second_full in (False, True):
                group = {**({"lokr_w1": a @ b} if first_full else {"lokr_w1_a": a, "lokr_w1_b": b}),
                         **({"lokr_w2": c @ d} if second_full else {"lokr_w2_a": c, "lokr_w2_b": d})}
                adapter = parse_adapter(group, .7)
                self.assertEqual(sum(t.numel() for t in adapter.weights.values()), sum(t.numel() for t in group.values()))
                dense = torch.kron(a @ b, c @ d) * .7
                torch.testing.assert_close(adapter.apply(x), F.linear(x, dense), rtol=1e-5, atol=1e-5)
                for start, stop in ((0, 4), (4, 8), (8, 20), (0, 7), (7, 14), (14, 20), (1, 3)):
                    branch = adapter.slice_outputs(start, stop)
                    torch.testing.assert_close(branch.apply(x), F.linear(x, dense[start:stop]), rtol=1e-5, atol=1e-5)
                    torch.testing.assert_close(branch.parameter_delta()[0], dense[start:stop], rtol=1e-5, atol=1e-5)
                with patch.object(F, "linear", wraps=F.linear) as linear:
                    adapter.slice_outputs(0, 4).apply(x)
                self.assertEqual(linear.call_args_list[-1].args[1].shape[0], 1)
                adapter.embedding = True
                indices = torch.tensor([[0, 7, 19]])
                torch.testing.assert_close(adapter.apply(indices), F.embedding(indices, dense), rtol=1e-5, atol=1e-5)

    def test_fused_lokr_reuses_shared_second_factor_after_transfer(self):
        for factored in (False, True):
            second = ({"lokr_w2_a": torch.randn(4, 2), "lokr_w2_b": torch.randn(2, 8)}
                      if factored else {"lokr_w2": torch.randn(4, 8)})
            adapter = parse_adapter({"lokr_w1": torch.randn(3, 1), **second}, 1.)
            moved = {}
            branches = [adapter.slice_outputs(start, start + 4).to("meta", moved) for start in (0, 4, 8)]
            for key in second:
                self.assertIs(branches[0].weights[key], branches[1].weights[key])
                self.assertIs(branches[0].weights[key], branches[2].weights[key])

    def test_glora_old_and_new_layout_and_ia3(self):
        a1, a2 = torch.randn(8, 2), torch.randn(2, 8)
        b1, b2 = torch.randn(8, 2), torch.randn(2, 8)
        base = self.model.proj.weight.detach()
        expected = (base @ a1 @ a2 + b1 @ b2) * 0.5
        x = torch.randn(2, 8)
        for old in (False, True):
            for alpha in (None, 1.):
                state = {"a1.weight": a2 if old else a1, "a2.weight": a1 if old else a2,
                         "b1.weight": b2 if old else b1, "b2.weight": b1 if old else b2}
                if alpha is not None:
                    state["alpha"] = torch.tensor(alpha)
                manager = LoRAManager([{"path": self.save("glora", state), "multiplier": 0.7}], "anima")
                with manager.activate(manager.prepare(self.model), "cpu"):
                    delta = expected * (2 if alpha is None else 1)
                    torch.testing.assert_close(self.model.proj(x), F.linear(x, base + delta * 0.7), rtol=1e-5, atol=1e-5)
        for on_input in (0, 1):
            vector = torch.randn(8)
            adapter = parse_rebuild({"weight": vector, "on_input": torch.tensor(on_input)}, 0.3, [self.model.proj])
            adapter = adapter.to("cpu", {})
            expected = base * (vector if on_input else vector[:, None]) * 0.3
            torch.testing.assert_close(adapter.apply(x), F.linear(x, expected))

    def test_full_diff_bias_and_norm_updates(self):
        weight, bias = torch.randn(8, 8), torch.randn(8)
        adapter = parse_rebuild({"diff": weight, "diff_b": bias}, 0.2, [self.model.proj])
        x = torch.randn(2, 8)
        torch.testing.assert_close(adapter.apply(x), F.linear(x, weight * 0.2, bias * 0.2))
        norm = torch.nn.LayerNorm(8)
        weight, bias = torch.randn(8), torch.randn(8)
        adapter = parse_rebuild({"w_norm": weight, "b_norm": bias}, 0.4, [norm])
        expected = F.layer_norm(x, (8,), eps=norm.eps) * weight * 0.4 + bias * 0.4
        torch.testing.assert_close(adapter.apply(x), expected)

    def test_mixed_weight_dependent_formats_follow_list_order_and_restore(self):
        down, up = torch.randn(2, 8) * 0.1, torch.randn(8, 2) * 0.1
        a1, a2 = torch.randn(8, 2) * 0.1, torch.randn(2, 8) * 0.1
        b1, b2 = torch.randn(8, 2) * 0.1, torch.randn(2, 8) * 0.1
        magnitude = torch.rand(8, 1) + 0.5
        files = {
            "lora": self.save("lora", {"lora_down.weight": down, "lora_up.weight": up}),
            "glora": self.save("glora", {"a1.weight": a1, "a2.weight": a2, "b1.weight": b1, "b2.weight": b2}),
            "dora": self.save("dora", {"lora_down.weight": down, "lora_up.weight": up, "dora_scale": magnitude}),
        }
        layer = self.model.proj
        base = layer.weight.detach().clone()
        x = torch.randn(2, 8)
        for sequence in (("lora", "glora", "dora"), ("dora", "glora", "lora")):
            expected = base.clone()
            for kind in sequence:
                if kind == "lora":
                    delta = up @ down
                elif kind == "glora":
                    delta = expected @ a1 @ a2 + b1 @ b2
                else:
                    merged = expected + up @ down
                    delta = merged * magnitude / merged.norm(dim=1, keepdim=True) - expected
                expected = expected + delta * 0.5
            manager = LoRAManager([{"path": files[kind], "multiplier": 0.5} for kind in sequence], "anima")
            with manager.activate(manager.prepare(self.model), "cpu"):
                torch.testing.assert_close(layer(x), F.linear(x, expected), rtol=1e-5, atol=1e-6)
            torch.testing.assert_close(layer.weight, base, rtol=0, atol=0)
            self.assertNotIn("forward", layer.__dict__)

    def test_oft_and_butterfly_oft_use_native_reconstruction(self):
        from backend.training.preview.rebuild import lycoris_modules
        import importlib

        for shape in ((2, 4, 4), (2, 2, 4, 4)):
            state = {"oft_blocks": torch.randn(shape) * 0.01, "alpha": torch.tensor(0.)}
            adapter = parse_rebuild(state, 0.4, [self.model.proj]).to("cpu", {})
            x = torch.randn(2, 8)
            base = self.model.proj.weight.detach()
            package = lycoris_modules().__package__.rsplit(".", 1)[0]
            functional = importlib.import_module(package + ".functional." + ("diag_oft" if len(shape) == 3 else "boft"))
            options = {"scale": 0.4} if len(shape) == 4 else {}
            expected = functional.diff_weight(base, state["oft_blocks"], None, constraint=0, backend="torch", **options)
            if len(shape) == 3:
                expected *= 0.4
            torch.testing.assert_close(adapter.apply(x), F.linear(x, expected), rtol=1e-5, atol=1e-6)

    def test_convolutional_locon_uses_native_tensor_geometry(self):
        model = torch.nn.Module()
        model.proj = torch.nn.Conv2d(4, 6, 3, padding=1, bias=False)
        down, up = torch.randn(2, 4, 3, 3), torch.randn(6, 2, 1, 1)
        path = self.save("locon", {"lora_down.weight": down, "lora_up.weight": up, "alpha": torch.tensor(2.)})
        manager = LoRAManager([{"path": path, "multiplier": 0.3}], "anima")
        x = torch.randn(1, 4, 8, 8)
        baseline = model.proj(x)
        expected = F.conv2d(F.conv2d(x, down, padding=1), up) * 0.3
        with manager.activate(manager.prepare(model), "cpu"):
            torch.testing.assert_close(model.proj(x), baseline + expected, rtol=1e-5, atol=1e-5)

    def test_embedding_lora_and_standalone_bias_patches(self):
        model = torch.nn.Module()
        model.proj = torch.nn.Embedding(8, 4)
        down, up = torch.randn(2, 4), torch.randn(8, 2)
        path = self.save("embedding", {"lora_down.weight": down, "lora_up.weight": up})
        manager = LoRAManager([{"path": path, "multiplier": 0.5}], "anima")
        tokens = torch.tensor([[0, 3, 7]])
        baseline = model.proj(tokens)
        expected = F.embedding(tokens, up @ down) * 0.5
        with manager.activate(manager.prepare(model), "cpu"):
            torch.testing.assert_close(model.proj(tokens), baseline + expected)
        bias = torch.randn(8)
        path = self.save("bias", {"diff_b": bias})
        x = torch.randn(2, 8)
        baseline = self.model.proj(x)
        manager = LoRAManager([{"path": path, "multiplier": 0.3}], "moss_image")
        with manager.activate(manager.prepare(self.model), "cpu"):
            torch.testing.assert_close(self.model.proj(x), baseline + bias * 0.3)

    def test_live_lycoris_training_is_the_base_for_weight_dependent_patches(self):
        from backend.training.preview.rebuild import lycoris_modules
        modules = lycoris_modules()
        for algorithm, dtype in ((modules.LoConModule, torch.float32), (modules.GLoRAModule, torch.bfloat16)):
            model = torch.nn.Module()
            model.proj = torch.nn.Linear(8, 8, bias=False)
            options = {"weight_decompose": True} if algorithm is modules.LoConModule else {}
            training = algorithm("live", model.proj, lora_dim=2, alpha=2, multiplier=0.4, bypass_mode=False, **options)
            with torch.no_grad():
                for parameter in training.parameters():
                    parameter.fill_(0.1)
                if options:
                    training.dora_scale.fill_(2)
            model.to(dtype)
            training.to(dtype)
            training.apply_to()
            training.train()
            child = next(iter(training.children()))
            child.eval()
            modes = {module: module.training for module in training.modules()}
            before = {key: value.detach().clone() for key, value in training.state_dict().items()}
            x = torch.randn(2, 8, dtype=dtype)
            baseline = model.proj(x).detach()
            path = self.save("external-ia3", {"weight": torch.ones(8), "on_input": torch.tensor(1)})
            manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
            for fail in (False, True):
                try:
                    with manager.activate(manager.prepare(model), "cpu"), torch.no_grad():
                        self.assertTrue(all(not module.training for module in modes))
                        torch.testing.assert_close(model.proj(x), baseline * 2, rtol=0.02, atol=0.02)
                        if fail:
                            raise ValueError("sample failed")
                except ValueError:
                    self.assertTrue(fail)
                for module, mode in modes.items():
                    self.assertEqual(module.training, mode)
                for key, value in before.items():
                    torch.testing.assert_close(training.state_dict()[key], value, rtol=0, atol=0)

    def test_live_biasless_norm_and_block_scaled_fp8_base(self):
        from backend.training.preview.rebuild import base_weight, lycoris_modules
        class BiaslessRMSNorm(torch.nn.RMSNorm):
            def _norm(self, x):
                return F.rms_norm(x, self.normalized_shape, eps=self.eps)

        model = torch.nn.Module()
        model.proj = BiaslessRMSNorm(8)
        training = lycoris_modules().NormModule("live", model.proj)
        with torch.no_grad():
            training.w_norm.fill_(0.2)
        training.apply_to()
        x = torch.randn(2, 8)
        path = self.save("set-norm", {"set_weight": torch.full((8,), 0.5)})
        manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
        with manager.activate(manager.prepare(model), "cpu"):
            torch.testing.assert_close(model.proj(x), F.rms_norm(x, (8,), eps=model.proj.eps) * 0.5)
        quantized = torch.nn.Linear(8, 8, bias=False)
        quantized.weight = torch.nn.Parameter(quantized.weight.to(torch.float8_e4m3fn), requires_grad=False)
        quantized.register_buffer("scale_weight", torch.rand(8, 2, 1))
        expected = (quantized.weight.float().reshape(8, 2, 4) * quantized.scale_weight).reshape(8, 8)
        torch.testing.assert_close(base_weight(quantized, "cpu"), expected)

    def test_live_lycoris_alpha_scalar_and_dora_follow_actual_forward(self):
        from backend.training.preview.rebuild import lycoris_modules
        modules = lycoris_modules()
        for algorithm in (modules.LoConModule, modules.LohaModule, modules.LokrModule):
            for bypass in (False, True):
                for dora in (False, True):
                    with self.subTest(algorithm=algorithm.name, bypass=bypass, dora=dora):
                        model = torch.nn.Module()
                        model.proj = torch.nn.Linear(8, 8, bias=False)
                        training = algorithm("live", model.proj, lora_dim=1, alpha=.5, multiplier=.4,
                                             use_scalar=True, weight_decompose=dora, bypass_mode=bypass).eval()
                        with torch.no_grad():
                            for parameter in training.parameters():
                                parameter.fill_(.6)
                            training.scalar.fill_(.7)
                            if dora:
                                training.dora_scale.fill_(1.2)
                        training.apply_to()
                        x = torch.randn(2, 8)
                        baseline = model.proj(x).detach()
                        before = {key: value.detach().clone() for key, value in training.state_dict().items()}
                        path = self.save("ia3", {"weight": torch.ones(8), "on_input": torch.tensor(1)})
                        manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
                        with manager.activate(manager.prepare(model), "cpu"):
                            torch.testing.assert_close(model.proj(x), baseline * 2, rtol=1e-5, atol=1e-6)
                        for key, value in before.items():
                            torch.testing.assert_close(training.state_dict()[key], value, rtol=0, atol=0)

    def test_live_output_axis_ia3_bias_is_part_of_training_base(self):
        from backend.training.preview.rebuild import lycoris_modules
        for bypass in (False, True):
            model = torch.nn.Module()
            model.proj = torch.nn.Linear(8, 8)
            with torch.no_grad():
                model.proj.bias.fill_(2)
            training = lycoris_modules().IA3Module("live", model.proj, multiplier=.5, bypass_mode=bypass,
                                                  train_on_input=False).eval()
            with torch.no_grad():
                training.weight.fill_(1)
            training.apply_to()
            x = torch.zeros(2, 8)
            baseline = model.proj(x).detach()
            path = self.save("set-bias", {"bias.set_weight": torch.zeros(8)})
            manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
            with manager.activate(manager.prepare(model), "cpu"):
                torch.testing.assert_close(model.proj(x), torch.zeros_like(baseline), rtol=0, atol=1e-6)
            torch.testing.assert_close(model.proj(x), baseline, rtol=0, atol=0)

    def test_live_norm_bias_replacement_preserves_native_merged_bias(self):
        from backend.training.preview.rebuild import lycoris_modules

        for bypass in (False, True):
            with self.subTest(bypass=bypass):
                model = torch.nn.Module()
                model.proj = torch.nn.LayerNorm(8)
                training = lycoris_modules().NormModule("live", model.proj, multiplier=.5,
                                                       bypass_mode=bypass).eval()
                with torch.no_grad():
                    training.w_norm.fill_(.2)
                    training.b_norm.fill_(.3)
                training.apply_to()
                x = torch.zeros(2, 8)
                baseline = model.proj(x).detach()
                torch.testing.assert_close(baseline, torch.full_like(x, .15))
                path = self.save("set-norm-bias", {"bias.set_weight": torch.zeros(8)})
                manager = LoRAManager([{"path": path, "multiplier": 1}], "anima")
                with manager.activate(manager.prepare(model), "cpu"):
                    torch.testing.assert_close(model.proj(x), torch.zeros_like(x), rtol=0, atol=1e-6)
                torch.testing.assert_close(model.proj(x), baseline, rtol=0, atol=0)

    def test_external_loha_and_lokr_dora_apply_alpha_once(self):
        groups = [
            ({"hada_w1_a": torch.randn(8, 2), "hada_w1_b": torch.randn(2, 8),
              "hada_w2_a": torch.randn(8, 2), "hada_w2_b": torch.randn(2, 8)}, "loha"),
            ({"lokr_w1": torch.randn(2, 2), "lokr_w2_a": torch.randn(4, 1), "lokr_w2_b": torch.randn(1, 4)}, "lokr"),
        ]
        x = torch.randn(2, 8)
        base = self.model.proj.weight.detach()
        for weights, kind in groups:
            rank = 2 if kind == "loha" else 1
            weights.update(alpha=torch.tensor(rank * .5), dora_scale=torch.rand(8, 1) + .5)
            if kind == "loha":
                delta = (weights["hada_w1_a"] @ weights["hada_w1_b"]) * (weights["hada_w2_a"] @ weights["hada_w2_b"]) * .5
            else:
                delta = torch.kron(weights["lokr_w1"], weights["lokr_w2_a"] @ weights["lokr_w2_b"]) * .5
            merged = base + delta
            normalized = merged * weights["dora_scale"] / merged.norm(dim=1, keepdim=True)
            path = self.save(kind + "-dora", weights)
            for multiplier in (1., .4, -.3):
                manager = LoRAManager([{"path": path, "multiplier": multiplier}], "anima")
                with manager.activate(manager.prepare(self.model), "cpu"):
                    torch.testing.assert_close(self.model.proj(x), F.linear(x, base + (normalized - base) * multiplier), rtol=1e-5, atol=1e-5)

    def test_live_oft_rescale_and_bias_match_forward_at_zero_and_nonunit_strength(self):
        from backend.training.preview.rebuild import lycoris_modules
        modules = lycoris_modules()
        for algorithm in (modules.DiagOFTModule, modules.ButterflyOFTModule):
            for bypass in (False, True):
                for strength in (0., .4, 1., -.4):
                    with self.subTest(algorithm=algorithm.name, bypass=bypass, strength=strength):
                        model = torch.nn.Module()
                        model.proj = torch.nn.Linear(16, 16)
                        training = algorithm("live", model.proj, lora_dim=4, alpha=.5, multiplier=strength,
                                             bypass_mode=bypass, rescaled=True).eval()
                        with torch.no_grad():
                            training.oft_blocks.normal_(std=.15)
                            training.rescale.copy_(torch.linspace(.6, 1.4, training.rescale.numel()).reshape(training.rescale.shape))
                        training.apply_to()
                        x = torch.randn(1, 16)
                        baseline = model.proj(x).detach()
                        offset = model.proj(torch.zeros_like(x)).detach()
                        ia3 = self.save("ia3", {"weight": torch.ones(16), "on_input": torch.tensor(1)})
                        bias = self.save("set-bias", {"bias.set_weight": torch.zeros(16)})
                        manager = LoRAManager([{"path": ia3, "multiplier": 1}, {"path": bias, "multiplier": 1}], "anima")
                        with manager.activate(manager.prepare(model), "cpu"):
                            torch.testing.assert_close(model.proj(x), (baseline - offset) * 2, rtol=1e-5, atol=1e-6)
                        torch.testing.assert_close(model.proj(x), baseline, rtol=0, atol=0)
