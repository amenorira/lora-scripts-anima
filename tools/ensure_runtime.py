#!/usr/bin/env python
"""Synchronize existing project venvs with the managed PyTorch/CUDA baseline."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


TORCH = "2.12.1+cu130"
TORCHVISION = "0.27.1+cu130"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu130"
XFORMERS = "0.0.35"
MIN_SKIP_SYNC_TORCH = "2.9.1"


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


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _uv_executable() -> str | None:
    if _env_bool("ANIMA_NO_UV"):
        return None
    return shutil.which("uv")


def _build_uv_pip_command(uv_bin: str, arguments: tuple[str, ...]) -> list[str] | None:
    if not arguments:
        return None
    subcmd = arguments[0]
    if subcmd not in {"install", "uninstall"}:
        return None
    rest = list(arguments[1:])
    if subcmd == "uninstall":
        rest = [arg for arg in rest if arg not in {"-y", "--yes"}]
    cmd = [uv_bin, "pip", subcmd, "--python", sys.executable]
    if subcmd == "install":
        pip_index = os.environ.get("PIP_INDEX_URL", "").strip()
        if pip_index and not os.environ.get("UV_INDEX_URL") and "--index-url" not in rest and "-i" not in rest:
            cmd.extend(["--index-url", pip_index])
        pip_extra = os.environ.get("PIP_EXTRA_INDEX_URL", "").strip()
        if pip_extra and not os.environ.get("UV_EXTRA_INDEX_URL"):
            cmd.extend(["--extra-index-url", pip_extra])
    cmd.extend(rest)
    return cmd


def pip(*arguments: str, check: bool = True) -> int:
    uv_bin = _uv_executable()
    if uv_bin:
        uv_cmd = _build_uv_pip_command(uv_bin, arguments)
        if uv_cmd is not None:
            rc = run(uv_cmd, check=False)
            if rc == 0:
                return 0
            print(
                "[Runtime][Notice] uv pip failed; falling back to pip. / uv pip 执行失败，已回退到 pip。",
                file=sys.stderr,
                flush=True,
            )
    return run([sys.executable, "-m", "pip", *arguments], check=check)


def _probe_cuda_torch() -> tuple[str | None, str | None]:
    """Import torch to verify the installed CUDA build is loadable."""
    try:
        import torch
        return getattr(torch, "__version__", None), getattr(torch.version, "cuda", None)
    except Exception:
        return None, None


def has_compatible_cuda_torch(min_version: str = MIN_SKIP_SYNC_TORCH) -> tuple[bool, str | None, str | None]:
    """Return (ok, torch_version, cuda_version) when CUDA PyTorch >= min_version is working."""
    torch_version, cuda_version = _probe_cuda_torch()
    if not torch_version or not cuda_version:
        return False, torch_version, cuda_version
    try:
        from packaging.version import InvalidVersion, Version

        base = torch_version.split("+", 1)[0]
        if Version(base) < Version(min_version):
            return False, torch_version, cuda_version
    except (ImportError, InvalidVersion):
        return False, torch_version, cuda_version
    return True, torch_version, cuda_version


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

    return warnings


def sync_triton() -> None:
    """Try to install the optional Triton baseline, including in older venvs."""
    if sys.platform not in ("win32", "linux"):
        return
    expected_triton = "triton-windows" if sys.platform == "win32" else "triton"
    triton_version = package_version(expected_triton)
    triton_spec = ">=3.7.1,<3.8" if sys.platform == "win32" else "==3.7.1"
    from packaging.specifiers import SpecifierSet

    if not triton_version or triton_version not in SpecifierSet(triton_spec):
        print(
            f"[Runtime] Synchronizing {expected_triton}{triton_spec} / 正在补齐匹配的 Triton 运行时",
            flush=True,
        )
        pip("install", "--upgrade", "--only-binary=:all:", "--no-deps", f"{expected_triton}{triton_spec}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Synchronize PyTorch/CUDA runtime baseline")
    parser.add_argument(
        "--skip-runtime-sync",
        action="store_true",
        help="Keep preinstalled working CUDA PyTorch >= 2.9.1 instead of overwriting with cu130",
    )
    args, _ = parser.parse_known_args(argv)

    skip_sync = args.skip_runtime_sync or _env_bool("ANIMA_SKIP_RUNTIME_SYNC")
    if skip_sync:
        ok, installed_torch, installed_cuda = has_compatible_cuda_torch()
        if ok:
            print(
                f"[Runtime] Keeping existing CUDA PyTorch {installed_torch} (CUDA {installed_cuda}); "
                "skipping cu130 runtime sync. / "
                f"已保留现有 CUDA PyTorch {installed_torch}（CUDA {installed_cuda}），跳过 cu130 运行时覆盖。",
                flush=True,
            )
            return 0

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

    try:
        sync_triton()
    except Exception:
        print(
            "[Runtime][WARN] Triton installation failed; startup will continue. "
            "Retry from Environment Management / Triton 安装失败，继续启动，可在环境管理页重试。",
            file=sys.stderr,
        )

    warnings = sync_optional_packages(core_changed=core_changed)
    for warning in warnings:
        print(f"[Runtime][WARN] {warning}", file=sys.stderr)
    if core_changed:
        print("[Runtime] CUDA 13.0 runtime upgrade complete. / CUDA 13.0 运行时升级完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
