"""GPU smoke test for the frozen Qwen3.5 encoder's optional kernels."""
from __future__ import annotations

import argparse
import inspect
import json
from pathlib import Path
import sys
import time


def check(site: Path, *, benchmark: bool = False) -> dict:
    sys.path.insert(0, str(site.resolve()))
    import torch
    import torch.nn.functional as F
    import causal_conv1d
    import fla
    from fla.ops.gated_delta_rule import chunk_gated_delta_rule
    from transformers.models.qwen3_5 import modeling_qwen3_5 as qwen

    for module in (causal_conv1d, fla):
        if not Path(module.__file__).resolve().is_relative_to(site.resolve()):
            raise RuntimeError(f"Kernel imported outside the isolated directory: {module.__file__}")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU required / 需要可用的 CUDA GPU")
    torch.manual_seed(20261023)
    device = torch.device('cuda')
    dtype = torch.bfloat16
    reference_delta = inspect.unwrap(qwen.torch_chunk_gated_delta_rule)
    checks = []

    def compare(name, actual, expected):
        if not torch.isfinite(actual).all() or not torch.isfinite(expected).all():
            raise RuntimeError(f"{name}: non-finite output")
        relative_rms = ((actual.float() - expected.float()).square().mean().sqrt()
                        / expected.float().square().mean().sqrt().clamp_min(1e-8)).item()
        torch.testing.assert_close(actual, expected, atol=0.02, rtol=0.05)
        if relative_rms > 0.02:
            raise RuntimeError(f"{name}: relative RMS error {relative_rms:.5f} > 0.02")
        checks.append({'name': name, 'relative_rms': relative_rms})

    def delta_inputs(length):
        q = torch.randn(1, length, 16, 128, device=device, dtype=dtype).repeat_interleave(2, dim=2)
        k = torch.randn_like(q)
        v = torch.randn_like(q)
        g = -F.softplus(torch.randn(1, length, 32, device=device))
        beta = torch.randn(1, length, 32, device=device, dtype=dtype).sigmoid()
        return q, k, v, g, beta

    def delta(fn, args):
        return fn(*args, use_qk_l2norm_in_kernel=True, output_final_state=False)[0]

    def reference_conv(x, weight):
        return F.silu(F.conv1d(x, weight.unsqueeze(1), padding=3, groups=x.shape[1])[..., :x.shape[-1]])

    with torch.no_grad():
        for length in (17, 128, 257, 4096):
            # Qwen3.5-9B: 16 key heads, 32 value heads, dimension 128;
            # mixed_qkv has 8192 channels and uses a channel-last view.
            weight = torch.randn(8192, 4, device=device, dtype=dtype) * 0.1
            x = torch.randn(1, length, 8192, device=device, dtype=dtype).transpose(1, 2)
            expected = reference_conv(x, weight)
            compare(f'conv/{length}', causal_conv1d.causal_conv1d_fn(x, weight, activation='silu'), expected)
            compare(f'transformers-conv/{length}', qwen.causal_conv1d_fn(x, weight, activation='silu'), expected)
            args = delta_inputs(length)
            expected = delta(reference_delta, args)
            compare(f'gated-delta/{length}', delta(chunk_gated_delta_rule, args), expected)
            compare(f'transformers-gated-delta/{length}', delta(qwen.torch_chunk_gated_delta_rule, args), expected)
        torch.cuda.synchronize()
        timings = []
        if benchmark:
            def measure(fn):
                fn()
                torch.cuda.synchronize()
                started = time.perf_counter()
                for _ in range(5):
                    fn()
                torch.cuda.synchronize()
                return (time.perf_counter() - started) * 200

            for length in (256, 1024):
                args = delta_inputs(length)
                slow = measure(lambda: delta(reference_delta, args))
                fast = measure(lambda: delta(chunk_gated_delta_rule, args))
                timings.append({'operator': 'gated_delta', 'tokens': length, 'reference_ms': slow,
                                'optimized_ms': fast, 'speedup': slow / fast})
                x = torch.randn(1, length, 8192, device=device, dtype=dtype).transpose(1, 2)
                weight = torch.randn(8192, 4, device=device, dtype=dtype) * 0.1
                slow = measure(lambda: reference_conv(x, weight))
                fast = measure(lambda: causal_conv1d.causal_conv1d_fn(x, weight, activation='silu'))
                timings.append({'operator': 'conv', 'tokens': length, 'reference_ms': slow,
                                'optimized_ms': fast, 'speedup': slow / fast})
    return {'ok': True, 'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
            'checks': checks, 'timings': timings}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True, type=Path)
    parser.add_argument('--benchmark', action='store_true')
    args = parser.parse_args()
    try:
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required / 需要可用的 CUDA GPU")
        devices = []
        for index in range(torch.cuda.device_count()):
            with torch.cuda.device(index):
                devices.append(check(args.site, benchmark=args.benchmark))
        result = {'ok': True, 'gpu': ', '.join(device['gpu'] for device in devices), 'devices': devices}
    except Exception as exc:
        result = {'ok': False, 'message': f'{type(exc).__name__}: {exc}'}
    print('MOSS_ACCELERATION_RESULT=' + json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
