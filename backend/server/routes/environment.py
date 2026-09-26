"""Environment-management routes and their in-memory background jobs."""

import asyncio
import os
import re
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


def _read_install_log_tail(path: str, tail: int) -> str:
    if tail <= 0:
        # Preserve the existing readlines()[-tail:] behavior for explicit
        # non-positive requests (zero means the whole log).
        with open(path, "r", encoding="utf-8", errors="replace") as file:
            return "".join(file.readlines()[-tail:])
    chunks = []
    with open(path, "rb") as file:
        file.seek(0, os.SEEK_END)
        position = file.tell()
        remaining = 512 * 1024
        newlines = 0
        while position > 0 and remaining > 0 and newlines <= tail:
            size = min(position, 8192, remaining)
            position -= size
            file.seek(position)
            chunk = file.read(size)
            chunks.append(chunk)
            newlines += chunk.count(b"\n")
            remaining -= size
    raw = b"".join(reversed(chunks))
    if position > 0 and newlines <= tail:
        return "[... earlier log truncated / 前面的日志已截断 ...]\n" + raw.decode("utf-8", errors="replace")
    return b"".join(raw.splitlines(keepends=True)[-tail:]).decode("utf-8", errors="replace")


def _install_job_snapshot(job_id: str, tail: int = 20) -> dict:
    """Read the existing install-job state for the realtime bridge."""
    _cleanup_install_jobs()
    with _install_jobs_lock:
        job = _install_jobs.get(job_id)
        job = dict(job) if job else None
    if not job:
        return {"status": "error", "done": True, "error": "Job not found / 任务不存在"}
    try:
        lines = _read_install_log_tail(job["log_path"], tail)
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
        raise RuntimeError(f"Unknown model or group / 未知模型或分组: group={group or '-'}, file={only_file or '-'}")

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
    from tools.ensure_runtime import XFORMERS

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
        f"xformers=={XFORMERS}",
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
    if version >= Version("2.12.1"):
        return ">=3.7.1,<3.8"
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
