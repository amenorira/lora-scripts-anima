import builtins
import copy
import gc
import json
import random
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
import weakref
from unittest.mock import patch

import numpy as np
import torch
from safetensors.torch import save_file

from backend.training.preview.compat import PreviewCompatibilityError, sampling_due
from backend.training.preview.sampling import wrap_sampler
from backend.training.preview.prompts import encode_with_adapters, prompt_texts
from backend.training.preview.lora import LoRAManager
from backend.training.preview.adapters import Adapter
from backend.training.preview.sampling import _release_cuda_cache
from backend.training.preview import moss_image
from tools.python_startup.preview_sampling import install_import_hook


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


@contextmanager
def mock_moss_text_encoder_swap(*, fail_prepare=False):
    """Exercise lifecycle behavior on CPU without importing training models."""
    calls = []
    utils = ModuleType("library.moss_image_utils")
    utils.TEXT_ENCODER_BLOCK_SWAP_HANDLES_ATTR = "_moss_text_encoder_block_swap_handles"
    utils.TEXT_ENCODER_BLOCK_SWAP_OFFLOADER_ATTR = "_moss_text_encoder_block_swap_offloader"
    utils.TEXT_ENCODER_DEVICE_ATTR = "_moss_text_encoder_device"
    class Offloader:
        def __init__(self, name, layers, count, blocks, **kwargs):
            calls.append(("enable", blocks, kwargs["device"].type))
            self.layers, self.S = layers, blocks
            self.copier = SimpleNamespace(sync=lambda: calls.append(("sync",)))
            self.cpu_master = {}
        def prepare_block_devices_before_forward(self, layers):
            if fail_prepare:
                # Model the upstream empty-placeholder window during .to().
                self.cpu_master[0] = layers[0].weight.detach()
                layers[0].weight.data = torch.ones_like(layers[0].weight)
                layers[-1].weight.data = torch.empty(0)
                raise torch.cuda.OutOfMemoryError("injected swap preparation OOM")
        def release_device_buffers(self):
            if fail_prepare:
                raise KeyError("second streamed master does not exist")
            calls.append(("release",))
    def attach(offloader, layers):
        return [layer.register_forward_pre_hook(lambda module, args: None) for layer in layers]
    def disable(encoder):
        handles = getattr(encoder, utils.TEXT_ENCODER_BLOCK_SWAP_HANDLES_ATTR, None)
        if handles is None:
            return
        for handle in handles:
            handle.remove()
        getattr(encoder, utils.TEXT_ENCODER_BLOCK_SWAP_OFFLOADER_ATTR).release_device_buffers()
        for name in (utils.TEXT_ENCODER_BLOCK_SWAP_HANDLES_ATTR, utils.TEXT_ENCODER_BLOCK_SWAP_OFFLOADER_ATTR,
                     utils.TEXT_ENCODER_DEVICE_ATTR):
            delattr(encoder, name)
        encoder.to("cpu")
    utils.disable_text_encoder_block_swap = disable
    offloading = ModuleType("library.custom_offloading_utils")
    offloading.LoRAStreamOffloader, offloading.attach_forward_streaming_hooks = Offloader, attach
    library = ModuleType("library")
    library.moss_image_utils = utils
    with patch.dict(sys.modules, {"library": library, utils.__name__: utils, offloading.__name__: offloading}):
        yield calls


class PreviewSamplingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name) / "external.safetensors"
        save_file({"diffusion_model.proj.lora_A.weight": torch.ones(2, 4),
                   "diffusion_model.proj.lora_B.weight": torch.ones(3, 2)}, path)
        self.document = {"schema_version": 1, "architecture": "anima",
                         "loras": [{"path": str(path), "multiplier": 0.5}]}
        self.config = Path(self.temp.name) / "preview.json"
        self.config.write_text(json.dumps(self.document), encoding="utf-8")
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

    def test_no_sampling_step_does_no_adapter_io(self):
        self.options.sample_every_n_steps = 3
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            return "upstream schedule"
        with patch("backend.training.preview.lora.load_file", side_effect=AssertionError("unexpected IO")):
            self.assertEqual(wrap_sampler(sampler, self.document)(*self.arguments()), "upstream schedule")

    def test_repeated_images_release_branches_before_decode_without_gc(self):
        for architecture in ("anima", "moss_image"):
            for custom in (False, True):
                document = {**self.document, "architecture": architecture}
                if custom:
                    document.update(sampler="heun", scheduler="simple")
                baseline = self.model.proj(torch.ones(1, 4)).detach()
                references = []
                transfers = []
                original_to = Adapter.to

                def move(branch, device, cache):
                    # Distinct CPU copies model the lifetime of GPU copies on
                    # machines without CUDA; the prepared CPU plan stays live.
                    resident = replace(original_to(branch, device, cache),
                                       weights={key: tensor.clone() for key, tensor in branch.weights.items()})
                    references.append(weakref.ref(resident))
                    references.extend(weakref.ref(tensor) for tensor in resident.weights.values())
                    transfers.append(1)
                    return resident

                def before():
                    # Anima's llm_adapter also needs external patches before
                    # the latent generator. MOSS keeps encoding unpatched.
                    torch.testing.assert_close(self.model.proj(torch.ones(1, 4)),
                                               baseline + (4 if architecture == "anima" else 0))

                def after():
                    self.assertNotIn("forward", self.model.proj.__dict__)
                    self.assertTrue(all(reference() is None for reference in references))
                    torch.testing.assert_close(self.model.proj(torch.ones(1, 4)), baseline)

                def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                            tokenize_strategy, text_encoding_strategy):
                    for _ in range(2):
                        output = _sample_image_inference(dit, architecture, before=before, after=after)
                        torch.testing.assert_close(output, baseline + 4)

                def latent_sampler(options, **arguments):
                    return _tiny_denoise(arguments["dit"], arguments.get("crossattn_emb", arguments.get("prompt_embeds")))

                automatic_gc = gc.isenabled()
                gc.disable()
                try:
                    with patch.object(Adapter, "to", move), \
                         patch(f"backend.training.preview.{architecture}.sample_latents", side_effect=latent_sampler), \
                         patch("backend.training.preview.sampling._release_cuda_cache") as cleanup:
                        wrapped = wrap_sampler(sampler, document)
                        for _ in range(3):
                            wrapped(*self.arguments())
                        cleanup.assert_not_called()
                    self.assertEqual(len(transfers), 6)
                finally:
                    if automatic_gc:
                        gc.enable()

    def test_empty_and_zero_strength_previews_skip_extra_cuda_cleanup(self):
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            return _sample_image_inference(dit)
        for rows in ([], [{"path": "missing.safetensors", "multiplier": 0}]):
            with patch("backend.training.preview.sampling._release_cuda_cache") as cleanup:
                wrap_sampler(sampler, {**self.document, "loras": rows})(*self.arguments())
                cleanup.assert_not_called()

    def test_replaced_cuda_buffer_is_released_before_fallback_cleanup(self):
        class CudaBuffer(torch.Tensor):
            @property
            def device(self):
                return torch.device("cuda:1")

        self.vae.register_buffer("preview_buffer", torch.ones(2))
        original = self.vae.preview_buffer
        references = []

        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            _sample_image_inference(dit)
            vae.preview_buffer = torch.zeros(2).as_subclass(CudaBuffer)
            references.append(weakref.ref(vae.preview_buffer))

        def cleanup(device):
            self.assertIs(self.vae.preview_buffer, original)
            self.assertTrue(all(reference() is None for reference in references))

        with patch("backend.training.preview.sampling._release_cuda_cache", side_effect=cleanup) as release:
            wrap_sampler(sampler, self.document)(*self.arguments())
            release.assert_called_once()

    def test_cuda_cleanup_failure_keeps_original_sampling_error(self):
        with patch("torch.cuda.empty_cache", side_effect=RuntimeError("cleanup failed")):
            with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
                _release_cuda_cache("cuda:1")
            with self.assertRaisesRegex(ValueError, "sampling failed"), \
                 self.assertLogs("backend.training.preview.sampling", level="WARNING"):
                try:
                    raise ValueError("sampling failed")
                finally:
                    _release_cuda_cache("cuda:1")

    def test_moss_skipped_image_never_allocates_external_gpu_branches(self):
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            return _sample_image_inference(dit)
        with patch.dict(sampler.__globals__, {"_sample_image_inference": lambda dit: "skipped"}), \
             patch.object(Adapter, "to", side_effect=AssertionError("unexpected device transfer")), \
             patch("backend.training.preview.sampling._release_cuda_cache") as cleanup:
            wrapped = wrap_sampler(sampler, {**self.document, "architecture": "moss_image"})
            self.assertEqual(wrapped(*self.arguments()), "skipped")
            cleanup.assert_not_called()

    def test_anima_repeated_denoiser_in_one_image_fails_instead_of_running_unpatched(self):
        def inference(dit):
            for _ in range(2):
                do_sample(64, 64, 42, dit, torch.ones(1, 4), 2, torch.float32, "cpu")
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            return _sample_image_inference(dit)
        with patch.dict(sampler.__globals__, {"_sample_image_inference": inference}), \
             patch("backend.training.preview.sampling._release_cuda_cache") as cleanup:
            with self.assertRaisesRegex(PreviewCompatibilityError, "Denoiser called outside"):
                wrap_sampler(sampler, self.document)(*self.arguments())
            cleanup.assert_called_once()
        self.assertNotIn("forward", self.model.proj.__dict__)

    def test_missing_prompt_file_skips_adapter_io(self):
        self.options.sample_prompts = str(Path(self.temp.name) / "missing.json")
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy, sample_prompts_te_outputs=None):
            self.assertIsNone(sample_prompts_te_outputs)
            return "skipped"
        with patch("backend.training.preview.lora.load_file", side_effect=AssertionError("unexpected IO")):
            self.assertEqual(wrap_sampler(sampler, self.document)(*self.arguments(), sample_prompts_te_outputs={"stale": True}), "skipped")

    def test_cleanup_failure_aborts_instead_of_continuing_training(self):
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            raise ValueError("sample failed")
        with patch.object(self.model, "switch_block_swap_for_training", side_effect=RuntimeError("offloader failed")):
            with self.assertRaisesRegex(RuntimeError, "restoration failed"):
                wrap_sampler(sampler, self.document)(*self.arguments())
        self.assertNotIn("forward", self.model.proj.__dict__)

    def test_success_does_not_repeat_upstream_block_swap_restoration(self):
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            dit.switch_block_swap_for_training()
        with patch.object(self.model, "switch_block_swap_for_training", wraps=self.model.switch_block_swap_for_training) as restore:
            wrap_sampler(sampler, self.document)(*self.arguments())
        self.assertEqual(restore.call_count, 1)

    def test_signature_and_model_contracts_are_checked(self):
        with self.assertRaises(PreviewCompatibilityError):
            wrap_sampler(lambda renamed_model: None, self.document)
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            self.fail("incompatible model must not sample")
        self.model.switch_block_swap_for_training = None
        with self.assertRaises(PreviewCompatibilityError):
            wrap_sampler(sampler, self.document)(*self.arguments())

    def test_import_hook_is_idempotent_and_does_not_replace_trainer(self):
        module = ModuleType("library.anima_train_utils")
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            return "sample"
        module.sample_images = sampler
        with patch.object(builtins, "__import__", builtins.__import__), \
             patch.object(builtins, "_anima_preview_sampling_hook", False, create=True), \
             patch.dict(sys.modules, {module.__name__: module}):
            install_import_hook(str(self.config))
            first = module.sample_images
            install_import_hook(str(self.config))
            self.assertIs(first, module.sample_images)
            self.assertIs(first.__wrapped__, sampler)
            self.assertEqual(first(*self.arguments()), "sample")

    def test_missing_function_is_not_silently_ignored(self):
        module = ModuleType("library.anima_train_utils")
        with patch.object(builtins, "__import__", builtins.__import__), \
             patch.object(builtins, "_anima_preview_sampling_hook", False, create=True), \
             patch.dict(sys.modules, {module.__name__: module}):
            with self.assertRaisesRegex(PreviewCompatibilityError, "missing"):
                install_import_hook(str(self.config))

    def test_schedule_matches_step_and_epoch_modes(self):
        self.assertTrue(sampling_due(self.options, 0, 0))
        self.assertTrue(sampling_due(self.options, None, 2))
        self.assertFalse(sampling_due(self.options, 1, 2))
        self.options.sample_every_n_epochs = 2
        self.assertFalse(sampling_due(self.options, None, 2))
        self.assertTrue(sampling_due(self.options, 2, 4))
        self.assertFalse(sampling_due(self.options, 1, 4))

    def test_compiled_training_uses_eager_preview_and_resumes_original_graph(self):
        self.model.proj = torch.compile(self.model.proj, backend="eager", fullgraph=True)
        x = torch.ones(1, 4)
        baseline = self.model.proj(x).detach()
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            torch.testing.assert_close(_sample_image_inference(dit), baseline + 4)
        wrap_sampler(sampler, self.document)(*self.arguments())
        torch.testing.assert_close(self.model.proj(x), baseline)

    def test_text_encoder_prompts_are_deduplicated_offloaded_and_cached_only_when_frozen(self):
        for architecture in ("anima", "moss_image"):
            for mode in ("existing", "reload", "wrapped"):
                encoder = PreviewModel()
                encoder.register_buffer("test_buffer", torch.ones(2))
                buffer = encoder.test_buffer
                original = encoder.proj(torch.ones(1, 4)).detach()
                path = Path(self.temp.name) / f"te-{architecture}-{mode}.safetensors"
                save_file({"lora_te_proj.lora_down.weight": torch.ones(2, 4),
                           "lora_te_proj.lora_up.weight": torch.ones(3, 2)}, path)
                document = {**self.document, "architecture": architecture,
                            "loras": [{"path": str(path), "multiplier": 0.5}]}
                encoded_texts = []
                def encode(tokenize, encoders, text):
                    encoded_texts.append(text)
                    output = encoders[0].proj(torch.ones(1, 4, dtype=encoders[0].proj.weight.dtype)).detach().float()
                    encoders[0].to(torch.float64)
                    return [output]
                def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                            tokenize_strategy, text_encoding_strategy, sample_prompts_te_outputs=None):
                    self.assertIsNone(text_encoder)
                    self.assertEqual(set(sample_prompts_te_outputs), {"tiny", "shared"})
                    for output in sample_prompts_te_outputs.values():
                        torch.testing.assert_close(output[0], original + 4)
                        self.assertEqual(output[0].device.type, "cpu")
                    self.assertNotIn("forward", encoder.proj.__dict__)
                    self.assertEqual(encoder.proj.weight.device.type, "cpu")
                arguments = list(self.arguments())
                wrapped = torch.nn.Module()
                wrapped.module = encoder
                arguments[6] = None if mode == "reload" else wrapped if mode == "wrapped" else encoder
                arguments[0] = SimpleNamespace(device=torch.device("cpu"), autocast=nullcontext,
                                               unwrap_model=lambda module: encoder if module is wrapped else module)
                arguments[1].sample_prompts = str(self.prompts)
                arguments[7] = SimpleNamespace(tokenize=lambda text: text)
                arguments[8] = SimpleNamespace(encode_tokens=encode)
                prompts = [{"prompt": "tiny", "negative_prompt": "shared"}] * 2
                with patch(f"backend.training.preview.{architecture}.load_text_encoder", return_value=encoder) as loader, \
                     patch.dict(sampler.__globals__, {"sampling": SimpleNamespace(load_prompts=lambda path: prompts)}):
                    sample = wrap_sampler(sampler, document)
                    for _ in range(2):
                        sample(*arguments, sample_prompts_te_outputs={"stale": True})
                    self.assertEqual(loader.call_count, int(mode == "reload"))
                    self.assertEqual(encoded_texts, ["tiny", "shared"] * (1 if mode == "reload" else 2))
                if mode != "reload":
                    self.assertIs(encoder.test_buffer, buffer)
                    self.assertEqual(encoder.test_buffer.dtype, torch.float32)
                    self.assertEqual(encoder.proj.weight.dtype, torch.float32)
                self.assertNotIn("forward", encoder.proj.__dict__)

    def test_prompt_collection_matches_cfg_and_replacement(self):
        def original():
            pass
        prompts = [{"prompt": "old", "negative_prompt": "old-negative", "scale": .5},
                   {"prompt": "unit", "negative_prompt": "unused", "scale": 1},
                   {"prompt": "guided", "negative_prompt": None, "scale": 2}]
        values = {"args": SimpleNamespace(sample_prompts="prompts.json"), "prompt_replacement": ("old", "new"),
                  "accelerator": SimpleNamespace(process_index=0, num_processes=1)}
        with patch.dict(original.__globals__, {"sampling": SimpleNamespace(load_prompts=lambda path: prompts)}):
            self.assertEqual(prompt_texts(original, values, "anima"), ("new", "unit", "guided"))
            self.assertEqual(prompt_texts(original, values, "moss_image"), ("new", "new-negative", "unit", "guided"))
            values["accelerator"] = SimpleNamespace(process_index=1, num_processes=2)
            self.assertEqual(prompt_texts(original, values, "anima"), ("unit",))

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

    def test_temporary_encoder_is_released_before_sampling_and_empty_ranks_skip_loading(self):
        path = Path(self.temp.name) / "temporary-te.safetensors"
        save_file({"lora_te_proj.lora_down.weight": torch.ones(2, 4),
                   "lora_te_proj.lora_up.weight": torch.ones(3, 2)}, path)
        document = {**self.document, "loras": [{"path": str(path), "multiplier": .5}]}
        references = []
        def load(*args):
            encoder = PreviewModel()
            encoder.proj.forward = encoder.proj.forward.__func__.__get__(encoder.proj, type(encoder.proj))
            references.append(weakref.ref(encoder))
            references.append(weakref.ref(encoder.proj))
            return encoder
        def encode(tokenize, encoders, text):
            return [encoders[0].proj(torch.ones(1, 4))]
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy, sample_prompts_te_outputs=None):
            self.assertIsNone(text_encoder)
            self.assertTrue(all(reference() is None for reference in references))
        arguments = list(self.arguments())
        arguments[0].autocast = nullcontext
        arguments[1].sample_prompts = str(self.prompts)
        arguments[6] = None
        arguments[7] = SimpleNamespace(tokenize=lambda text: text)
        arguments[8] = SimpleNamespace(encode_tokens=encode)
        with patch("backend.training.preview.anima.load_text_encoder", side_effect=load) as loader, \
             patch.dict(sampler.__globals__, {"sampling": SimpleNamespace(load_prompts=lambda path: [{"prompt": "tiny", "scale": 1}])}):
            automatic_gc = gc.isenabled()
            gc.disable()
            try:
                sample = wrap_sampler(sampler, document)
                for _ in range(2):
                    sample(*arguments)
                self.assertEqual(loader.call_count, 1)
                arguments[0].process_index, arguments[0].num_processes = 1, 2
                sample(*arguments)
                self.assertEqual(loader.call_count, 1)
            finally:
                if automatic_gc:
                    gc.enable()

    def test_temporary_encoder_uses_cpu_when_cuda_cannot_fit_or_allocation_fails(self):
        values = {"args": self.options, "accelerator": SimpleNamespace(device=torch.device("cuda"), autocast=nullcontext),
                  "tokenize_strategy": SimpleNamespace(tokenize=lambda text: text),
                  "text_encoding_strategy": SimpleNamespace(encode_tokens=lambda tokenize, models, text: [models[0].proj(torch.ones(1, 4))])}
        for allocation_fails in (False, True):
            loader = ([torch.cuda.OutOfMemoryError("injected allocation failure"), PreviewModel()]
                      if allocation_fails else [PreviewModel()])
            with patch("backend.training.preview.anima.load_text_encoder", side_effect=loader) as load, \
                 patch("torch.cuda.mem_get_info", return_value=(0, 1024)), \
                 patch("torch.cuda.memory_reserved", return_value=0), patch("torch.cuda.memory_allocated", return_value=0):
                outputs = encode_with_adapters(LoRAManager([], "anima"), ("tiny",), values, None, "anima")
            self.assertEqual(outputs["tiny"][0].device.type, "cpu")
            self.assertEqual(load.call_count, 2 if allocation_fails else 1)
            if allocation_fails:
                self.assertEqual(load.call_args.args[1].type, "cpu")

    def test_moss_preview_swap_streams_without_full_model_memory_check_and_cleans_up(self):
        values = {"args": SimpleNamespace(text_encoder_blocks_to_swap=1),
                  "accelerator": SimpleNamespace(device=torch.device("cuda"), autocast=nullcontext),
                  "tokenize_strategy": SimpleNamespace(tokenize=lambda text: text)}
        for temporary in (False, True):
            for fail in (False, True):
                encoder = torch.nn.Module()
                encoder.layers = torch.nn.ModuleList([torch.nn.Linear(4, 3)])
                def encode(tokenize, models, text):
                    self.assertTrue(moss_image.text_encoder_swap_active(models[0]))
                    if fail:
                        raise ValueError("injected encoding failure")
                    return [models[0].layers[0](torch.ones(1, 4))]
                values["text_encoding_strategy"] = SimpleNamespace(encode_tokens=encode)
                with mock_moss_text_encoder_swap() as calls, \
                     patch("backend.training.preview.moss_image.load_text_encoder", return_value=encoder), \
                     patch("torch.cuda.mem_get_info", side_effect=AssertionError("full-model memory check")):
                    if fail:
                        with self.assertRaisesRegex(ValueError, "encoding failure"):
                            encode_with_adapters(LoRAManager([], "moss_image"), ("tiny",), values,
                                                 None if temporary else encoder, "moss_image")
                    else:
                        result = encode_with_adapters(LoRAManager([], "moss_image"), ("tiny",), values,
                                                      None if temporary else encoder, "moss_image")
                        self.assertEqual(result["tiny"][0].device.type, "cpu")
                self.assertEqual(calls, [("enable", 1, "cuda"), ("release",)])
                self.assertFalse(moss_image.text_encoder_swap_active(encoder))
                self.assertEqual(len(encoder.layers[0]._forward_pre_hooks), 0)

    def test_moss_swap_initialization_oom_restores_placeholders_and_temporary_cpu_retry(self):
        values = {"args": SimpleNamespace(text_encoder_blocks_to_swap=2),
                  "accelerator": SimpleNamespace(device=torch.device("cuda"), autocast=nullcontext),
                  "tokenize_strategy": SimpleNamespace(tokenize=lambda text: text),
                  "text_encoding_strategy": SimpleNamespace(encode_tokens=lambda tokenize, models, text:
                                                               [models[0].layers[0](torch.ones(1, 4))])}
        for temporary in (False, True):
            encoder = torch.nn.Module()
            encoder.layers = torch.nn.ModuleList([torch.nn.Linear(4, 3), torch.nn.Linear(3, 2)])
            weight = encoder.layers[0].weight
            original = weight.detach().clone()
            replacement = copy.deepcopy(encoder)
            with mock_moss_text_encoder_swap(fail_prepare=True) as calls, \
                 patch("backend.training.preview.moss_image.load_text_encoder", side_effect=[encoder, replacement]) as load, \
                 (patch.object(encoder, "to", side_effect=AssertionError("moving discarded encoder")) if temporary else nullcontext()):
                if temporary:
                    result = encode_with_adapters(LoRAManager([], "moss_image"), ("tiny",), values, None, "moss_image")
                    self.assertEqual(result["tiny"][0].device.type, "cpu")
                    self.assertEqual(load.call_args.args[1].type, "cpu")
                    self.assertEqual(load.call_count, 2)
                    self.assertEqual(encoder.layers[-1].weight.numel(), 0)
                    torch.testing.assert_close(result["tiny"][0], replacement.layers[0](torch.ones(1, 4)))
                else:
                    with self.assertRaises(torch.cuda.OutOfMemoryError):
                        encode_with_adapters(LoRAManager([], "moss_image"), ("tiny",), values, encoder, "moss_image")
            self.assertIs(encoder.layers[0].weight, weight)
            if not temporary:
                torch.testing.assert_close(weight, original)
            self.assertFalse(moss_image.text_encoder_swap_active(encoder))
            self.assertEqual(len(encoder.layers[0]._forward_pre_hooks), 0)
            self.assertEqual(calls, [("enable", 2, "cuda"), ("sync",)])

    def test_moss_temporary_encoding_oom_disables_swap_before_cpu_retry(self):
        encoder = torch.nn.Module()
        encoder.layers = torch.nn.ModuleList([torch.nn.Linear(4, 3)])
        attempts = []
        def encode(tokenize, models, text):
            active = moss_image.text_encoder_swap_active(models[0])
            attempts.append(active)
            if active:
                raise torch.cuda.OutOfMemoryError("injected encoding OOM")
            return [models[0].layers[0](torch.ones(1, 4))]
        values = {"args": SimpleNamespace(text_encoder_blocks_to_swap=1),
                  "accelerator": SimpleNamespace(device=torch.device("cuda"), autocast=nullcontext),
                  "tokenize_strategy": SimpleNamespace(tokenize=lambda text: text),
                  "text_encoding_strategy": SimpleNamespace(encode_tokens=encode)}
        with mock_moss_text_encoder_swap() as calls, \
             patch("backend.training.preview.moss_image.load_text_encoder", return_value=encoder) as load:
            result = encode_with_adapters(LoRAManager([], "moss_image"), ("tiny",), values, None, "moss_image")
        self.assertEqual(result["tiny"][0].device.type, "cpu")
        self.assertEqual(attempts, [True, False])
        self.assertEqual(load.call_args.args[1].type, "cpu")
        self.assertEqual(calls, [("enable", 1, "cuda"), ("release",)])

    def test_moss_live_swap_preserves_ring_and_external_lora_on_success_and_failure(self):
        path = Path(self.temp.name) / "live-swap-te.safetensors"
        save_file({"lora_te_proj.lora_down.weight": torch.ones(2, 4),
                   "lora_te_proj.lora_up.weight": torch.ones(3, 2)}, path)
        document = {**self.document, "architecture": "moss_image",
                    "loras": [{"path": str(path), "multiplier": .5}]}
        for fail in (False, True):
            encoder = PreviewModel()
            encoder.register_buffer("ring", torch.zeros(1))
            resets = []
            encoder.layers = torch.nn.ModuleList([])
            handles, offloader = [], SimpleNamespace(prepare_block_devices_before_forward=lambda layers: resets.append(layers))
            encoder._moss_text_encoder_block_swap_handles = handles
            encoder._moss_text_encoder_block_swap_offloader = offloader
            baseline = encoder.proj(torch.ones(1, 4)).detach()
            ring = torch.ones(1)
            def encode(tokenize, models, text):
                torch.testing.assert_close(encoder.proj(torch.ones(1, 4)), baseline + 4)
                encoder.ring = ring
                if fail:
                    raise ValueError("injected live-swap encoding failure")
                return [torch.ones(1)]
            def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                        tokenize_strategy, text_encoding_strategy, sample_prompts_te_outputs=None):
                self.assertIsNone(text_encoder)
            arguments = list(self.arguments())
            arguments[0].autocast = nullcontext
            arguments[1].sample_prompts = str(self.prompts)
            arguments[6] = encoder
            arguments[7] = SimpleNamespace(tokenize=lambda text: text)
            arguments[8] = SimpleNamespace(encode_tokens=encode)
            with patch.object(encoder, "to", side_effect=AssertionError("moving a live ring")), \
                 patch.dict(sampler.__globals__, {"sampling": SimpleNamespace(load_prompts=lambda path: [{"prompt": "tiny", "scale": 1}])}):
                sample = wrap_sampler(sampler, document)
                if fail:
                    with self.assertRaisesRegex(ValueError, "live-swap encoding failure"):
                        sample(*arguments)
                else:
                    sample(*arguments)
            self.assertIs(encoder.ring, ring)
            self.assertIs(encoder._moss_text_encoder_block_swap_handles, handles)
            self.assertIs(encoder._moss_text_encoder_block_swap_offloader, offloader)
            self.assertEqual(len(resets), int(fail))
            self.assertNotIn("forward", encoder.proj.__dict__)

    def test_moss_upstream_encoding_failure_resets_caller_owned_live_ring(self):
        encoder = PreviewModel()
        encoder.layers = torch.nn.ModuleList([])
        resets = []
        encoder._moss_text_encoder_block_swap_handles = []
        offloader = SimpleNamespace(prepare_block_devices_before_forward=lambda layers: resets.append(layers))
        encoder._moss_text_encoder_block_swap_offloader = offloader
        def sampler(accelerator, args, epoch, steps, dit, vae, text_encoder,
                    tokenize_strategy, text_encoding_strategy):
            raise ValueError("injected upstream text encoding failure")
        arguments = list(self.arguments())
        arguments[6] = encoder
        with self.assertRaisesRegex(ValueError, "upstream text encoding failure"):
            wrap_sampler(sampler, {**self.document, "architecture": "moss_image"})(*arguments)
        self.assertEqual(resets, [[]])
        self.assertIs(encoder._moss_text_encoder_block_swap_offloader, offloader)
