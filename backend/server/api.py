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
from backend.server.config import app_config
from backend.server.models import (APIResponse, APIResponseFail,
                                 APIResponseSuccess, PresetSaveRequest,
                                 TaggerInterrogateRequest)
from backend.server.state import avaliable_presets, load_presets
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


@router.get("/fields")
async def get_fields():
    """返回训练字段定义（前端表单渲染 + 后端白名单共用同一数据源）"""
    from backend.training.field_registry import get_fields_json
    return APIResponseSuccess(data=get_fields_json())


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


# ═══════════════════════════════════════════════════════════
#  sd-scripts 训练核心信息 API
# ═══════════════════════════════════════════════════════════

import time as _time
import json as _json

# 磁盘缓存路径（与 flash-attn 缓存同目录）
_SD_CACHE_DIR = Path(__file__).parents[2] / "cache"
_SD_CACHE_FILE = _SD_CACHE_DIR / ".sd_scripts_cache.json"
_SD_ETAG_RELEASES = _SD_CACHE_DIR / ".sd_etag_releases.txt"
_SD_ETAG_COMMITS = _SD_CACHE_DIR / ".sd_etag_commits.txt"
_SD_ETAG_MAIN = _SD_CACHE_DIR / ".sd_etag_main.txt"

# 内存缓存 TTL：5 分钟。磁盘缓存 TTL：1 小时。
_SD_MEM_CACHE_TTL = 300
_SD_DISK_CACHE_TTL = 86400  # 24 小时（Release 不频繁，无需频繁刷新）

_sd_scripts_cache: dict = {}


def _github_api_request(url: str, etag_file: Path) -> tuple[Optional[dict], Optional[str], bool]:
    """带 ETag 条件请求的 GitHub API 调用。
    返回 (data, error, from_cache)。
    - 304 时返回 (None, None, True) 表示缓存有效
    - 成功时更新 ETag 文件
    - 失败时返回错误信息
    """
    import urllib.request as _ur
    import json as _json

    req = _ur.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "lora-scripts-anima")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")

    # ETag 条件请求：不消耗 rate limit
    etag = None
    try:
        if etag_file.exists():
            etag = etag_file.read_text(encoding="utf-8").strip()
            if etag:
                req.add_header("If-None-Match", etag)
    except Exception:
        pass

    # GitHub Token
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("FA_GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with _ur.urlopen(req, timeout=15) as resp:
            new_etag = resp.headers.get("ETag") or resp.headers.get("etag")
            if new_etag:
                try:
                    _SD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    etag_file.write_text(new_etag, encoding="utf-8")
                except Exception:
                    pass
            data = _json.loads(resp.read())
            return data, None, False
    except _ur.HTTPError as exc:
        if exc.code == 304:
            return None, None, True  # 缓存有效
        if exc.code in (403, 429):
            return None, f"rate limited / 请求频率限制 ({exc.code})", False
        return None, str(exc), False
    except Exception as exc:
        return None, str(exc), False


def _load_sd_disk_cache() -> Optional[dict]:
    """读取 sd-scripts 磁盘缓存。"""
    try:
        if _SD_CACHE_FILE.exists():
            data = _json.loads(_SD_CACHE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "ts" in data:
                age = _time.time() - data["ts"]
                if age < _SD_DISK_CACHE_TTL:
                    return data.get("payload")
    except Exception:
        pass
    return None


def _save_sd_disk_cache(payload: dict) -> None:
    """保存 sd-scripts 状态到磁盘缓存。"""
    try:
        _SD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _SD_CACHE_FILE.write_text(
            _json.dumps({"ts": _time.time(), "payload": payload}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def _read_sd_scripts_version() -> dict:
    """读取 vendor/sd-scripts 的本地版本信息。
    
    三层检测策略（按优先级）：
    1. 独立 Git 仓库（有人 git clone 了上游）→ git describe
    2. 跟踪文件 vendor/.sd-scripts-version → 读记录
    3. 代码特征推断 → 检查 setup.py / library 等
    4. 都失败 → 标记为 unknown
    
    返回 dict 含 version_source 字段标识数据来源。
    """
    root = Path(__file__).parents[2]
    sd_root = root / "vendor" / "sd-scripts"
    track_file = root / "vendor" / ".sd-scripts-version"
    
    info: dict = {
        "local_commit": None,
        "local_branch": None,
        "sync_date": None,
        "repo": "kohya-ss/sd-scripts",
        "tag": None,
        "version_source": "unknown",
    }

    # ── 第1层：独立 Git 仓库检测 ──────────────────────
    git_dir = sd_root / ".git"
    if git_dir.exists():
        import subprocess as _sp
        try:
            r = _sp.run(
                ["git", "-C", str(sd_root), "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                info["local_commit"] = r.stdout.strip()
                info["version_source"] = "git"
        except Exception:
            pass

        try:
            r = _sp.run(
                ["git", "-C", str(sd_root), "rev-parse", "--abbrev-ref", "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                branch = r.stdout.strip()
                if branch and branch != "HEAD":
                    info["local_branch"] = branch
        except Exception:
            pass

        try:
            r = _sp.run(
                ["git", "-C", str(sd_root), "describe", "--tags", "--always"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                tag_desc = r.stdout.strip()
                # git describe 可能返回 "v0.10.5" 或 "v0.10.5-1-ga1b48df"
                if tag_desc and not tag_desc.startswith(info["local_commit"] or ""):
                    if "-" in tag_desc:
                        info["tag"] = tag_desc.split("-")[0]
                    else:
                        info["tag"] = tag_desc
        except Exception:
            pass

        try:
            r = _sp.run(
                ["git", "-C", str(sd_root), "log", "-1", "--format=%ci"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                info["sync_date"] = r.stdout.strip()
        except Exception:
            pass

        # 尝试获取 remote URL
        try:
            r = _sp.run(
                ["git", "-C", str(sd_root), "remote", "get-url", "origin"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                remote = r.stdout.strip()
                # 从 URL 提取 owner/repo
                import re as _re
                m = _re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote)
                if m:
                    info["repo"] = m.group(1)
        except Exception:
            pass

        return info

    # ── 第2层：跟踪文件 ────────────────────────────────
    if track_file.exists():
        try:
            current_section = None
            with open(track_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("[") and line.endswith("]"):
                        current_section = line[1:-1]
                        continue
                    if current_section == "upstream" and "=" in line:
                        key, _, val = line.partition("=")
                        key = key.strip()
                        val = val.strip().strip('"').strip("'")
                        if key == "repo":
                            info["repo"] = val
                        elif key == "branch":
                            info["local_branch"] = val
                        elif key == "commit" and val and val != "UNKNOWN":
                            info["local_commit"] = val[:8]
                        elif key == "sync_date":
                            info["sync_date"] = val
                        elif key == "tag":
                            info["tag"] = val
            if info["local_commit"]:
                info["version_source"] = "tracking_file"
            return info
        except Exception:
            pass

    # ── 第3层：代码特征推断 ────────────────────────────
    # 尝试从 setup.py 或特征文件推断
    if sd_root.is_dir():
        setup_py = sd_root / "setup.py"
        if setup_py.exists():
            info["version_source"] = "inferred"

    return info


def _fetch_github_releases(owner: str, repo: str) -> dict:
    """从 GitHub API 获取最新 release 信息（带 ETag 缓存）。"""
    url = f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=5"
    data, error, from_cache = _github_api_request(url, _SD_ETAG_RELEASES)

    if from_cache:
        return {"releases": [], "error": None, "from_cache": True}

    if error:
        return {"releases": [], "error": error, "from_cache": False}

    if isinstance(data, list):
        releases = []
        for rel in data[:5]:
            releases.append({
                "tag_name": rel.get("tag_name", ""),
                "name": rel.get("name", ""),
                "published_at": rel.get("published_at", ""),
                "html_url": rel.get("html_url", ""),
                "body": rel.get("body") or "",
                "prerelease": rel.get("prerelease", False),
            })
        return {"releases": releases, "error": None, "from_cache": False}
    return {"releases": [], "error": None, "from_cache": False}


def _fetch_github_commits(owner: str, repo: str, branch: str = "main") -> dict:
    """从 GitHub API 获取最近 commit 记录（带 ETag 缓存）。"""
    url = f"https://api.github.com/repos/{owner}/{repo}/commits?per_page=10&sha={branch}"
    data, error, from_cache = _github_api_request(url, _SD_ETAG_COMMITS)

    if from_cache:
        return {"commits": [], "error": None, "from_cache": True}

    if error:
        return {"commits": [], "error": error, "from_cache": False}

    if isinstance(data, list):
        commits = []
        for c in data[:10]:
            commit = c.get("commit", {})
            commits.append({
                "sha": c.get("sha", "")[:8],
                "message": (commit.get("message", "") or "").split("\n")[0][:120],
                "author": (commit.get("author", {}) or {}).get("name", ""),
                "date": (commit.get("commit", {}) or {}).get("author", {}).get("date", ""),
                "html_url": c.get("html_url", ""),
            })
        return {"commits": commits, "error": None, "from_cache": False}
    return {"commits": [], "error": None, "from_cache": False}


def _fetch_github_main_head(owner: str, repo: str, branch: str = "main") -> dict:
    """从 GitHub API 获取 main 分支最新 commit 信息（带 ETag 缓存）。"""
    url = f"https://api.github.com/repos/{owner}/{repo}/branches/{branch}"
    data, error, from_cache = _github_api_request(url, _SD_ETAG_MAIN)

    if from_cache:
        return {"sha": None, "error": None, "from_cache": True}

    if error:
        return {"sha": None, "error": error, "from_cache": False}

    if isinstance(data, dict):
        commit = data.get("commit", {})
        sha = commit.get("sha", "")
        return {
            "sha": sha[:8] if sha else None,
            "full_sha": sha,
            "message": ((commit.get("commit", {}) or {}).get("message", "") or "").split("\n")[0][:120],
            "date": (commit.get("commit", {}) or {}).get("author", {}).get("date", ""),
            "html_url": f"https://github.com/{owner}/{repo}/commit/{sha}" if sha else "",
            "error": None,
            "from_cache": False,
        }
    return {"sha": None, "error": None, "from_cache": False}


@router.get("/sd-scripts/status")
async def sd_scripts_status() -> dict:
    """返回 sd-scripts 训练核心的状态信息。
    
    策略：缓存优先，静默降级。
    - 磁盘缓存有效 → 直接返回，不请求 API
    - 缓存过期 → 尝试 API（ETag 条件请求，304 不消耗限流）
    - API 失败/限流 → 静默使用过期缓存，不报错
    - 首次无缓存 → 返回本地信息 + 空的上游数据（不调用 API，等下次）
    """
    global _sd_scripts_cache
    import time as _time
    now = _time.time()

    # 内存缓存
    cached = _sd_scripts_cache
    if cached and (now - cached.get("ts", 0)) < _SD_MEM_CACHE_TTL:
        return cached.get("data", {})

    info = _read_sd_scripts_version()
    owner, repo_name = info["repo"].split("/") if "/" in info["repo"] else ("kohya-ss", "sd-scripts")
    branch = info.get("local_branch") or "main"

    # 1. 先尝试磁盘缓存
    disk_cache = _load_sd_disk_cache()
    if disk_cache:
        # 磁盘缓存有效，直接返回（不调用 API）
        disk_cache["local"] = info  # 本地信息始终用最新
        _sd_scripts_cache = {"data": disk_cache, "ts": now}
        return disk_cache

    # 2. 磁盘缓存不存在或过期 → 尝试 GitHub API
    releases_data = _fetch_github_releases(owner, repo_name)
    commits_data = _fetch_github_commits(owner, repo_name, branch)
    main_head_data = _fetch_github_main_head(owner, repo_name, branch)

    # 3. 判断 API 结果
    any_success = (
        (releases_data.get("releases") and not releases_data.get("error"))
        or (commits_data.get("commits") and not commits_data.get("error"))
    )

    if any_success:
        # API 成功 → 构建数据并保存缓存
        latest_release = releases_data["releases"][0] if releases_data["releases"] else None
        latest_main_commit = main_head_data if main_head_data.get("sha") and not main_head_data.get("error") else None

        data = {
            "local": info,
            "latest_release": latest_release,
            "latest_main_commit": latest_main_commit,
            "recent_releases": releases_data["releases"],
            "recent_commits": commits_data["commits"],
            "update_available": bool(latest_release and info.get("local_commit")),
            "latest_tag": latest_release["tag_name"] if latest_release else None,
            "using_disk_cache": False,
        }
        _save_sd_disk_cache(data)
    else:
        # API 完全失败 → 返回仅包含本地信息的数据
        data = {
            "local": info,
            "latest_release": None,
            "latest_main_commit": None,
            "recent_releases": [],
            "recent_commits": [],
            "update_available": False,
            "latest_tag": info.get("tag"),
            "using_disk_cache": False,
        }

    _sd_scripts_cache = {"data": data, "ts": now}
    return data


def _perform_sd_scripts_update(target: str, log_f):
    """后台任务：更新 vendor/sd-scripts 到指定的上游版本。
    target: "release" 拉取最新 release tag；"main" 拉取 main 分支 HEAD。
    
    鲁棒性：
    - 如果 vendor/sd-scripts/.git 存在（独立 git 仓库）→ git fetch + checkout
    - 否则 → 克隆到临时目录 + 替换文件
    """
    import subprocess as _sp
    import tempfile as _tmp
    import shutil as _shutil

    root = Path(__file__).parents[2]
    vendor_sd = root / "vendor" / "sd-scripts"
    track_file = root / "vendor" / ".sd-scripts-version"
    info = _read_sd_scripts_version()
    owner, repo_name = info["repo"].split("/") if "/" in info["repo"] else ("kohya-ss", "sd-scripts")
    repo_url = f"https://github.com/{owner}/{repo_name}.git"

    log_f.write(f"[INFO] 开始更新 sd-scripts，目标: {target}\n")
    log_f.write(f"[INFO] 版本来源: {info.get('version_source', 'unknown')}\n")
    log_f.flush()

    # 1. 确定目标引用
    if target == "release":
        releases_data = _fetch_github_releases(owner, repo_name)
        if releases_data["error"] or not releases_data["releases"]:
            log_f.write(f"[ERROR] 无法获取最新 release: {releases_data['error']}\n")
            log_f.flush()
            return -1
        latest = releases_data["releases"][0]
        ref = latest["tag_name"]
        log_f.write(f"[INFO] 目标 release: {ref}\n")
    elif target == "main":
        ref = "main"
        log_f.write(f"[INFO] 目标分支: {ref}\n")
    else:
        log_f.write(f"[ERROR] 未知目标: {target}\n")
        log_f.flush()
        return -1

    # 2. 判断是否为独立 git 仓库
    is_git_repo = (vendor_sd / ".git").exists()
    new_commit = None
    new_date = None

    if is_git_repo:
        # 鲁棒路径：vendor/sd-scripts 是独立 git 仓库 → git fetch + checkout
        log_f.write(f"[INFO] 检测到独立 git 仓库，使用 git fetch + checkout\n")
        log_f.flush()
        try:
            # 确保 remote origin 指向正确的上游
            _sp.run(
                ["git", "-C", str(vendor_sd), "remote", "set-url", "origin", repo_url],
                capture_output=True, text=True, timeout=10,
            )
            # fetch 目标引用
            fetch_result = _sp.run(
                ["git", "-C", str(vendor_sd), "fetch", "--depth", "1", "origin", f"{ref}:refs/remotes/origin/{ref}"],
                capture_output=True, text=True, timeout=60,
            )
            if fetch_result.returncode != 0:
                log_f.write(f"[ERROR] git fetch 失败: {fetch_result.stderr}\n")
                log_f.flush()
                return -1
            # checkout 到目标
            co_result = _sp.run(
                ["git", "-C", str(vendor_sd), "checkout", f"origin/{ref}"],
                capture_output=True, text=True, timeout=30,
            )
            if co_result.returncode != 0:
                log_f.write(f"[ERROR] git checkout 失败: {co_result.stderr}\n")
                log_f.flush()
                return -1
            log_f.write(f"[INFO] git checkout 完成\n")
            log_f.flush()

            # 获取新 commit
            r = _sp.run(
                ["git", "-C", str(vendor_sd), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
            new_commit = r.stdout.strip() if r.returncode == 0 else None
            r = _sp.run(
                ["git", "-C", str(vendor_sd), "log", "-1", "--format=%ci"],
                capture_output=True, text=True, timeout=10,
            )
            new_date = r.stdout.strip() if r.returncode == 0 else None
        except Exception as e:
            log_f.write(f"[ERROR] git 操作失败: {e}\n")
            log_f.flush()
            return -1
    else:
        # 文件替换路径：克隆到临时目录
        tmp_dir = _tmp.mkdtemp(prefix="sd_scripts_update_")
        log_f.write(f"[INFO] 克隆 {repo_url} (ref={ref})...\n")
        log_f.flush()
        try:
            result = _sp.run(
                ["git", "clone", "--depth", "1", "--branch", ref, repo_url, tmp_dir],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                log_f.write(f"[ERROR] git clone 失败: {result.stderr}\n")
                log_f.flush()
                return -1
            log_f.write(f"[INFO] 克隆完成\n")
            log_f.flush()

            r_commit = _sp.run(
                ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=tmp_dir, timeout=10
            )
            new_commit = r_commit.stdout.strip() if r_commit.returncode == 0 else None
            r_date = _sp.run(
                ["git", "log", "-1", "--format=%ci"], capture_output=True, text=True, cwd=tmp_dir, timeout=10
            )
            new_date = r_date.stdout.strip() if r_date.returncode == 0 else None

            log_f.write(f"[INFO] 清理旧文件...\n")
            log_f.flush()
            for item in vendor_sd.iterdir():
                if item.is_dir():
                    _shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)

            log_f.write(f"[INFO] 复制新文件...\n")
            log_f.flush()
            for item in Path(tmp_dir).iterdir():
                if item.name == ".git":
                    continue
                dest = vendor_sd / item.name
                if item.is_dir():
                    _shutil.copytree(item, dest)
                else:
                    _shutil.copy2(item, dest)
        finally:
            _shutil.rmtree(tmp_dir, ignore_errors=True)

    log_f.write(f"[INFO] 新 commit: {new_commit}\n")
    log_f.flush()

    # 3. 更新跟踪文件
    import datetime as _dt
    now_str = _dt.datetime.now().isoformat()
    short_commit = new_commit[:8] if new_commit else "UNKNOWN"
    tag_str = ref if target == "release" else ""
    new_track = (
        f"# Upstream Version Tracking\n"
        f"# Auto-updated by Web UI\n"
        f"\n"
        f"[upstream]\n"
        f"repo = \"{owner}/{repo_name}\"\n"
        f"branch = \"main\"\n"
        f"commit = \"{new_commit or 'UNKNOWN'}\"\n"
        f"sync_date = \"{new_date or now_str}\"\n"
    )
    if tag_str:
        new_track += f"tag = \"{tag_str}\"\n"
    new_track += f"last_check = \"{now_str[:10]}\"\n"
    new_track += (
        f"\n"
        f"[local]\n"
        f"additions = []\n"
        f"modifications = []\n"
    )
    track_file.write_text(new_track, encoding="utf-8")
    log_f.write(f"[INFO] 跟踪文件已更新\n")

    log_f.write(f"[SUCCESS] sd-scripts 已更新到 {ref} (commit: {short_commit})\n")
    log_f.flush()
    return 0


@router.post("/sd-scripts/update")
async def sd_scripts_update(request: Request) -> dict:
    """更新 vendor/sd-scripts 到上游最新版本。
    body: {"target": "release"} 或 {"target": "main"}
    后台执行，通过 /api/install-log/{job_id} 轮询进度。
    """
    try:
        body = await request.json()
        target = body.get("target", "release")
    except Exception:
        target = "release"

    if target not in ("release", "main"):
        return {"success": False, "error": f"Invalid target: {target}. Use 'release' or 'main'."}

    import tempfile as _tmp
    log_f = _tmp.NamedTemporaryFile(
        delete=False, suffix=".log", prefix="anima_sd_update_",
        mode="w", encoding="utf-8",
    )
    log_path = log_f.name
    job_id = _install_uuid().hex[:12]
    _install_jobs[job_id] = {
        "log_path": log_path, "done": False,
        "start": _install_time.time(), "returncode": None,
    }

    def _run():
        try:
            rc = _perform_sd_scripts_update(target, log_f)
            _install_jobs[job_id]["returncode"] = rc
        except Exception as e:
            log_f.write(f"\n[ERROR] {e}\n")
            _install_jobs[job_id]["returncode"] = -1
        finally:
            _install_jobs[job_id]["done"] = True
            log_f.close()

    _install_thr.Thread(target=_run, daemon=True).start()
    return {"success": True, "job_id": job_id, "message": f"sd-scripts update to {target} started / 更新已启动"}
