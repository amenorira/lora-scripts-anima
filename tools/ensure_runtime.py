#!/usr/bin/env python
"""Synchronize existing project venvs with the managed PyTorch/CUDA baseline."""

from __future__ import annotations

import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys


TORCH = "2.12.1+cu130"
TORCHVISION = "0.27.1+cu130"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu130"
XFORMERS = "0.0.35"


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
        raise RuntimeError(f"command timed out after {timeout}s / 命令超时: {exc}")
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed with exit code {result.returncode} / 命令执行失败")
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
            warnings.append("bitsandbytes CUDA 13 upgrade failed / bitsandbytes CUDA 13 升级失败")

    if package_version("xformers") and (
        core_changed or package_version("xformers") != XFORMERS or xformers_cuda_build() != 1300
    ):
        if pip(
            "install",
            "--upgrade",
            "--force-reinstall",
            "--no-deps",
            f"xformers=={XFORMERS}",
            "--index-url",
            PYTORCH_INDEX,
            check=False,
        ) != 0:
            pip("uninstall", "-y", "xformers", check=False)
            warnings.append("xformers upgrade failed; removed the incompatible old wheel / xformers 升级失败，已移除不兼容的旧包")

    expected_triton = "triton-windows" if sys.platform == "win32" else "triton"
    triton_version = package_version(expected_triton)
    triton_spec = ">=3.7.1,<3.8" if sys.platform == "win32" else "==3.7.1"
    from packaging.specifiers import SpecifierSet

    if triton_version and (core_changed or triton_version not in SpecifierSet(triton_spec)):
        if pip("install", "--upgrade", f"{expected_triton}{triton_spec}", check=False) != 0:
            warnings.append(f"{expected_triton} upgrade failed; retry from the Environment page / {expected_triton} 升级失败，可到环境页重试")

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
