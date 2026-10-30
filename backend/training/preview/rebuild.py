"""Additional adapter formats, using the bundled engines' own reconstruction.

Low-rank common cases use adapters.py. Weight-dependent formats reconstruct a
single layer's delta on demand, leaving the live base weights and optimizer
untouched. Source layout follows ComfyUI's weight_adapter loaders; LyCORIS and
sd-scripts supply their native OFT/BOFT/DoRA/GLoRA reconstruction routines.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, replace
import importlib
import math

import torch
import torch.nn.functional as F

from .adapters import PreviewLoRAError


EXTRA_PARTS = {"dora_scale", "lora_mid.weight", "hada_t1", "hada_t2", "lokr_t2",
               "oft_blocks", "rescale", "oft_R.weight", "boft_R", "boft_s",
               "a1.weight", "a2.weight", "b1.weight", "b2.weight", "bm.weight",
               "diff", "diff_b", "set_weight", "w_norm", "b_norm", "weight", "on_input"}


def lycoris_modules():
    try:
        return importlib.import_module("lycoris.modules")
    except ModuleNotFoundError as exc:
        if exc.name != "lycoris":
            raise
        return importlib.import_module("vendor.lycoris.modules")


def base_weight(module, device):
    weight = module.weight.detach().to(device)
    if hasattr(module, "_convrot_groupsize"):
        from library.convrot_int8_kernels import dequantize_int8_convrot_weight

        return dequantize_int8_convrot_weight(weight, module.scale_weight.to(device), module._convrot_groupsize)
    if weight.dtype in (torch.float8_e4m3fn, torch.float8_e5m2):
        scale = getattr(module, "weight_scale", getattr(module, "scale_weight", None))
        if scale is not None:
            scale = scale.to(device).float()
            if scale.ndim == 3:
                return (weight.float().reshape(scale.shape[0], scale.shape[1], -1) * scale).reshape(weight.shape)
            if scale.ndim == 1:
                scale = scale.unsqueeze(1)
            return weight.float() * scale
    if not weight.is_floating_point():
        raise PreviewLoRAError(f"Unknown quantized base weight / 无法解析量化基底: {type(module).__name__}")
    return weight.float()


def module_shape(module):
    if hasattr(module, "in_features") and hasattr(module, "out_features"):
        return (module.out_features, module.in_features)
    return tuple(module.weight.shape)


def engine_diff_weight(engine, multiplier=1, device=None):
    """Read the delta with the same alpha/scalar semantics as native forward.

    LyCORIS LoHa/LoKr get_weight already includes alpha/rank; their exported
    get_diff_weight applies it again and omits scalar. Use the forward's path.
    """
    if getattr(engine, "name", None) in {"loha", "kron"}:
        weight = engine.get_weight(engine.shape).to(device)
        return weight * engine.scalar.to(weight) * multiplier, None
    return engine.get_diff_weight(multiplier=multiplier, device=device)


@dataclass
class RebuildAdapter:
    kind: str
    weights: dict
    scale: float
    in_features: int
    out_features: int
    targets: list
    engine: object = None
    output_slice: tuple | None = None
    order: tuple = (0, 0)

    @property
    def depends_on_weight(self):
        return self.kind in {"set", "set-bias", "ia3", "oft", "boft", "native-oft", "native-boft", "glora"} or "dora_scale" in self.weights

    def to(self, device, cache):
        weights = {}
        for key, tensor in self.weights.items():
            if id(tensor) not in cache:
                cache[id(tensor)] = tensor.to(device)
            weights[key] = cache[id(tensor)]
        engine = copy.deepcopy(self.engine).to(device=device, dtype=torch.float32) if self.engine is not None else None
        return replace(self, weights=weights, engine=engine)

    def slice_outputs(self, start, stop):
        return replace(self, out_features=stop - start, output_slice=(start, stop))

    def delta(self, device, *, base_override=None, bias_override=None):
        w = self.weights
        if self.kind == "diff":
            return w["diff"] * self.scale, w.get("diff_b", None) * self.scale if "diff_b" in w else None
        if self.kind in ("bias", "set-bias"):
            bias = w["diff_b" if self.kind == "bias" else "set_bias"].reshape(-1)
            if self.kind == "set-bias":
                if bias_override is None:
                    originals = [getattr(target, "bias", None) for target in self.targets]
                    bias_override = torch.cat([torch.zeros(module_shape(target)[0], device=bias.device)
                                               if value is None else value.to(bias)
                                               for target, value in zip(self.targets, originals)])
                bias = bias - bias_override
            return None, bias * self.scale
        base = base_override if base_override is not None else torch.cat([base_weight(target, device) for target in self.targets], dim=0)
        if self.kind == "set":
            return (w["set_weight"] - base) * self.scale, None
        if self.kind == "ia3":
            axis = bool(w["on_input"].item())
            vector = w["weight"].reshape(-1)
            return base * (vector if axis else vector[:, None]) * self.scale, None
        if self.kind in ("oft", "boft"):
            package = lycoris_modules().__package__.rsplit(".", 1)[0]
            functional = importlib.import_module(package + ".functional." + ("diag_oft" if self.kind == "oft" else "boft"))
            constraint = float(w.get("alpha", torch.tensor(0.)).item()) * base.shape[0]
            options = {"scale": self.scale} if self.kind == "boft" else {}
            delta = functional.diff_weight(base, w["oft_blocks"], w.get("rescale"),
                                           constraint=constraint, backend="torch", **options)
            return delta * (self.scale if self.kind == "oft" else 1), None
        if self.kind in ("native-oft", "native-boft"):
            if self.kind == "native-oft":
                rotation = self.engine.oft_R.get_rotation_blocks(apply_dropout=False)
                shaped = base.reshape(base.shape[0], self.engine.rank, self.engine.block_size)
                rotated = torch.einsum("ork,rck->orc", shaped, rotation).reshape_as(base)
            else:
                from networks.boft import BOFTModule

                factors, blocks, block, _ = w["boft_R"].shape
                rotations = BOFTModule.cayley_batch(w["boft_R"].reshape(-1, block, block)).reshape(factors, blocks, block, block)
                rotated = base.T
                for index, rotation in enumerate(rotations):
                    permutation = w[f"_permutation{index}"]
                    shaped = rotated[torch.argsort(permutation)].reshape(blocks, block, -1)
                    rotated = torch.bmm(rotation, shaped).reshape(base.shape[1], -1)[permutation]
                rotated = rotated.T * w["boft_s"]
            return (rotated - base) * self.scale, None
        proxy = self.engine.org_module[0]
        proxy.weight = torch.nn.Parameter(base, requires_grad=False)
        try:
            if "dora_scale" in w:
                diff, bias = engine_diff_weight(self.engine, multiplier=1, device=device)
                merged = base + diff
                magnitude = w["dora_scale"]
                axis = 0 if magnitude.shape[0] == merged.shape[0] else 1
                norm = merged.movedim(axis, 0).flatten(1).norm(dim=1)
                norm = norm.reshape(-1, *([1] * (merged.ndim - 1))).movedim(0, axis)
                normalized = merged * (magnitude / norm.clamp_min(torch.finfo(merged.dtype).eps))
                return (normalized - base) * self.scale, bias
            return engine_diff_weight(self.engine, multiplier=self.scale, device=device)
        finally:
            # Do not retain full dequantized FP32 layers between denoising calls.
            proxy.weight = torch.nn.Parameter(torch.empty(base.shape, device="meta"), requires_grad=False)

    def parameter_delta(self, device, **kwargs):
        weight, bias = self.delta(device, **kwargs)
        if self.output_slice:
            start, stop = self.output_slice
            if weight is not None:
                weight = weight[start:stop]
            if bias is not None:
                bias = bias[start:stop]
        return weight, bias

    def apply(self, x):
        return apply_weight_delta(self.targets[0], x, *self.parameter_delta(x.device))


def apply_weight_delta(module, x, weight, bias):
    bias = None if bias is None else bias.float().reshape(-1)
    convolution = isinstance(module, (torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d))
    if weight is None:
        if convolution or isinstance(module, torch.nn.GroupNorm):
            bias = bias.view(1, -1, *([1] * (x.ndim - 2)))
        return bias
    weight = weight.float()
    if hasattr(module, "in_features"):
        return F.linear(x, weight, bias)
    if convolution:
        op = (F.conv1d, F.conv2d, F.conv3d)[module.weight.ndim - 3]
        return op(x, weight, bias, module.stride, module.padding, module.dilation, module.groups)
    if isinstance(module, torch.nn.Embedding):
        return F.embedding(x.long(), weight, module.padding_idx)
    if isinstance(module, torch.nn.LayerNorm):
        normalized = F.layer_norm(x, module.normalized_shape, eps=module.eps)
    elif isinstance(module, torch.nn.GroupNorm):
        normalized = F.group_norm(x, module.num_groups, eps=module.eps)
        weight = weight.view(1, -1, *([1] * (x.ndim - 2)))
        if bias is not None:
            bias = bias.view(1, -1, *([1] * (x.ndim - 2)))
    elif callable(getattr(module, "_norm", None)):
        normalized = module._norm(x)
    else:
        eps = getattr(module, "eps", getattr(module, "variance_epsilon", 1e-6))
        normalized = x * torch.rsqrt(x.square().mean(dim=-1, keepdim=True) + eps)
    return normalized * weight + (0 if bias is None else bias)


def parse_rebuild(group, multiplier, targets, *, options=None):
    options = options or {}
    shapes = [module_shape(module) for module in targets]
    shape = (sum(item[0] for item in shapes), *shapes[0][1:])
    if any(item[1:] != shape[1:] for item in shapes):
        raise PreviewLoRAError("Incompatible fused target shapes")
    target = targets[0]
    supported = (hasattr(target, "in_features") or isinstance(target, (
        torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d, torch.nn.Embedding,
        torch.nn.LayerNorm, torch.nn.GroupNorm, torch.nn.RMSNorm))
        or callable(getattr(target, "_norm", None)) or type(target).__name__.endswith("RMSNorm"))
    if not supported:
        raise PreviewLoRAError(f"Unsupported adapter target: {type(target).__name__}")
    for key, tensor in group.items():
        if tensor.numel() == 0 or not torch.isfinite(tensor).all():
            raise PreviewLoRAError(f"Non-finite adapter tensor: {key}")
    weights = {key: value.float() for key, value in group.items()}
    if "w_norm" in weights:
        if set(weights) - {"w_norm", "b_norm"}:
            raise PreviewLoRAError("Mixed normalization adapter components")
        weights = {"diff": weights["w_norm"], **({"diff_b": weights["b_norm"]} if "b_norm" in weights else {})}
    kind = ""
    engine = None
    keys = set(weights)
    if keys in ({"diff_b"}, {"set_bias"}):
        key = next(iter(keys))
        if weights[key].numel() != shape[0]:
            raise PreviewLoRAError("Invalid bias adapter shape")
        kind = "bias" if key == "diff_b" else "set-bias"
    elif "diff" in keys:
        if keys - {"diff", "diff_b"} or tuple(weights["diff"].shape) != shape:
            raise PreviewLoRAError("Invalid full-diff adapter shape or components")
        if "diff_b" in keys and weights["diff_b"].numel() != shape[0]:
            raise PreviewLoRAError("Invalid bias diff shape")
        kind = "diff"
    elif "set_weight" in keys:
        if keys != {"set_weight"} or tuple(weights["set_weight"].shape) != shape:
            raise PreviewLoRAError("Invalid replacement weight")
        kind = "set"
    elif "on_input" in keys:
        if keys != {"on_input", "weight"} or weights["on_input"].numel() != 1:
            raise PreviewLoRAError("Invalid IA3 components")
        if weights["weight"].numel() != shape[1 if weights["on_input"].item() else 0]:
            raise PreviewLoRAError("Invalid IA3 shape")
        kind = "ia3"
    elif "oft_blocks" in keys:
        if keys - {"oft_blocks", "alpha", "rescale"}:
            raise PreviewLoRAError("Invalid OFT/BOFT components")
        blocks = weights["oft_blocks"]
        if blocks.ndim not in (3, 4) or blocks.shape[-1] != blocks.shape[-2] or blocks.shape[-3] * blocks.shape[-2] != shape[0]:
            raise PreviewLoRAError("Invalid OFT/BOFT block shape")
        if blocks.ndim == 4 and (blocks.shape[-1] % 2 or shape[0] % (2 ** (blocks.shape[0] - 1) * blocks.shape[-1])):
            raise PreviewLoRAError("Invalid BOFT butterfly shape")
        if "alpha" in weights and weights["alpha"].numel() != 1:
            raise PreviewLoRAError("OFT constraint must be scalar")
        if "rescale" in weights:
            if weights["rescale"].numel() != shape[0]:
                raise PreviewLoRAError("Invalid OFT rescale shape")
            weights["rescale"] = weights["rescale"].reshape(shape[0], *([1] * (len(shape) - 1)))
        kind = "oft" if blocks.ndim == 3 else "boft"
    elif "oft_R.weight" in keys or "boft_R" in keys:
        # Use native implementations: these rotate input channels and differ
        # from ComfyUI/LyCORIS's oft_blocks output-channel representation.
        proxy = torch.nn.Linear(shape[1], shape[0], bias=False, device="meta")
        if "oft_R.weight" in keys:
            from networks.oft_v2 import OFTv2Module

            if keys != {"oft_R.weight"} or weights["oft_R.weight"].ndim != 2:
                raise PreviewLoRAError("Invalid native OFTv2 components")
            r, elements = weights["oft_R.weight"].shape
            block = int((1 + math.isqrt(1 + 8 * elements)) // 2)
            if block * (block - 1) // 2 != elements or shape[1] % block or r not in (1, shape[1] // block):
                raise PreviewLoRAError("Invalid native OFTv2 shape")
            coft_eps = float(options.get("coft_eps", 6e-5))
            if not math.isfinite(coft_eps) or coft_eps <= 0:
                raise PreviewLoRAError("Invalid native OFTv2 constraint")
            engine = OFTv2Module("preview", "lora_unet", "preview", proxy, block_size=block,
                                 block_share=r == 1, auto_adjust=False,
                                 coft=str(options.get("coft", False)).lower() in ("true", "1"),
                                 coft_eps=coft_eps)
            kind = "native-oft"
        else:
            from networks.boft import BOFTModule

            if keys - {"boft_R", "boft_s"} or weights["boft_R"].ndim != 4:
                raise PreviewLoRAError("Invalid native BOFT components")
            factors, blocks, block, width = weights["boft_R"].shape
            if block != width or blocks * block != shape[1]:
                raise PreviewLoRAError("Invalid native BOFT shape")
            # Keep permutation vectors, rather than the native constructor's
            # full [in_features, in_features] permutation matrices per layer.
            if "boft_s" not in weights:
                weights["boft_s"] = torch.ones(shape[0], 1)
            elif weights["boft_s"].shape == (1, shape[0]):
                weights["boft_s"] = weights["boft_s"].T.contiguous()
            if weights["boft_s"].shape != (shape[0], 1):
                raise PreviewLoRAError("Invalid native BOFT scale shape")
            for index in range(factors):
                weights[f"_permutation{index}"] = BOFTModule.block_butterfly_perm(
                    shape[1], int(blocks / (2 ** index)), int(block / 2), factors - 1)
            kind = "native-boft"
        if engine is not None:
            info = engine.load_local_state(weights)
            if info.missing_keys or info.unexpected_keys:
                raise PreviewLoRAError(f"Native adapter keys do not match: {info}")
    else:
        modules = lycoris_modules()
        canonical = {"down": "lora_down.weight", "up": "lora_up.weight"}
        state = {"preview." + canonical.get(key, key): value for key, value in weights.items() if key != "dora_scale"}
        if "a1.weight" in weights:
            a1, a2, b1, b2 = (weights[key] for key in ("a1.weight", "a2.weight", "b1.weight", "b2.weight"))
            if a1.shape[1] == shape[1] and a2.shape[0] == shape[1] and b2.shape[0] == shape[0]:
                state.update({"preview.a1.weight": a2, "preview.a2.weight": a1,
                              "preview.b1.weight": b2, "preview.b2.weight": b1})
        if "alpha" not in weights:
            candidates = ("lora_down.weight", "hada_w1_b", "lokr_w2_b", "lokr_w1_b", "a2.weight")
            rank = next((state["preview." + key].shape[0] for key in candidates if "preview." + key in state), 1)
            state["preview.alpha"] = torch.tensor(float(rank))
        if "dora_scale" in weights:
            magnitude = weights["dora_scale"]
            valid = [(shape[0], *([1] * (len(shape) - 1))), (1, shape[1], *([1] * (len(shape) - 2)))]
            if tuple(magnitude.shape) not in valid:
                raise PreviewLoRAError("Invalid DoRA magnitude shape")
        cls, params = modules.get_module(state, "preview")
        if cls is None:
            raise PreviewLoRAError("Unrecognized adapter format")
        accepted = set(cls.weight_list)
        if {key.removeprefix("preview.") for key in state} - accepted:
            raise PreviewLoRAError(f"Mixed or unsupported components for {cls.name}")
        # A proxy prevents constructors from touching the live model. DoRA's
        # initial norm is overwritten by the file's magnitude tensor.
        if hasattr(target, "in_features"):
            proxy = torch.nn.Linear(shape[1], shape[0], bias=False, device="meta")
        elif isinstance(target, (torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d)):
            cls_conv = (torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d)[len(shape) - 3]
            proxy = cls_conv(target.in_channels, target.out_channels, target.kernel_size,
                             stride=target.stride, padding=target.padding, dilation=target.dilation,
                             groups=target.groups, bias=False, device="meta")
        elif len(targets) == 1:
            proxy = copy.copy(target)
            proxy._parameters = {key: (None if tensor is None else torch.nn.Parameter(
                torch.empty(tensor.shape, device="meta"), requires_grad=False))
                for key, tensor in target._parameters.items()}
            proxy._buffers = {}
            proxy._modules = {}
            proxy.__dict__.pop("forward", None)
        else:
            proxy = torch.nn.Linear(shape[1], shape[0], bias=False,
                                    device="meta")
        with torch.no_grad():
            engine = modules.make_module(cls, params, "preview", proxy)
        if engine is None or getattr(engine, "not_supported", False):
            raise PreviewLoRAError(f"Unsupported target for {cls.name}")
        kind = cls.name
        proxy.weight = torch.nn.Parameter(torch.empty(shape, device="meta"), requires_grad=False)
        expected = engine.state_dict()
        for key, value in state.items():
            local = key.removeprefix("preview.")
            if local in expected and expected[local].shape != value.shape:
                raise PreviewLoRAError(f"{kind} tensor shape mismatch: {local}")
    if engine is not None:
        engine.requires_grad_(False).eval()
    return RebuildAdapter(kind, weights, multiplier, shape[1] if len(shape) > 1 else shape[0], shape[0], targets, engine)
