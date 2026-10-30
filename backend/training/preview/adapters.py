"""Linear LoRA / LoHa / LoKr tensor contracts and additive inference.

Format and scaling references:
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/weight_adapter/lora.py
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/weight_adapter/loha.py
https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/weight_adapter/lokr.py

This implementation uses PyTorch directly and never imports ComfyUI. LoKr
applies its two factors without constructing a full Kronecker weight. LoHa
reconstructs output chunks, bounding scratch memory instead of keeping one
full FP32 delta per adapted layer resident throughout sampling.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import math

import torch
import torch.nn.functional as F


class PreviewLoRAError(RuntimeError):
    pass


PARTS = {"hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b",
         "lokr_w1", "lokr_w2", "lokr_w1_a", "lokr_w1_b", "lokr_w2_a", "lokr_w2_b", "scalar"}


@dataclass
class Adapter:
    kind: str
    weights: dict
    scale: float
    in_features: int
    out_features: int
    output_slice: tuple | None = None
    embedding: bool = False
    order: tuple = (0, 0)

    @property
    def depends_on_weight(self):
        return False

    def parameter_delta(self, device=None, **kwargs):
        w = self.weights
        if self.kind == "lora":
            weight = w["up"] @ w["down"]
        elif self.kind == "loha":
            weight = (w["hada_w1_a"] @ w["hada_w1_b"]) * (w["hada_w2_a"] @ w["hada_w2_b"])
        else:
            weight = torch.kron(w["lokr_w1"], w["lokr_w2"])
            if self.output_slice:
                weight = weight[self.output_slice[0]:self.output_slice[1]]
        return weight * self.scale, None

    @property
    def down(self):
        return self.weights["down"]

    @property
    def up(self):
        return self.weights["up"]

    def to(self, device, cache):
        def move(tensor):
            if id(tensor) not in cache:
                cache[id(tensor)] = tensor.to(device)
            return cache[id(tensor)]
        return replace(self, weights={key: move(tensor) for key, tensor in self.weights.items()})

    def slice_outputs(self, start, stop):
        weights = dict(self.weights)
        if self.kind == "lora":
            weights["up"] = weights["up"][start:stop]
        elif self.kind == "loha":
            for key in ("hada_w1_a", "hada_w2_a"):
                weights[key] = weights[key][start:stop]
        else:
            return replace(self, out_features=stop - start, output_slice=(start, stop))
        return replace(self, weights=weights, out_features=stop - start)

    def apply(self, x):
        w = self.weights
        if self.embedding:
            indices = x.long()
            if self.kind == "lora":
                output = F.linear(F.embedding(indices, w["up"]), w["down"].T)
            elif self.kind == "loha":
                first = F.embedding(indices, w["hada_w1_a"]) @ w["hada_w1_b"]
                second = F.embedding(indices, w["hada_w2_a"]) @ w["hada_w2_b"]
                output = first * second
            else:
                first, second = w["lokr_w1"], w["lokr_w2"]
                left = F.embedding(indices // second.shape[0], first)
                right = F.embedding(indices % second.shape[0], second)
                output = (left.unsqueeze(-1) * right.unsqueeze(-2)).flatten(-2)
            return output * self.scale
        if self.kind == "lora":
            output = F.linear(F.linear(x, w["down"]), w["up"])
        elif self.kind == "loha":
            chunk = max(1, 2_097_152 // self.in_features)
            parts = []
            for start in range(0, self.out_features, chunk):
                first = w["hada_w1_a"][start:start + chunk] @ w["hada_w1_b"]
                second = w["hada_w2_a"][start:start + chunk] @ w["hada_w2_b"]
                first.mul_(second)
                parts.append(F.linear(x, first))
            output = torch.cat(parts, dim=-1)
        else:
            # [..., I1 * I2] -> [..., I1, I2] -> [..., O1 * O2]
            first = w["lokr_w1"]
            second = w["lokr_w2"]
            grouped = x.reshape(*x.shape[:-1], first.shape[1], second.shape[1])
            inner = F.linear(grouped, second)
            output = F.linear(inner.transpose(-1, -2), first).transpose(-1, -2)
            output = output.reshape(*x.shape[:-1], first.shape[0] * second.shape[0])
            if self.output_slice:
                output = output[..., self.output_slice[0]:self.output_slice[1]]
        return output * self.scale


def parse_adapter(group, multiplier):
    keys = set(group) - {"alpha", "scalar"}
    for key, tensor in group.items():
        if key in ("alpha", "scalar"):
            if tensor.numel() != 1 or not torch.isfinite(tensor).all():
                raise PreviewLoRAError(f"{key} must be a finite scalar")
        elif tensor.ndim != 2 or min(tensor.shape) == 0 or not tensor.is_floating_point() or not torch.isfinite(tensor).all():
            raise PreviewLoRAError(f"Invalid Linear adapter tensor: {key}")
    weights = {key: tensor.float() for key, tensor in group.items() if key in keys}
    rank = None
    if keys == {"down", "up"}:
        kind = "lora"
        down, up = weights["down"], weights["up"]
        rank, in_features = down.shape
        out_features, up_rank = up.shape
        if rank != up_rank:
            raise PreviewLoRAError("Invalid LoRA rank")
    elif keys == {"hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b"}:
        kind = "loha"
        first, second = [], []
        for side in (1, 2):
            a, b = weights[f"hada_w{side}_a"], weights[f"hada_w{side}_b"]
            if a.shape[1] != b.shape[0]:
                raise PreviewLoRAError("Invalid LoHa rank")
            first.append(a.shape)
            second.append(b.shape)
        if first[0] != first[1] or second[0] != second[1]:
            raise PreviewLoRAError("LoHa factor shape mismatch")
        out_features, rank = first[0]
        in_features = second[0][1]
    elif keys and keys <= {"lokr_w1", "lokr_w2", "lokr_w1_a", "lokr_w1_b", "lokr_w2_a", "lokr_w2_b"}:
        kind = "lokr"
        rebuilt = {}
        for side in (1, 2):
            key = f"lokr_w{side}"
            direct = key in weights
            factored = key + "_a" in weights or key + "_b" in weights
            if direct == factored:
                raise PreviewLoRAError("LoKr needs exactly one full matrix or factor pair per side")
            if direct:
                rebuilt[key] = weights[key]
            else:
                a, b = weights.get(key + "_a"), weights.get(key + "_b")
                if a is None or b is None or a.shape[1] != b.shape[0]:
                    raise PreviewLoRAError("Incomplete LoKr factors or invalid rank")
                if rank is not None and rank != b.shape[0]:
                    raise PreviewLoRAError("LoKr decomposed factors have different ranks")
                rank = b.shape[0]
                rebuilt[key] = a @ b
        weights = rebuilt
        out_features = weights["lokr_w1"].shape[0] * weights["lokr_w2"].shape[0]
        in_features = weights["lokr_w1"].shape[1] * weights["lokr_w2"].shape[1]
    else:
        raise PreviewLoRAError("Incomplete, mixed or unsupported LoRA / LoHa / LoKr components")
    alpha = group.get("alpha")
    # Full-matrix LoKr has unit alpha scaling, matching ComfyUI's weight loader.
    scale = multiplier * (float(alpha.item()) / rank if alpha is not None and rank is not None else 1.0)
    if "scalar" in group:
        scale *= float(group["scalar"].item())
    if not math.isfinite(scale):
        raise PreviewLoRAError("Adapter scale must be finite")
    return Adapter(kind, weights, scale, in_features, out_features)
