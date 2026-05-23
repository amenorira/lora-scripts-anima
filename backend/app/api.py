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
    """安装 flash_attn wheel。body: { url: string|null, source: string }。
    url=null 则自动从 GitHub 选最优匹配；否则用指定 URL。
    source='mirror' 时 wheel 下载 URL 自动走 ghproxy 代理。
    """
    detect_env, current_status, fetch_candidates, install_wheel = _import_flash_attn_tool()
    try:
        body = await request.json()
        url = body.get("url", None)
        source = body.get("source", "default")
    except Exception:
        url = None
        source = "default"

    try:
        if url is None:
            env = detect_env()
            # 切换源获取候选
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
        # 国内镜像：wheel 下载走 ghproxy 代理
        if source == "mirror" and url and not url.startswith("https://ghproxy.com/"):
            url = "https://ghproxy.com/" + url
        result = install_wheel(url)
        return {"success": True, **result}
    except Exception as e:
        log.error(f"flash_attn install error: {e}")
        return {"success": False, "error": str(e)}
