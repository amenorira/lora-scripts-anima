"""Managed llama-server runtime for local vision-language tag inference."""
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
from collections import deque
from pathlib import Path
from typing import Callable

import httpx
from PIL import Image

from backend.constants import TAGGER_MODELS_DIR, TAGGER_RUNTIME_DIR
from backend.monitor.hardware import gpu_info
from backend.tagger.prompt_presets import resolve_tagger_prompt
from backend.tagger.registry import MODEL_SPEC_BY_ID, llama_server_path, model_paths
from backend.tagger.runtime_spec import (
    RUNTIME_API_VERSION,
    RUNTIME_CHANNEL,
    RUNTIME_REPO,
    installed_runtime_metadata,
    installed_runtime_matches,
    installed_runtime_ref,
    resolve_runtime_manifest,
    runtime_asset,
)
from backend.utils.hf_download import download_hf_file

_SYSTEM_PROMPT = """Follow the user's image-tagging instructions. Return only one comma-separated
training caption, without analysis, explanations, Markdown, headings, or additional text."""
_CONTEXT_SIZE = 4096
_TAG_RESPONSE_FIELDS = (
    "subjects",
    "composition",
    "appearance",
    "clothing_accessories",
    "expression_gaze_pose",
    "background_objects",
)


class LlamaRuntimeStartupError(RuntimeError):
    """The managed llama-server could not become ready for inference."""


class LlamaResponseError(RuntimeError):
    """llama-server responded, but the model output was unusable."""


def _parse_tag_response(body: dict, maximum: int) -> list[str]:
    try:
        choice = body["choices"][0]
        content = choice["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlamaResponseError("Qwen response did not contain a completion") from exc
    finish_reason = str(choice.get("finish_reason") or "") if isinstance(choice, dict) else ""
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    text = str(content).strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].strip().lower() in {"```", "```json"}:
            lines.pop(0)
        if lines and lines[-1].strip() == "```":
            lines.pop()
        text = "\n".join(lines).strip()
    if finish_reason == "length":
        raise LlamaResponseError("Qwen tag output reached the token limit before completion")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        tags = [part.strip() for part in text.split(",") if part.strip()]
    else:
        tags = data.get("tags") if isinstance(data, dict) else None
        if tags is None and isinstance(data, dict):
            tags = []
            for field in _TAG_RESPONSE_FIELDS:
                value = data.get(field, "")
                if isinstance(value, list):
                    tags.extend(str(part).strip() for part in value if str(part).strip())
                else:
                    tags.extend(part.strip() for part in str(value).split(",") if part.strip())
        if isinstance(tags, str):
            tags = [part.strip() for part in tags.split(",") if part.strip()]
    if not isinstance(tags, list) or not tags:
        raise LlamaResponseError("Qwen response did not contain a tag list")
    result: list[str] = []
    for tag in tags:
        value = str(tag).strip()
        if value.upper() == "<END>":
            break
        if value:
            result.append(value)
        if len(result) >= maximum:
            break
    if not result:
        raise LlamaResponseError("Qwen response did not contain tags before the end marker")
    return result


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


def _runtime_platform() -> str:
    return "windows-x86_64" if sys.platform == "win32" else "linux-x86_64"


def _directory_size(root: Path) -> int:
    if not root.is_dir():
        return 0
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


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
        self._low_vram: bool | None = None
        self._port: int | None = None
        self._last_used = 0.0
        self._stderr_path: Path | None = None
        self._log_file = None
        self._output_thread: threading.Thread | None = None
        self._output_lines: deque[str] = deque(maxlen=80)
        self._events: deque[str] = deque(maxlen=120)
        self._on_log: Callable[[str], None] | None = None
        atexit.register(self.stop)
        threading.Thread(target=self._idle_worker, daemon=True, name="llama-runtime-idle").start()

    def _idle_worker(self) -> None:
        while True:
            time.sleep(30)
            with self._lock:
                if self._process and time.time() - self._last_used > 600:
                    self.stop("idle timeout")

    def _emit(self, message: str, callback: Callable[[str], None] | None = None) -> None:
        line = f"[{time.strftime('%H:%M:%S')}] {message}"
        self._events.append(line)
        target = callback or self._on_log
        if target:
            try:
                target(message)
            except Exception:
                pass

    def _capture_output(self, process: subprocess.Popen, log_file) -> None:
        stream = process.stdout
        if stream is None:
            return
        try:
            for raw in stream:
                line = str(raw).rstrip("\r\n")
                if not line:
                    continue
                self._output_lines.append(line)
                log_file.write(line + "\n")
                log_file.flush()
                self._emit(f"llama-server | {line}")
        finally:
            stream.close()

    def status(self, model_id: str) -> dict:
        spec = MODEL_SPEC_BY_ID[model_id]
        model_path, projector_path = model_paths(spec)
        manifest, _ = resolve_runtime_manifest()
        with self._lock:
            running = bool(self._process and self._process.poll() is None)
            return {
                "runtime_installed": (
                    llama_server_path().is_file()
                    and installed_runtime_matches(manifest)
                ),
                "model_installed": model_path.is_file() and projector_path.is_file(),
                "running": running,
                "loaded_model": self._model_id if running else None,
                "low_vram": self._low_vram if running else None,
            }

    def runtime_status(self, *, refresh: bool = False) -> dict:
        manifest, manifest_source = resolve_runtime_manifest(refresh=refresh)
        platform_name = _runtime_platform()
        asset = runtime_asset(manifest, platform_name)
        target_ref = manifest["runtime_ref"]
        with self._lock:
            running = bool(self._process and self._process.poll() is None)
            installed = llama_server_path().is_file()
            metadata = installed_runtime_metadata() if installed else {}
            current_ref = installed_runtime_ref() if installed else None
            current_revision = int(metadata.get("package_revision") or 1) if metadata else None
            target_revision = int(manifest.get("package_revision") or 1)
            current = installed and installed_runtime_matches(manifest)
            return {
                "installed": installed,
                "ready": current,
                "update_available": bool(installed and current_ref and not current),
                "repair_required": bool(installed and not current_ref),
                "running": running,
                "loaded_model": self._model_id if running else None,
                "low_vram": self._low_vram if running else None,
                "idle_timeout_seconds": 600,
                "idle_remaining_seconds": (
                    max(0, int(600 - (time.time() - self._last_used))) if running else None
                ),
                "runtime_ref": target_ref,
                "package_revision": target_revision,
                "installed_ref": current_ref,
                "installed_package_revision": current_revision,
                "llama_cpp_commit": manifest["llama_cpp_commit"],
                "cuda_version": manifest["cuda_version"],
                "installed_cuda_version": metadata.get("cuda_version"),
                "runtime_api_version": RUNTIME_API_VERSION,
                "channel": RUNTIME_CHANNEL,
                "manifest_source": manifest_source,
                "mandatory": manifest["mandatory"],
                "platform": platform_name,
                "archive_size_bytes": asset["size_bytes"],
                "installed_size_bytes": _directory_size(TAGGER_RUNTIME_DIR),
                "install_path": str(TAGGER_RUNTIME_DIR),
                "repository": RUNTIME_REPO,
                "logs": list(self._events),
            }

    def install_runtime(self, progress: dict, progress_lock: threading.Lock,
                        on_log: Callable[[str], None],
                        on_progress: Callable[[str], None] | None = None,
                        force: bool = False) -> None:
        if not gpu_info():
            raise RuntimeError("llama runtime requires an NVIDIA GPU with CUDA / llama 运行时仅支持 NVIDIA CUDA")
        manifest, manifest_source = resolve_runtime_manifest(refresh=True)
        target_ref = manifest["runtime_ref"]
        runtime_current = llama_server_path().is_file() and installed_runtime_matches(manifest)
        if force or not runtime_current:
            self.stop()
        if runtime_current and not force:
            on_log("Using installed llama-server runtime")
            return

        asset = runtime_asset(manifest, _runtime_platform())
        archive_name = str(asset["filename"])
        on_log(f"Using {RUNTIME_CHANNEL}-v{RUNTIME_API_VERSION} runtime channel ({manifest_source})")
        on_log(f"Downloading {archive_name} from Hugging Face")
        with tempfile.TemporaryDirectory(prefix="anima-llama-runtime-") as temporary:
            temp = Path(temporary)
            archive = temp / archive_name
            download_hf_file(
                RUNTIME_REPO, str(asset["path"]), archive, progress=progress,
                lock=progress_lock, on_log=on_log, on_progress=on_progress,
            )
            digest = _sha256(archive)
            if digest != asset["sha256"]:
                raise RuntimeError("llama runtime SHA256 verification failed")
            with progress_lock:
                progress.update({"phase": "installing", "filename": archive_name})
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
            source_root = server_matches[0].parent
            try:
                packaged_metadata = json.loads(
                    (source_root / "runtime.json").read_text(encoding="utf-8-sig")
                )
            except (OSError, ValueError, TypeError) as exc:
                raise RuntimeError("Runtime archive metadata is missing or invalid") from exc
            if (
                packaged_metadata.get("llama_cpp_ref") != target_ref
                or packaged_metadata.get("llama_cpp_commit") != manifest["llama_cpp_commit"]
                or int(packaged_metadata.get("package_revision") or 1)
                != int(manifest.get("package_revision") or 1)
            ):
                raise RuntimeError("Runtime archive metadata does not match the stable channel")
            staging = TAGGER_RUNTIME_DIR.with_name(TAGGER_RUNTIME_DIR.name + ".new")
            backup = TAGGER_RUNTIME_DIR.with_name(TAGGER_RUNTIME_DIR.name + ".old")
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(backup, ignore_errors=True)
            staging.mkdir(parents=True)
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

    def install(self, model_id: str, progress: dict, progress_lock: threading.Lock,
                on_log: Callable[[str], None],
                on_progress: Callable[[str], None] | None = None) -> None:
        spec = MODEL_SPEC_BY_ID[model_id]
        if spec.engine != "llama":
            raise ValueError("Model does not use llama-server")
        if not gpu_info():
            raise RuntimeError("Qwen Tagger requires an NVIDIA GPU with CUDA / Qwen 反推仅支持 NVIDIA CUDA")
        TAGGER_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        self.install_runtime(progress, progress_lock, on_log, on_progress)

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
                on_progress=on_progress,
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
        spec = MODEL_SPEC_BY_ID[model_id]
        large_model = spec.min_vram_gb >= 10
        if low_vram:
            return 20 if large_model else 12
        hardware = gpu_info(True) or {}
        free_mb = int(hardware.get("vram_total_mb") or 0) - int(hardware.get("vram_used_mb") or 0)
        return 999 if free_mb >= spec.min_vram_gb * 1024 else (20 if large_model else 12)

    def start(self, model_id: str, *, low_vram: bool = False,
              on_log: Callable[[str], None] | None = None) -> None:
        with self._lock:
            self._on_log = on_log or self._on_log
            if (
                self._process
                and self._process.poll() is None
                and self._model_id == model_id
                and self._low_vram == low_vram
            ):
                self._last_used = time.time()
                self._emit(f"Reusing llama-server for {model_id}", on_log)
                return
            self.stop("configuration changed")
            self._on_log = on_log
            spec = MODEL_SPEC_BY_ID[model_id]
            model_path, projector_path = model_paths(spec)
            server = llama_server_path()
            if not server.is_file() or not model_path.is_file() or not projector_path.is_file():
                raise LlamaRuntimeStartupError("Qwen model or llama runtime is not installed")
            target_manifest, _ = resolve_runtime_manifest()
            if not installed_runtime_matches(target_manifest):
                raise LlamaRuntimeStartupError(
                    "Qwen runtime requires an update or repair / Qwen 运行组件需要更新或修复"
                )
            port = _free_port()
            stderr_path = TAGGER_RUNTIME_DIR / "llama-server.log"
            log_file = open(stderr_path, "w", encoding="utf-8", errors="replace")
            command = [
                str(server), "--model", str(model_path), "--mmproj", str(projector_path),
                "--host", "127.0.0.1", "--port", str(port), "--ctx-size", str(_CONTEXT_SIZE),
                "--image-min-tokens", "1024",
                "--parallel", "1", "--n-gpu-layers", str(self._gpu_layers(model_id, low_vram)),
            ]
            gpu_layers = command[-1]
            self._output_lines.clear()
            self._emit(
                f"Starting llama-server: model={model_path.name}, mmproj={projector_path.name}, "
                f"gpu_layers={gpu_layers}, ctx={_CONTEXT_SIZE}, port={port}",
                on_log,
            )
            try:
                self._process = subprocess.Popen(
                    command,
                    cwd=str(TAGGER_RUNTIME_DIR),
                    env=self._environment(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
            except Exception as exc:
                log_file.close()
                raise LlamaRuntimeStartupError(f"Unable to start llama-server: {exc}") from exc
            self._log_file = log_file
            self._model_id = model_id
            self._low_vram = low_vram
            self._port = port
            self._stderr_path = stderr_path
            self._output_thread = threading.Thread(
                target=self._capture_output,
                args=(self._process, log_file),
                daemon=True,
                name="llama-server-output",
            )
            self._output_thread.start()
            self._emit("Waiting for llama-server health check", on_log)
            deadline = time.time() + 120
            while time.time() < deadline:
                if self._process.poll() is not None:
                    exit_code = self._process.returncode
                    detail = "\n".join(self._output_lines)[-4000:]
                    if exit_code in {-1073741515, 0xC0000135}:
                        detail = (detail + "\n" if detail else "") + (
                            "Windows loader error 0xC0000135: a required DLL is missing. "
                            "The installed runtime package must be rebuilt as Release with deployable dependencies."
                        )
                    self.stop("startup failed")
                    raise LlamaRuntimeStartupError(
                        f"llama-server exited during startup (code {exit_code}): {detail or 'no process output'}"
                    )
                try:
                    response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=2)
                    if response.status_code == 200:
                        self._last_used = time.time()
                        self._emit("llama-server health check passed; model is ready", on_log)
                        return
                except Exception:
                    pass
                time.sleep(0.5)
            self.stop("startup timeout")
            raise LlamaRuntimeStartupError("llama-server startup timed out")

    def stop(self, reason: str = "requested") -> None:
        process = self._process
        callback = self._on_log
        self._process = None
        self._model_id = None
        self._low_vram = None
        self._port = None
        if process and process.poll() is None:
            self._emit(f"Stopping llama-server ({reason})", callback)
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if process:
            self._emit(f"llama-server exited with code {process.returncode}", callback)
        if self._output_thread and self._output_thread is not threading.current_thread():
            self._output_thread.join(timeout=1)
        self._output_thread = None
        if self._log_file:
            self._log_file.close()
            self._log_file = None
        self._on_log = None

    def infer_tags(self, model_id: str, image: Image.Image, options: dict,
                   on_log: Callable[[str], None] | None = None) -> list[str]:
        low_vram = bool(options.get("low_vram", False))
        self.start(model_id, low_vram=low_vram, on_log=on_log)
        maximum = max(10, min(int(options.get("max_tags", 80)), 160))
        prompt = resolve_tagger_prompt(options, maximum)
        source_has_transparency = bool(image.info.get("source_has_transparency", False))
        prompt += (
            "\n\nSource alpha metadata: meaningful transparency is present. Tag it only when relevant."
            if source_has_transparency
            else "\n\nSource alpha metadata: no meaningful transparency. Never output transparent_background."
        )
        prepared = image.copy()
        prepared.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        prepared.save(buffer, format="JPEG", quality=92)
        data_url = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        payload = {
            "model": "local",
            "temperature": 0.0,
            "repeat_penalty": 1.08,
            "max_tokens": min(1536, max(768, maximum * 10)),
            "chat_template_kwargs": {"enable_thinking": False},
            "reasoning_effort": "none",
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]},
            ],
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
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise LlamaResponseError("llama-server returned an invalid HTTP JSON response") from exc
        tags = _parse_tag_response(body, maximum)
        if not source_has_transparency:
            tags = [
                tag for tag in tags
                if str(tag).strip().lower().replace(" ", "_") != "transparent_background"
            ]
        return tags


llama_runtime = LlamaRuntime()
