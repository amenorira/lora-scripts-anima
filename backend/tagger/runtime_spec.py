"""Compatible llama.cpp runtime channel resolution and installed metadata."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path, PurePosixPath

import httpx

from backend.constants import TAGGER_CACHE_DIR, TAGGER_RUNTIME_DIR


RUNTIME_API_VERSION = 1
RUNTIME_CHANNEL = "stable"
RUNTIME_CHANNEL_FILE = "manifests/stable-v1.json"
RUNTIME_REPO = os.environ.get("ANIMA_LLAMA_RUNTIME_REPO", "ame-la/anima-llama-runtime")
RUNTIME_MANIFEST_TTL_SECONDS = 3600
_CACHE_PATH = TAGGER_CACHE_DIR / "runtime-manifests" / "stable-v1.json"

EMBEDDED_RUNTIME_MANIFEST = {
    "schema_version": 2,
    "runtime_api_version": RUNTIME_API_VERSION,
    "channel": RUNTIME_CHANNEL,
    "runtime_ref": "b10142",
    "package_revision": 1,
    "llama_cpp_commit": "3d1c3a8975f970a8e5f99ea648733087b52124c5",
    "cuda_version": "13.0.2",
    "generated_at": "2026-07-28T08:27:47.0109379Z",
    "mandatory": False,
    "assets": [
        {
            "filename": "llama-runtime-b10142-windows-x86_64-cu130.zip",
            "path": "llama-runtime-b10142-windows-x86_64-cu130.zip",
            "sha256": "8961ca07c85c622642dd436c1d0f42472e7cdfb452ae2877c7832203b4bbbbbc",
            "size_bytes": 263_885_011,
            "platform": "windows-x86_64",
        },
        {
            "filename": "llama-runtime-b10142-linux-x86_64-cu130.tar.gz",
            "path": "llama-runtime-b10142-linux-x86_64-cu130.tar.gz",
            "sha256": "e7c4d9d1df5974c7a49b29eff21ec8885d1856da19d717209f26eb8eafb2cfd0",
            "size_bytes": 259_445_514,
            "platform": "linux-x86_64",
        },
    ],
}


def _validate_asset(asset: object) -> dict:
    if not isinstance(asset, dict):
        raise ValueError("Runtime manifest asset must be an object")
    platform_name = str(asset.get("platform") or "")
    if platform_name not in {"windows-x86_64", "linux-x86_64"}:
        raise ValueError("Runtime manifest contains an unsupported platform")
    filename = str(asset.get("filename") or "")
    expected_suffix = ".zip" if platform_name.startswith("windows") else ".tar.gz"
    if not filename or Path(filename).name != filename or not filename.endswith(expected_suffix):
        raise ValueError("Runtime manifest contains an invalid filename")
    asset_path = str(asset.get("path") or filename).replace("\\", "/")
    posix_path = PurePosixPath(asset_path)
    if posix_path.is_absolute() or ".." in posix_path.parts or posix_path.name != filename:
        raise ValueError("Runtime manifest contains an unsafe asset path")
    checksum = str(asset.get("sha256") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("Runtime manifest contains an invalid SHA256")
    size_bytes = int(asset.get("size_bytes") or 0)
    if size_bytes <= 0:
        raise ValueError("Runtime manifest contains an invalid asset size")
    return {
        "filename": filename,
        "path": asset_path,
        "sha256": checksum,
        "size_bytes": size_bytes,
        "platform": platform_name,
    }


def validate_runtime_manifest(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Runtime manifest must be an object")
    if int(data.get("schema_version") or 0) != 2:
        raise ValueError("Unsupported runtime manifest schema")
    if int(data.get("runtime_api_version") or 0) != RUNTIME_API_VERSION:
        raise ValueError("Incompatible runtime API version")
    if str(data.get("channel") or "") != RUNTIME_CHANNEL:
        raise ValueError("Unexpected runtime channel")
    runtime_ref = str(data.get("runtime_ref") or "")
    commit = str(data.get("llama_cpp_commit") or "").lower()
    if not re.fullmatch(r"b\d+", runtime_ref):
        raise ValueError("Invalid llama.cpp runtime reference")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid llama.cpp commit")
    cuda_version = str(data.get("cuda_version") or "")
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", cuda_version):
        raise ValueError("Invalid runtime CUDA version")
    assets = [_validate_asset(item) for item in data.get("assets") or []]
    package_revision = int(data.get("package_revision") or 1)
    if package_revision < 1:
        raise ValueError("Invalid runtime package revision")
    by_platform = {item["platform"]: item for item in assets}
    if set(by_platform) != {"windows-x86_64", "linux-x86_64"} or len(assets) != 2:
        raise ValueError("Runtime manifest must contain exactly one asset per platform")
    return {
        "schema_version": 2,
        "runtime_api_version": RUNTIME_API_VERSION,
        "channel": RUNTIME_CHANNEL,
        "runtime_ref": runtime_ref,
        "package_revision": package_revision,
        "llama_cpp_commit": commit,
        "cuda_version": cuda_version,
        "generated_at": str(data.get("generated_at") or ""),
        "mandatory": bool(data.get("mandatory", False)),
        "assets": assets,
    }


def embedded_runtime_manifest() -> dict:
    return validate_runtime_manifest(EMBEDDED_RUNTIME_MANIFEST)


def _cached_runtime_manifest() -> dict | None:
    try:
        return validate_runtime_manifest(json.loads(_CACHE_PATH.read_text(encoding="utf-8-sig")))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _manifest_endpoints() -> list[str]:
    primary = (os.environ.get("HF_ENDPOINT") or "https://huggingface.co").rstrip("/")
    endpoints = [primary]
    if primary != "https://hf-mirror.com":
        endpoints.append("https://hf-mirror.com")
    return endpoints


def _download_channel_manifest() -> dict:
    errors: list[str] = []
    for endpoint in _manifest_endpoints():
        url = f"{endpoint}/{RUNTIME_REPO}/resolve/main/{RUNTIME_CHANNEL_FILE}"
        try:
            response = httpx.get(url, timeout=4, follow_redirects=True)
            response.raise_for_status()
            return validate_runtime_manifest(response.json())
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}")
    raise RuntimeError("Unable to load runtime channel manifest (" + ", ".join(errors) + ")")


def _write_cached_manifest(manifest: dict) -> None:
    _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = _CACHE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temporary, _CACHE_PATH)


def resolve_runtime_manifest(*, refresh: bool = False) -> tuple[dict, str]:
    cached = _cached_runtime_manifest()
    cache_fresh = False
    try:
        cache_fresh = time.time() - _CACHE_PATH.stat().st_mtime < RUNTIME_MANIFEST_TTL_SECONDS
    except OSError:
        pass
    if cached and cache_fresh and not refresh:
        return cached, "cache"
    try:
        remote = _download_channel_manifest()
        _write_cached_manifest(remote)
        return remote, "remote"
    except Exception:
        if cached:
            return cached, "cache"
    return embedded_runtime_manifest(), "embedded"


def runtime_asset(manifest: dict, platform_name: str) -> dict:
    for asset in manifest.get("assets") or []:
        if asset.get("platform") == platform_name:
            return dict(asset)
    raise ValueError(f"Runtime channel has no asset for {platform_name}")


def installed_runtime_metadata() -> dict:
    metadata_path = TAGGER_RUNTIME_DIR / "runtime.json"
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def installed_runtime_ref() -> str | None:
    value = installed_runtime_metadata().get("llama_cpp_ref")
    return str(value) if value else None


def installed_runtime_matches(manifest: dict) -> bool:
    metadata = installed_runtime_metadata()
    try:
        installed_revision = int(metadata.get("package_revision") or 1)
    except (TypeError, ValueError):
        return False
    return (
        str(metadata.get("llama_cpp_ref") or "") == str(manifest.get("runtime_ref") or "")
        and installed_revision == int(manifest.get("package_revision") or 1)
    )
