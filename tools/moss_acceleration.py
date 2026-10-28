"""Locked, isolated optional kernels. Never installs into the training venv."""
from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys
import tempfile
import urllib.request
from uuid import uuid4

from packaging.specifiers import SpecifierSet

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache" / "moss_acceleration"
CATALOG = Path(__file__).with_name("moss_acceleration_wheels.json")
VERSIONS = {"flash-linear-attention": "0.5.2", "fla-core": "0.5.2", "causal-conv1d": "1.7.0"}
BASELINE = {"torch": "2.12.1+cu130", "transformers": "5.21.0", "einops": "0.7.0"}


def runtime_signature() -> dict:
    packages = {}
    for name in (*BASELINE, "triton", "triton-windows"):
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    machine = platform.machine().lower()
    return {"python": f"{sys.version_info.major}.{sys.version_info.minor}", "platform": sys.platform,
            "machine": {"amd64": "x86_64", "arm64": "aarch64"}.get(machine, machine),
            "bits": struct.calcsize("P") * 8, "packages": packages,
            "host": platform.node(), "interpreter": str(Path(sys.executable).resolve())}


def platform_tag(env: dict) -> str | None:
    if env["platform"] == "win32" and env["machine"] == "x86_64":
        return "win_amd64"
    if env["platform"] == "linux" and env["machine"] in ("x86_64", "aarch64"):
        return "linux_" + env["machine"]
    return None


def incompatibility(env: dict) -> str | None:
    if env["python"] != "3.12" or env["bits"] != 64:
        return "python"
    if not platform_tag(env):
        return "platform"
    if any(env["packages"].get(name) != version for name, version in BASELINE.items()):
        return "baseline"
    name = "triton-windows" if env["platform"] == "win32" else "triton"
    spec = ">=3.7.1,<3.8" if env["platform"] == "win32" else "==3.7.1"
    version = env["packages"].get(name)
    if not version or not SpecifierSet(spec).contains(version):
        return "triton"
    return None


def selected_wheels(env: dict) -> list[dict]:
    if reason := incompatibility(env):
        raise RuntimeError(f"Unsupported MOSS acceleration environment / 加速环境不匹配: {reason}")
    entries = json.loads(CATALOG.read_text(encoding="utf-8"))
    return [entry for entry in entries if entry["name"].endswith(("-any.whl", f"-{platform_tag(env)}.whl"))]


def _catalog_digest() -> str:
    return hashlib.sha256(CATALOG.read_bytes()).hexdigest()


def _read_state() -> dict:
    try:
        state = json.loads((CACHE / "active.json").read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def _site(state: dict) -> Path | None:
    bundle = state.get("bundle")
    if not isinstance(bundle, str) or not re.fullmatch(r"[0-9a-f]{32}", bundle):
        return None
    site = CACHE / "installs" / bundle / "site"
    return site if all((site / name).is_file() for name in ("fla/__init__.py", "causal_conv1d/__init__.py")) else None


def _available(state: dict, env: dict) -> bool:
    return bool(_site(state) and state.get("signature") == env and state.get("catalog") == _catalog_digest()
                and isinstance(state.get("verification"), dict) and state["verification"].get("ok") is True
                and not incompatibility(env))


def current_status() -> dict:
    env, state = runtime_signature(), _read_state()
    installed = _site(state) is not None
    available = _available(state, env)
    return {"installed": installed, "available": available, "enabled": available and state.get("enabled") is True,
            "can_install": incompatibility(env) is None, "versions": VERSIONS, "env": env,
            "reason": incompatibility(env) or ("changed" if installed and not available else None),
            "verification": state.get("verification") if available else None}


def training_pythonpath() -> str | None:
    """Metadata-only check; stale/corrupt optional bundles never block training."""
    try:
        state = _read_state()
        if state.get("enabled") is True and _available(state, runtime_signature()):
            return str(_site(state))
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def _write_state(state: dict) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    temporary = CACHE / f"active-{uuid4().hex}.tmp"
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, CACHE / "active.json")


def set_enabled(enabled: bool) -> dict:
    state = _read_state()
    if enabled and not _available(state, runtime_signature()):
        raise RuntimeError("Install and verify the kernels first / 请先安装并通过算子验证")
    state["enabled"] = enabled
    _write_state(state)
    return current_status()


def _verified_file(path: Path, entry: dict) -> bool:
    return (path.is_file() and path.stat().st_size == entry["size"]
            and hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"])


def download_wheel(entry: dict, emit) -> Path:
    directory = CACHE / "wheels"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / entry["name"]
    if _verified_file(destination, entry):
        return destination
    temporary = directory / (entry["name"] + ".part")
    request = urllib.request.Request(entry["url"], headers={"User-Agent": "lora-scripts-anima/moss-acceleration"})
    emit(stage="downloading", message=entry["name"])
    with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
        received = 0
        while chunk := response.read(1024 * 1024):
            received += len(chunk)
            if received > entry["size"]:
                raise RuntimeError("Wheel size mismatch / 安装包大小不匹配")
            output.write(chunk)
            emit(stage="downloading", downloaded=received, total=entry["size"])
    if not _verified_file(temporary, entry):
        raise RuntimeError("Wheel SHA256 mismatch / 安装包 SHA256 校验失败")
    os.replace(temporary, destination)
    return destination


def _run(command: list[str], env: dict, *, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)


def verify(site: Path, emit) -> dict:
    env = os.environ.copy()
    env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
    for name, suffix in (("TRITON_CACHE_DIR", "triton"), ("TORCHINDUCTOR_CACHE_DIR", "inductor"),
                         ("CUDA_CACHE_PATH", "cuda")):
        env[name] = str(CACHE / "verification" / suffix)
    emit(stage="verifying", message="Checking BF16 CUDA kernels / 正在验证 BF16 CUDA 算子")
    result = _run([sys.executable, "-B", str(ROOT / "tools/check_moss_acceleration.py"), "--site", str(site)], env, timeout=300)
    lines = [line for line in result.stdout.splitlines() if line.startswith("MOSS_ACCELERATION_RESULT=")]
    report = json.loads(lines[-1].split("=", 1)[1]) if lines else {"ok": False, "message": result.stdout[-4000:]}
    if result.returncode or report.get("ok") is not True:
        raise RuntimeError(str(report.get("message") or "Kernel verification failed / 算子验证失败"))
    return report


def install(emit) -> None:
    signature = runtime_signature()
    wheels = [download_wheel(entry, emit) for entry in selected_wheels(signature)]
    installs = CACHE / "installs"
    installs.mkdir(parents=True, exist_ok=True)
    # The active bundle is only replaced after a fresh isolated install passes.
    with tempfile.TemporaryDirectory(prefix="staging-", dir=installs) as staging:
        staging_path = Path(staging).resolve()
        install_root = installs.resolve()
        if not staging_path.is_relative_to(install_root):
            raise RuntimeError("Staging directory escaped the install root")
        site = staging_path / "site"
        env = os.environ.copy()
        env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PIP_DISABLE_PIP_VERSION_CHECK="1")
        emit(stage="installing", message="Installing isolated pinned wheels / 正在安装隔离的锁定版本")
        result = _run([sys.executable, "-B", "-m", "pip", "install", "--no-deps", "--no-index",
                       "--no-compile", "--ignore-installed", "--only-binary=:all:", "--target", str(site),
                       *map(str, wheels)], env, timeout=300)
        emit(message=result.stdout[-4000:])
        if result.returncode:
            raise RuntimeError("Isolated installation failed / 隔离安装失败")
        report = verify(site, emit)
        if runtime_signature() != signature:
            raise RuntimeError("Environment changed during verification / 验证期间运行环境发生变化")
        bundle = uuid4().hex
        destination = (installs / bundle).resolve()
        if not destination.is_relative_to(install_root):
            raise RuntimeError("Bundle directory escaped the install root")
        os.replace(staging_path, destination)
        _write_state({"bundle": bundle, "enabled": True, "signature": signature,
                      "catalog": _catalog_digest(), "verification": report})
    emit(stage="done", message="Verified; enabled for the next MOSS run / 验证通过，下次 MOSS 训练启用")
