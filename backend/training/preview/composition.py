"""Ordered weight-dependent composition, with only per-forward scratch tensors.

Pure additive adapters keep the low-rank fast path. When an adapter reads the
current weight, evaluate its input after earlier list entries. A fused QKV
adapter reads all three preceding projection states before its output slice
is selected; this matters for input-axis DoRA and cross-projection rotations.
"""
import torch

from .rebuild import apply_weight_delta, base_weight, module_shape


def composed_output_delta(module, plans, x, training_weights=None):
    bases, prefixes = {}, {}

    def original(target):
        if target not in bases:
            bias = getattr(target, "bias", None)
            weight, bias = base_weight(target, x.device), None if bias is None else bias.detach().to(x.device).float()
            if target in (training_weights or {}):
                weight, bias = training_weights[target].merged(weight, bias)
            bases[target] = weight, bias
        return bases[target]

    def effective(target, before):
        key = (target, before)
        if key in prefixes:
            return prefixes[key]
        weight, bias = original(target)
        for branch in plans.get(target, []):
            if branch.order >= before:
                break
            if hasattr(branch, "targets"):
                if len(branch.targets) == 1 and branch.targets[0] is target:
                    input_weight, input_bias = weight, bias
                else:
                    previous = [effective(other, branch.order) for other in branch.targets]
                    input_weight = torch.cat([item[0] for item in previous], dim=0)
                    input_bias = None if all(item[1] is None for item in previous) else torch.cat([
                        torch.zeros(module_shape(other)[0], device=x.device) if item[1] is None else item[1]
                        for other, item in zip(branch.targets, previous)])
                delta_weight, delta_bias = branch.parameter_delta(
                    x.device, base_override=input_weight, bias_override=input_bias)
            else:
                delta_weight, delta_bias = branch.parameter_delta(x.device)
            if delta_weight is not None:
                weight = weight + delta_weight
            if delta_bias is not None:
                bias = delta_bias if bias is None else bias + delta_bias
        prefixes[key] = (weight, bias)
        return weight, bias

    final_weight, final_bias = effective(module, (float("inf"), float("inf")))
    weight, bias = original(module)
    bias_delta = None if final_bias is None else final_bias - (0 if bias is None else bias)
    return apply_weight_delta(module, x, final_weight - weight, bias_delta)
