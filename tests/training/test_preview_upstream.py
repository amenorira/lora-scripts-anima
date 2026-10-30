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
with manager.activate(manager.prepare(model), "cpu"), torch.no_grad():
    torch.testing.assert_close(layer(x), expected, rtol=1e-5, atol=1e-6)
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
    with manager.activate(manager.prepare(coft_model), "cpu"), torch.no_grad():
        torch.testing.assert_close(coft_model.proj(x), expected, rtol=1e-5, atol=1e-6)
        assert not torch.equal(live.oft_R.weight, saved), "COFT projection was not exercised"
        raise ValueError("injected sampling error")
except ValueError:
    pass
assert live.oft_R.weight is identity
assert torch.equal(live.oft_R.weight, saved)
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
