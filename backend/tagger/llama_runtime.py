"""Managed llama-server runtime for Qwen3-VL GGUF tag inference."""
from __future__ import annotations

import atexit
import base64
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Callable

import httpx
from PIL import Image

from backend.constants import TAGGER_MODELS_DIR, TAGGER_RUNTIME_DIR
from backend.monitor.hardware import gpu_info
from backend.tagger.registry import MODEL_SPEC_BY_ID, llama_server_path, model_paths
from backend.utils.hf_download import download_hf_file, download_url_with_fallback

_RUNTIME_REF = "b10142"
_RUNTIME_RELEASE_API = os.environ.get(
    "ANIMA_LLAMA_RUNTIME_RELEASE_API",
    f"https://api.github.com/repos/amenorira/lora-scripts-anima/releases/tags/llama-runtime-{_RUNTIME_REF}",
)

_SYSTEM_PROMPT = """You create concise English comma-style training tags for anime images.
Return only JSON matching the requested schema. Describe visible subjects, count, appearance,
clothing, pose, camera view, composition, background, lighting, medium, and style. Use short
lowercase tags. Do not explain, speculate about identity, or invent unreadable text."""


def _safe_extract_zip(archive: Path, target: Path) -> None:
    root = target.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            destination = (target / member.filename).resolve()
            if root not in destination.parents and destination != root:
                raise ValueError("Unsafe runtime archive path")
        bundle.extractall(target)


def _safe_extract_tar(archive: Path, target: Path) -> None:
    root = target.resolve()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            if member.issym() or member.islnk():
                raise ValueError("Runtime archive links are not allowed")
            destination = (target / member.name).resolve()
            if root not in destination.parents and destination != root:
                raise ValueError("Unsafe runtime archive path")
        bundle.extractall(target)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _runtime_asset_names() -> tuple[str, str]:
    platform_name = "windows-x86_64" if sys.platform == "win32" else "linux-x86_64"
    extension = ".zip" if sys.platform == "win32" else ".tar.gz"
    base = f"llama-runtime-{_RUNTIME_REF}-{platform_name}-cu130"
    return base + extension, base + ".sha256"


def _release_assets() -> dict[str, str]:
    response = httpx.get(_RUNTIME_RELEASE_API, timeout=20, follow_redirects=True)
    if response.status_code == 404:
        raise RuntimeError(
            "The llama runtime release has not been published yet / llama 运行时 Release 尚未发布"
        )
    response.raise_for_status()
    return {
        str(asset.get("name")): str(asset.get("browser_download_url"))
        for asset in response.json().get("assets", [])
    }


def _torch_library_paths() -> list[Path]:
    paths: list[Path] = []
    try:
        import torch

        torch_root = Path(torch.__file__).resolve().parent
        for candidate in (torch_root / "lib", torch_root / "bin"):
            if candidate.is_dir():
                paths.append(candidate)
    except Exception:
        pass
    return paths


class LlamaRuntime:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process: subprocess.Popen | None = None
        self._model_id: str | None = None
        self._port: int | None = None
        self._last_used = 0.0
        self._stderr_path: Path | None = None
        self._log_file = None
        atexit.register(self.stop)
        threading.Thread(target=self._idle_worker, daemon=True, name="llama-runtime-idle").start()

    def _idle_worker(self) -> None:
        while True:
            time.sleep(30)
            with self._lock:
                if self._process and time.time() - self._last_used > 600:
                    self.stop()

    def status(self, model_id: str) -> dict:
        spec = MODEL_SPEC_BY_ID[model_id]
        model_path, projector_path = model_paths(spec)
        with self._lock:
            running = bool(self._process and self._process.poll() is None)
            return {
                "runtime_installed": llama_server_path().is_file(),
                "model_installed": model_path.is_file() and projector_path.is_file(),
                "running": running,
                "loaded_model": self._model_id if running else None,
            }

    def install(self, model_id: str, progress: dict, progress_lock: threading.Lock,
                on_log: Callable[[str], None]) -> None:
        spec = MODEL_SPEC_BY_ID[model_id]
        if spec.engine != "llama":
            raise ValueError("Model does not use llama-server")
        if not gpu_info():
            raise RuntimeError("Qwen Tagger requires an NVIDIA GPU with CUDA / Qwen 反推仅支持 NVIDIA CUDA")
        TAGGER_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        if not llama_server_path().is_file():
            on_log("Resolving llama-server runtime release...")
            assets = _release_assets()
            archive_name, checksum_name = _runtime_asset_names()
            if archive_name not in assets or checksum_name not in assets:
                raise RuntimeError(f"Runtime release is missing {archive_name} or checksum")
            with tempfile.TemporaryDirectory(prefix="anima-llama-runtime-") as temporary:
                temp = Path(temporary)
                archive = temp / archive_name
                checksum = temp / checksum_name
                download_url_with_fallback(
                    [assets[archive_name]], archive, progress=progress, lock=progress_lock,
                    on_log=on_log, label=archive_name,
                )
                download_url_with_fallback(
                    [assets[checksum_name]], checksum, progress=progress, lock=progress_lock,
                    on_log=on_log, label=checksum_name,
                )
                expected = checksum.read_text(encoding="utf-8", errors="replace").split()[0].lower()
                digest = _sha256(archive)
                if not expected or digest != expected:
                    raise RuntimeError("llama runtime SHA256 verification failed")
                extracted = temp / "extracted"
                extracted.mkdir()
                if archive.suffix == ".zip":
                    _safe_extract_zip(archive, extracted)
                else:
                    _safe_extract_tar(archive, extracted)
                server_name = "llama-server.exe" if sys.platform == "win32" else "llama-server"
                server_matches = list(extracted.rglob(server_name))
                if not server_matches:
                    raise RuntimeError("llama-server was not found in the runtime archive")
                staging = TAGGER_RUNTIME_DIR.with_name(TAGGER_RUNTIME_DIR.name + ".new")
                backup = TAGGER_RUNTIME_DIR.with_name(TAGGER_RUNTIME_DIR.name + ".old")
                shutil.rmtree(staging, ignore_errors=True)
                shutil.rmtree(backup, ignore_errors=True)
                staging.mkdir(parents=True)
                source_root = server_matches[0].parent
                for item in source_root.iterdir():
                    destination = staging / item.name
                    shutil.copytree(item, destination) if item.is_dir() else shutil.copy2(item, destination)
                if TAGGER_RUNTIME_DIR.exists():
                    os.replace(TAGGER_RUNTIME_DIR, backup)
                try:
                    os.replace(staging, TAGGER_RUNTIME_DIR)
                except Exception:
                    if backup.exists() and not TAGGER_RUNTIME_DIR.exists():
                        os.replace(backup, TAGGER_RUNTIME_DIR)
                    raise
                shutil.rmtree(backup, ignore_errors=True)
                if sys.platform != "win32":
                    llama_server_path().chmod(0o755)
                on_log("llama-server runtime installed")

        model_path, projector_path = model_paths(spec)
        model_path.parent.mkdir(parents=True, exist_ok=True)
        for index, (filename, destination) in enumerate(
            ((spec.model_file, model_path), (spec.projector_file, projector_path)), start=1
        ):
            if destination.is_file():
                on_log(f"Using existing {filename}")
                continue
            download_hf_file(
                spec.repo_id,
                filename,
                destination,
                progress=progress,
                lock=progress_lock,
                on_log=on_log,
                file_index=index,
                file_total=2,
            )
        with progress_lock:
            progress.update({"phase": "done", "done": True, "status": "done"})

    def _environment(self) -> dict[str, str]:
        env = os.environ.copy()
        libraries = _torch_library_paths()
        if not libraries:
            return env
        key = "PATH" if sys.platform == "win32" else "LD_LIBRARY_PATH"
        existing = env.get(key, "")
        env[key] = os.pathsep.join([*(str(path) for path in libraries), existing])
        return env

    def _gpu_layers(self, model_id: str, low_vram: bool) -> int:
        if low_vram:
            return 20 if "8b" in model_id else 12
        hardware = gpu_info(True) or {}
        free_mb = int(hardware.get("vram_total_mb") or 0) - int(hardware.get("vram_used_mb") or 0)
        spec = MODEL_SPEC_BY_ID[model_id]
        return 999 if free_mb >= spec.min_vram_gb * 1024 else (20 if "8b" in model_id else 12)

    def start(self, model_id: str, *, low_vram: bool = False) -> None:
        with self._lock:
            if self._process and self._process.poll() is None and self._model_id == model_id:
                self._last_used = time.time()
                return
            self.stop()
            spec = MODEL_SPEC_BY_ID[model_id]
            model_path, projector_path = model_paths(spec)
            server = llama_server_path()
            if not server.is_file() or not model_path.is_file() or not projector_path.is_file():
                raise RuntimeError("Qwen model or llama runtime is not installed")
            port = _free_port()
            stderr_path = TAGGER_RUNTIME_DIR / "llama-server.log"
            log_file = open(stderr_path, "w", encoding="utf-8", errors="replace")
            command = [
                str(server), "--model", str(model_path), "--mmproj", str(projector_path),
                "--host", "127.0.0.1", "--port", str(port), "--ctx-size", "2048",
                "--parallel", "1", "--n-gpu-layers", str(self._gpu_layers(model_id, low_vram)),
            ]
            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=str(TAGGER_RUNTIME_DIR),
                    env=self._environment(),
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
            except Exception:
                log_file.close()
                raise
            self._log_file = log_file
            self._model_id = model_id
            self._port = port
            self._stderr_path = stderr_path
            deadline = time.time() + 120
            while time.time() < deadline:
                if self._process.poll() is not None:
                    detail = stderr_path.read_text(encoding="utf-8", errors="replace")[-4000:]
                    self.stop()
                    raise RuntimeError(f"llama-server exited during startup: {detail}")
                try:
                    response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=2)
                    if response.status_code == 200:
                        self._last_used = time.time()
                        return
                except Exception:
                    pass
                time.sleep(0.5)
            self.stop()
            raise TimeoutError("llama-server startup timed out")

    def stop(self) -> None:
        process = self._process
        self._process = None
        self._model_id = None
        self._port = None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._log_file:
            self._log_file.close()
            self._log_file = None

    def infer_tags(self, model_id: str, image: Image.Image, options: dict) -> list[str]:
        low_vram = bool(options.get("low_vram", False))
        self.start(model_id, low_vram=low_vram)
        maximum = max(10, min(int(options.get("max_tags", 80)), 160))
        detail = str(options.get("preset", options.get("detail", "balanced")))
        detail_hint = {
            "concise": "Use only the most important visible tags.",
            "detailed": "Include fine clothing, pose, composition, background, lighting, and style details.",
        }.get(detail, "Balance precision and useful visual detail.")
        prepared = image.copy()
        prepared.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        prepared.save(buffer, format="JPEG", quality=92)
        data_url = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        schema = {
            "name": "anime_training_tags",
            "schema": {
                "type": "object",
                "properties": {"tags": {"type": "array", "items": {"type": "string"}, "maxItems": maximum}},
                "required": ["tags"],
                "additionalProperties": False,
            },
            "strict": True,
        }
        payload = {
            "model": "local",
            "temperature": 0.1,
            "max_tokens": 384,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": f"{detail_hint} Return at most {maximum} tags."},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]},
            ],
            "response_format": {"type": "json_schema", "json_schema": schema},
        }
        with self._lock:
            if not self._port:
                raise RuntimeError("llama-server is not running")
            response = httpx.post(
                f"http://127.0.0.1:{self._port}/v1/chat/completions",
                json=payload,
                timeout=180,
            )
            self._last_used = time.time()
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        if isinstance(content, list):
            content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
        text = str(content).strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:].lstrip()
        data = json.loads(text)
        tags = data.get("tags") if isinstance(data, dict) else None
        if not isinstance(tags, list):
            raise ValueError("Qwen response did not contain a tags array")
        return [str(tag) for tag in tags[:maximum]]


llama_runtime = LlamaRuntime()
