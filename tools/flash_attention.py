"""Download, install and verify compatible FlashAttention 2 wheels."""
from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from urllib.parse import unquote, urlsplit

from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename
from packaging.version import Version

from backend.utils.hf_download import download_url_with_fallback
from tools.network_mirror import invalidate_hf_cache, wheel_download_urls

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache" / "flash_attn"
CATALOG = Path(__file__).with_name("flash_attention_wheels.json")


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def detect_environment() -> dict:
    import torch

    version = Version(torch.__version__)
    supported_gpu = torch.cuda.is_available() and all(
        torch.cuda.get_device_capability(i)[0] >= 8 for i in range(torch.cuda.device_count()))
    return {"python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "torch": str(version), "torch_tag": f"{version.major}.{version.minor}",
            "cuda": torch.version.cuda, "tags": [str(tag) for tag in sys_tags()], "supported_gpu": supported_gpu}


def matching_wheel_name(url: str, env: dict) -> str | None:
    name = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
    try:
        distribution, version, _, tags = parse_wheel_filename(name)
    except Exception:
        return None
    abi = re.fullmatch(r"cu(\d+)torch(\d+\.\d+)", version.local or "")
    if (distribution != "flash-attn" or version.major != 2 or version.is_prerelease or not abi
            or abi[1] != str(env.get("cuda") or "").replace(".", "")
            or abi[2] != env.get("torch_tag")
            or not set(map(str, tags)).intersection(env.get("tags", []))):
        return None
    return name


def bundled_wheel(env: dict) -> dict | None:
    for entry in json.loads(CATALOG.read_text(encoding="utf-8")):
        name = matching_wheel_name(entry["url"], env)
        if name:
            return {**entry, "name": name}
    return None


def resolve_wheel(env: dict) -> dict:
    wheel = bundled_wheel(env)
    if not wheel:
        raise RuntimeError("No matching FA2 wheel for this Python/PyTorch/CUDA/platform / 当前 Python/PyTorch/CUDA/平台组合没有预置轮子")
    return wheel


def current_status() -> dict:
    env = detect_environment()
    version = package_version("flash-attn")
    wheel = bundled_wheel(env)
    eligible = bool(wheel and env["cuda"] and env["supported_gpu"])
    return {"installed": bool(version), "version": version,
            "env": {k: env[k] for k in ("python", "torch", "cuda")},
            "has_wheel": bool(wheel), "can_install": eligible}


def verify_installation() -> dict:
    env = os.environ.copy()
    env.update({"ANIMA_ENABLE_FLASH_ATTN": "1", "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1"})
    command = [sys.executable, "-X", "utf8", str(ROOT / "tools/check_flash_attn.py")]
    try:
        process = subprocess.run(command, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        lines = [line for line in process.stdout.splitlines() if line.startswith("FLASH_ATTN_RESULT=")]
        result = json.loads(lines[-1].split("=", 1)[1]) if lines else {
            "ok": False, "message": (process.stderr or process.stdout or f"Process exited {process.returncode}")[-4000:]}
        if process.returncode != 0:
            result["ok"] = False
    except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
        result = {"ok": False, "message": str(exc)}
    return result


def validate_download(path: Path, wheel: dict) -> None:
    if path.stat().st_size != wheel["size"]:
        raise RuntimeError("Incomplete wheel download / 轮子下载不完整")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != wheel["sha256"]:
        raise RuntimeError("Wheel checksum mismatch / 轮子校验值不一致")


def download_wheel(wheel: dict, emit) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / wheel["name"]
    dest.with_suffix(".whl.part").unlink(missing_ok=True)
    if dest.exists():
        try:
            validate_download(dest, wheel)
        except RuntimeError:
            dest.unlink()
        else:
            emit(stage="downloaded", message="Using verified cached wheel / 使用已校验的缓存轮子")
            return dest

    progress: dict = {}
    lock = threading.Lock()

    def _on_log(message: str) -> None:
        with lock:
            phase = progress.get("phase")
        if "next source" in message:
            emit(stage="retrying", message=message)
        elif phase == "connecting":
            emit(stage="connecting", message=message)
        else:
            emit(message=message)

    def _on_progress(_line: str) -> None:
        with lock:
            downloaded = int(progress.get("downloaded") or 0)
            total = int(progress.get("total") or wheel["size"])
            speed_mb = float(progress.get("speed") or 0.0)
        emit(stage="downloading", downloaded=downloaded, total=total, speed=speed_mb * 1048576.0)

    download_url_with_fallback(
        wheel_download_urls(wheel),
        dest,
        progress=progress,
        lock=lock,
        on_log=_on_log,
        on_progress=_on_progress,
        label=wheel["name"],
        expected_size=wheel["size"],
        expected_sha256=wheel["sha256"],
        on_source_fail=lambda _url, _err: invalidate_hf_cache(),
    )
    emit(stage="downloaded", downloaded=wheel["size"], total=wheel["size"])
    return dest


def _pip(wheel: Path, emit) -> None:
    command = [sys.executable, "-m", "pip", "install", "--no-deps", "--no-input", "--no-index", "--disable-pip-version-check", "--no-compile", "--force-reinstall"]
    command.append(str(wheel))
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    if result.stdout.strip():
        emit(message=result.stdout[-4000:])
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-4000:])


def install(emit) -> None:
    emit(stage="resolving", message="Matching Python, PyTorch, CUDA and platform / 匹配运行环境")
    wheel = resolve_wheel(detect_environment())
    emit(message=wheel["name"])
    path = download_wheel(wheel, emit)
    emit(stage="installing", message="Installing wheel / 安装轮子")
    _pip(path, emit)
    emit(stage="verifying", message="Verifying installed extension / 验证安装结果")
    result = verify_installation()
    if not result["ok"]:
        raise RuntimeError(result["message"])
    emit(stage="done", message=result["message"])
