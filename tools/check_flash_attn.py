"""Check FlashAttention CUDA outputs and gradients in a child process."""
from __future__ import annotations

import json
import sys


def check() -> dict:
    # A standalone invocation may inherit the project's default import guard.
    if sys.modules.get("flash_attn") is None:
        sys.modules.pop("flash_attn", None)
    import torch
    from flash_attn import flash_attn_func, flash_attn_varlen_func

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU unavailable / 没有可用的 CUDA 显卡")
    for device_id in range(torch.cuda.device_count()):
        device = torch.device("cuda", device_id)
        for dtype in (torch.float16, torch.bfloat16):
            for varlen in (False, True):
                shape = (80, 4, 128) if varlen else (1, 80, 4, 128)
                xs = [torch.randn(shape, device=device, dtype=dtype, requires_grad=True) for _ in range(3)]
                if varlen:
                    cu = torch.tensor([0, 32, 80], device=device, dtype=torch.int32)
                    actual = flash_attn_varlen_func(*xs, cu, cu, 48, 48, dropout_p=0.0)
                else:
                    actual = flash_attn_func(*xs, dropout_p=0.0)
                grads = torch.autograd.grad(actual, xs, torch.ones_like(actual))
                if not all(bool(value.isfinite().all()) for value in (actual, *grads)):
                    raise RuntimeError("FlashAttention produced NaN/Inf / 输出或梯度出现 NaN/Inf")
                torch.cuda.synchronize(device)
    return {"ok": True, "message": "CUDA forward/backward checks passed / CUDA 前向与反向检查通过"}


if __name__ == "__main__":
    try:
        result = check()
    except Exception as exc:
        result = {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
    print("FLASH_ATTN_RESULT=" + json.dumps(result, ensure_ascii=False), flush=True)
    sys.exit(0 if result["ok"] else 1)
