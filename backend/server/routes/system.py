"""Core local-server routes that are unrelated to training or environment setup."""

import asyncio
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from backend import launch_utils
from backend.constants import (
    CONFIG_DIR,
    OUTPUT_DIR,
    REPO_ROOT,
    SD_MODELS_DIR,
    SD_SCRIPTS_DIR,
    TRAIN_DIR,
    VENDOR_ROOT,
)
from backend.regularization.storage import OUTPUT_ROOT as REGULARIZATION_OUTPUT_ROOT
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
    _git_version_cache = launch_utils.app_version(REPO_ROOT)
    return _git_version_cache


@router.get("/health")
async def health_check():
    """Lightweight connectivity check with training and generation activity."""
    tasks = tm.training_dump()
    active_task = next(
        (task for task in tasks if task.get("status") in {"CREATED", "RUNNING"}),
        None,
    )
    return {
        "status": "ok",
        "training_active": active_task is not None,
        "regularization_active": tm.regularization_active(),
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

    Serialize the registry once per process and return 304 to clients with
    a matching ETag to save the ~88 KB transfer.
    """
    global _fields_payload_cache
    with _fields_payload_lock:
        cached = _fields_payload_cache.get("v1")
        if cached is not None:
            return cached
        from backend.training.fields.field_registry import get_fields_json

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


def _to_picker_path(path) -> str:
    """选择器返回路径：项目目录内的转为相对路径（正斜杠），目录外保持绝对路径。
    刻意不 resolve()：避免把符号链接目录（如 models/ 指向别的盘）穿透成链接目标，
    用户在界面上看到的目录结构是什么，写回输入框的就是什么。"""
    abs_path = Path(path)
    if not abs_path.is_absolute():
        abs_path = REPO_ROOT / abs_path
    try:
        rel = abs_path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(abs_path).replace("\\", "/")
    # 与字段默认值（如 ./models/anima-base-v1.0.safetensors）保持同一书写风格
    return f"./{rel}" if rel != "." else "."


@router.get("/file_picker_available")
async def file_picker_available():
    """本地系统文件选择器是否可用。无图形环境的 Linux 服务器（AutoDL 等云平台）
    上不可用，前端据此隐藏本地选择按钮，只保留内置浏览器。"""
    return APIResponseSuccess(data={"available": tk_is_available()})


@router.get("/pick_file")
async def pick_file(
    picker_type: str, title: str = "", file_type_label: str = "", all_files_label: str = ""
):
    if not tk_is_available():
        return APIResponseFail(message="unavailable / 不可用")
    if picker_type == "folder":
        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, open_directory_selector, "", title)
    else:
        pattern = {
            "model-file": "*.safetensors;*.ckpt;*.pt",
            "text-file": "*.txt;*.md",
            "image-file": "*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff;*.avif",
        }.get(picker_type)
        if pattern is None:
            return APIResponseFail(message=f"Invalid picker_type / 无效的选择器类型: {picker_type}")
        file_types = [
            (file_type_label or pattern, pattern),
            (all_files_label or "*.*", "*.*"),
        ]

        def _pick():
            return open_file_selector("", title, file_types)

        coro = asyncio.get_event_loop().run_in_executor(_tk_executor, _pick)

    result = await coro
    if result == "":
        return APIResponseFail(message="cancelled / 已取消")

    return APIResponseSuccess(data={"path": _to_picker_path(result)})


_files_cache: dict[str, tuple[float, list[dict]]] = {}
_files_cache_lock = threading.Lock()
_FILES_CACHE_TTL = 60


def invalidate_files_cache() -> None:
    """数据集目录被改名/增删后清缓存，避免选择器在 TTL 内继续列出旧名字。"""
    with _files_cache_lock:
        _files_cache.clear()


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}
_TEXT_FILE_EXTS = {".txt", ".md", ".json", ".toml", ".yaml", ".yml"}
_STATE_SCAN_SKIP_DIRS = {"sample", "log", "logs"}


def _list_state_dirs(output_root: Path) -> list[dict]:
    """Scan OUTPUT_DIR for valid resumable training state directories."""
    if not output_root.exists():
        return []
    from backend.monitor.artifacts import _dir_summary, _is_training_state_dir, _parse_state_dir
    from backend.training.checkpoint_state import resumable_state

    try:
        resolved_root = output_root.resolve()
    except OSError:
        return []

    results: list[dict] = []
    seen: set[Path] = set()
    pending: list[tuple[Path, int]] = [(output_root, 0)]
    while pending:
        current, depth = pending.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.name.startswith((".", "__")):
                        continue
                    try:
                        if entry.is_symlink() or not entry.is_dir():
                            continue
                        dir_path = Path(entry.path)
                        resolved_dir = dir_path.resolve()
                        if not resolved_dir.is_relative_to(resolved_root) or resolved_dir in seen:
                            continue
                    except OSError:
                        continue

                    if _is_training_state_dir(dir_path):
                        seen.add(resolved_dir)
                        run_dir_hint = dir_path.parent if dir_path.parent != output_root else None
                        if not resumable_state(dir_path, run_dir_hint):
                            continue
                        try:
                            dir_stat = entry.stat()
                            total_size, latest_mtime = _dir_summary(dir_path, dir_stat)
                        except OSError:
                            continue
                        parsed = _parse_state_dir(dir_path, dir_path.name)
                        try:
                            run_name = (
                                dir_path.parent.relative_to(output_root).as_posix()
                                if dir_path.parent != output_root
                                else ""
                            )
                        except ValueError:
                            run_name = dir_path.parent.name if dir_path.parent != output_root else ""
                        results.append({
                            "name": dir_path.name,
                            "path": _to_picker_path(dir_path),
                            "size": total_size,
                            "size_bytes": total_size,
                            "mtime": latest_mtime,
                            "run_name": run_name,
                            "step": parsed.get("ckpt_step"),
                            "epoch": parsed.get("ckpt_epoch"),
                        })
                    elif depth < 3 and entry.name.lower() not in _STATE_SCAN_SKIP_DIRS:
                        pending.append((dir_path, depth + 1))
        except OSError:
            continue

    results.sort(key=lambda item: -float(item.get("mtime") or 0))
    return results


def _list_text_files(roots: tuple[Path, ...], *, max_entries: int = 5000, max_results: int = 500) -> list[dict]:
    """Scan CONFIG_DIR and TRAIN_DIR for text/prompt/knowledge files."""
    results: list[dict] = []
    seen_files: set[Path] = set()
    visited = 0

    for root in roots:
        if not root.exists():
            continue
        try:
            resolved_root = root.resolve()
        except OSError:
            continue
        pending: list[Path] = [root]
        while pending and visited < max_entries and len(results) < max_results:
            current = pending.pop()
            subdirs: list[Path] = []
            try:
                with os.scandir(current) as entries:
                    for entry in entries:
                        if entry.name.startswith((".", "__")):
                            continue
                        visited += 1
                        if visited > max_entries:
                            break
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_file():
                                ext = os.path.splitext(entry.name)[1].lower()
                                if ext not in _TEXT_FILE_EXTS:
                                    continue
                                file_path = Path(entry.path)
                                resolved_file = file_path.resolve()
                                if not resolved_file.is_relative_to(resolved_root) or resolved_file in seen_files:
                                    continue
                                seen_files.add(resolved_file)
                                st = entry.stat()
                                results.append({
                                    "path": _to_picker_path(file_path),
                                    "name": file_path.name,
                                    "size": st.st_size,
                                    "size_bytes": st.st_size,
                                    "mtime": st.st_mtime,
                                })
                                if len(results) >= max_results:
                                    break
                            elif entry.is_dir():
                                sub_path = Path(entry.path)
                                if sub_path.resolve().is_relative_to(resolved_root):
                                    subdirs.append(sub_path)
                        except OSError:
                            continue
            except OSError:
                continue
            pending.extend(reversed(subdirs))

    results.sort(key=lambda item: -float(item.get("mtime") or 0))
    return results


def _writable_roots(*, include_output: bool) -> tuple[Path, ...]:
    """Return allowed writable storage roots (TRAIN_DIR/SD_MODELS_DIR/CONFIG_DIR already follow DATA_DIR)."""
    roots: list[Path] = [TRAIN_DIR, SD_MODELS_DIR, CONFIG_DIR]
    if include_output:
        roots.append(OUTPUT_DIR)
    return tuple(roots)


def _resolve_writable_dir(
    raw_dir: str,
    *,
    allowed_roots: tuple[Path, ...],
    default_dir: Path,
) -> tuple[Path, Path]:
    """Resolve a target directory and strictly enforce confinement within allowed_roots."""
    text = (raw_dir or "").strip() if isinstance(raw_dir, str) else ""
    if "\x00" in text:
        raise ValueError("Invalid path / 无效路径")
    if not text:
        display_path = default_dir
    else:
        candidate = Path(text).expanduser()
        if candidate.is_absolute():
            display_path = candidate
        else:
            parts = candidate.parts
            logical_map = {
                "models": SD_MODELS_DIR,
                "train": TRAIN_DIR,
                "output": OUTPUT_DIR,
                "config": CONFIG_DIR,
            }
            if parts and parts[0] in logical_map:
                display_path = logical_map[parts[0]].joinpath(*parts[1:])
            else:
                display_path = REPO_ROOT / candidate
        display_path = Path(os.path.normpath(str(display_path)))

    resolved = display_path.resolve()
    allowed_resolved = [root.resolve() for root in allowed_roots]
    if not any(resolved.is_relative_to(root) for root in allowed_resolved):
        raise PermissionError("Path is outside allowed writable directories / 路径超出允许的可写目录")
    return display_path, resolved


def _validate_entry_name(raw_name: object) -> str:
    """Validate a single folder or file basename (no separators, traversal, or control chars)."""
    if not isinstance(raw_name, str):
        raise ValueError("Name is required / 名称不能为空")
    name = raw_name.strip()
    if not name or name in {".", ".."} or ".." in name:
        raise ValueError("Invalid name / 名称无效")
    if any(ch in name for ch in ("/", "\\", ":", "\x00")):
        raise ValueError("Invalid characters in name / 名称包含非法字符")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        raise ValueError("Control characters are not allowed / 名称不能包含控制字符")
    return name


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(os.path, "isjunction", None)
    return path.is_symlink() or (callable(is_junction) and bool(is_junction(path)))


def _existing_ancestor(path: Path) -> Path:
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    return current


def _collect_storage_volumes() -> list[dict]:
    """Probe disk space for output, models, and train, deduplicating identical mounts."""
    volumes: list[dict] = []
    by_device: dict[int, dict] = {}
    for key, path in (("output", OUTPUT_DIR), ("models", SD_MODELS_DIR), ("train", TRAIN_DIR)):
        try:
            probe = _existing_ancestor(path)
            dev = os.stat(probe).st_dev
            usage = shutil.disk_usage(probe)
        except OSError:
            continue
        existing = by_device.get(dev)
        if existing is not None:
            existing["keys"].append(key)
            continue
        entry = {
            "key": key,
            "keys": [key],
            "path": _to_picker_path(path),
            "free_bytes": usage.free,
            "total_bytes": usage.total,
        }
        by_device[dev] = entry
        volumes.append(entry)
    return volumes


_DATASET_STATS_MAX_ENTRIES = 5000
_DATASET_STATS_TIMEOUT_SEC = 1.5


def _dataset_folder_stats(
    folder: Path,
    *,
    max_entries: int = _DATASET_STATS_MAX_ENTRIES,
    timeout_sec: float = _DATASET_STATS_TIMEOUT_SEC,
) -> dict:
    """统计数据集文件夹：递归数图片及同名 .txt 打标数（带条目数与时间上限，避免大 FUSE 目录卡死）。"""
    images = 0
    captioned = 0
    visited = 0
    truncated = False
    deadline = time.monotonic() + timeout_sec
    pending: list[Path] = [folder]

    while pending:
        if visited >= max_entries or time.monotonic() >= deadline:
            truncated = True
            break
        current = pending.pop()
        file_names: list[str] = []
        txt_stems: set[str] = set()
        subdirs: list[Path] = []
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.name.startswith((".", "__")):
                        continue
                    visited += 1
                    if visited > max_entries:
                        truncated = True
                        break
                    try:
                        if entry.is_file():
                            name = entry.name
                            stem, ext = os.path.splitext(name)
                            ext_low = ext.lower()
                            if ext_low == ".txt":
                                txt_stems.add(os.path.normcase(stem))
                            elif ext_low in _IMAGE_EXTS:
                                file_names.append(os.path.normcase(stem))
                        elif not entry.is_symlink() and entry.is_dir():
                            subdirs.append(Path(entry.path))
                    except OSError:
                        continue
        except OSError:
            continue
        for stem in file_names:
            images += 1
            if stem in txt_stems:
                captioned += 1
        if truncated:
            break
        pending.extend(reversed(subdirs))

    result = {"images": images, "captioned": captioned}
    if truncated:
        result["truncated"] = True
    return result


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    now = time.time()
    with _files_cache_lock:
        cached = _files_cache.get(pick_type)
        if cached and now - cached[0] < _FILES_CACHE_TTL:
            return APIResponseSuccess(data={"files": cached[1]})

    pick_preset = {
        "model-file": {"type": "file", "path": SD_MODELS_DIR, "filter": "(.safetensors|.ckpt|.pt)"},
        "model-saved-file": {"type": "file", "path": OUTPUT_DIR, "filter": "(.safetensors|.ckpt|.pt)"},
        "train-dir": {"type": "folder", "path": TRAIN_DIR, "filter": None},
        "reg-dir": {"type": "folder", "path": REGULARIZATION_OUTPUT_ROOT, "filter": None},
    }
    # 目录选择器里无意义的杂项目录
    hidden_dir_names = {".ipynb_checkpoints", ".DS_Store"}

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
                st = file.stat()
                result_list.append({
                    "path": _to_picker_path(file),
                    "name": file.name,
                    "size": f"{round(st.st_size / (1024**3), 2)} GB",
                    "size_bytes": st.st_size,
                    "mtime": st.st_mtime,
                })
        elif file_type == "folder":
            folders = [folder for folder in path.iterdir() if folder.is_dir()]
            for folder in folders:
                if folder.name in hidden_dir_names:
                    continue
                entry = {
                    "path": _to_picker_path(folder),
                    "name": folder.name,
                    "size": 0,
                    "size_bytes": 0,
                    "mtime": folder.stat().st_mtime,
                }
                entry.update(_dataset_folder_stats(folder))
                result_list.append(entry)

        return result_list

    if pick_type == "state-dir":
        dirs = await asyncio.to_thread(_list_state_dirs, OUTPUT_DIR)
        with _files_cache_lock:
            _files_cache[pick_type] = (now, dirs)
        return APIResponseSuccess(data={"files": dirs})

    if pick_type == "text-file":
        dirs = await asyncio.to_thread(_list_text_files, (CONFIG_DIR, TRAIN_DIR))
        with _files_cache_lock:
            _files_cache[pick_type] = (now, dirs)
        return APIResponseSuccess(data={"files": dirs})

    if pick_type not in pick_preset:
        return APIResponseFail(message="Invalid request / 无效请求")

    dirs = await asyncio.to_thread(list_path_or_files, pick_preset[pick_type])
    with _files_cache_lock:
        _files_cache[pick_type] = (now, dirs)
    return APIResponseSuccess(data={"files": dirs})


@router.post("/files/mkdir")
async def create_directory(request: Request):
    """Create a folder inside an allowed writable storage root."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid JSON body / 请求 JSON 格式无效"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid request body / 请求体无效"})

    parent_raw = body.get("parent", "")
    name_raw = body.get("name", "")
    if parent_raw is not None and not isinstance(parent_raw, str):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Invalid parent path / 父目录无效"})

    try:
        name = _validate_entry_name(name_raw)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"status": "error", "message": str(exc)})

    allowed_roots = _writable_roots(include_output=True)
    try:
        display_parent, parent_resolved = _resolve_writable_dir(
            parent_raw or "",
            allowed_roots=allowed_roots,
            default_dir=TRAIN_DIR,
        )
    except PermissionError as exc:
        return JSONResponse(status_code=403, content={"status": "error", "message": str(exc)})
    except (ValueError, OSError) as exc:
        return JSONResponse(status_code=400, content={"status": "error", "message": str(exc)})

    def _create_dir() -> tuple[int, dict]:
        allowed_resolved = [root.resolve() for root in allowed_roots]
        if not parent_resolved.exists():
            if parent_resolved in allowed_resolved:
                parent_resolved.mkdir(parents=True, exist_ok=True)
            else:
                return 400, {"status": "error", "message": "Parent directory does not exist / 父目录不存在"}
        if not parent_resolved.is_dir():
            return 400, {"status": "error", "message": "Parent path is not a directory / 父路径不是目录"}

        target = parent_resolved / name
        target_resolved = target.resolve()
        if (
            target_resolved.parent != parent_resolved
            or not any(target_resolved.is_relative_to(root) for root in allowed_resolved)
        ):
            return 403, {"status": "error", "message": "Target path escapes allowed root / 目标路径越界"}
        if target.exists() or _is_link_or_junction(target):
            return 409, {"status": "error", "message": "Folder already exists / 目录已存在"}

        target.mkdir(exist_ok=False)
        invalidate_files_cache()
        return 200, {
            "status": "success",
            "path": _to_picker_path(display_parent / name),
            "name": name,
        }

    try:
        status_code, payload = await asyncio.to_thread(_create_dir)
    except OSError as exc:
        return JSONResponse(status_code=500, content={"status": "error", "message": f"Failed to create folder: {exc}"})
    if status_code != 200:
        return JSONResponse(status_code=status_code, content=payload)
    return payload


@router.get("/storage/space")
async def storage_space():
    """Return free/total disk space for output, models, and train mounts (deduplicated by device)."""
    volumes = await asyncio.to_thread(_collect_storage_volumes)
    return {"status": "success", "volumes": volumes}


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
                            info["local_commit"] = value
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
