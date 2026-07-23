"""Shared main-venv runtime contract for musubi-tuner Krea 2.

sd-scripts and musubi-tuner deliberately use one CUDA/PyTorch installation.
The application-owned requirement file is installed *after* the vendored
sd-scripts requirements, making the Krea 2 Transformers stack deterministic
without editing either upstream repository.
"""
from __future__ import annotations

import importlib
import importlib.metadata
import sys
import warnings
from typing import Any

from packaging.version import InvalidVersion, Version


# These are the musubi-tuner 0.3.4 direct runtime requirements.  torch and
# torchvision are shared from the main CUDA 13 environment, but are validated
# explicitly below because accelerate/bitsandbytes depend on torch indirectly.
MUSUBI_RUNTIME_PACKAGES: dict[str, str | None] = {
    "accelerate": "1.6.0",
    "av": "14.0.1",
    "bitsandbytes": None,
    "diffusers": "0.32.1",
    "einops": "0.7.0",
    "huggingface-hub": "0.34.3",
    "opencv-python": "4.10.0.84",
    "pillow": ">=11.3.0",
    "safetensors": "0.4.5",
    "toml": "0.10.2",
    "tqdm": "4.67.1",
    "transformers": "4.57.6",
    "tokenizers": "0.22.2",
    "voluptuous": "0.15.2",
    "ftfy": "6.3.1",
    "easydict": "1.13",
    "sentencepiece": "0.2.1",
    "torch": ">=2.9.1",
    "torchvision": ">=0.24.1",
}


# Metadata alone can say that a wheel is installed even when a native module
# cannot load (for example av, OpenCV, or torchvision after a partial repair).
# Keep the probe deliberately small and aligned with the imports Krea 2 reaches
# before training; importing every optional musubi feature would make opening
# the Environment page needlessly expensive.
_CRITICAL_RUNTIME_IMPORTS: tuple[tuple[str, str], ...] = (
    ("accelerate", "accelerate"),
    ("av", "av"),
    ("opencv-python", "cv2"),
    ("diffusers", "diffusers"),
    ("einops", "einops"),
    ("ftfy", "ftfy"),
    ("safetensors", "safetensors"),
    ("sentencepiece", "sentencepiece"),
    ("toml", "toml"),
    ("voluptuous", "voluptuous"),
    ("pillow", "PIL"),
)


def installed_versions() -> dict[str, str | None]:
    """Return package versions from the interpreter that runs the GUI."""

    versions: dict[str, str | None] = {}
    for package_name in MUSUBI_RUNTIME_PACKAGES:
        try:
            versions[package_name] = importlib.metadata.version(package_name)
        except importlib.metadata.PackageNotFoundError:
            versions[package_name] = None
    return versions


def version_error(package_name: str, expected: str | None, installed: str) -> str | None:
    """Return an actionable version mismatch message, if any."""

    if expected is None:
        return None
    if expected.startswith(">="):
        minimum = expected[2:]
        try:
            if Version(installed) >= Version(minimum):
                return None
        except InvalidVersion:
            pass
        return (
            f"{package_name} must be {expected}, found {installed} / "
            f"{package_name} 版本必须为 {expected}，当前为 {installed}"
        )
    if installed == expected:
        return None
    return (
        f"{package_name} must be {expected}, found {installed} / "
        f"{package_name} 版本必须为 {expected}，当前为 {installed}"
    )


def shared_runtime_status(*, verify_imports: bool = True) -> dict[str, Any]:
    """Check the one shared Krea 2 / sd-scripts training environment.

    This intentionally does not require a CUDA device to be visible: a GUI may
    run on a machine without a compatible driver, while the important invariant
    here is that the installed Torch build is CUDA-capable rather than a second
    CPU-only wheel inside an abandoned core venv.

    ``verify_imports=False`` is the launcher hot path. It only reads package
    metadata (plus the CUDA wheel tag), so a healthy GUI launch does not spend
    several seconds importing Qwen3-VL. A full import check still runs after a
    dependency repair, in the Environment page, and before Krea 2 work.
    """

    versions = installed_versions()
    errors: list[str] = []
    for package_name, expected in MUSUBI_RUNTIME_PACKAGES.items():
        installed = versions[package_name]
        if installed is None:
            errors.append(f"{package_name} is not installed / 未安装 {package_name}")
            continue
        mismatch = version_error(package_name, expected, installed)
        if mismatch:
            errors.append(mismatch)

    torch_path = None
    torch_cuda = None
    if verify_imports:
        try:
            import torch

            torch_path = str(getattr(torch, "__file__", ""))
            torch_cuda = getattr(torch.version, "cuda", None)
            if not torch_cuda:
                errors.append(
                    "torch must be a CUDA build for Krea 2, but the active interpreter loaded a CPU-only Torch / "
                    "Krea 2 需要 CUDA 版 torch，当前解释器加载的是仅 CPU 版"
                )
        except Exception as exc:  # pragma: no cover - metadata check above normally catches this
            errors.append(f"failed to import torch / 无法导入 torch: {exc}")

        try:
            import torchvision  # noqa: F401
        except Exception as exc:  # pragma: no cover - platform wheel failure
            errors.append(f"failed to import torchvision / 无法导入 torchvision: {exc}")

        for package_name, module_name in _CRITICAL_RUNTIME_IMPORTS:
            if versions.get(package_name) is None:
                continue
            try:
                importlib.import_module(module_name)
            except Exception as exc:  # pragma: no cover - depends on local wheels
                errors.append(
                    f"failed to import {package_name} ({module_name}) / "
                    f"无法导入 {package_name} ({module_name}): {exc}"
                )

        try:
            # Qwen3-VL's import path probes CUDA availability. On a GUI-only
            # machine with an older/no driver, PyTorch emits this known warning even
            # though a CUDA-capable wheel is installed correctly. The runtime
            # contract deliberately allows that state, so hide only this probe.
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message=r"cudaGetDeviceCount\(\) returned cudaError.*",
                    category=UserWarning,
                    module=r"torch\.cuda",
                )
                from transformers import Qwen3VLConfig, Qwen3VLForConditionalGeneration  # noqa: F401
        except Exception as exc:
            errors.append(
                "transformers cannot provide Qwen3-VL required by Krea 2 / "
                f"当前 transformers 无法提供 Krea 2 所需的 Qwen3-VL: {exc}"
            )
    else:
        for package_name in ("torch", "torchvision"):
            installed = versions.get(package_name) or ""
            if "+cu" not in installed:
                errors.append(
                    f"{package_name} must be a CUDA wheel for Krea 2, but package metadata is not CUDA-tagged / "
                    f"Krea 2 需要 CUDA 版 {package_name}，但当前包元数据未包含 CUDA 标记"
                )

    return {
        "ok": not errors,
        "errors": errors,
        "versions": versions,
        "python": sys.executable,
        "torch_path": torch_path,
        "torch_cuda": torch_cuda,
        "imports_verified": verify_imports,
    }
