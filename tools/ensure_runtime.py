#!/usr/bin/env python
"""Upgrade an existing project venv from cu128 to the cu130 baseline."""

from __future__ import annotations

import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys


TORCH = "2.10.0+cu130"
TORCHVISION = "0.25.0+cu130"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu130"


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def package_file(name: str, relative: str) -> Path | None:
    try:
        path = Path(importlib.metadata.distribution(name).locate_file(relative))
        return path if path.exists() else None
    except importlib.metadata.PackageNotFoundError:
        return None


def run(command: list[str], *, input_text: str | None = None, check: bool = True, timeout: float | None = None) -> int:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(
            command,
            input=input_text,
            text=input_text is not None,
            encoding="utf-8" if input_text is not None else None,
            env=env,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"command timed out after {timeout}s: {exc}")
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed with exit code {result.returncode}")
    return result.returncode


def pip(*arguments: str, check: bool = True) -> int:
    return run([sys.executable, "-m", "pip", *arguments], check=check)


def xformers_cuda_build() -> int | None:
    try:
        distribution = importlib.metadata.distribution("xformers")
        path = Path(distribution.locate_file("xformers/cpp_lib.json"))
        data = json.loads(path.read_text(encoding="utf-8"))
        return int(data["version"]["cuda"])
    except (ImportError, KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def minor_version(version: str | None) -> tuple[int, int]:
    match = re.match(r"(\d+)\.(\d+)", version or "")
    return (int(match.group(1)), int(match.group(2))) if match else (0, 0)


def sync_optional_packages(*, core_changed: bool) -> list[str]:
    warnings: list[str] = []

    bnb_suffix = ".dll" if sys.platform == "win32" else ".so"
    if package_version("bitsandbytes") and not package_file(
        "bitsandbytes", f"bitsandbytes/libbitsandbytes_cuda130{bnb_suffix}"
    ):
        if pip(
            "install", "--upgrade", "--force-reinstall", "--no-deps", "bitsandbytes", check=False
        ) != 0:
            warnings.append("bitsandbytes CUDA 13 upgrade failed")

    if package_version("xformers") and (core_changed or xformers_cuda_build() != 1300):
        if pip(
            "install",
            "--upgrade",
            "--force-reinstall",
            "--no-deps",
            "xformers",
            "--index-url",
            PYTORCH_INDEX,
            check=False,
        ) != 0:
            pip("uninstall", "-y", "xformers", check=False)
            warnings.append("xformers upgrade failed; removed the incompatible old wheel")

    flash_version = package_version("flash-attn")
    if flash_version and (core_changed or "cu130torch2.10" not in flash_version.lower()):
        try:
            result = run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    "-m",
                    "tools.install_flash_attn",
                    "--yes",
                    "--force",
                ],
                input_text="\n",
                check=False,
                # 整体上限 30 分钟：被墙网络下镜像 ~0.5MB/s（240MB 约 8 分钟），
                # 慢但有效不应打断；此上限只兜住极端异常（完全卡死/龟速）。
                timeout=1800,
            )
        except RuntimeError as exc:
            result = -1
            print(f"[Runtime][ERROR] flash-attn upgrade timed out: {exc}", file=sys.stderr)
        if result != 0:
            # 升级失败时保留现有安装 —— 已可用的旧 wheel 远好于"卸载后没有"
            # （老逻辑直接卸载，被墙环境下会把用户原本可用的 flash-attn 静默移除）
            warnings.append(
                "FlashAttention upgrade failed; keeping the existing installation. "
                "Retry later or use the Environment page / "
                "FlashAttention 升级失败，保留现有安装；可稍后重试或到环境页手动重装"
            )

    expected_triton = "triton-windows" if sys.platform == "win32" else "triton"
    triton_version = package_version(expected_triton)
    if triton_version and (core_changed or minor_version(triton_version) != (3, 6)):
        if pip("install", "--upgrade", f"{expected_triton}>=3.6,<3.7", check=False) != 0:
            warnings.append(f"{expected_triton} upgrade failed; retry from the Environment page")

    return warnings


def main() -> int:
    torch_version = package_version("torch")
    torchvision_version = package_version("torchvision")
    core_changed = torch_version != TORCH or torchvision_version != TORCHVISION

    if core_changed:
        print(
            f"[Runtime] Upgrading {torch_version or 'missing'} to {TORCH} / "
            f"正在升级到 PyTorch {TORCH}",
            flush=True,
        )
        try:
            pip(
                "install",
                "--upgrade",
                f"torch=={TORCH}",
                f"torchvision=={TORCHVISION}",
                "--extra-index-url",
                PYTORCH_INDEX,
            )
        except RuntimeError as exc:
            print(f"[Runtime][ERROR] {exc}", file=sys.stderr)
            return 1

    warnings = sync_optional_packages(core_changed=core_changed)
    for warning in warnings:
        print(f"[Runtime][WARN] {warning}", file=sys.stderr)
    if core_changed:
        print("[Runtime] CUDA 13.0 runtime upgrade complete. / CUDA 13.0 运行时升级完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
