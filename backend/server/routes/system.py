"""Core local-server routes that are unrelated to training or environment setup."""

import asyncio
import concurrent.futures
import hashlib
import json
import re
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request, Response

from backend import launch_utils
from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR, VENDOR_ROOT
from backend.server.models import APIResponse, APIResponseFail, APIResponseSuccess
from backend.tasks import tm
from backend.utils.devices import printable_devices
from backend.utils.tk_window import (
    is_available as tk_is_available,
    open_directory_selector,
    open_file_selector,
)

router = APIRouter()

# tkinter 非线程安全：Tk root 与对话框必须在同一线程，否则偶发"对话框不弹出 /
# main thread is not in main loop"。这里用单工作线程执行器把所有原生选择器调用
# 串行化到固定线程，根治本地选择器"有时不生效"。单 worker 也保证同一时刻只有一个对话框。
_tk_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="tk-picker")
_git_version_cache: str | None = None


def _git_version() -> str:
    global _git_version_cache
    if _git_version_cache is not None:
        return _git_version_cache
    try:
        result = launch_utils.run_capture_text(
            ["git", "describe", "--tags", "--always"],
            cwd=str(REPO_ROOT),
        )
        _git_version_cache = result.stdout.strip() or "dev"
        return _git_version_cache
    except Exception:
        return "dev"


@router.get("/health")
async def health_check():
    """Lightweight connectivity check — returns OK + training active flag."""
    tasks = tm.dump()
    active_task = next(
        (task for task in tasks if task.get("status") in {"CREATED", "RUNNING"}),
        None,
    )
    return {
        "status": "ok",
        "training_active": active_task is not None,
        "task_id": active_task["id"] if active_task else None,
    }


@router.get("/version")
async def get_version():
    version = await asyncio.to_thread(_git_version)
    return APIResponseSuccess(data={"version": version})


_fields_payload_cache: dict[str, tuple[str, bytes]] = {}
_fields_payload_lock = threading.Lock()


def _fields_payload() -> tuple[str, bytes]:
    """Process-stable fields JSON + strong ETag (body hash).

    The registry is static per process (get_fields_json caches it), so the
    serialized payload is built once and reused; unchanged clients get a 304
    instead of re-downloading ~88 KB on every page load.
    """
    global _fields_payload_cache
    with _fields_payload_lock:
        cached = _fields_payload_cache.get("v1")
        if cached is not None:
            return cached
        from backend.training.field_registry import get_fields_json

        body = json.dumps(
            {"status": "success", "message": None, "data": get_fields_json()},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        etag = '"' + hashlib.sha1(body).hexdigest() + '"'
        _fields_payload_cache = {"v1": (etag, body)}
        return etag, body


@router.get("/fields")
async def get_fields(request: Request):
    """返回训练字段定义（前端表单渲染 + 后端白名单共用同一数据源）"""
    etag, body = await asyncio.to_thread(_fields_payload)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(content=body, media_type="application/json", headers={"ETag": etag})


@router.get("/pick_file")
async def pick_file(picker_type: str):
    if not tk_is_available():
        return APIResponseFail(message="unavailable")
    if picker_type == "folder":
        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, open_directory_selector, "")
    elif picker_type == "model-file":
        file_types = [("checkpoints", "*.safetensors;*.ckpt;*.pt"), ("all files", "*.*")]

        def _pick():
            return open_file_selector("", "Select file", file_types)

        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, _pick)
    elif picker_type == "image-file":
        file_types = [
            ("images", "*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff;*.avif"),
            ("all files", "*.*"),
        ]

        def _pick_image():
            return open_file_selector("", "Select image", file_types)

        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, _pick_image)
    else:
        return APIResponseFail(message=f"Invalid picker_type: {picker_type}")

    result = await coro
    if result == "":
        return APIResponseFail(message="cancelled")

    return APIResponseSuccess(data={"path": result})


_files_cache: dict[str, tuple[float, list[dict]]] = {}
_files_cache_lock = threading.Lock()
_FILES_CACHE_TTL = 60


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    now = time.time()
    with _files_cache_lock:
        cached = _files_cache.get(pick_type)
        if cached and now - cached[0] < _FILES_CACHE_TTL:
            return APIResponseSuccess(data={"files": cached[1]})

    pick_preset = {
        "model-file": {"type": "file", "path": "./models", "filter": "(.safetensors|.ckpt|.pt)"},
        "model-saved-file": {"type": "file", "path": "./output", "filter": "(.safetensors|.ckpt|.pt)"},
        "train-dir": {"type": "folder", "path": "./train", "filter": None},
    }
    folder_blacklist = [".ipynb_checkpoints", ".DS_Store"]

    def list_path_or_files(preset_info):
        path = Path(preset_info["path"])
        file_type = preset_info["type"]
        regex_filter = preset_info["filter"]
        result_list = []

        if not path.exists():
            return result_list

        if file_type == "file":
            if regex_filter:
                pattern = re.compile(regex_filter)
                files = [file for file in path.glob("**/*") if file.is_file() and pattern.search(file.name)]
            else:
                files = [file for file in path.glob("**/*") if file.is_file()]
            for file in files:
                result_list.append({
                    "path": str(file.resolve().absolute()).replace("\\", "/"),
                    "name": file.name,
                    "size": f"{round(file.stat().st_size / (1024**3), 2)} GB",
                })
        elif file_type == "folder":
            folders = [folder for folder in path.iterdir() if folder.is_dir()]
            for folder in folders:
                if folder.name in folder_blacklist:
                    continue
                result_list.append({
                    "path": str(folder.resolve().absolute()).replace("\\", "/"),
                    "name": folder.name,
                    "size": 0,
                })

        return result_list

    if pick_type not in pick_preset:
        return APIResponseFail(message="Invalid request")

    dirs = await asyncio.to_thread(list_path_or_files, pick_preset[pick_type])
    with _files_cache_lock:
        _files_cache[pick_type] = (now, dirs)
    return APIResponseSuccess(data={"files": dirs})


@router.get("/tasks/terminate/{task_id}", response_model_exclude_none=True)
async def terminate_task(task_id: str):
    tm.terminate_task(task_id)
    return APIResponseSuccess()


@router.get("/graphic_cards")
async def list_available_cards() -> APIResponse:
    if not printable_devices:
        return APIResponse(status="pending")

    return APIResponseSuccess(data={"cards": printable_devices})


_sd_scripts_version_cache: dict | None = None


def _read_sd_scripts_version() -> dict:
    """读取 vendor/sd-scripts 的本地版本信息。"""
    global _sd_scripts_version_cache
    if _sd_scripts_version_cache is not None:
        return _sd_scripts_version_cache

    sd_root = SD_SCRIPTS_DIR
    track_file = VENDOR_ROOT / ".sd-scripts-version"
    info: dict = {
        "local_commit": None,
        "local_branch": None,
        "sync_date": None,
        "repo": "kohya-ss/sd-scripts",
        "tag": None,
        "version_source": "unknown",
    }

    if (sd_root / ".git").exists():
        try:
            result = launch_utils.run_capture_text(["git", "-C", str(sd_root), "rev-parse", "--short", "HEAD"], timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                info["local_commit"] = result.stdout.strip()
                info["version_source"] = "git"
        except Exception:
            pass
        try:
            result = launch_utils.run_capture_text(["git", "-C", str(sd_root), "rev-parse", "--abbrev-ref", "HEAD"], timeout=5)
            if result.returncode == 0:
                branch = result.stdout.strip()
                if branch and branch != "HEAD":
                    info["local_branch"] = branch
        except Exception:
            pass
        try:
            result = launch_utils.run_capture_text(["git", "-C", str(sd_root), "describe", "--tags", "--always"], timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                tag_desc = result.stdout.strip()
                if tag_desc and not tag_desc.startswith(info["local_commit"] or ""):
                    info["tag"] = tag_desc.split("-")[0] if "-" in tag_desc else tag_desc
        except Exception:
            pass
        try:
            result = launch_utils.run_capture_text(["git", "-C", str(sd_root), "log", "-1", "--format=%ci"], timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                info["sync_date"] = result.stdout.strip()
        except Exception:
            pass
        try:
            result = launch_utils.run_capture_text(["git", "-C", str(sd_root), "remote", "get-url", "origin"], timeout=5)
            if result.returncode == 0:
                match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", result.stdout.strip())
                if match:
                    info["repo"] = match.group(1)
        except Exception:
            pass

        _sd_scripts_version_cache = info
        return info

    if track_file.exists():
        try:
            current_section = None
            with open(track_file, "r", encoding="utf-8") as file:
                for line in file:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("[") and line.endswith("]"):
                        current_section = line[1:-1]
                        continue
                    if current_section == "upstream" and "=" in line:
                        key, _, value = line.partition("=")
                        value = value.strip().strip('"').strip("'")
                        if key.strip() == "repo":
                            info["repo"] = value
                        elif key.strip() == "branch":
                            info["local_branch"] = value
                        elif key.strip() == "commit" and value and value != "UNKNOWN":
                            info["local_commit"] = value[:8]
                        elif key.strip() == "sync_date":
                            info["sync_date"] = value
                        elif key.strip() == "tag":
                            info["tag"] = value
            if info["local_commit"]:
                info["version_source"] = "tracking_file"
            _sd_scripts_version_cache = info
            return info
        except Exception:
            pass

    if sd_root.is_dir() and (sd_root / "setup.py").exists():
        info["version_source"] = "inferred"

    _sd_scripts_version_cache = info
    return info


@router.get("/sd-scripts/status")
async def sd_scripts_status() -> dict:
    """返回 sd-scripts 训练核心的本地版本信息（仅本地，不查询上游）。"""
    info = await asyncio.to_thread(_read_sd_scripts_version)
    owner, repo_name = info["repo"].split("/") if "/" in info["repo"] else ("kohya-ss", "sd-scripts")
    return {"local": info, "repo_url": f"https://github.com/{owner}/{repo_name}"}
