import asyncio
import hashlib
import json
import os
import re
import random

from glob import glob
from datetime import datetime
from pathlib import Path
from typing import Tuple, Optional

import toml
from fastapi import APIRouter, BackgroundTasks, Body, Request
from starlette.requests import Request

from backend import launch_utils
from backend.app.config import app_config
from backend.app.models import (APIResponse, APIResponseFail,
                                 APIResponseSuccess, PresetSaveRequest,
                                 TaggerInterrogateRequest)
from backend.app.state import avaliable_schemas, avaliable_presets, load_schemas, load_presets
from backend.log import log
from backend.tagger.interrogator import (available_interrogators,
                                          on_interrogate)
from backend.tasks import tm
from backend.utils import train_utils
from backend.utils.devices import printable_devices
from backend.utils.tk_window import (open_directory_selector,
                                      open_file_selector)

router = APIRouter()


def _git_version() -> str:
    try:
        import subprocess
        r = subprocess.run(["git", "describe", "--tags", "--always"],
                          capture_output=True, text=True,
                          cwd=Path(__file__).parents[2])
        return r.stdout.strip() or "dev"
    except Exception:
        return "dev"


@router.get("/health")
async def health_check():
    """Lightweight connectivity check — returns OK immediately."""
    return {"status": "ok"}


@router.get("/version")
async def get_version():
    return APIResponseSuccess(data={"version": _git_version()})


@router.post("/interrogate")
async def run_interrogate(req: TaggerInterrogateRequest, background_tasks: BackgroundTasks):
    interrogator = available_interrogators.get(req.interrogator_model, available_interrogators["wd14-convnextv2-v2"])
    background_tasks.add_task(
        on_interrogate,
        image=None,
        batch_input_glob=req.path,
        batch_input_recursive=req.batch_input_recursive,
        batch_output_dir="",
        batch_output_filename_format="[name].[output_extension]",
        batch_output_action_on_conflict=req.batch_output_action_on_conflict,
        batch_remove_duplicated_tag=True,
        batch_output_save_json=False,
        interrogator=interrogator,
        threshold=req.threshold,
        character_threshold=req.character_threshold,
        add_rating_tag=req.add_rating_tag,
        add_model_tag=req.add_model_tag,
        additional_tags=req.additional_tags,
        exclude_tags=req.exclude_tags,
        sort_by_alphabetical_order=False,
        add_confident_as_weight=False,
        replace_underscore=req.replace_underscore,
        replace_underscore_excludes=req.replace_underscore_excludes,
        escape_tag=req.escape_tag,
        unload_model_after_running=True
    )
    return APIResponseSuccess()


@router.get("/tagger/models")
async def list_tagger_models():
    """List available tagger/interrogator models."""
    models = []
    for key, interrogator in available_interrogators.items():
        models.append({
            "id": key,
            "name": key
        })
    return APIResponseSuccess(data=models)


@router.get("/pick_file")
async def pick_file(picker_type: str):
    if picker_type == "folder":
        coro = asyncio.to_thread(open_directory_selector, "")
    elif picker_type == "model-file":
        file_types = [("checkpoints", "*.safetensors;*.ckpt;*.pt"), ("all files", "*.*")]
        coro = asyncio.to_thread(open_file_selector, "", "Select file", file_types)

    result = await coro
    if result == "":
        return APIResponseFail(message="User cancelled / 用户取消")

    return APIResponseSuccess(data={
        "path": result
    })


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    pick_preset = {
        "model-file": {
            "type": "file",
            "path": "./sd-models",
            "filter": "(.safetensors|.ckpt|.pt)"
        },
        "model-saved-file": {
            "type": "file",
            "path": "./output",
            "filter": "(.safetensors|.ckpt|.pt)"
        },
        "train-dir": {
            "type": "folder",
            "path": "./train",
            "filter": None
        },
    }

    folder_blacklist = [".ipynb_checkpoints", ".DS_Store"]

    def list_path_or_files(preset_info):
        path = Path(preset_info["path"])
        file_type = preset_info["type"]
        regex_filter = preset_info["filter"]
        result_list = []

        if file_type == "file":
            if regex_filter:
                pattern = re.compile(regex_filter)
                files = [f for f in path.glob("**/*") if f.is_file() and pattern.search(f.name)]
            else:
                files = [f for f in path.glob("**/*") if f.is_file()]
            for file in files:
                result_list.append({
                    "path": str(file.resolve().absolute()).replace("\\", "/"),
                    "name": file.name,
                    "size": f"{round(file.stat().st_size / (1024**3),2)} GB"
                })
        elif file_type == "folder":
            folders = [f for f in path.iterdir() if f.is_dir()]
            for folder in folders:
                if folder.name in folder_blacklist:
                    continue
                result_list.append({
                    "path": str(folder.resolve().absolute()).replace("\\", "/"),
                    "name": folder.name,
                    "size": 0
                })

        return result_list

    if pick_type not in pick_preset:
        return APIResponseFail(message="Invalid request")

    dirs = list_path_or_files(pick_preset[pick_type])
    return APIResponseSuccess(data={
        "files": dirs
    })


@router.get("/tasks", response_model_exclude_none=True)
async def get_tasks() -> APIResponse:
    return APIResponseSuccess(data={
        "tasks": tm.dump()
    })


@router.get("/tasks/terminate/{task_id}", response_model_exclude_none=True)
async def terminate_task(task_id: str):
    tm.terminate_task(task_id)
    return APIResponseSuccess()


@router.get("/graphic_cards")
async def list_avaliable_cards() -> APIResponse:
    if not printable_devices:
        return APIResponse(status="pending")

    return APIResponseSuccess(data={
        "cards": printable_devices
    })


@router.get("/schemas/hashes")
async def list_schema_hashes() -> APIResponse:
    if os.environ.get("ANIMA_SCHEMA_HOT_RELOAD", os.environ.get("MIKAZUKI_SCHEMA_HOT_RELOAD", "0")) == "1":
        log.info("Hot reloading schemas")
        await load_schemas()

    return APIResponseSuccess(data={
        "schemas": [
            {
                "name": schema["name"],
                "hash": schema["hash"]
            }
            for schema in avaliable_schemas
        ]
    })


@router.get("/schemas/all")
async def get_all_schemas() -> APIResponse:
    return APIResponseSuccess(data={
        "schemas": avaliable_schemas
    })


# ═══════════════════════════════════════════════════════════
#  安装后台任务 & 日志轮询（Flash Attention / xformers 共用）
# ═══════════════════════════════════════════════════════════

import subprocess as _install_sp
import tempfile as _install_tmp
import threading as _install_thr
import time as _install_time
from uuid import uuid4 as _install_uuid

_install_jobs: dict[str, dict] = {}

def _start_install_job(cmd: list[str]) -> str:
    """启动后台 pip install，输出写入临时日志文件。返回 job_id。"""
    job_id = _install_uuid().hex[:12]
    log_f = _install_tmp.NamedTemporaryFile(
        delete=False, suffix=".log", prefix="anima_install_",
        mode="w", encoding="utf-8",
    )
    log_path = log_f.name
    _install_jobs[job_id] = {
        "log_path": log_path, "done": False,
        "start": _install_time.time(), "returncode": None,
    }

    def _run():
        try:
            proc = _install_sp.Popen(
                cmd, stdout=log_f, stderr=_install_sp.STDOUT, text=True,
            )
            proc.wait()
            _install_jobs[job_id]["returncode"] = proc.returncode
        except Exception as e:
            log_f.write(f"\n[ERROR] {e}\n")
            _install_jobs[job_id]["returncode"] = -1
        finally:
            _install_jobs[job_id]["done"] = True
            log_f.close()

    _install_thr.Thread(target=_run, daemon=True).start()
    return job_id


@router.get("/install-log/{job_id}")
async def install_log(job_id: str, tail: int = 20) -> dict:
    """轮询安装进度。返回最新日志行 + 完成状态。"""
    import time
    job = _install_jobs.get(job_id)
    if not job:
        return {"lines": "", "done": True, "error": "Job not found / 任务不存在"}
    try:
        with open(job["log_path"], "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
            lines = "".join(all_lines[-tail:])
    except Exception:
        lines = ""
    return {
        "lines": lines,
        "done": job.get("done", False),
        "returncode": job.get("returncode"),
        "elapsed": time.time() - job.get("start", 0),
    }


# ═══════════════════════════════════════════════════════════
#  Flash Attention 环境管理 API
# ═══════════════════════════════════════════════════════════

_fa_cache: dict[str, dict] = {}  # key: source name → {candidates, fetch_error, from_disk, ts}
_FA_CACHE_TTL = 300  # 5 分钟，避免频繁请求 GitHub API 触发限流


def _import_flash_attn_tool():
    """延迟导入 tools/install_flash_attn.py，避免启动时拖慢 import。"""
    import importlib.util
    import sys
    _root = Path(__file__).parents[2]
    _path = _root / "tools" / "install_flash_attn.py"
    if not _path.exists():
        raise ImportError(f"install_flash_attn.py not found at {_path}")
    spec = importlib.util.spec_from_file_location("install_flash_attn", _path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["install_flash_attn"] = mod
    spec.loader.exec_module(mod)
    return mod.detect_env, mod.current_status, mod.fetch_candidates, mod.install_wheel


@router.get("/flash-attention/status")
async def flash_attn_status(source: str = "") -> dict:
    """返回 flash_attn 安装状态 + 环境检测 + GitHub 候选 wheel 列表。
    source: 可选 'default'|'mirror'|'fallback'，空则用默认源。
    """
    import time
    import os as _os
    detect_env, current_status, fetch_candidates, _ = _import_flash_attn_tool()
    # 支持切换源
    if source:
        import tools.install_flash_attn as fa_tool
        try:
            fa_tool.FA_RELEASES_URL, fa_tool.FA_FALLBACK_URLS = _fa_source_config(source)
        except Exception:
            pass
    try:
        status = current_status()
        env = detect_env()
        now = time.time()
        cache_key = source or "default"
        cached = _fa_cache.get(cache_key)
        if cached is None or (now - cached.get("ts", 0)) > _FA_CACHE_TTL:
            candidates, fetch_error = fetch_candidates(env)
            from_disk = False
            # 检测是否来自磁盘缓存（fetch_error 中包含 "回退磁盘缓存" 字样）
            if fetch_error and "回退磁盘缓存" in str(fetch_error):
                from_disk = True
            slim = [
                {"url": c["url"], "name": c["name"], "notes": c.get("notes", c["notes"]) if isinstance(c, dict) else [], "usable": c["usable"]}
                for c in candidates[:20]
            ]
            _fa_cache[cache_key] = {
                "candidates": slim, "fetch_error": fetch_error,
                "from_disk": from_disk, "ts": now
            }
        c = _fa_cache[cache_key]
        token_set = bool(
            _os.environ.get("FA_GITHUB_TOKEN") or _os.environ.get("GITHUB_TOKEN")
        )
        return {
            "installed": status["installed"], "version": status["version"],
            "env": env, "candidates": c["candidates"],
            "fetch_error": c["fetch_error"],
            "from_disk_cache": c.get("from_disk", False),
            "token_set": token_set,
            "source": cache_key,
        }
    except Exception as e:
        log.error(f"flash_attn status error: {e}")
        return {"installed": False, "version": None, "env": {}, "candidates": [], "fetch_error": str(e)}


def _fa_source_config(source: str):
    """切换候选源配置。
    - default: GitHub 官方 API（国际）
    - mirror:  ghproxy 代理（国内）
    - fallback: 备用 GitHub 仓库
    """
    if source == "mirror":
        return (
            "https://ghproxy.com/https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
            ["https://ghproxy.com/https://api.github.com/repos/bdashore3/flash-attention/releases"]
        )
    if source == "fallback":
        return (
            "https://api.github.com/repos/bdashore3/flash-attention/releases",
            ["https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases"]
        )
    # default
    return (
        "https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
        ["https://api.github.com/repos/bdashore3/flash-attention/releases"]
    )


@router.post("/flash-attention/install")
async def flash_attn_install(request: Request) -> dict:
    """安装 flash_attn wheel（后台执行，通过 /api/install-log/{job_id} 轮询进度）。"""
    detect_env, current_status, fetch_candidates, _ = _import_flash_attn_tool()
    try:
        body = await request.json()
        url = body.get("url", None)
        source = body.get("source", "default")
    except Exception:
        url = None
        source = "default"

    if url is None:
        env = detect_env()
        if source and source != "default":
            import tools.install_flash_attn as fa_tool
            try:
                fa_tool.FA_RELEASES_URL, fa_tool.FA_FALLBACK_URLS = _fa_source_config(source)
            except Exception:
                pass
        candidates, _ = fetch_candidates(env)
        url = None
        for c in candidates:
            if c["usable"]:
                url = c["url"]
                break
        if url is None:
            return {"success": False, "error": "No usable wheel found. Please specify a URL manually."}

    if source == "mirror" and url and not url.startswith("https://ghproxy.com/"):
        url = "https://ghproxy.com/" + url

    import sys
    job_id = _start_install_job([sys.executable, "-m", "pip", "install", url])
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}


# ═══════════════════════════════════════════════════════════
#  xformers 环境管理 API
# ═══════════════════════════════════════════════════════════

@router.get("/xformers/status")
async def xformers_status() -> dict:
    """返回 xformers 安装状态 + 基础环境信息。"""
    import importlib.metadata as _imd
    import sys

    try:
        ver = _imd.version("xformers")
        installed = True
    except _imd.PackageNotFoundError:
        ver = None
        installed = False

    env: dict[str, object] = {
        "python_tag": f"cp{sys.version_info.major}{sys.version_info.minor}",
        "torch_ver": None,
        "cuda_ver": None,
    }
    try:
        import torch  # noqa: F811
        env["torch_ver"] = torch.__version__
        m = re.search(r"\+cu(\d+)", torch.__version__)
        if m:
            num = m.group(1)
            if len(num) >= 2:
                env["cuda_ver"] = f"{num[:-1]}.{num[-1]}"
    except ImportError:
        pass

    return {"installed": installed, "version": ver, "env": env}


@router.post("/xformers/install")
async def xformers_install() -> dict:
    """pip install xformers（后台执行，通过 /api/install-log/{job_id} 轮询进度）。"""
    import sys
    job_id = _start_install_job([sys.executable, "-m", "pip", "install", "xformers"])
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}
