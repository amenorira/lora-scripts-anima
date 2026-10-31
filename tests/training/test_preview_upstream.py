"""Run the unchanged upstream samplers with tiny real DiTs in isolated processes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
PROGRAM = r'''
from tools.runtime_paths import configure_test_paths
configure_test_paths()
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
import torch
import torch.nn.functional as F
from unittest.mock import patch
from safetensors.torch import save_file
from accelerate import Accelerator
torch.set_num_threads(1)
architecture, folder = sys.argv[1], Path(sys.argv[2])
if architecture == "moss_image":
    from library.moss_image_models import MossImage
    model = MossImage(dim=32, ffn_dim=64, num_heads=4, num_layers=1, text_dim=16, freq_dim=16)
    name = "layers.0.proj.q"
else:
    from library.anima_models import Anima
    model = Anima(max_img_h=64, max_img_w=64, max_frames=1, in_channels=16, out_channels=16,
                  patch_spatial=2, patch_temporal=1, model_channels=64, num_blocks=1,
                  num_heads=4, crossattn_emb_channels=16, concat_padding_mask=False, pos_emb_cls="rope3d")
    name = next(n for n, m in model.named_modules() if n.startswith("blocks.0.") and isinstance(m, torch.nn.Linear))
from networks import lora_generic
network = lora_generic.create_network(1., 2, 2, None, [], model)
network.apply_to([], model, apply_text_encoder=False, apply_unet=True)
for n, p in network.named_parameters():
    if "lora_up" in n:
        torch.nn.init.normal_(p, std=0.01)
layer = model.get_submodule(name)
optimizer = torch.optim.SGD(network.parameters(), lr=0.01)
def training_step():
    optimizer.zero_grad()
    layer(torch.randn(2, layer.in_features)).square().mean().backward()
    optimizer.step()
training_step()
rows = []
for i, kind in enumerate(("lora", "loha", "lokr")):
    key = "diffusion_model." + name
    if kind == "lora":
        state = {"lora_A.weight": torch.randn(2, layer.in_features) * 0.01,
                 "lora_B.weight": torch.randn(layer.out_features, 2) * 0.01, "alpha": torch.tensor(2.)}
    elif kind == "loha":
        state = {"hada_w1_a": torch.randn(layer.out_features, 2) * 0.01,
                 "hada_w1_b": torch.randn(2, layer.in_features) * 0.01,
                 "hada_w2_a": torch.randn(layer.out_features, 2) * 0.01,
                 "hada_w2_b": torch.randn(2, layer.in_features) * 0.01, "alpha": torch.tensor(2.)}
    else:
        state = {"lokr_w1": torch.ones(1, 1), "lokr_w2": torch.randn(layer.out_features, layer.in_features) * 0.001}
    path = folder / (kind + ".safetensors")
    save_file({key + "." + k: v for k, v in state.items()}, path)
    rows.append({"path": str(path), "multiplier": [0.5, -0.3, 0.2][i]})
Path(os.environ["ANIMA_PREVIEW_LORAS_CONFIG"]).write_text(json.dumps(
    {"schema_version": 1, "architecture": architecture, "loras": rows}), encoding="utf-8")
if architecture == "moss_image":
    from library import moss_image_train_utils as sampling
else:
    from library import anima_train_utils as sampling
assert getattr(sampling.sample_images, "_anima_preview_loras", False), "startup hook did not install"
prompts = folder / "prompts.json"
prompts.write_text(json.dumps([{"prompt": "tiny", "width": 64, "height": 64,
                               "sample_steps": 2, "scale": 1., "seed": 42}]), encoding="utf-8")
args = SimpleNamespace(sample_at_first=True, sample_every_n_steps=1, sample_every_n_epochs=None,
                       sample_prompts=str(prompts), output_dir=str(folder), output_name="tiny",
                       sample_uncond_skip_layers="")
class TinyVAE(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("anchor", torch.zeros(1))
    @property
    def device(self): return self.anchor.device
    @property
    def dtype(self): return self.anchor.dtype
    def decode_from_dit(self, latents):
        self.last_latents = latents.detach().clone()
        assert torch.isfinite(latents).all()
        return F.interpolate(latents[:, :3], (64, 64))
    def decode_to_pixels(self, latents):
        self.last_latents = latents.detach().clone()
        assert torch.isfinite(latents).all()
        return F.interpolate(latents[:, :3, 0], (64, 64))
features, mask = torch.randn(1, 4, 16), torch.ones(1, 4, dtype=torch.bool)
embeddings = (features, mask) if architecture == "moss_image" else (features, mask, torch.ones(1, 4, dtype=torch.long), mask)
vae, accelerator = TinyVAE(), Accelerator(cpu=True)
before = {k: v.clone() for k, v in network.state_dict().items()}
rng = torch.get_rng_state()
from backend.training.preview.adapters import Adapter
external_calls = {}
apply_adapter = Adapter.apply
def observed_apply(adapter, x):
    delta = apply_adapter(adapter, x)
    assert delta.abs().max() > 0, "external adapter had no effect"
    external_calls[adapter.kind] = external_calls.get(adapter.kind, 0) + 1
    return delta
with patch.object(Adapter, "apply", observed_apply):
    sampling.sample_images(accelerator, args, None, 1, model, vae, None, None, None, {"tiny": embeddings})
assert set(external_calls) == {"lora", "loha", "lokr"}, external_calls
assert list((folder / "sample").glob("*.png")), "no preview image was written"
assert torch.equal(rng, torch.get_rng_state()), "sampling changed training RNG"
assert before.keys() == network.state_dict().keys()
for key in before:
    assert torch.equal(before[key], network.state_dict()[key]), key
from backend.training.preview.sampling import wrap_sampler
from backend.training.preview.config import SAMPLERS, SCHEDULERS
base_sampler = sampling.sample_images.__wrapped__
document = {"schema_version": 1, "architecture": architecture, "loras": []}
base_sampler(accelerator, args, None, 1, model, vae, None, None, None, {"tiny": embeddings})
native_latents = vae.last_latents.clone()
wrap_sampler(base_sampler, document)(accelerator, args, None, 1, model, vae, None, None, None, {"tiny": embeddings})
torch.testing.assert_close(vae.last_latents, native_latents, rtol=0, atol=0)
kernel_name = "generate_latents" if architecture == "moss_image" else "do_sample"
original_kernel = getattr(sampling, kernel_name)
prompts.write_text(json.dumps([{"prompt": "tiny", "negative_prompt": "negative", "width": 64, "height": 64,
                               "sample_steps": 4, "scale": 2., "seed": 42}]), encoding="utf-8")
cache = {"tiny": embeddings, "negative": embeddings}
for sampler_name in SAMPLERS:
    for scheduler_name in SCHEDULERS:
        args.output_name = sampler_name + "_" + scheduler_name
        wrapped = wrap_sampler(base_sampler, {**document, "loras": rows, "sampler": sampler_name, "scheduler": scheduler_name})
        with patch.object(Adapter, "apply", observed_apply):
            wrapped(accelerator, args, None, 1, model, vae, None, None, None, cache)
        assert getattr(sampling, kernel_name) is original_kernel
        assert torch.equal(rng, torch.get_rng_state())
        for key in before:
            assert torch.equal(before[key], network.state_dict()[key]), key
wrapped = wrap_sampler(base_sampler, {**document, "loras": rows, "sampler": "heun", "scheduler": "simple"})
with patch("backend.training.preview.kernels.sample", side_effect=ValueError("injected preview error")):
    try:
        wrapped(accelerator, args, None, 1, model, vae, None, None, None, cache)
        raise AssertionError("preview exception was swallowed")
    except ValueError as exc:
        assert "injected preview error" in str(exc)
assert getattr(sampling, kernel_name) is original_kernel
assert torch.equal(rng, torch.get_rng_state())
# Non-default sampling is also functional with an empty external-adapter list.
wrapped = wrap_sampler(base_sampler, {**document, "sampler": "er_sde", "scheduler": "simple"})
with patch("backend.training.preview.lora.LoRAManager._weights", side_effect=AssertionError("unexpected adapter I/O")):
    wrapped(accelerator, args, None, 1, model, vae, None, None, None, cache)
assert getattr(sampling, kernel_name) is original_kernel
assert torch.equal(rng, torch.get_rng_state())
training_step()
assert any(not torch.equal(before[k], network.state_dict()[k]) for k in before)
# A weight-dependent external DoRA sees the current native training LoRA too.
from backend.training.preview.lora import LoRAManager
live = layer.forward.__self__
effective = layer.weight.detach() + live.lora_up.weight.detach() @ live.lora_down.weight.detach() * live.scale * live.multiplier
down, up = torch.randn(2, layer.in_features) * 0.01, torch.randn(layer.out_features, 2) * 0.01
merged = effective + up @ down
magnitude = merged.norm(dim=1, keepdim=True) * 1.2
path = folder / "live_external_dora.safetensors"
save_file({"diffusion_model." + name + "." + k: v for k, v in {
    "lora_down.weight": down, "lora_up.weight": up, "dora_scale": magnitude}.items()}, path)
manager = LoRAManager([{"path": str(path), "multiplier": 0.4}], architecture)
x = torch.randn(2, layer.in_features)
expected = F.linear(x, effective + (merged * 1.2 - effective) * 0.4, layer.bias)
versions = [p._version for p in network.parameters()]
from backend.training.preview.live import LiveTrainingWeight
with patch("backend.training.preview.lora.LiveTrainingWeight", wraps=LiveTrainingWeight) as snapshots:
    with manager.activate(manager.prepare(model), "cpu", models=(model,)), torch.no_grad():
        torch.testing.assert_close(layer(x), expected, rtol=1e-5, atol=1e-6)
    assert snapshots.call_count == 1, snapshots.call_count
assert versions == [p._version for p in network.parameters()], "preview wrote non-mutating training parameters"
# The actual compile + block-swap helper wraps bound training forwards.
from library.compile_utils import disable_linear_from_compile
disable_linear_from_compile(model)
wrapped_forward = layer.forward
with manager.activate(manager.prepare(model), "cpu", models=(model,)), torch.no_grad():
    torch.testing.assert_close(layer(x), expected, rtol=1e-5, atol=1e-6)
assert layer.forward is wrapped_forward
training_step()
# Native sd-scripts input-channel rotation formats: validate against the
# original per-module implementations, including non-unit multipliers.
from networks.oft_v2 import OFTv2Module
from networks.boft import BOFTModule
from backend.training.preview.rebuild import parse_rebuild
plain = torch.nn.Linear(8, 8, bias=False)
x = torch.randn(2, 8)
for cls, options in ((OFTv2Module, {"block_size": 4}),
                     (OFTv2Module, {"block_size": 4, "block_share": True, "coft": True, "coft_eps": 0.001}),
                     (BOFTModule, {"block_size": 4, "boft_n_butterfly_factor": 2})):
    native = cls("test", "lora_unet", "test", plain, multiplier=0.4, **options).eval()
    for p in native.parameters():
        torch.nn.init.normal_(p, std=0.02)
    native.org_forward = plain.forward
    state = {k: v.detach().clone() for k, v in native.state_dict().items()}
    adapter = parse_rebuild(state, 0.4, [plain], options=options).to("cpu", {})
    expected = native(x)
    actual = plain(x) + adapter.apply(x)
    torch.testing.assert_close(actual, expected, rtol=1e-5, atol=1e-6)
# Native COFT projects parameters even during eval. Preview must restore those
# compressed parameters, mixed module modes, and optimizer parameter identities.
coft_model = torch.nn.Module()
coft_model.proj = torch.nn.Linear(8, 8, bias=False)
coft_model.other = torch.nn.Linear(8, 8, bias=False)
untargeted = OFTv2Module("other", "lora_unet", "other", coft_model.other, block_size=4, coft=True)
with torch.no_grad(): untargeted.oft_R.weight.fill_(0.1)
untargeted.apply_to()
untargeted_saved = untargeted.oft_R.weight.detach().clone()
live = OFTv2Module("live", "lora_unet", "proj", coft_model.proj, block_size=4, coft=True)
with torch.no_grad(): live.oft_R.weight.fill_(0.1)
live.apply_to()
saved = live.oft_R.weight.detach().clone()
identity = live.oft_R.weight
path = folder / "live_external_ia3.safetensors"
save_file({"lora_unet_proj.weight": torch.ones(8), "lora_unet_proj.on_input": torch.tensor(1)}, path)
manager = LoRAManager([{"path": str(path), "multiplier": 1}], architecture)
reference = parse_rebuild({k: v.detach().clone() for k, v in live.state_dict().items()}, 1, [coft_model.proj],
                          options={"coft": True}).to("cpu", {})
x = torch.randn(2, 8)
expected = (F.linear(x, coft_model.proj.weight) + reference.apply(x)) * 2
try:
    with manager.activate(manager.prepare(coft_model), "cpu", models=(coft_model,)), torch.no_grad():
        torch.testing.assert_close(coft_model.proj(x), expected, rtol=1e-5, atol=1e-6)
        coft_model.other(x)
        assert not torch.equal(untargeted.oft_R.weight, untargeted_saved)
        assert not torch.equal(live.oft_R.weight, saved), "COFT projection was not exercised"
        raise ValueError("injected sampling error")
except ValueError:
    pass
assert live.oft_R.weight is identity
assert torch.equal(live.oft_R.weight, saved)
assert torch.equal(untargeted.oft_R.weight, untargeted_saved), "untargeted COFT was not restored"
assert live.training and live.oft_R.training
# ConvRot INT8 keeps its packed base tensors intact while external adapters
# execute on the original activation (CPU fallback and CUDA when available).
from library.convrot_int8_kernels import quantize_int8_convrot_weight
from library.convrot_int8_utils import apply_convrot_int8_monkey_patch
from backend.training.preview.lora import LoRAManager
from backend.training.preview.rebuild import base_weight
quantized = torch.nn.Module()
quantized.proj = torch.nn.Linear(8, 8, bias=False)
quantized.requires_grad_(False)
q, scale = quantize_int8_convrot_weight(quantized.proj.weight, 4)
state = {"proj.weight": q, "proj.scale_weight": scale}
apply_convrot_int8_monkey_patch(quantized, state, groupsize=4)
quantized.load_state_dict(state, assign=True)
down, up = torch.randn(2, 8) * 0.01, torch.randn(8, 2) * 0.01
path = folder / "quantized_lora.safetensors"
save_file({"lora_unet_proj.lora_down.weight": down, "lora_unet_proj.lora_up.weight": up}, path)
for device in (["cpu", "cuda"] if torch.cuda.is_available() else ["cpu"]):
    quantized.to(device)
    x = torch.randn(2, 8, device=device)
    manager = LoRAManager([{"path": str(path), "multiplier": 0.7}], architecture)
    packed = quantized.proj.weight.detach().clone()
    delta = F.linear(F.linear(x.float(), down.to(device)), up.to(device)) * 0.7
    with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=device == "cuda"):
        baseline = quantized.proj(x)
        expected = baseline + delta.to(baseline.dtype)
        with manager.activate(manager.prepare(quantized), device):
            torch.testing.assert_close(quantized.proj(x), expected, rtol=1e-3, atol=1e-4)
    assert torch.equal(quantized.proj.weight, packed)
# Exercise both upstream encoding strategies with a tiny real Qwen encoder.
# Frozen prompts are encoded once; neither TE forwards nor GPU branches survive
# into the original sampler, which consumes CPU embeddings on subsequent calls.
from transformers import Qwen3Config, Qwen3Model
encoder = Qwen3Model(Qwen3Config(vocab_size=32, hidden_size=16, intermediate_size=32,
                               num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=2,
                               head_dim=8)).requires_grad_(False).eval()
te_path = folder / "text_encoder_lora.safetensors"
save_file({"lora_te_layers_0_self_attn_q_proj.lora_down.weight": torch.randn(2, 16) * .02,
           "lora_te_layers_0_self_attn_q_proj.lora_up.weight": torch.randn(16, 2) * .02}, te_path)
ids, mask = torch.tensor([[1, 2, 3, 4]]), torch.ones(1, 4, dtype=torch.long)
if architecture == "anima":
    from library.strategy_anima import AnimaTextEncodingStrategy
    strategy = AnimaTextEncodingStrategy()
    tokenize = SimpleNamespace(tokenize=lambda text: [ids, mask, ids, mask])
else:
    from library.strategy_moss_image import MossImageTextEncodingStrategy
    strategy = MossImageTextEncodingStrategy()
    tokenize = SimpleNamespace(tokenize=lambda text: [ids, mask])
wrapped = wrap_sampler(base_sampler, {**document, "loras": rows + [{"path": str(te_path), "multiplier": .5}]})
with patch("backend.training.preview." + architecture + ".load_text_encoder", return_value=encoder) as loader, \
     patch.object(strategy, "encode_tokens", wraps=strategy.encode_tokens) as encoding:
    missing_args = SimpleNamespace(**{**vars(args), "sample_prompts": str(folder / "missing.json")})
    wrapped(accelerator, missing_args, None, 1, model, vae, None, tokenize, strategy)
    assert loader.call_count == 0 and encoding.call_count == 0
    for step in (1, 2):
        wrapped(accelerator, args, None, step, model, vae, None, tokenize, strategy)
    assert loader.call_count == 1, loader.call_count
    assert encoding.call_count == 2, encoding.call_count
assert encoder.device.type == "cpu"
assert "forward" not in encoder.layers[0].self_attn.q_proj.__dict__
# DiT-only external adapters must still disable the live TE adapter's dropout.
from networks.lora_anima import LoRAModule as QwenLoRA
te_training = QwenLoRA("live_te", encoder.layers[0].self_attn.q_proj, lora_dim=2, module_dropout=1.)
te_training.apply_to()
te_training.train()
native_encode = strategy.encode_tokens
def encode_in_eval(*arguments):
    assert not te_training.training, "live TE training dropout remained enabled during preview"
    outputs = native_encode(*arguments)
    if fail_encoding:
        raise ValueError("injected live TE error")
    return outputs
for fail_encoding in (False, True):
    wrapped = wrap_sampler(base_sampler, {**document, "loras": rows})
    with patch.object(strategy, "encode_tokens", side_effect=encode_in_eval):
        try:
            wrapped(accelerator, args, None, 1, model, vae, encoder, tokenize, strategy)
            assert not fail_encoding
        except ValueError as error:
            assert fail_encoding and "injected live TE error" in str(error)
    assert te_training.training, "live TE training mode was not restored"
training_step()
print("upstream preview + resumed training + native orthogonal formats OK", architecture)
'''


class UpstreamPreviewTests(unittest.TestCase):
    def test_real_samplers_and_training_resume_for_both_architectures(self):
        for architecture in ("moss_image", "anima"):
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as directory:
                env = os.environ.copy()
                env["PYTHONDONTWRITEBYTECODE"] = "1"
                env["ANIMA_ENABLE_FLASH_ATTN"] = "0"
                env["ANIMA_PREVIEW_LORAS_CONFIG"] = str(Path(directory) / "preview.json")
                env["PYTHONPATH"] = os.pathsep.join(map(str, [ROOT / "tools/python_startup", ROOT,
                                                               ROOT / "vendor/sd-scripts", ROOT / "vendor"]))
                result = subprocess.run([sys.executable, "-B", "-c", PROGRAM, architecture, directory],
                                        cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", timeout=180)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
