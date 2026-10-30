"""Strict adapter loading and temporary preview forward branches.

Design references (independent implementation, no ComfyUI runtime dependency):
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/lora.py
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/weight_adapter/lora.py
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/weight_adapter/bypass.py

As in ComfyUI, model-derived aliases resolve file keys and missing alpha means
unit scaling. The current training model is the starting point; external list
entries follow in order. Base tensors are never modified. Pure additive patches
use compressed branches; weight-dependent patches use per-forward scratch.
Both compute in FP32 outside the sampler's autocast context.
"""
from __future__ import annotations

from contextlib import contextmanager
import functools
import json
from pathlib import Path

import torch
from safetensors.torch import load_file

from . import anima, moss_image
from .adapters import PARTS, PreviewLoRAError, parse_adapter
from .rebuild import EXTRA_PARTS, module_shape, parse_rebuild
from .composition import composed_output_delta
from .live import LiveTrainingWeight, training_owner


SUFFIXES = (
    (".lora_down.weight", "down"), (".lora_up.weight", "up"),
    (".lora_A.weight", "down"), (".lora_B.weight", "up"),
    (".lora_A.default.weight", "down"), (".lora_B.default.weight", "up"),
    (".lora.down.weight", "down"), (".lora.up.weight", "up"),
    ("_lora.down.weight", "down"), ("_lora.up.weight", "up"),
    (".lora_linear_layer.down.weight", "down"), (".lora_linear_layer.up.weight", "up"),
    (".lora_A", "down"), (".lora_B", "up"),
    (".alpha", "alpha"),
) + tuple(("." + key, key) for key in PARTS | EXTRA_PARTS)
SUFFIXES = tuple(sorted(SUFFIXES, key=lambda item: len(item[0]), reverse=True))


def aliases(name):
    return (name, "diffusion_model." + name, "model.diffusion_model." + name,
            "transformer." + name, "base_model.model." + name,
            "lora_unet_" + name.replace(".", "_"), "lycoris_" + name.replace(".", "_"),
            "lora_transformer_" + name.replace(".", "_"), "oft_unet_" + name.replace(".", "_"),
            "lora_unet." + name)


def module_index(model, architecture):
    if architecture not in ("anima", "moss_image"):
        raise PreviewLoRAError(f"Unsupported architecture: {architecture}")
    modules = {}
    # torch.compile wraps modules with _orig_mod, which is not part of file keys.
    for path, module in model.named_modules():
        if hasattr(module, "_orig_mod"):
            continue
        if not isinstance(getattr(module, "weight", None), torch.Tensor):
            continue
        name = ".".join(part for part in path.split(".") if part != "_orig_mod")
        if name in modules and modules[name] is not module:
            raise PreviewLoRAError(f"Ambiguous model module: {name}")
        modules[name] = module
    index = {}
    for name, module in modules.items():
        for alias in aliases(name):
            if alias in index and index[alias] != [(name, module)]:
                raise PreviewLoRAError(f"Ambiguous LoRA alias: {alias}")
            index[alias] = [(name, module)]
    adapter = moss_image if architecture == "moss_image" else anima
    for name in modules:
        if not name.endswith(".proj.q"):
            continue
        fused = name[:-1] + "qkv"
        targets = adapter.fused_targets(fused)
        if targets and all(target in modules for target in targets):
            for alias in aliases(fused):
                index[alias] = [(target, modules[target]) for target in targets]
    return index


def make_adapter(group, multiplier, modules, options=None):
    basic = (all((hasattr(module, "in_features") or isinstance(module, torch.nn.Embedding))
                 and len(module_shape(module)) == 2 for module in modules)
             and set(group) <= (PARTS | {"down", "up", "alpha"})
             and all(tensor.ndim == 2 for key, tensor in group.items() if key not in ("scalar", "alpha")))
    adapter = (parse_adapter(group, multiplier) if basic else
               parse_rebuild(group, multiplier, modules, options=options))
    if basic and isinstance(modules[0], torch.nn.Embedding):
        adapter.embedding = True
    return adapter


def parse_training_adapter(owner, module):
    parts = {suffix.removeprefix("."): part for suffix, part in SUFFIXES}
    state = owner.state_dict()
    if not state or set(state) - parts.keys():
        raise PreviewLoRAError("Unknown live adapter state dictionary")
    group = {parts[key]: tensor.detach().float().clone() for key, tensor in state.items()}
    options = {key: getattr(owner, key) for key in ("coft", "coft_eps") if hasattr(owner, key)}
    return make_adapter(group, getattr(owner, "multiplier", 1), [module], options)


class LoRAManager:
    def __init__(self, rows, architecture):
        self.rows = rows
        self.architecture = architecture
        self._cache = {}  # CPU tensors only, reused across previews.
        self._active = False
        self._prepared_signature = None
        self._prepared = None
        self._has_text_encoder = None
        self._options = {}

    def _weights(self, path):
        if path not in self._cache:
            if Path(path).suffix.lower() == ".safetensors":
                from safetensors import safe_open

                with safe_open(path, framework="pt", device="cpu") as file:
                    metadata = file.metadata() or {}
                try:
                    options = json.loads(metadata.get("ss_network_args", "{}"))
                except (ValueError, TypeError) as exc:
                    raise PreviewLoRAError(f"Invalid adapter metadata: {path}") from exc
                self._options[path] = options if isinstance(options, dict) else {}
                self._cache[path] = load_file(path, device="cpu")
            else:
                state = torch.load(path, map_location="cpu", weights_only=True)
                if isinstance(state, dict) and "state_dict" in state:
                    state = state["state_dict"]
                if not isinstance(state, dict) or any(not isinstance(value, torch.Tensor) for value in state.values()):
                    raise PreviewLoRAError(f"Invalid adapter state dictionary: {path}")
                self._cache[path] = state
        return self._cache[path]

    @property
    def needs_text_encoder(self):
        if self._has_text_encoder is None:
            self._has_text_encoder = any(
                key.startswith(("lora_te_", "lora_te1_", "text_encoders.", "text_encoder."))
                for row in self.rows if row["multiplier"] != 0 for key in self._weights(row["path"]))
        return self._has_text_encoder

    def release_models(self):
        self._prepared_signature = self._prepared = None

    def prepare(self, model, text_encoder=None):
        if not any(row["multiplier"] != 0 for row in self.rows):
            return {}
        index = module_index(model, self.architecture)
        if text_encoder is not None:
            for alias, targets in module_index(text_encoder, self.architecture).items():
                if alias.startswith("lora_unet_"):
                    name = alias.removeprefix("lora_unet_")
                    index["lora_te_" + name] = targets
                    index["lora_te1_" + name] = targets
                elif alias.startswith("diffusion_model."):
                    name = alias.removeprefix("diffusion_model.")
                    index["text_encoder." + name] = targets
                    index["text_encoders.qwen3_06b.transformer.model." + name] = targets
                    index["text_encoders.qwen3_5.transformer.model." + name] = targets
                    index["text_encoders.qwen3_5_9b.transformer.model." + name] = targets
                    index["text_encoders.qwen35_9b.transformer.model." + name] = targets
                    index["text_encoders.transformer.model." + name] = targets
        signature = tuple((key, tuple((id(module), module_shape(module))
                                      for _, module in targets)) for key, targets in index.items())
        if signature == self._prepared_signature:
            return self._prepared
        result = {}
        for row_index, row in enumerate(self.rows):
            if row["multiplier"] == 0:
                continue
            path = row["path"]
            state = self._weights(path)
            groups = {}
            for key, tensor in state.items():
                match = next(((suffix, part) for suffix, part in SUFFIXES if key.endswith(suffix)), None)
                if match is None:
                    raise PreviewLoRAError(f"{path}: unsupported LoRA tensor / 不支持的权重: {key}")
                suffix, part = match
                base = key[:-len(suffix)]
                group = groups.setdefault(base, {})
                if part in group:
                    raise PreviewLoRAError(f"{path}: duplicate LoRA component: {key}")
                group[part] = tensor
            if not groups:
                raise PreviewLoRAError(f"{path}: empty LoRA / LoRA 文件没有权重")
            for group_index, (base, group) in enumerate(groups.items()):
                targets = index.get(base)
                if targets is None and base.endswith(".bias") and set(group) == {"set_weight"}:
                    targets = index.get(base[:-5])
                    group = {"set_bias": group["set_weight"]}
                if not targets:
                    raise PreviewLoRAError(f"{path}: unmatched DiT module / 无法匹配 DiT 模块: {base}. "
                                           "Adapter keys must match the selected DiT or text encoder / 适配器键名必须匹配当前 DiT 或文本编码器")
                try:
                    adapter = make_adapter(group, row["multiplier"], [module for _, module in targets], self._options.get(path, {}))
                except (ValueError, RuntimeError, TypeError, AttributeError, KeyError) as exc:
                    raise PreviewLoRAError(f"{path}: {base}: {exc}") from exc
                sizes = [module_shape(module)[0] for _, module in targets]
                if adapter.out_features != sum(sizes) or any(adapter.in_features != (module_shape(module)[1] if len(module_shape(module)) > 1 else module_shape(module)[0]) for _, module in targets):
                    raise PreviewLoRAError(f"{path}: shape mismatch / 权重形状不匹配: {base}")
                offset = 0
                for (name, module), size in zip(targets, sizes):
                    branch = adapter.slice_outputs(offset, offset + size)
                    branch.order = (row_index, group_index)
                    result.setdefault(module, []).append(branch)
                    offset += size
        self._prepared_signature, self._prepared = signature, result
        self._cache.clear()
        return result

    @contextmanager
    def activate(self, prepared, device):
        if self._active:
            raise PreviewLoRAError("Nested preview LoRA activation / 预览 LoRA 重复挂载")
        self._active = True
        restores = []
        modes, training_parameters = {}, {}
        try:
            # Allocate every branch before changing a forward; failure leaves the model intact.
            moved = {}
            resident = {module: [b.to(device, moved)
                                 for b in branches if b.scale != 0]
                        for module, branches in prepared.items()}
            owners = {module: owner for module in resident if (owner := training_owner(module)) is not None}
            for owner in owners.values():
                for child in owner.modules():
                    modes.setdefault(child, child.training)
                    child.training = False
                for parameter in owner.parameters():
                    if parameter not in training_parameters:
                        training_parameters[parameter] = parameter.detach().clone()
            training_weights = {}
            if any(branch.depends_on_weight for branches in resident.values() for branch in branches):
                training_weights = {module: LiveTrainingWeight(module, owner, device, parse_training_adapter)
                                    for module, owner in owners.items()}
            for module, branches in resident.items():
                if not branches:
                    continue
                original = module.forward
                own_forward = module.__dict__.get("forward")
                had_forward = "forward" in module.__dict__

                def make_forward(original, branches, module):
                    @functools.wraps(original)
                    def forward(x, *args, **kwargs):
                        output = original(x, *args, **kwargs)
                        with torch.autocast(device_type=x.device.type, enabled=False):
                            source = x.float()
                            if any(branch.depends_on_weight for branch in branches):
                                delta = composed_output_delta(module, resident, source, training_weights)
                            else:
                                delta = None
                                for branch in branches:
                                    addition = branch.apply(source)
                                    delta = addition if delta is None else delta + addition
                        return output + delta.to(output.dtype)
                    return forward

                restores.append((module, had_forward, own_forward))
                module.forward = make_forward(original, branches, module)
            yield
        finally:
            errors = []
            for module, had_forward, original in reversed(restores):
                try:
                    if had_forward:
                        module.forward = original
                    else:
                        del module.forward
                except Exception as exc:
                    errors.append(exc)
            for module, training in modes.items():
                try:
                    module.training = training
                except Exception as exc:
                    errors.append(exc)
            with torch.no_grad():
                for parameter, saved in training_parameters.items():
                    try:
                        parameter.copy_(saved)
                    except Exception as exc:
                        errors.append(exc)
            self._active = False
            if errors:
                raise PreviewLoRAError("Preview adapter restoration failed / 预览适配器恢复失败: " + "; ".join(map(str, errors))) from errors[0]
