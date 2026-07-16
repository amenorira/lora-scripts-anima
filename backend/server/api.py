import asyncio
import concurrent.futures
import os
import re
import shutil
import threading
import time as _time

from pathlib import Path


from io import BytesIO

from fastapi import APIRouter, File, Form, Request, UploadFile

from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR, SD_MODELS_DIR, VENDOR_ROOT, TOOLS_DIR
from backend import launch_utils
from backend.server.config import app_config
from backend.server.models import (APIResponse, APIResponseFail,
                                 APIResponseSuccess, PresetSaveRequest,
                                 TaggerInterrogateRequest)
from backend.server.state import avaliable_presets, load_presets
from backend.log import log
from PIL import Image, UnidentifiedImageError

from backend.tagger.interrogator import (available_interrogators,
                                          on_interrogate,
                                          cancel_tagger_task)
from backend.tagger.interrogators.base import CATEGORY_LABELS
from backend.tasks import tm
from backend.utils import train_utils
from backend.utils.devices import printable_devices
from backend.utils.tk_window import (is_available as tk_is_available,
                                      open_directory_selector,
                                      open_file_selector)

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
        r = launch_utils.run_capture_text(
            ["git", "describe", "--tags", "--always"],
            cwd=str(REPO_ROOT),
        )
        _git_version_cache = r.stdout.strip() or "dev"
        return _git_version_cache
    except Exception:
        return "dev"


@router.get("/health")
async def health_check():
    """Lightweight connectivity check — returns OK + training active flag."""
    from backend.tasks import tm
    tasks = tm.dump()
    active_task = next((t for t in tasks if t.get("status") == "RUNNING"), None)
    return {
        "status": "ok",
        "training_active": active_task is not None,
        "task_id": active_task["id"] if active_task else None,
    }


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
    if not tk_is_available():
        return APIResponseFail(message="unavailable")
    if picker_type == "folder":
        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, open_directory_selector, "")
    elif picker_type == "model-file":
        file_types = [("checkpoints", "*.safetensors;*.ckpt;*.pt"), ("all files", "*.*")]

        def _pick():
            return open_file_selector("", "Select file", file_types)
        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, _pick)
    else:
        return APIResponseFail(message=f"Invalid picker_type: {picker_type}")

    result = await coro
    if result == "":
        return APIResponseFail(message="cancelled")

    return APIResponseSuccess(data={
        "path": result
    })


_files_cache: dict[str, tuple[float, list[dict]]] = {}
_files_cache_lock = threading.Lock()
_FILES_CACHE_TTL = 60


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    now = _time.time()
    with _files_cache_lock:
        cached = _files_cache.get(pick_type)
        if cached and now - cached[0] < _FILES_CACHE_TTL:
            return APIResponseSuccess(data={"files": cached[1]})

    pick_preset = {
        "model-file": {
            "type": "file",
            "path": "./models",
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
    with _files_cache_lock:
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
    now = _install_time.time()
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
        "elapsed": _install_time.time() - job.get("start", 0),
    }


# ═══════════════════════════════════════════════════════════
#  Anima 模型下载 API（环境管理页）
#
#  与 _install_jobs 平行但独立：模型下载走 Python 线程 + HF Hub
#  进度回调（非子进程），需要结构化百分比/速度，不能套用 pip log。
# ═══════════════════════════════════════════════════════════

_download_jobs: dict[str, dict] = {}
_download_jobs_lock = _install_thr.Lock()


def _cleanup_download_jobs():
    """清理 10 分钟前完成的下载任务。"""
    now = _install_time.time()
    with _download_jobs_lock:
        for jid in [k for k, v in _download_jobs.items()
                    if v.get("done") and now - v.get("start", 0) > 600]:
            del _download_jobs[jid]


def _start_download_job(only_file: str | None = None) -> str:
    """启动 Anima 模型下载后台线程，返回 job_id。

    only_file: 若指定，只下载该文件名（用于失败后单文件重试）。
    """
    from tools.download_anima_model import ANIMA_FILES, download_anima_files

    # 选择文件清单
    if only_file:
        files = [(h, l, d) for h, l, d in ANIMA_FILES if l == only_file or h == only_file]
        if not files:
            raise RuntimeError(f"未知文件: {only_file}")
    else:
        files = ANIMA_FILES

    job_id = _install_uuid().hex[:12]
    shared_progress: dict = {}
    log_lines: list[str] = []  # 简短环形缓冲，前端轮询时一并返回

    with _download_jobs_lock:
        _download_jobs[job_id] = {
            "start": _install_time.time(),
            "done": False,
            "progress": shared_progress,   # 线程内原地更新
            "log": log_lines,
            "only_file": only_file,
        }

    def _run():
        from backend.utils.hf_download import make_progress_bar
        try:
            from backend.log import console as _rich_console
        except Exception:
            _rich_console = None
        progress_bar = make_progress_bar(console=_rich_console)
        # task_id 由 on_progress 在首次拿到 filename/total 时惰性创建
        state = {"task_id": None}

        def _on_log(msg: str):
            # 事件日志：滚动保留最近 50 行 + 打到服务器控制台（换行）
            log_lines.append(msg)
            if len(log_lines) > 50:
                del log_lines[: len(log_lines) - 50]
            try:
                log.info(f"[anima-dl] {msg}")
            except Exception:
                pass

        def _on_progress(line: str):
            try:
                with _download_jobs_lock:
                    p = dict(shared_progress)
                fn = p.get("filename") or "?"
                total = int(p.get("total") or 0)
                done = int(p.get("downloaded") or 0)
                speed = float(p.get("speed") or 0.0)
                if state["task_id"] is None:
                    state["task_id"] = progress_bar.add_task(fn, total=total or None, completed=done)
                else:
                    progress_bar.update(state["task_id"], description=fn,
                                        total=total or None, completed=done)
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
            if only_file:
                ok = any(p != Path(".") for p in paths)
            else:
                ok = all(p != Path(".") for p in paths)
            with _download_jobs_lock:
                _download_jobs[job_id]["done"] = True
                _download_jobs[job_id]["success"] = ok
                shared_progress.setdefault("phase", "done" if ok else "error")
        except Exception as e:
            log_lines.append(f"[ERROR] {e}")
            with _download_jobs_lock:
                shared_progress.update({"phase": "error", "error": str(e)})
                _download_jobs[job_id]["done"] = True
                _download_jobs[job_id]["success"] = False
        finally:
            try:
                progress_bar.stop()
            except Exception:
                pass
            # rich Progress.stop() 不保证换行，光标可能停在进度条行尾
            try:
                import sys as _sys
                _sys.stderr.write("\n")
                _sys.stderr.flush()
            except Exception:
                pass

    _install_thr.Thread(target=_run, daemon=True).start()
    return job_id


@router.get("/anima-model/status")
async def anima_model_status() -> dict:
    """扫描 models/ 目录，返回 Anima 各核心文件已下载/未下载状态。

    附带 dest_dir / 每文件 dest_path（相对仓库根，如 models/xxx.safetensors），
    供前端显示"下载到哪里"的说明。
    """
    _cleanup_download_jobs()
    from tools.download_anima_model import list_local_anima_files
    files = await asyncio.to_thread(list_local_anima_files, SD_MODELS_DIR)
    # SD_MODELS_DIR 相对仓库根的路径（如 "models"），用于前端展示目标目录
    try:
        dest_dir_rel = SD_MODELS_DIR.relative_to(REPO_ROOT).as_posix() + "/"
    except ValueError:
        dest_dir_rel = "models/"
    for f in files:
        f["dest_path"] = dest_dir_rel + f.get("filename", "")
    return {"files": files, "dest_dir": dest_dir_rel}


@router.post("/anima-model/download")
async def anima_model_download(request: Request) -> dict:
    """启动后台模型下载。body 可选 {'file': '<filename>'} 仅下载单个文件。返回 job_id。"""
    only_file = None
    try:
        body = await request.json()
        only_file = body.get("file") or None
    except Exception:
        pass
    # 已有任务进行中则拒绝
    with _download_jobs_lock:
        running = [j for j, v in _download_jobs.items() if not v.get("done")]
    if running:
        return {"success": False, "message": "已有下载任务进行中 / A download is already running"}
    try:
        job_id = await asyncio.to_thread(_start_download_job, only_file)
    except Exception as e:
        return {"success": False, "message": str(e)}
    return {"success": True, "job_id": job_id}


@router.get("/anima-model/progress/{job_id}")
async def anima_model_progress(job_id: str) -> dict:
    """轮询下载进度。返回结构化 progress + 文本 log + done 标志。"""
    _cleanup_download_jobs()
    with _download_jobs_lock:
        job = _download_jobs.get(job_id)
        if job:
            job = {
                "progress": dict(job.get("progress", {})),
                "log": list(job.get("log", [])),
                "done": job.get("done", False),
                "success": job.get("success"),
                "elapsed": _install_time.time() - job.get("start", 0),
            }
    if not job:
        return {"done": True, "progress": {"phase": "error", "error": "Job not found / 任务不存在"}, "log": []}
    return job


# ═══════════════════════════════════════════════════════════
#  Flash Attention 环境管理 API
# ═══════════════════════════════════════════════════════════

_fa_cache: dict[str, dict] = {}  # key: source name → {candidates, fetch_error, from_disk, ts}
_fa_cache_lock = _install_thr.Lock()
_FA_CACHE_TTL = 300  # 5 分钟，避免频繁请求 GitHub API 触发限流

# 环境检测（torch import + nvidia-smi subprocess）较慢且会话内基本不变，做 TTL 缓存。
# 避免每次进入环境管理页都重复跑 nvidia-smi（最长 10s 超时）。
_fa_env_cache: dict | None = None
_fa_env_cache_ts: float = 0.0
_FA_ENV_CACHE_TTL = 600.0  # 10 分钟

# 缓存 install_flash_attn 工具模块的导出函数，避免每次调用都重新 exec_module。
_fa_tool_funcs: tuple | None = None
_fa_tool_lock = _install_thr.Lock()


def _import_flash_attn_tool():
    """延迟导入 tools/install_flash_attn.py，避免启动时拖慢 import。结果缓存。"""
    global _fa_tool_funcs
    with _fa_tool_lock:
        if _fa_tool_funcs is not None:
            return _fa_tool_funcs
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
        _fa_tool_funcs = (
            mod.detect_env, mod.current_status, mod.fetch_candidates,
            mod.install_wheel, mod.proxy_download_url, mod.download_urls_for,
        )
        return _fa_tool_funcs


# ═══════════════════════════════════════════════════════════
#  Flash Attention "下载+安装" 结构化进度任务
#
#  与 Anima 的 _download_jobs 平行：FA 先预下载 wheel 到临时文件（多分块/续传/速度），
#  再 pip install 本地文件。下载阶段给前端真实百分比/速度（旧方案 pip 非 TTY 不输出实时
#  进度的根因修复），安装阶段为短 spinner + 逐行捕获 pip 输出。
# ═══════════════════════════════════════════════════════════

_fa_jobs: dict[str, dict] = {}
_fa_jobs_lock = _install_thr.Lock()


def _cleanup_fa_jobs():
    """清理 10 分钟前完成的 FA 安装任务。"""
    now = _install_time.time()
    with _fa_jobs_lock:
        for jid in [k for k, v in _fa_jobs.items()
                    if v.get("done") and now - v.get("start", 0) > 600]:
            del _fa_jobs[jid]


def _start_fa_job(download_urls: list[str], wheel_name: str, source: str) -> str:
    """启动 FA 安装后台线程：预下载 wheel → pip install 本地文件。返回 job_id。

    progress dict 写入 stage（downloading/installing/done/error）+ 下载阶段的结构化
    百分比/速度/大小；安装阶段把 pip stdout 逐行写入 log_lines。
    临时 wheel 在 finally 删除，绝不残留。
    """
    from backend.utils.hf_download import download_url_with_fallback, cleanup_temp

    job_id = _install_uuid().hex[:12]
    shared_progress: dict = {"stage": "downloading", "filename": wheel_name}
    log_lines: list[str] = []

    with _fa_jobs_lock:
        _fa_jobs[job_id] = {
            "start": _install_time.time(),
            "done": False,
            "progress": shared_progress,
            "log": log_lines,
            "source": source,
            "wheel_name": wheel_name,
        }

    def _run():
        import sys
        tmp_dir: str | None = None
        try:
            # ── 下载阶段：预下载 wheel 到临时目录（用真实 wheel 文件名落盘）──
            # 用真实文件名而非 mkstemp 的随机名：pip 会校验 wheel 文件名格式
            # ({name}-{ver}-{pythontag}-{abitag}-{platformtag}.whl)，随机名会被
            # pip 拒绝（"Invalid wheel filename"）。下载引擎的 .partN/.partial
            # 也落在这个临时目录里，finally 用 rmtree 一并清理。
            log_lines.append(f"[DOWNLOAD] {wheel_name}  ({len(download_urls)} 源候选 / source(s))")
            tmp_dir = _install_tmp.mkdtemp(prefix="anima_fa_")
            dest = Path(tmp_dir) / wheel_name

            # 控制台 rich 进度条（与 Anima 同款）：_on_progress 把结构化 progress 驱到 rich，
            # 否则控制台下载阶段只有"[DOWNLOAD]"事件行，长时间无进度反馈。进度也写入
            # shared_progress 供前端轮询，这里只是把同样的数据额外渲染到服务器控制台。
            from backend.utils.hf_download import make_progress_bar
            try:
                from backend.log import console as _rich_console
            except Exception:
                _rich_console = None
            progress_bar = make_progress_bar(console=_rich_console)
            state = {"task_id": None}

            def _on_log(msg: str):
                log_lines.append(msg)
                try:
                    log.info(f"[fa-install] {msg}")
                except Exception:
                    pass

            def _on_progress(_line: str):
                # 轮询 shared_progress 里的结构化字段驱动 rich 进度条
                try:
                    with _fa_jobs_lock:
                        p = dict(shared_progress)
                    fn = p.get("filename") or wheel_name
                    total = int(p.get("total") or 0)
                    done = int(p.get("downloaded") or 0)
                    speed = float(p.get("speed") or 0.0)
                    if state["task_id"] is None:
                        state["task_id"] = progress_bar.add_task(fn, total=total or None, completed=done)
                    else:
                        progress_bar.update(state["task_id"], description=fn,
                                            total=total or None, completed=done)
                        if speed:
                            progress_bar.tasks[state["task_id"]].speed = speed
                except Exception:
                    pass

            progress_bar.start()
            download_url_with_fallback(
                download_urls, dest,
                progress=shared_progress, lock=_fa_jobs_lock,
                on_log=_on_log, on_progress=_on_progress,
                file_index=0, file_total=1, label=wheel_name,
            )
            dl_size = dest.stat().st_size
            log_lines.append(f"[DOWNLOAD] 完成 / Done ({dl_size / (1024**2):.1f} MB)")

            # ── 安装阶段：pip install 本地文件 ──
            with _fa_jobs_lock:
                shared_progress.update({"stage": "installing", "filename": wheel_name,
                                        "downloaded": dl_size, "total": dl_size, "speed": 0.0})
            log_lines.append(f"[INSTALL] pip install {dest.name}  (本地文件，约 10-30s)")

            proc = _install_sp.Popen(
                [sys.executable, "-m", "pip", "install", "--retries", "3", "--timeout", "60",
                 str(dest)],
                stdout=_install_sp.PIPE, stderr=_install_sp.STDOUT, text=True,
                encoding="utf-8", errors="replace",
            )
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    log_lines.append(line)
            proc.wait()

            if proc.returncode == 0:
                with _fa_jobs_lock:
                    shared_progress.update({"stage": "done", "filename": wheel_name,
                                            "downloaded": dl_size, "total": dl_size, "speed": 0.0})
                log_lines.append("[INSTALL] 安装成功 / Successfully installed")
                with _fa_jobs_lock:
                    _fa_jobs[job_id]["success"] = True
            else:
                with _fa_jobs_lock:
                    shared_progress.update({"stage": "error", "filename": wheel_name,
                                            "error": f"pip exit code {proc.returncode}"})
                log_lines.append(f"[ERROR] pip 安装失败，退出码 {proc.returncode} / install failed")
                with _fa_jobs_lock:
                    _fa_jobs[job_id]["success"] = False
        except Exception as e:
            log_lines.append(f"[ERROR] {type(e).__name__}: {e}")
            with _fa_jobs_lock:
                shared_progress.update({"stage": "error", "error": str(e)})
                _fa_jobs[job_id]["success"] = False
        finally:
            # 停止 rich 进度条，避免光标卡在进度行 & 补换行
            try:
                progress_bar.stop()
            except Exception:
                pass
            try:
                sys.stderr.write("\n")
                sys.stderr.flush()
            except Exception:
                pass
            # 删除临时 wheel 目录（连 wheel 文件 + .partN/.partial 一起），绝不残留
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            with _fa_jobs_lock:
                _fa_jobs[job_id]["done"] = True

    _install_thr.Thread(target=_run, daemon=True).start()
    return job_id


@router.get("/flash-attention/progress/{job_id}")
async def flash_attn_progress(job_id: str) -> dict:
    """轮询 FA 安装进度。返回结构化 progress + 文本 log + done 标志。"""
    _cleanup_fa_jobs()
    with _fa_jobs_lock:
        job = _fa_jobs.get(job_id)
        if job:
            job = {
                "progress": dict(job.get("progress", {})),
                "log": list(job.get("log", [])),
                "done": job.get("done", False),
                "success": job.get("success"),
                "elapsed": _install_time.time() - job.get("start", 0),
            }
    if not job:
        return {"done": True, "progress": {"stage": "error", "error": "Job not found / 任务不存在"}, "log": []}
    return job


def _flash_attn_status_sync(cache_key: str) -> dict:
    """flash_attn 状态检测的同步实现。

    import torch / nvidia-smi / urllib GitHub API 均为阻塞调用，由 flash_attn_status
    通过 asyncio.to_thread 放到线程池执行，避免阻塞 FastAPI 事件循环——否则会拖慢
    /api/health 健康检查，触发前端"后端断开"误报。
    """
    import time
    import os as _os
    detect_env, current_status, fetch_candidates, _, _, _ = _import_flash_attn_tool()

    # 环境检测做 TTL 缓存：torch import + nvidia-smi 会话内复用，省去重复子进程开销
    global _fa_env_cache, _fa_env_cache_ts
    now = time.time()
    env = _fa_env_cache
    if env is None or (now - _fa_env_cache_ts) > _FA_ENV_CACHE_TTL:
        env = detect_env()
        _fa_env_cache = env
        _fa_env_cache_ts = now

    status = current_status()

    # 线程安全地读取缓存
    with _fa_cache_lock:
        cached = _fa_cache.get(cache_key)
        cache_expired = cached is None or (now - cached.get("ts", 0)) > _FA_CACHE_TTL

    if cache_expired:
        candidates, fetch_error = fetch_candidates(env, source=cache_key)
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


@router.get("/flash-attention/status")
async def flash_attn_status(source: str = "") -> dict:
    """返回 flash_attn 安装状态 + 环境检测 + GitHub 候选 wheel 列表。
    source: 可选 'default'|'mirror'|'fallback'，空则用默认源。

    阻塞操作通过 asyncio.to_thread 放到线程池执行，避免阻塞事件循环导致
    /api/health 健康检查超时（否则前端会误报"后端断开"）。
    """
    cache_key = source or "default"
    try:
        return await asyncio.to_thread(_flash_attn_status_sync, cache_key)
    except Exception as e:
        log.error(f"flash_attn status error: {e}")
        return {"installed": False, "version": None, "env": {}, "candidates": [], "fetch_error": str(e)}


@router.post("/flash-attention/install")
async def flash_attn_install(request: Request) -> dict:
    """安装 flash_attn wheel（后台执行，通过 /api/flash-attention/progress/{job_id} 轮询进度）。

    流程：预下载 wheel 到临时文件（多分块/续传/速度，结构化进度）→
    pip install 本地文件（解包+写入，输出逐行捕获）。下载阶段给前端真实百分比/速度，
    安装阶段为短 spinner。比旧方案（pip 直接安装远端 URL，非 TTY 下 pip 不输出实时进度）
    进度可见性更好。
    """
    try:
        body = await request.json()
        manual_url = body.get("url", None)  # 前端传入的原始 URL；None = 自动匹配
        source = body.get("source", "default")
    except Exception:
        manual_url = None
        source = "default"

    src = source or "default"
    if manual_url is None:
        # detect_env + fetch_candidates 为阻塞调用（nvidia-smi / GitHub API），
        # 放线程池避免阻塞事件循环导致健康检查超时。
        def _resolve():
            detect_env, _, fetch_candidates, _, _, _ = _import_flash_attn_tool()
            env = detect_env()
            candidates, _ = fetch_candidates(env, source=src)
            for c in candidates:
                if c["usable"]:
                    return c["url"], c.get("name", "")
            return None, None
        resolved = await asyncio.to_thread(_resolve)
        wheel_url, wheel_name = resolved[0], resolved[1]
        if wheel_url is None:
            return {"success": False, "error": "No usable wheel found. Please specify a URL manually."}
        # 自动安装：按 source 代理顺序生成全部变体（直连/镜像回退），交给下载引擎按序尝试
        _, _, _, _, _, download_urls_for = _import_flash_attn_tool()
        download_urls = download_urls_for(wheel_url, src)
    else:
        # 手动 URL：仅 [url]，避免代理前缀破坏非 GitHub 链接。
        # 文件名做 URL 解码（GitHub release URL 末段常为 %2B 等 percent-encoding），
        # 否则落盘名含 %2B 会破坏 pip 的 wheel 文件名解析。
        from urllib.parse import unquote
        wheel_name = unquote(manual_url.rsplit("/", 1)[-1]) or "flash_attn.whl"
        download_urls = [manual_url]

    job_id = _start_fa_job(download_urls, wheel_name, src)
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}


# ═══════════════════════════════════════════════════════════
#  xformers 环境管理 API
# ═══════════════════════════════════════════════════════════

def _xformers_status_sync() -> dict:
    """xformers 状态检测的同步实现。import torch 首次加载可能数秒，
    由 xformers_status 通过 asyncio.to_thread 放线程池执行，避免阻塞事件循环。
    """
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


@router.get("/xformers/status")
async def xformers_status() -> dict:
    """返回 xformers 安装状态 + 基础环境信息。

    import torch 首次加载可能数秒，通过 asyncio.to_thread 放到线程池，
    避免阻塞事件循环导致 /api/health 健康检查超时。
    """
    return await asyncio.to_thread(_xformers_status_sync)


@router.post("/xformers/install")
async def xformers_install() -> dict:
    """pip install xformers（后台执行，通过 /api/install-log/{job_id} 轮询进度）。"""
    import sys
    job_id = _start_install_job([sys.executable, "-m", "pip", "install", "--progress-bar", "on", "xformers"])
    return {"success": True, "job_id": job_id, "message": "Installation started / 安装已启动"}


# ═══════════════════════════════════════════════════════════
#  Triton 环境检测 API
# ═══════════════════════════════════════════════════════════


def _triton_status_sync() -> dict:
    """Triton 安装状态检测。torch.compile 的 inductor 后端需要 Triton 生成 GPU 代码。
    检测顺序：triton（Linux）、triton-windows（Windows 移植版）。两者都无时给出分平台指引。"""
    import importlib.metadata as _imd
    import sys

    installed = False
    ver = None
    package = None
    # 先查 triton（Linux）
    try:
        ver = _imd.version("triton")
        installed = True
        package = "triton"
    except _imd.PackageNotFoundError:
        pass
    # 再查 triton-windows（Windows）
    if not installed:
        try:
            ver = _imd.version("triton-windows")
            installed = True
            package = "triton-windows"
        except _imd.PackageNotFoundError:
            pass

    platform_note = None
    if not installed:
        if sys.platform == "win32":
            platform_note = (
                "Triton 未安装。Windows 需先安装 VC++ Redistributable，"
                "然后在环境管理页一键安装 triton-windows（triton-lang 官方移植 v3.7，版本约束 <3.8） / "
                "Triton not installed. Windows: install VC++ Redist first, "
                "then one-click install triton-windows (official triton-lang port v3.7, version <3.8)"
            )
        else:
            platform_note = (
                "Triton 未安装。Linux 用户: pip install triton / "
                "Triton not installed. Linux: pip install triton"
            )

    return {"installed": installed, "version": ver, "package": package, "platform_note": platform_note}


@router.get("/triton/status")
async def triton_status() -> dict:
    """返回 Triton 安装状态（compile 字段的依赖）。"""
    return await asyncio.to_thread(_triton_status_sync)


@router.post("/triton/install")
async def triton_install() -> dict:
    """pip install triton（Linux）或 triton-windows（Windows）。后台执行，通过 /api/install-log/{job_id} 轮询进度。

    根据 PyTorch 版本自动选择兼容的 Triton 版本：
        PyTorch 2.9  → Triton 3.5
        PyTorch 2.10 → Triton 3.6
        PyTorch 2.11 → Triton 3.6
        PyTorch 2.12 → Triton 3.7
    Windows 使用 triton-lang 官方移植版（https://github.com/triton-lang/triton-windows）。
    """
    import sys

    # 检测 PyTorch 版本以选择兼容的 Triton
    triton_ver = ""
    try:
        from packaging.version import Version
    except ImportError:
        Version = None  # fallback: 不带版本约束

    if Version is not None:
        try:
            import torch
            tv = torch.__version__.split("+")[0]  # 去掉 +cu128 后缀
            v = Version(tv)
            # PyTorch → Triton 兼容性映射
            if v >= Version("2.12"):
                triton_ver = ">=3.7,<3.8"
            elif v >= Version("2.10"):
                triton_ver = ">=3.6,<3.7"
            elif v >= Version("2.9"):
                triton_ver = ">=3.5,<3.6"
            # <2.9: 不带版本约束，让 pip 解析
        except Exception:
            pass  # torch 未安装或不兼容

    if sys.platform == "win32":
        pkg = "triton-windows"
    else:
        pkg = "triton"
    if triton_ver:
        pkg = f"{pkg}{triton_ver}"

    job_id = _start_install_job([sys.executable, "-m", "pip", "install", "-U", "--progress-bar", "on", pkg])
    return {"success": True, "job_id": job_id, "message": f"Installing {pkg} / 正在安装 {pkg}..."}


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
        try:
            r = launch_utils.run_capture_text(
                ["git", "-C", str(sd_root), "rev-parse", "--short", "HEAD"],
                timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                info["local_commit"] = r.stdout.strip()
                info["version_source"] = "git"
        except Exception:
            pass

        try:
            r = launch_utils.run_capture_text(
                ["git", "-C", str(sd_root), "rev-parse", "--abbrev-ref", "HEAD"],
                timeout=5,
            )
            if r.returncode == 0:
                branch = r.stdout.strip()
                if branch and branch != "HEAD":
                    info["local_branch"] = branch
        except Exception:
            pass

        try:
            r = launch_utils.run_capture_text(
                ["git", "-C", str(sd_root), "describe", "--tags", "--always"],
                timeout=5,
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
            r = launch_utils.run_capture_text(
                ["git", "-C", str(sd_root), "log", "-1", "--format=%ci"],
                timeout=5,
            )
            if r.returncode == 0 and r.stdout.strip():
                info["sync_date"] = r.stdout.strip()
        except Exception:
            pass

        # 尝试获取 remote URL
        try:
            r = launch_utils.run_capture_text(
                ["git", "-C", str(sd_root), "remote", "get-url", "origin"],
                timeout=5,
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


# ═══════════════════════════════════════════════════════════
#  单图标注推理
# ═══════════════════════════════════════════════════════════

@router.post("/tagger/single")
async def tagger_single_image(
    file: UploadFile = File(...),
    interrogator_model: str = Form(...),
):
    """Single-image tag inference. Returns all categories with raw confidence scores.
    No files written — pure in-memory inference for frontend display."""

    # ── 校验图片 ──────────────────────────────────────
    if not file.content_type or not file.content_type.startswith("image/"):
        return APIResponseFail(message="File is not an image / 文件不是图片")

    try:
        contents = await file.read()
        image = Image.open(BytesIO(contents))
    except UnidentifiedImageError:
        return APIResponseFail(message="Cannot identify image format / 无法识别图片格式")
    except Exception as e:
        return APIResponseFail(message=f"Failed to read image: {str(e)[:200]}")

    # ── 获取 interrogator ──────────────────────────────
    interrogator = available_interrogators.get(interrogator_model)
    if interrogator is None:
        return APIResponseFail(
            message=f"Unknown model: {interrogator_model} / 未知模型: {interrogator_model}"
        )

    # ── 推理 ───────────────────────────────────────────
    try:
        tags = await asyncio.to_thread(interrogator.interrogate, image)
    except Exception as e:
        log.exception("Single-image inference failed")
        return APIResponseFail(message=f"Inference failed: {str(e)[:200]}")

    # ── 构建响应（返回全部标签，置信度保留 4 位小数）─────
    categories = {}
    for cat_key, tag_list in tags.items():
        filtered = [
            [tag_name, round(confidence, 4)]
            for tag_name, confidence in tag_list
            if confidence >= 0.01
        ]
        if filtered:
            categories[cat_key] = filtered

    # ── 分类显示标签 ───────────────────────────────────
    labels = {}
    for cat_key in categories:
        labels[cat_key] = CATEGORY_LABELS.get(cat_key, cat_key)

    return APIResponseSuccess(data={
        "model": interrogator_model,
        "categories": categories,
        "labels": labels,
    })
