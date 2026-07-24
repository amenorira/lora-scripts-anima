"""Environment-management routes and their in-memory background jobs."""

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Request

from backend.constants import REPO_ROOT, SD_MODELS_DIR
from backend.core.realtime import realtime_tasks
from backend.log import log

router = APIRouter()

_JOB_TTL_SECONDS = 600


def _prune_finished_jobs(
    jobs: dict[str, dict],
    lock,
    on_remove: Callable[[dict], None] | None = None,
    *,
    now: float | None = None,
) -> None:
    """Remove completed jobs older than the shared retention window.

    The callback runs while holding the original lock, matching the previous
    cleanup behavior for install-log deletion.
    """
    current_time = time.time() if now is None else now
    with lock:
        expired_ids = [
            job_id
            for job_id, job in jobs.items()
            if job.get("done") and current_time - job.get("start", 0) > _JOB_TTL_SECONDS
        ]
        for job_id in expired_ids:
            job = jobs[job_id]
            if on_remove is not None:
                on_remove(job)
            del jobs[job_id]


# ── Generic pip-install jobs ─────────────────────────────────

_install_jobs: dict[str, dict] = {}
_install_jobs_lock = threading.Lock()


def _remove_install_job(job: dict) -> None:
    log_path = job.get("log_path")
    if not log_path:
        return
    try:
        os.unlink(log_path)
    except Exception:
        pass


def _cleanup_install_jobs() -> None:
    _prune_finished_jobs(_install_jobs, _install_jobs_lock, _remove_install_job)


def _install_job_snapshot(job_id: str, tail: int = 20) -> dict:
    """Read the existing install-job state for the realtime bridge."""
    _cleanup_install_jobs()
    with _install_jobs_lock:
        job = _install_jobs.get(job_id)
        job = dict(job) if job else None
    if not job:
        return {"status": "error", "done": True, "error": "Job not found / 任务不存在"}
    try:
        with open(job["log_path"], "r", encoding="utf-8", errors="replace") as file:
            lines = "".join(file.readlines()[-tail:])
    except Exception:
        lines = ""
    done = bool(job.get("done", False))
    returncode = job.get("returncode")
    return {
        "status": "finished" if done and returncode in (None, 0) else ("error" if done else "running"),
        "lines": lines,
        "done": done,
        "returncode": returncode,
        "elapsed": time.time() - job.get("start", 0),
    }


def _start_install_job(cmd: list[str], max_retries: int = 2) -> str:
    """启动后台 pip install，输出写入临时日志文件。失败时自动重试（指数退避）。"""
    job_id = uuid4().hex[:12]
    log_file = tempfile.NamedTemporaryFile(
        delete=False,
        suffix=".log",
        prefix="anima_install_",
        mode="w",
        encoding="utf-8",
    )
    with _install_jobs_lock:
        _install_jobs[job_id] = {
            "log_path": log_file.name,
            "done": False,
            "start": time.time(),
            "returncode": None,
        }

    def _run():
        for attempt in range(max_retries + 1):
            try:
                if attempt > 0:
                    log_file.write(f"\n[RETRY] Attempt {attempt + 1}/{max_retries + 1}...\n")
                    log_file.flush()
                process = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT, text=True)
                process.wait()
                if process.returncode == 0:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = 0
                    break
                if attempt < max_retries:
                    wait_seconds = 2 ** attempt
                    log_file.write(f"\n[RETRY] Failed with code {process.returncode}, retrying in {wait_seconds}s...\n")
                    log_file.flush()
                    time.sleep(wait_seconds)
                else:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = process.returncode
            except Exception as exc:
                log_file.write(f"\n[ERROR] {exc}\n")
                log_file.flush()
                if attempt < max_retries:
                    time.sleep(2 ** attempt)
                else:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = -1
        with _install_jobs_lock:
            _install_jobs[job_id]["done"] = True
        log_file.close()

    threading.Thread(target=_run, daemon=True).start()
    return job_id


# ── Anima model downloads ─────────────────────────────────────

_download_jobs: dict[str, dict] = {}
_download_jobs_lock = threading.Lock()


def _cleanup_download_jobs() -> None:
    _prune_finished_jobs(_download_jobs, _download_jobs_lock)


def _download_job_snapshot(job_id: str) -> dict:
    _cleanup_download_jobs()
    with _download_jobs_lock:
        job = _download_jobs.get(job_id)
        if job:
            return {
                "status": "finished" if job.get("done") and job.get("success") is not False else ("error" if job.get("done") else "running"),
                "progress": dict(job.get("progress", {})),
                "log": list(job.get("log", [])),
                "done": job.get("done", False),
                "success": job.get("success"),
                "elapsed": time.time() - job.get("start", 0),
            }
    return {"status": "error", "done": True, "progress": {"phase": "error", "error": "Job not found / 任务不存在"}, "log": []}


def _start_download_job(only_file: str | None = None, group: str | None = None) -> str:
    """启动训练模型下载后台线程，返回 job_id。"""
    from tools.download_anima_model import MODEL_FILES, download_anima_files

    files = [
        item
        for item in MODEL_FILES
        if (not group or item[4] == group)
        and (not only_file or item[2] == only_file or item[1] == only_file)
    ]
    if not files:
        raise RuntimeError(f"未知模型或分组: {group or '-'} / {only_file or '-'}")

    job_id = uuid4().hex[:12]
    shared_progress: dict = {"group": group or "all"}
    log_lines: list[str] = []
    with _download_jobs_lock:
        _download_jobs[job_id] = {
            "start": time.time(),
            "done": False,
            "progress": shared_progress,
            "log": log_lines,
            "only_file": only_file,
            "group": group,
        }

    def _run():
        from backend.utils.hf_download import make_progress_bar

        try:
            from backend.log import console as rich_console
        except Exception:
            rich_console = None
        progress_bar = make_progress_bar(console=rich_console)
        state = {"task_id": None}

        def _on_log(message: str):
            log_lines.append(message)
            if len(log_lines) > 50:
                del log_lines[: len(log_lines) - 50]
            try:
                log.info(f"[model-dl] {message}")
            except Exception:
                pass

        def _on_progress(_line: str):
            try:
                with _download_jobs_lock:
                    progress = dict(shared_progress)
                filename = progress.get("filename") or "?"
                total = int(progress.get("total") or 0)
                downloaded = int(progress.get("downloaded") or 0)
                speed = float(progress.get("speed") or 0.0)
                if state["task_id"] is None:
                    state["task_id"] = progress_bar.add_task(filename, total=total or None, completed=downloaded)
                else:
                    progress_bar.update(state["task_id"], description=filename, total=total or None, completed=downloaded)
                    if speed:
                        progress_bar.tasks[state["task_id"]].speed = speed
            except Exception:
                pass

        progress_bar.start()
        try:
            paths = download_anima_files(
                dest_dir=SD_MODELS_DIR,
                progress=shared_progress,
                on_log=_on_log,
                on_progress=_on_progress,
                files=files,
                progress_lock=_download_jobs_lock,
            )
            success = any(path != Path(".") for path in paths) if only_file else all(path != Path(".") for path in paths)
            with _download_jobs_lock:
                _download_jobs[job_id]["done"] = True
                _download_jobs[job_id]["success"] = success
                shared_progress.setdefault("phase", "done" if success else "error")
        except Exception as exc:
            log_lines.append(f"[ERROR] {exc}")
            with _download_jobs_lock:
                shared_progress.update({"phase": "error", "error": str(exc)})
                _download_jobs[job_id]["done"] = True
                _download_jobs[job_id]["success"] = False
        finally:
            try:
                progress_bar.stop()
            except Exception:
                pass
            try:
                sys.stderr.write("\n")
                sys.stderr.flush()
            except Exception:
                pass

    threading.Thread(target=_run, daemon=True).start()
    return job_id


@router.get("/anima-model/status")
async def anima_model_status() -> dict:
    """扫描 models/ 目录，返回全部训练模型的下载状态。"""
    _cleanup_download_jobs()
    from tools.download_anima_model import list_local_model_files

    files = await asyncio.to_thread(list_local_model_files, SD_MODELS_DIR)
    try:
        dest_dir_rel = SD_MODELS_DIR.relative_to(REPO_ROOT).as_posix() + "/"
    except ValueError:
        dest_dir_rel = "models/"
    for file in files:
        file["dest_path"] = dest_dir_rel + file.get("filename", "")
    return {"files": files, "dest_dir": dest_dir_rel}


@router.post("/anima-model/download")
async def anima_model_download(request: Request) -> dict:
    """启动后台模型下载。可按 group 批量下载，或按 group + file 下载单个文件。"""
    only_file = None
    group = None
    try:
        body = await request.json()
        only_file = body.get("file") or None
        group = body.get("group") or None
    except Exception:
        pass
    with _download_jobs_lock:
        running = [job for job in _download_jobs.values() if not job.get("done")]
    if running:
        return {"success": False, "message": "已有下载任务进行中 / A download is already running"}
    try:
        job_id = await asyncio.to_thread(_start_download_job, only_file, group)
    except Exception as exc:
        return {"success": False, "message": str(exc)}
    await realtime_tasks.register(
        job_id,
        "model-download",
        lambda job_id=job_id: _download_job_snapshot(job_id),
    )
    return {"success": True, "job_id": job_id}


# ── Flash Attention ───────────────────────────────────────────

_fa_cache: dict[str, dict] = {}
_fa_cache_lock = threading.Lock()
_FA_CACHE_TTL = 300
_fa_env_cache: dict | None = None
_fa_env_cache_ts: float = 0.0
_FA_ENV_CACHE_TTL = 600.0
_fa_tool_funcs: tuple | None = None
_fa_tool_lock = threading.Lock()


def _import_flash_attn_tool():
    """延迟导入 tools/install_flash_attn.py，避免启动时拖慢 import。"""
    global _fa_tool_funcs
    with _fa_tool_lock:
        if _fa_tool_funcs is not None:
            return _fa_tool_funcs
        import importlib.util

        tool_path = REPO_ROOT / "tools" / "install_flash_attn.py"
        if not tool_path.exists():
            raise ImportError(f"install_flash_attn.py not found at {tool_path}")
        spec = importlib.util.spec_from_file_location("install_flash_attn", tool_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["install_flash_attn"] = module
        spec.loader.exec_module(module)
        _fa_tool_funcs = (
            module.detect_env,
            module.current_status,
            module.fetch_candidates,
            module.install_wheel,
            module.proxy_download_url,
            module.download_urls_for,
        )
        return _fa_tool_funcs


_fa_jobs: dict[str, dict] = {}
_fa_jobs_lock = threading.Lock()


def _cleanup_fa_jobs() -> None:
    _prune_finished_jobs(_fa_jobs, _fa_jobs_lock)


def _fa_job_snapshot(job_id: str) -> dict:
    _cleanup_fa_jobs()
    with _fa_jobs_lock:
        job = _fa_jobs.get(job_id)
        if job:
            done = bool(job.get("done", False))
            success = job.get("success")
            return {
                "status": "finished" if done and success is not False else ("error" if done else "running"),
                "progress": dict(job.get("progress", {})),
                "log": list(job.get("log", [])),
                "done": done,
                "success": success,
                "elapsed": time.time() - job.get("start", 0),
            }
    return {"status": "error", "done": True, "progress": {"stage": "error", "error": "Job not found / 任务不存在"}, "log": []}


def _start_fa_job(download_urls: list[str], wheel_name: str, source: str) -> str:
    """启动 FA 安装后台线程：预下载 wheel → pip install 本地文件。"""
    from backend.utils.hf_download import download_url_with_fallback

    job_id = uuid4().hex[:12]
    shared_progress: dict = {"stage": "downloading", "filename": wheel_name}
    log_lines: list[str] = []
    with _fa_jobs_lock:
        _fa_jobs[job_id] = {
            "start": time.time(),
            "done": False,
            "progress": shared_progress,
            "log": log_lines,
            "source": source,
            "wheel_name": wheel_name,
        }

    def _run():
        tmp_dir: str | None = None
        progress_bar = None
        try:
            log_lines.append(f"[DOWNLOAD] {wheel_name}  ({len(download_urls)} 源候选 / source(s))")
            tmp_dir = tempfile.mkdtemp(prefix="anima_fa_")
            destination = Path(tmp_dir) / wheel_name

            from backend.utils.hf_download import make_progress_bar

            try:
                from backend.log import console as rich_console
            except Exception:
                rich_console = None
            progress_bar = make_progress_bar(console=rich_console)
            state = {"task_id": None}

            def _on_log(message: str):
                log_lines.append(message)
                try:
                    log.info(f"[fa-install] {message}")
                except Exception:
                    pass

            def _on_progress(_line: str):
                try:
                    with _fa_jobs_lock:
                        progress = dict(shared_progress)
                    filename = progress.get("filename") or wheel_name
                    total = int(progress.get("total") or 0)
                    downloaded = int(progress.get("downloaded") or 0)
                    speed = float(progress.get("speed") or 0.0)
                    if state["task_id"] is None:
                        state["task_id"] = progress_bar.add_task(filename, total=total or None, completed=downloaded)
                    else:
                        progress_bar.update(state["task_id"], description=filename, total=total or None, completed=downloaded)
                        if speed:
                            progress_bar.tasks[state["task_id"]].speed = speed
                except Exception:
                    pass

            progress_bar.start()
            download_url_with_fallback(
                download_urls,
                destination,
                progress=shared_progress,
                lock=_fa_jobs_lock,
                on_log=_on_log,
                on_progress=_on_progress,
                file_index=0,
                file_total=1,
                label=wheel_name,
            )
            downloaded_size = destination.stat().st_size
            log_lines.append(f"[DOWNLOAD] 完成 / Done ({downloaded_size / (1024**2):.1f} MB)")

            with _fa_jobs_lock:
                shared_progress.update({
                    "stage": "installing",
                    "filename": wheel_name,
                    "downloaded": downloaded_size,
                    "total": downloaded_size,
                    "speed": 0.0,
                })
            log_lines.append(f"[INSTALL] pip install {destination.name}  (本地文件，约 10-30s)")
            process = subprocess.Popen(
                [sys.executable, "-m", "pip", "install", "--retries", "3", "--timeout", "60", str(destination)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            for line in process.stdout:
                line = line.rstrip()
                if line:
                    log_lines.append(line)
            process.wait()

            if process.returncode == 0:
                with _fa_jobs_lock:
                    shared_progress.update({
                        "stage": "done",
                        "filename": wheel_name,
                        "downloaded": downloaded_size,
                        "total": downloaded_size,
                        "speed": 0.0,
                    })
                    _fa_jobs[job_id]["success"] = True
                log_lines.append("[INSTALL] 安装成功 / Successfully installed")
            else:
                with _fa_jobs_lock:
                    shared_progress.update({
                        "stage": "error",
                        "filename": wheel_name,
                        "error": f"pip exit code {process.returncode}",
                    })
                    _fa_jobs[job_id]["success"] = False
                log_lines.append(f"[ERROR] pip 安装失败，退出码 {process.returncode} / install failed")
        except Exception as exc:
            log_lines.append(f"[ERROR] {type(exc).__name__}: {exc}")
            with _fa_jobs_lock:
                shared_progress.update({"stage": "error", "error": str(exc)})
                _fa_jobs[job_id]["success"] = False
        finally:
            if progress_bar is not None:
                try:
                    progress_bar.stop()
                except Exception:
                    pass
            try:
                sys.stderr.write("\n")
                sys.stderr.flush()
            except Exception:
                pass
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            with _fa_jobs_lock:
                _fa_jobs[job_id]["done"] = True

    threading.Thread(target=_run, daemon=True).start()
    return job_id


def _flash_attn_status_sync(cache_key: str) -> dict:
    """Synchronous implementation of Flash Attention status detection."""
    detect_env, current_status, fetch_candidates, _, _, _ = _import_flash_attn_tool()
    global _fa_env_cache, _fa_env_cache_ts
    now = time.time()
    env = _fa_env_cache
    if env is None or now - _fa_env_cache_ts > _FA_ENV_CACHE_TTL:
        env = detect_env()
        _fa_env_cache = env
        _fa_env_cache_ts = now

    status = current_status()
    with _fa_cache_lock:
        cached = _fa_cache.get(cache_key)
        cache_expired = cached is None or now - cached.get("ts", 0) > _FA_CACHE_TTL
    if cache_expired:
        candidates, fetch_error = fetch_candidates(env, source=cache_key)
        from_disk = bool(fetch_error and "回退磁盘缓存" in str(fetch_error))
        slim = [
            {
                "url": candidate["url"],
                "name": candidate["name"],
                "notes": candidate.get("notes", candidate["notes"]) if isinstance(candidate, dict) else [],
                "usable": candidate["usable"],
            }
            for candidate in candidates[:20]
        ]
        with _fa_cache_lock:
            _fa_cache[cache_key] = {
                "candidates": slim,
                "fetch_error": fetch_error,
                "from_disk": from_disk,
                "ts": now,
            }

    with _fa_cache_lock:
        cache = _fa_cache[cache_key].copy()
    return {
        "installed": status["installed"],
        "version": status["version"],
        "env": env,
        "candidates": cache["candidates"],
        "fetch_error": cache["fetch_error"],
        "from_disk_cache": cache.get("from_disk", False),
        "token_set": bool(os.environ.get("FA_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN")),
        "source": cache_key,
    }


@router.get("/flash-attention/status")
async def flash_attn_status(source: str = "") -> dict:
    """返回 flash_attn 安装状态 + 环境检测 + GitHub 候选 wheel 列表。"""
    try:
        return await asyncio.to_thread(_flash_attn_status_sync, source or "default")
    except Exception as exc:
        log.error(f"flash_attn status error: {exc}")
        return {"installed": False, "version": None, "env": {}, "candidates": [], "fetch_error": str(exc)}


@router.post("/flash-attention/install")
async def flash_attn_install(request: Request) -> dict:
    """Install a Flash Attention wheel in a background job."""
    try:
        body = await request.json()
        manual_url = body.get("url", None)
        source = body.get("source", "default")
    except Exception:
        manual_url = None
        source = "default"

    source = source or "default"
    if manual_url is None:
        def _resolve():
            detect_env, _, fetch_candidates, _, _, _ = _import_flash_attn_tool()
            env = detect_env()
            candidates, _ = fetch_candidates(env, source=source)
            for candidate in candidates:
                if candidate["usable"]:
                    return candidate["url"], candidate.get("name", "")
            return None, None

        wheel_url, wheel_name = await asyncio.to_thread(_resolve)
        if wheel_url is None:
            return {"success": False, "error": "No usable wheel found. Please specify a URL manually."}
        _, _, _, _, _, download_urls_for = _import_flash_attn_tool()
        download_urls = download_urls_for(wheel_url, source)
    else:
        from urllib.parse import unquote

        wheel_name = unquote(manual_url.rsplit("/", 1)[-1]) or "flash_attn.whl"
        download_urls = [manual_url]

    job_id = _start_fa_job(download_urls, wheel_name, source)
    await realtime_tasks.register(
        job_id,
        "flash-attention-install",
        lambda job_id=job_id: _fa_job_snapshot(job_id),
    )
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}


# ── xformers and Triton ───────────────────────────────────────

def _xformers_status_sync() -> dict:
    import importlib.metadata as importlib_metadata

    try:
        version = importlib_metadata.version("xformers")
        installed = True
    except importlib_metadata.PackageNotFoundError:
        version = None
        installed = False

    env: dict[str, object] = {
        "python_tag": f"cp{sys.version_info.major}{sys.version_info.minor}",
        "torch_ver": None,
        "cuda_ver": None,
    }
    try:
        import torch

        env["torch_ver"] = torch.__version__
        match = re.search(r"\+cu(\d+)", torch.__version__)
        if match:
            number = match.group(1)
            if len(number) >= 2:
                env["cuda_ver"] = f"{number[:-1]}.{number[-1]}"
    except ImportError:
        pass

    return {"installed": installed, "version": version, "env": env}


@router.get("/xformers/status")
async def xformers_status() -> dict:
    return await asyncio.to_thread(_xformers_status_sync)


@router.post("/xformers/install")
async def xformers_install() -> dict:
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--force-reinstall",
        "--no-deps",
        "--progress-bar",
        "on",
        "xformers",
    ]
    try:
        import torch

        match = re.search(r"\+cu(\d+)", torch.__version__)
        if match:
            command.extend(["--index-url", f"https://download.pytorch.org/whl/cu{match.group(1)}"])
    except Exception:
        pass
    job_id = _start_install_job(command)
    await realtime_tasks.register(
        job_id,
        "xformers-install",
        lambda job_id=job_id: _install_job_snapshot(job_id),
    )
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}


def _matching_triton_spec(torch_version: str | None = None) -> str:
    """Return the Triton minor range matched to the active PyTorch version."""
    try:
        from packaging.version import Version
    except ImportError:
        return ""
    try:
        if torch_version is None:
            import torch

            torch_version = torch.__version__
        version = Version(str(torch_version).split("+")[0])
    except Exception:
        return ""
    if version >= Version("2.12"):
        return ">=3.7,<3.8"
    if version >= Version("2.10"):
        return ">=3.6,<3.7"
    if version >= Version("2.9"):
        return ">=3.5,<3.6"
    return ""


def _triton_status_sync() -> dict:
    import importlib.metadata as importlib_metadata

    installed = False
    version = None
    package = None
    try:
        version = importlib_metadata.version("triton")
        installed = True
        package = "triton"
    except importlib_metadata.PackageNotFoundError:
        pass
    if not installed:
        try:
            version = importlib_metadata.version("triton-windows")
            installed = True
            package = "triton-windows"
        except importlib_metadata.PackageNotFoundError:
            pass

    platform_note = None
    if not installed:
        if sys.platform == "win32":
            version_spec = _matching_triton_spec()
            package_label = f"triton-windows{version_spec}" if version_spec else "兼容版本的 triton-windows"
            package_label_en = f"triton-windows{version_spec}" if version_spec else "a compatible triton-windows version"
            platform_note = (
                "Triton 未安装。Windows 需先安装 VC++ Redistributable，"
                f"然后在环境管理页一键安装与当前 PyTorch 匹配的 {package_label} / "
                "Triton not installed. Windows: install VC++ Redist first, "
                f"then one-click install {package_label_en} matched to the active PyTorch version"
            )
        else:
            platform_note = "Triton 未安装。Linux 用户: pip install triton / Triton not installed. Linux: pip install triton"
    return {"installed": installed, "version": version, "package": package, "platform_note": platform_note}


@router.get("/triton/status")
async def triton_status() -> dict:
    return await asyncio.to_thread(_triton_status_sync)


@router.post("/triton/install")
async def triton_install() -> dict:
    triton_version = _matching_triton_spec()

    package = "triton-windows" if sys.platform == "win32" else "triton"
    if triton_version:
        package = f"{package}{triton_version}"
    job_id = _start_install_job([sys.executable, "-m", "pip", "install", "-U", "--progress-bar", "on", package])
    await realtime_tasks.register(
        job_id,
        "triton-install",
        lambda job_id=job_id: _install_job_snapshot(job_id),
    )
    return {"success": True, "job_id": job_id, "message": f"Installing {package} / 正在安装 {package}..."}
