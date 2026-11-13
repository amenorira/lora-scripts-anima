import copy
import random
from contextlib import nullcontext
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import torch
from safetensors.torch import save_file

from backend.training.preview.sampling import wrap_sampler


def _tiny_denoise(dit, x):
    output = dit.proj(x)
    if getattr(dit, "fail_sampling", False):
        raise ValueError("injected sampling failure")
    return output


def do_sample(height, width, seed, dit, crossattn_emb, steps, dtype, device,
              guidance_scale=1., flow_shift=3., neg_crossattn_emb=None):
    return _tiny_denoise(dit, crossattn_emb)


def generate_latents(dit, prompt_embeds, prompt_mask, negative_embeds, negative_mask,
                     height, width, steps, guidance_scale, flow_shift, uncond_skip_layers,
                     seed, device, show_progress=True):
    return _tiny_denoise(dit, prompt_embeds)


def _sample_image_inference(dit, architecture="anima", *, before=None, after=None):
    if before is not None:
        before()
    x = torch.ones(1, 4)
    if architecture == "moss_image":
        output = generate_latents(dit, x, None, None, None, 64, 64, 2, 1., 5., [], 42, "cpu")
    else:
        output = do_sample(64, 64, 42, dit, x, 2, torch.float32, "cpu")
    if after is not None:
        after()
    return output


class PreviewModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = torch.nn.Linear(4, 3)
        self.forward_only = False

    def switch_block_swap_for_training(self):
        self.forward_only = False


class PreviewSamplingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name) / "external.safetensors"
        save_file({"diffusion_model.proj.lora_A.weight": torch.ones(2, 4),
                   "diffusion_model.proj.lora_B.weight": torch.ones(3, 2)}, path)
        self.document = {"schema_version": 1, "architecture": "anima",
                         "loras": [{"path": str(path), "multiplier": 0.5}]}
        self.model = PreviewModel()
        self.vae = torch.nn.Linear(2, 2)
        self.te = torch.nn.Linear(2, 2)
        self.te.eval()
        self.accelerator = SimpleNamespace(device=torch.device("cpu"), unwrap_model=lambda model: model)
        self.options = SimpleNamespace(sample_at_first=True, sample_every_n_steps=2, sample_every_n_epochs=None)
        self.prompts = Path(self.temp.name) / "prompts.json"
        self.prompts.write_text('[{"prompt": "tiny", "scale": 1}]', encoding="utf-8")

    def arguments(self):
        return (self.accelerator, self.options, None, 2, self.model, self.vae, self.te, None, None)

    def test_success_and_failure_restore_full_state_and_forward(self):
        for architecture in ("anima", "moss_image"):
            self.document["architecture"] = architecture
            for fail in (False, True):
                calls = []
                baseline = self.model.proj(torch.ones(1, 4)).detach()
                saved = copy.deepcopy(self.model.state_dict())
                cpu_rng = torch.get_rng_state()
                py_rng, np_rng = random.getstate(), np.random.get_state()

                def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                            tokenize_strategy, text_encoding_strategy, *, future_option=0):
                    calls.append(future_option)
                    dit.forward_only = True
                    dit.eval()
                    vae.eval()
                    text_encoder.train()
                    vae.to(torch.float64)
                    random.random()
                    np.random.rand()
                    torch.rand(2)
                    dit.fail_sampling = fail
                    torch.testing.assert_close(_sample_image_inference(dit, architecture), baseline + 4)
                    dit.switch_block_swap_for_training()
                    return "image"

                wrapper = wrap_sampler(sampler, self.document)
                if fail:
                    with self.assertRaisesRegex(ValueError, "sampling failure"):
                        wrapper(*self.arguments(), future_option=7)
                else:
                    self.assertEqual(wrapper(*self.arguments(), future_option=7), "image")
                self.assertEqual(calls, [7])
                self.assertTrue(self.model.training)
                self.assertTrue(self.vae.training)
                self.assertFalse(self.te.training)
                self.assertFalse(self.model.forward_only)
                self.assertNotIn("forward", self.model.proj.__dict__)
                self.assertEqual(self.vae.weight.dtype, torch.float32)
                self.assertTrue(torch.equal(cpu_rng, torch.get_rng_state()))
                self.assertEqual(py_rng, random.getstate())
                self.assertTrue(np.array_equal(np_rng[1], np.random.get_state()[1]))
                for key in saved:
                    torch.testing.assert_close(saved[key], self.model.state_dict()[key], rtol=0, atol=0)

    def test_cleanup_failure_aborts_instead_of_continuing_training(self):
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            raise ValueError("sample failed")
        with patch.object(self.model, "switch_block_swap_for_training", side_effect=RuntimeError("offloader failed")):
            with self.assertRaisesRegex(RuntimeError, "restoration failed"):
                wrap_sampler(sampler, self.document)(*self.arguments())
        self.assertNotIn("forward", self.model.proj.__dict__)

    def test_text_encoding_failure_restores_caller_owned_encoder(self):
        encoder = PreviewModel()
        encoder.register_buffer("test_buffer", torch.ones(2))
        original_buffer = encoder.test_buffer
        original = encoder.proj(torch.ones(1, 4)).detach()
        path = Path(self.temp.name) / "te.safetensors"
        save_file({"lora_te_proj.lora_down.weight": torch.ones(2, 4),
                   "lora_te_proj.lora_up.weight": torch.ones(3, 2)}, path)
        document = {**self.document, "loras": [{"path": str(path), "multiplier": .5}]}
        fail = True
        def encode(tokenize, encoders, text):
            torch.testing.assert_close(encoders[0].proj(torch.ones(1, 4)), original + 4)
            encoders[0].to(torch.float64)
            torch.rand(3)
            if fail:
                raise ValueError("injected text encoding failure")
            return [torch.ones(1)]
        samples = []
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy, sample_prompts_te_outputs=None):
            samples.append(sample_prompts_te_outputs)
        arguments = list(self.arguments())
        arguments[0].autocast = nullcontext
        arguments[1].sample_prompts = str(self.prompts)
        arguments[6] = encoder
        arguments[7] = SimpleNamespace(tokenize=lambda text: text)
        arguments[8] = SimpleNamespace(encode_tokens=encode)
        rng = torch.get_rng_state()
        with patch("backend.training.preview.anima.load_text_encoder", return_value=encoder) as loader, \
             patch.dict(sampler.__globals__, {"sampling": SimpleNamespace(load_prompts=lambda path: [{"prompt": "tiny", "scale": 1}])}):
            sample = wrap_sampler(sampler, document)
            with self.assertRaisesRegex(ValueError, "text encoding failure"):
                sample(*arguments)
            self.assertEqual(samples, [])
            self.assertIs(encoder.test_buffer, original_buffer)
            self.assertEqual(encoder.test_buffer.dtype, torch.float32)
            self.assertEqual(encoder.proj.weight.dtype, torch.float32)
            self.assertNotIn("forward", encoder.proj.__dict__)
            self.assertTrue(torch.equal(rng, torch.get_rng_state()))
            fail = False
            sample(*arguments)
            self.assertEqual(loader.call_count, 0)
            self.assertEqual(len(samples), 1)
