import asyncio
import os
import re
import time as _time

from pathlib import Path


from fastapi import APIRouter, Request

from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR, VENDOR_ROOT, TOOLS_DIR
from backend import launch_utils
from backend.server.config import app_config
from backend.server.models import (APIResponse, APIResponseFail,
                                 APIResponseSuccess, PresetSaveRequest,
                                 TaggerInterrogateRequest)
from backend.server.state import avaliable_presets, load_presets
from backend.log import log
from backend.tagger.interrogator import (available_interrogators,
                                          on_interrogate,
                                          cancel_tagger_task)
from backend.tasks import tm
from backend.utils import train_utils
from backend.utils.devices import printable_devices
from backend.utils.tk_window import (open_directory_selector,
                                      open_file_selector)

router = APIRouter()


_git_version_cache: str | None = None


def _git_version() -> str:
    global _git_version_cache
    if _git_version_cache is not None:
        return _git_version_cache
    try:
        import subprocess
        r = subprocess.run(["git", "describe", "--tags", "--always"],
                          capture_output=True, text=True,
                          cwd=str(REPO_ROOT))
        _git_version_cache = r.stdout.strip() or "dev"
        return _git_version_cache
    except Exception:
        return "dev"


@router.get("/health")
async def health_check():
    """Lightweight connectivity check — returns OK immediately."""
    return {"status": "ok"}


@router.get("/version")
async def get_version():
    version = await asyncio.to_thread(_git_version)
    return APIResponseSuccess(data={"version": version})


@router.get("/fields")
async def get_fields():
    """返回训练字段定义（前端表单渲染 + 后端白名单共用同一数据源）"""
    from backend.training.field_registry import get_fields_json
    return APIResponseSuccess(data=get_fields_json())


@router.post("/interrogate")
async def run_interrogate(req: TaggerInterrogateRequest):
    import uuid
    from backend.tagger.interrogator import get_tagger_progress
    task_id = str(uuid.uuid4())[:8]
    interrogator = available_interrogators.get(req.interrogator_model, available_interrogators["wd-eva02-large-tagger-v3"])
    # 使用独立线程执行，避免阻塞 FastAPI 事件循环
    asyncio.create_task(asyncio.to_thread(
        on_interrogate,
        task_id=task_id,
        image=None,
        batch_input_glob=req.path,
        batch_input_recursive=req.batch_input_recursive,
        batch_output_dir=req.batch_output_dir,
        batch_output_filename_format="[name].[output_extension]",
        batch_output_action_on_conflict=req.batch_output_action_on_conflict,
        batch_remove_duplicated_tag=req.batch_remove_duplicated_tag,
        batch_output_save_json=req.batch_output_save_json,
        interrogator=interrogator,
        threshold=req.threshold,
        character_threshold=req.character_threshold,
        category_thresholds=req.category_thresholds,
        add_rating_tag=req.add_rating_tag,
        add_model_tag=req.add_model_tag,
        additional_tags=req.additional_tags,
        exclude_tags=req.exclude_tags,
        sort_by_alphabetical_order=req.sort_by_alphabetical_order,
        add_confident_as_weight=req.add_confident_as_weight,
        replace_underscore=req.replace_underscore,
        replace_underscore_excludes=req.replace_underscore_excludes,
        escape_tag=req.escape_tag,
        unload_model_after_running=True
    ))
    return APIResponseSuccess(data={"task_id": task_id})


@router.get("/interrogate/progress")
async def tagger_progress(task_id: str):
    """Poll tagger task progress."""
    from backend.tagger.interrogator import get_tagger_progress
    return APIResponseSuccess(data=get_tagger_progress(task_id))


@router.post("/interrogate/stop")
async def stop_interrogate(task_id: str):
    """Cancel a running tagger task."""
    if cancel_tagger_task(task_id):
        return APIResponseSuccess(data={"message": "Task cancelled"})
    return APIResponseFail(message="Task not found")


# 模型 ID → 用户友好显示名称
_MODEL_DISPLAY_NAMES = {
    'wd-eva02-large-tagger-v3': 'WD EVA02 Large v3',
    'wd-vit-large-tagger-v3':  'WD ViT Large v3',
    'cl_tagger_1_02':          'CL Tagger v1.02',
    'camie-tagger-v2':         'Camie Tagger v2',
}


@router.get("/tagger/models")
async def list_tagger_models():
    """List available tagger/interrogator models."""
    models = []
    for key in available_interrogators:
        models.append({
            "id": key,
            "name": _MODEL_DISPLAY_NAMES.get(key, key),
        })
    return APIResponseSuccess(data=models)


@router.get("/pick_file")
async def pick_file(picker_type: str):
    if picker_type == "folder":
        coro = asyncio.to_thread(open_directory_selector, "")
    elif picker_type == "model-file":
        file_types = [("checkpoints", "*.safetensors;*.ckpt;*.pt"), ("all files", "*.*")]
        coro = asyncio.to_thread(open_file_selector, "", "Select file", file_types)
    else:
        return APIResponseFail(message=f"Invalid picker_type: {picker_type}")

    result = await coro
    if result == "":
        return APIResponseFail(message="User cancelled / 用户取消")

    return APIResponseSuccess(data={
        "path": result
    })


_files_cache: dict[str, tuple[float, list[dict]]] = {}
_FILES_CACHE_TTL = 60


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    now = _time.time()
    cached = _files_cache.get(pick_type)
    if cached and now - cached[0] < _FILES_CACHE_TTL:
        return APIResponseSuccess(data={"files": cached[1]})

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

        if not path.exists():
            return result_list

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

    dirs = await asyncio.to_thread(list_path_or_files, pick_preset[pick_type])
    _files_cache[pick_type] = (now, dirs)
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
_install_jobs_lock = _install_thr.Lock()

def _cleanup_install_jobs():
    """Remove completed install jobs older than 10 minutes."""
    now = time.time()
    with _install_jobs_lock:
        expired = [jid for jid, job in _install_jobs.items()
                   if job.get("done") and now - job.get("start", 0) > 600]
        for jid in expired:
            jpath = _install_jobs[jid].get("log_path")
            if jpath:
                try:
                    os.unlink(jpath)
                except Exception:
                    pass
            del _install_jobs[jid]


def _start_install_job(cmd: list[str], max_retries: int = 2) -> str:
    """启动后台 pip install，输出写入临时日志文件。失败时自动重试（指数退避）。返回 job_id。"""
    job_id = _install_uuid().hex[:12]
    log_f = _install_tmp.NamedTemporaryFile(
        delete=False, suffix=".log", prefix="anima_install_",
        mode="w", encoding="utf-8",
    )
    log_path = log_f.name
    with _install_jobs_lock:
        _install_jobs[job_id] = {
            "log_path": log_path, "done": False,
            "start": _install_time.time(), "returncode": None,
        }

    def _run():
        for attempt in range(max_retries + 1):
            try:
                if attempt > 0:
                    log_f.write(f"\n[RETRY] Attempt {attempt + 1}/{max_retries + 1}...\n")
                    log_f.flush()
                proc = _install_sp.Popen(
                    cmd, stdout=log_f, stderr=_install_sp.STDOUT, text=True,
                )
                proc.wait()
                if proc.returncode == 0:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = 0
                    break
                if attempt < max_retries:
                    wait_sec = 2 ** attempt
                    log_f.write(f"\n[RETRY] Failed with code {proc.returncode}, retrying in {wait_sec}s...\n")
                    log_f.flush()
                    _install_time.sleep(wait_sec)
                else:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = proc.returncode
            except Exception as e:
                log_f.write(f"\n[ERROR] {e}\n")
                log_f.flush()
                if attempt < max_retries:
                    _install_time.sleep(2 ** attempt)
                else:
                    with _install_jobs_lock:
                        _install_jobs[job_id]["returncode"] = -1
        with _install_jobs_lock:
            _install_jobs[job_id]["done"] = True
        log_f.close()

    _install_thr.Thread(target=_run, daemon=True).start()
    return job_id


@router.get("/install-log/{job_id}")
async def install_log(job_id: str, tail: int = 20) -> dict:
    """轮询安装进度。返回最新日志行 + 完成状态。"""
    _cleanup_install_jobs()
    import time
    with _install_jobs_lock:
        job = _install_jobs.get(job_id)
        # 拷贝 dict 避免在锁外持有引用
        if job:
            job = dict(job)
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
_fa_cache_lock = _install_thr.Lock()
_FA_CACHE_TTL = 300  # 5 分钟，避免频繁请求 GitHub API 触发限流


def _import_flash_attn_tool():
    """延迟导入 tools/install_flash_attn.py，避免启动时拖慢 import。"""
    import importlib.util
    import sys
    _root = REPO_ROOT
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

        # 线程安全地读取缓存
        with _fa_cache_lock:
            cached = _fa_cache.get(cache_key)
            cache_expired = cached is None or (now - cached.get("ts", 0)) > _FA_CACHE_TTL

        if cache_expired:
            candidates, fetch_error = fetch_candidates(env)
            from_disk = False
            # 检测是否来自磁盘缓存（fetch_error 中包含 "回退磁盘缓存" 字样）
            if fetch_error and "回退磁盘缓存" in str(fetch_error):
                from_disk = True
            slim = [
                {"url": c["url"], "name": c["name"], "notes": c.get("notes", c["notes"]) if isinstance(c, dict) else [], "usable": c["usable"]}
                for c in candidates[:20]
            ]
            # 线程安全地写入缓存
            with _fa_cache_lock:
                _fa_cache[cache_key] = {
                    "candidates": slim, "fetch_error": fetch_error,
                    "from_disk": from_disk, "ts": now
                }

        with _fa_cache_lock:
            c = _fa_cache[cache_key].copy()
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
#  sd-scripts 本地版本信息 API
# ═══════════════════════════════════════════════════════════


_sd_scripts_version_cache: dict | None = None


def _read_sd_scripts_version() -> dict:
    """读取 vendor/sd-scripts 的本地版本信息。
    
    三层检测策略（按优先级）：
    1. 独立 Git 仓库（有人 git clone 了上游）→ git describe
    2. 跟踪文件 vendor/.sd-scripts-version → 读记录
    3. 代码特征推断 → 检查 setup.py / library 等
    4. 都失败 → 标记为 unknown
    
    返回 dict 含 version_source 字段标识数据来源。
    """
    global _sd_scripts_version_cache
    if _sd_scripts_version_cache is not None:
        return _sd_scripts_version_cache

    root = REPO_ROOT
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

        _sd_scripts_version_cache = info
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
            _sd_scripts_version_cache = info
            return info
        except Exception:
            pass

    # ── 第3层：代码特征推断 ────────────────────────────
    # 尝试从 setup.py 或特征文件推断
    if sd_root.is_dir():
        setup_py = sd_root / "setup.py"
        if setup_py.exists():
            info["version_source"] = "inferred"

    _sd_scripts_version_cache = info
    return info


@router.get("/sd-scripts/status")
async def sd_scripts_status() -> dict:
    """返回 sd-scripts 训练核心的本地版本信息（仅本地，不查询上游）。"""
    info = await asyncio.to_thread(_read_sd_scripts_version)
    owner, repo_name = info["repo"].split("/") if "/" in info["repo"] else ("kohya-ss", "sd-scripts")
    return {
        "local": info,
        "repo_url": f"https://github.com/{owner}/{repo_name}",
    }
