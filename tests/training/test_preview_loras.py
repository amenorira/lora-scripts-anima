import copy
from dataclasses import replace
import gc
from pathlib import Path
import tempfile
import traceback
import unittest
import weakref
from unittest.mock import patch

import torch
from safetensors.torch import save_file

from backend.training.preview.lora import LoRAManager, PreviewLoRAError
from backend.training.preview.adapters import Adapter


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

    def test_invalid_second_adapter_does_not_patch_any_layer(self):
        good, _ = self.file()
        for kwargs in ({"base": "diffusion_model.missing"}, {"out": 4}, {"alpha": float("nan")}):
            bad, _ = self.file("bad", **kwargs)
            manager = LoRAManager([{"path": good, "multiplier": 1}, {"path": bad, "multiplier": 1}], "anima")
            with self.assertRaises(PreviewLoRAError):
                manager.prepare(self.model)
            self.assertNotIn("forward", self.model.layers[0].proj.q.__dict__)

        bad, _ = self.file("bad-te", base="lora_te_layers_0_self_attn_q_proj")
        manager = LoRAManager([{"path": good, "multiplier": 1}, {"path": bad, "multiplier": 1}], "anima")
        with self.assertRaises(PreviewLoRAError):
            manager.prepare(None, self.model)

    def test_failed_adapter_forward_releases_weights_with_retained_traceback(self):
        path, _ = self.file()
        manager = LoRAManager([{"path": path, "multiplier": .5}], "anima")
        prepared = manager.prepare(self.model)
        layer = self.model.layers[0].proj.q
        x = torch.ones(2, 4)
        caller_input = weakref.ref(x)
        before = copy.deepcopy(self.model.state_dict())
        baseline = layer(x).detach()
        weights = []
        original_to, original_linear = Adapter.to, torch.nn.functional.linear
        injected = torch.cuda.OutOfMemoryError("injected down projection failure")

        def move(branch, *args, **kwargs):
            resident = replace(original_to(branch, *args, **kwargs),
                               weights={key: tensor.clone() for key, tensor in branch.weights.items()})
            weights.extend(weakref.ref(tensor) for tensor in resident.weights.values())
            return resident

        def fail_down(value, weight, *args, **kwargs):
            if weight.shape == (2, 4):
                raise injected
            return original_linear(value, weight, *args, **kwargs)

        saved_error = None
        automatic_gc = gc.isenabled()
        gc.disable()
        try:
            with patch.object(Adapter, "to", move), \
                 patch("torch.nn.functional.linear", fail_down), torch.no_grad():
                try:
                    with manager.activate(prepared, "cpu"):
                        layer(x)
                except torch.cuda.OutOfMemoryError as error:
                    saved_error = error
            self.assertIs(saved_error, injected)
            self.assertIn("fail_down", "".join(traceback.format_exception(saved_error)))
            self.assertTrue(weights)
            self.assertTrue(all(reference() is None for reference in weights))
            self.assertIs(caller_input(), x)
            self.assertFalse(manager._active)
            self.assertNotIn("forward", layer.__dict__)
            for key, tensor in before.items():
                torch.testing.assert_close(self.model.state_dict()[key], tensor, rtol=0, atol=0)
            torch.testing.assert_close(layer(x), baseline, rtol=0, atol=0)
            branch = prepared[layer][0]
            expected = baseline + (x @ branch.down.T @ branch.up.T) * branch.scale
            with manager.activate(prepared, "cpu"), torch.no_grad():
                torch.testing.assert_close(layer(x), expected)
        finally:
            if automatic_gc:
                gc.enable()
