"""Read the live training adapter without merging into trainable base tensors.

The current training model is the starting point, followed by the external list.
Only weight-dependent external patches need the live adapter's effective weight.
Compression is retained between calls; dense scratch is local to one forward.
"""
import copy
import inspect

import torch

from .adapters import PreviewLoRAError
from .rebuild import apply_weight_delta, engine_diff_weight


def training_owner(module):
    # Block swapping disables compilation around Linear.forward. Unwrap that
    # function before looking for the adapter's bound method.
    owner = getattr(inspect.unwrap(module.forward), "__self__", None)
    if owner is not module and isinstance(owner, torch.nn.Module) and callable(getattr(owner, "org_forward", None)):
        return owner
    return None


def _snapshot_engine(module, device):
    """Copy compressed tensors only; org_module/org_forward are plain references."""
    result = copy.copy(module)
    result._parameters = {key: None if value is None else torch.nn.Parameter(
        value.detach().to(device=device, dtype=torch.float32).clone(), requires_grad=False)
        for key, value in module._parameters.items()}
    result._buffers = {key: None if value is None else value.detach().to(
        device=device, dtype=torch.float32 if value.is_floating_point() else value.dtype).clone()
        for key, value in module._buffers.items()}
    result._modules = {key: None if value is None else _snapshot_engine(value, device)
                       for key, value in module._modules.items()}
    result.training = False
    return result


class LiveTrainingWeight:
    def __init__(self, module, owner, device, parse):
        has_engine = callable(getattr(owner, "get_merged_weight", None))
        # LyCORIS rescale/DoRA can still act at zero multiplier. Native sd-scripts
        # modules explicitly short-circuit that case, so keep the two contracts.
        self.enabled = getattr(owner, "enabled", True) and (has_engine or getattr(owner, "multiplier", 1) != 0)
        self.multiplier = getattr(owner, "multiplier", 1)
        self.engine = self.adapter = None
        forward = getattr(owner.forward, "__func__", owner.forward)
        fp8_check = getattr(forward, "__globals__", {}).get("is_weight_only_fp8_linear")
        self.fp8_weight_decompose = bool(callable(fp8_check) and fp8_check(module))
        if not self.enabled:
            return
        if has_engine:
            # Preserve the live algorithm's scaling, including its own DoRA
            # interpolation. An independent FP32 copy avoids bf16 matmul errors.
            self.engine = _snapshot_engine(owner, device)
            if hasattr(self.engine, "w_norm") and not hasattr(self.engine, "b_norm"):
                self.engine.b_norm = None
            proxy = copy.copy(module)
            proxy._parameters, proxy._buffers, proxy._modules = {}, {}, {}
            self.engine.org_module = [proxy]
        else:
            try:
                self.adapter = parse(owner, module).to(device, {})
            except (ValueError, RuntimeError, TypeError, KeyError, AttributeError) as exc:
                raise PreviewLoRAError(f"Cannot reconstruct live training adapter / 无法重建当前训练适配器: {type(owner).__name__}: {exc}") from exc

    def merged(self, weight, bias):
        if not self.enabled:
            return weight, bias
        if self.engine is None:
            if hasattr(self.adapter, "targets"):
                delta, delta_bias = self.adapter.parameter_delta(weight.device, base_override=weight, bias_override=bias)
            else:
                delta, delta_bias = self.adapter.parameter_delta(weight.device)
            return (weight if delta is None else weight + delta,
                    bias if delta_bias is None else delta_bias if bias is None else bias + delta_bias)
        proxy = self.engine.org_module[0]
        proxy.weight = torch.nn.Parameter(weight, requires_grad=False)
        proxy.bias = None if bias is None else torch.nn.Parameter(bias, requires_grad=False)
        try:
            kind = getattr(self.engine, "name", None)
            if kind in {"locon", "loha", "kron"}:
                diff, _ = engine_diff_weight(self.engine, device=weight.device)
                bypass = self.engine.bypass_mode
                if kind == "kron" and self.engine.wd and self.fp8_weight_decompose:
                    bypass = False  # Native LoKr rebuilds FP8 DoRA even in bypass mode.
                merged = (self.engine.apply_weight_decompose(weight + diff, self.multiplier)
                          if self.engine.wd and not bypass else weight + diff * self.multiplier)
                merged_bias = bias
            else:
                merged, merged_bias = self.engine.get_merged_weight(multiplier=self.multiplier, device=weight.device)
                if kind == "diag-oft" and self.engine.bypass_mode and self.engine.rescaled and self.multiplier != 1:
                    merged = merged + (self.engine.rescale - 1) * weight
            if bias is not None and self.engine.bypass_mode:
                merged_bias = self._bypass_bias(proxy, weight, bias, merged_bias)
            if merged is None or merged.shape != weight.shape:
                raise PreviewLoRAError("Live training adapter weight shape changed / 当前训练适配器权重形状不兼容")
            return merged.float(), bias if merged_bias is None else merged_bias.float()
        finally:
            proxy._parameters.clear()

    def _bypass_bias(self, proxy, weight, bias, merged_bias):
        # Output-channel IA3/OFT/BOFT can transform the original bias too. A
        # zero-input forward on the independent engine reads the actual native
        # affine offset without invoking or mutating the live training module.
        if hasattr(proxy, "in_features"):
            shape = (1, proxy.in_features)
        elif isinstance(proxy, (torch.nn.Conv1d, torch.nn.Conv2d, torch.nn.Conv3d)):
            shape = (1, proxy.in_channels, *(d * (k - 1) + 1 for d, k in zip(proxy.dilation, proxy.kernel_size)))
        else:
            return merged_bias
        original = self.engine.org_forward
        self.engine.org_forward = lambda x, *args, **kwargs: apply_weight_delta(proxy, x, weight, bias)
        try:
            output = self.engine(torch.zeros(shape, device=weight.device, dtype=torch.float32))
            return output[0] if output.ndim == 2 else output[(0, slice(None), *([0] * (output.ndim - 2)))]
        finally:
            self.engine.org_forward = original
