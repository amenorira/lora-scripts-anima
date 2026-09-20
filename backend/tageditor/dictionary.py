"""Tag Editor 词典：从 Hugging Face 取数据、构建紧凑静态资源、对外提供状态与文件。

词典数据约 9MB，不进仓库，也不做运行时查询接口：
    下载（backend/utils/hf_download，带镜像回退与续传）
    → 构建（tools/dev/build_tag_dictionary.py 的校验与 core/detail 拆分）
    → $HF_HOME/tag_dictionary/asset/ 落盘
    → 浏览器按同源静态文件加载，查询全在 Web Worker 里完成

目录跟随 HF_HOME（start.sh 里是 huggingface/），和其他 Hugging Face 数据在一起：
    $HF_HOME/tag_dictionary/source/   下载下来的 CSV，只改构建脚本时不必再下一次
    $HF_HOME/tag_dictionary/asset/    浏览器加载的 manifest / core / detail
源目录交给 tools/dev/build_tag_dictionary.py 也能离线重建。
升级兼容：新资源不可用时读取 cache/tag_dictionary；安装时从 cache/tag_dict_src
补齐缺失的 CSV，保留旧缓存，强制更新仍重新下载。
"""
from __future__ import annotations

import datetime
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from huggingface_hub import HfApi

from backend.utils.hf_download import IntegrityError, download_hf_file, _endpoints_for_download
from tools.dev.build_tag_dictionary import (
    CATEGORY_FILES,
    LEGACY_ASSET_DIR,
    SOURCE_REPO,
    SOURCE_URL,
    SCHEMA_VERSION,
    build,
    category_stats,
    default_asset_dir,
    default_source_dir,
    reuse_legacy_sources,
)

# 下载来的 CSV 与构建产物都放 HF_HOME（huggingface/）下，与其他 HF 数据一致
SOURCE_DIR = default_source_dir()
ASSET_DIR = default_asset_dir()
MANIFEST_NAME = "manifest.json"

# HF 仓库里 CSV 放在 tags/ 下，本地平铺保存
HF_FILES = [(f"tags/{name}.csv", f"{name}.csv") for name in CATEGORY_FILES]

_DOWNLOADING = "downloading"
_BUILDING = "building"
_READY = "ready"
_FAILED = "failed"
_BUSY = (_DOWNLOADING, _BUILDING)

_lock = threading.Lock()
_progress: dict = {}
_state: dict = {"status": "idle", "message": "", "finished_at": "", "log": []}
_thread: threading.Thread | None = None
_check_lock = threading.Lock()
_update_check: dict = {}


# ── 已安装的词典 ──────────────────────────────────────

def read_manifest() -> dict | None:
    """读取已安装词典的 manifest；文件缺失或损坏时视为未安装。"""
    return _installed_assets()[1]


def _installed_assets() -> tuple[Path, dict | None]:
    """新目录优先，旧版完整资源直接读取；所有静态文件使用同一份 manifest。"""
    for directory in (ASSET_DIR, LEGACY_ASSET_DIR):
        manifest = _read_manifest(directory)
        if manifest is not None:
            return directory, manifest
    return ASSET_DIR, None


def _read_manifest(directory: Path) -> dict | None:
    try:
        manifest = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(manifest, dict):
        return None
    if (manifest.get("schema_version") != SCHEMA_VERSION
            or not isinstance(manifest.get("tag_count"), int) or manifest["tag_count"] <= 0):
        return None
    for key in ("core", "detail"):
        name = manifest.get(key)
        if (not isinstance(name, str) or not name or name.startswith(".")
                or "/" in name or "\\" in name or not (directory / name).is_file()):
            return None
    return manifest


def asset_path(name: str) -> Path | None:
    """把请求的文件名限定在已安装词典的文件里，避免路径穿越。"""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    directory, manifest = _installed_assets()
    if manifest is None:
        return None
    # 构建器只保留当前和上一版；允许旧页面继续加载同一版的说明文件。
    if name != MANIFEST_NAME and not re.fullmatch(r"tags-(?:core|detail)\.[0-9a-f]{8}\.json", name):
        return None
    directories = (directory,) if name == MANIFEST_NAME else (ASSET_DIR, LEGACY_ASSET_DIR)
    for root in directories:
        path = root / name
        if path.is_file():
            return path
    return None


def _installed_size(directory: Path, manifest: dict) -> int:
    total = 0
    for key in ("core", "detail"):
        path = directory / manifest[key]
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def _download_percent() -> int:
    """下载阶段的总体进度：已完成文件数 + 当前文件比例。"""
    with _lock:
        progress = dict(_progress)
        files = [dict(item) for item in _progress.get("files", {}).values()]
    if files:
        return int(100 * sum(1 if item.get("done") else min(
            1, item.get("downloaded", 0) / max(1, item.get("total", 0)))
            for item in files) / len(files))
    index = int(progress.get("file_index") or 0)
    total = int(progress.get("file_total") or len(HF_FILES))
    done = int(progress.get("downloaded") or 0)
    size = int(progress.get("total") or 0)
    fraction = (done / size) if size > 0 else 0.0
    return max(0, min(100, int((index + fraction) * 100 / max(1, total))))


@lru_cache(maxsize=2)
def _legacy_categories(directory: str, core: str) -> list:
    root = Path(directory)
    return category_stats(row[2] for row in json.loads((root / core).read_text(encoding="utf-8")))


def _remote_info():
    error = None
    for endpoint in _endpoints_for_download():
        try:
            return HfApi(endpoint=endpoint).dataset_info(
                SOURCE_REPO, files_metadata=True, timeout=8)
        except Exception as exc:
            error = exc
    raise RuntimeError(f"无法检查词典更新：{error}")


def check_update(force: bool = False) -> dict:
    """检查 CSV 内容指纹；失败不影响已安装词典，自动检查缓存一小时。"""
    global _update_check
    with _check_lock:
        manifest = read_manifest() or {}
        key = manifest.get("core", "")
        if (not force and _update_check.get("key") == key
                and time.monotonic() - _update_check.get("time", 0) < 3600):
            return dict(_update_check)
        result = {"key": key, "time": time.monotonic(), "state": "unknown"}
        try:
            info = _remote_info()
            remote = {s.rfilename: s for s in info.siblings}
            hashes = manifest.get("source_hashes", {})
            changed = []
            for path, _ in HF_FILES:
                item = remote[path]
                expected = item.lfs.sha256 if item.lfs else item.blob_id
                if not expected:
                    raise ValueError(f"缺少文件指纹：{path}")
                local = hashes.get(path, {}).get("sha256" if item.lfs else "blob")
                if local != expected:
                    changed.append(path)
            result.update(state=("unknown" if not hashes else "available" if changed else "current"),
                          revision=info.sha, changed_files=changed,
                          checked_at=datetime.datetime.now().isoformat(timespec="seconds"))
        except Exception as error:
            result.update(state="error", message=str(error))
        _update_check = result
        return dict(result)


def status() -> dict:
    """给前端的完整状态：是否已安装、数据版本、体积，以及正在进行的安装进度。"""
    with _lock:
        state = dict(_state)
        log = list(_state["log"])
        progress = dict(_progress)
        files = [dict(item) for item in _progress.get("files", {}).values()]
    directory, manifest = _installed_assets()
    categories = [{key: item[key] for key in ("id", "name", "tag_count")}
                  for item in (manifest or {}).get("categories", [])]
    if manifest and not categories:
        try:
            categories = _legacy_categories(str(directory), manifest["core"])
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            categories = []
    payload = {
        "status": state["status"],
        "message": state["message"],
        "log": log,
        "installed": manifest is not None,
        "data_version": (manifest or {}).get("data_version", ""),
        "tag_count": int((manifest or {}).get("tag_count") or 0),
        "size_bytes": _installed_size(directory, manifest) if manifest else 0,
        "source": SOURCE_REPO,
        "categories": categories,
        "files": files,
        "update": (dict(_update_check) if _update_check.get("key") == (manifest or {}).get("core", "") else {}),
        "finished_at": state["finished_at"],
        "error_kind": state.get("error_kind", ""),
        "current_file": str(progress.get("filename") or ""),
        "file_index": int(progress.get("file_index") or 0),
        "file_total": len(HF_FILES),
        "phase": str(progress.get("phase") or ""),
        "download_source": str(progress.get("source") or ""),
    }
    if state["status"] == _DOWNLOADING:
        payload["percent"] = _download_percent()
        with _lock:
            progress = dict(_progress)
        payload["current_file"] = str(progress.get("filename") or "")
        payload["downloaded_bytes"] = int(progress.get("downloaded") or 0)
        payload["total_bytes"] = int(progress.get("total") or 0)
        payload["speed_mb"] = float(progress.get("speed") or 0.0)
        if files:
            payload.update(downloaded_bytes=sum(f.get("downloaded", 0) for f in files),
                           total_bytes=sum(f.get("total", 0) for f in files),
                           speed_mb=sum(f.get("speed", 0) for f in files if not f.get("done")),
                           file_index=sum(bool(f.get("done")) for f in files))
    elif state["status"] == _BUILDING:
        payload["percent"] = 100
    else:
        payload["percent"] = 0
    return payload


# ── 安装 / 更新 ───────────────────────────────────────

def _set_state(status: str, message: str = "") -> None:
    with _lock:
        _state["status"] = status
        _state["message"] = message
        if status in (_READY, _FAILED):
            _state["finished_at"] = datetime.datetime.now().isoformat(timespec="seconds")


def _log(message: str) -> None:
    with _lock:
        _state["log"].append(message)
        if len(_state["log"]) > 40:
            del _state["log"][: len(_state["log"]) - 40]


def start_install(force: bool = False) -> dict:
    """启动后台安装；已有任务在跑或已安装（且非强制）时直接返回原因。

    注意：_lock 不是可重入锁，判定完必须先放开再调 status()。"""
    global _thread
    with _lock:
        busy = _state["status"] in _BUSY
        installed = read_manifest() is not None
        start = not busy and (force or not installed)
        if start:
            _progress.clear()
            _state["error_kind"] = ""
            _state["log"] = []
            _state["status"] = _DOWNLOADING
            _state["message"] = ""
    if not start:
        return {"started": False, "reason": "busy" if busy else "installed", "status": status()}
    _thread = threading.Thread(target=_install, args=(force,), daemon=True)
    _thread.start()
    return {"started": True, "reason": "", "status": status()}


def _install(force: bool) -> None:
    try:
        _download_sources(force)
        _set_state(_BUILDING, "")
        _log("构建词典资源")
        manifest = build(SOURCE_DIR, ASSET_DIR, datetime.date.today().isoformat(),
                         SOURCE_URL, on_report=_report_sink)
        _log(f"完成：{manifest['tag_count']} 个标签")
        _update_check.clear()
        _set_state(_READY, "")
    except (Exception, SystemExit) as error:  # 构建器的 CSV 校验通过 SystemExit 报错
        with _lock:
            _state["error_kind"] = ("integrity" if isinstance(error, IntegrityError)
                                    else "build" if _state["status"] == _BUILDING else "download")
        _log(f"失败：{error}")
        _set_state(_FAILED, str(error))


def _report_sink(report: str) -> None:
    for line in report.splitlines():
        _log(line)


def _download_sources(force: bool) -> None:
    if not force:
        reuse_legacy_sources(SOURCE_DIR)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    total = len(HF_FILES)
    with _lock:
        _progress["files"] = {name: {"filename": name, "phase": "queued", "done": False}
                              for _, name in HF_FILES}
    def download(index: int, hf_path: str, local_name: str) -> None:
        target = SOURCE_DIR / local_name
        progress = _progress["files"][local_name]
        if not force and target.is_file() and target.stat().st_size > 0:
            _log(f"复用本地 {local_name}")
        else:
            _log(f"下载 {hf_path}")
            with _lock:
                progress.update({"filename": local_name, "file_index": index,
                                  "file_total": total, "downloaded": 0, "total": 0,
                                  "speed": 0.0, "phase": "connecting"})
            download_hf_file(
                SOURCE_REPO, hf_path, target,
                progress=progress, lock=_lock,
                file_index=index, file_total=total,
                on_log=_log,
                repo_type="dataset",   # 数据源是数据集仓库，地址要带 /datasets/
            )
        with _lock:
            progress.update(done=True, phase="file_done", speed=0.0)
    with ThreadPoolExecutor(max_workers=len(HF_FILES), thread_name_prefix="dictionary") as executor:
        futures = [executor.submit(download, index, path, name)
                   for index, (path, name) in enumerate(HF_FILES)]
        for future in futures:
            future.result()
