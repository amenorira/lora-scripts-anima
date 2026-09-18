"""Tag Editor 词典：从 Hugging Face 取数据、构建紧凑静态资源、对外提供状态与文件。

词典数据约 9MB，不进仓库，也不做运行时查询接口：
    下载（backend/utils/hf_download，带镜像回退与续传）
    → 构建（tools/dev/build_tag_dictionary.py 的校验与 core/detail 拆分）
    → cache/tag_dictionary/ 落盘
    → 浏览器按同源静态文件加载，查询全在 Web Worker 里完成

下载下来的 CSV 留在 cache/tag_dict_src/：只改构建脚本时不必再下一次。
源目录交给 tools/dev/build_tag_dictionary.py 也能离线重建。
"""
from __future__ import annotations

import datetime
import json
import threading
from pathlib import Path

from backend.utils.hf_download import download_hf_file
from tools.dev.build_tag_dictionary import CATEGORY_FILES, SOURCE_REPO, build

CACHE_DIR = Path("cache") / "tag_dictionary"
SOURCE_DIR = Path("cache") / "tag_dict_src"
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


# ── 已安装的词典 ──────────────────────────────────────

def read_manifest() -> dict | None:
    """读取已安装词典的 manifest；文件缺失或损坏时视为未安装。"""
    try:
        manifest = json.loads((CACHE_DIR / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(manifest, dict):
        return None
    for key in ("core", "detail"):
        name = manifest.get(key)
        if not isinstance(name, str) or not (CACHE_DIR / name).is_file():
            return None
    return manifest


def asset_path(name: str) -> Path | None:
    """把请求的文件名限定在已安装词典的文件里，避免路径穿越。"""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    manifest = read_manifest()
    if manifest is None:
        return None
    allowed = {MANIFEST_NAME, manifest["core"], manifest["detail"]}
    if name not in allowed:
        return None
    path = CACHE_DIR / name
    return path if path.is_file() else None


def _installed_size(manifest: dict) -> int:
    total = 0
    for key in ("core", "detail"):
        path = CACHE_DIR / manifest[key]
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def _download_percent() -> int:
    """下载阶段的总体进度：已完成文件数 + 当前文件比例。"""
    with _lock:
        progress = dict(_progress)
    index = int(progress.get("file_index") or 0)
    total = int(progress.get("file_total") or len(HF_FILES))
    done = int(progress.get("downloaded") or 0)
    size = int(progress.get("total") or 0)
    fraction = (done / size) if size > 0 else 0.0
    return max(0, min(100, int((index + fraction) * 100 / max(1, total))))


def status() -> dict:
    """给前端的完整状态：是否已安装、数据版本、体积，以及正在进行的安装进度。"""
    with _lock:
        state = dict(_state)
        log = list(_state["log"])[-4:]
    manifest = read_manifest()
    payload = {
        "status": state["status"],
        "message": state["message"],
        "log": log,
        "installed": manifest is not None,
        "data_version": (manifest or {}).get("data_version", ""),
        "tag_count": int((manifest or {}).get("tag_count") or 0),
        "size_bytes": _installed_size(manifest) if manifest else 0,
        "source": SOURCE_REPO,
        "finished_at": state["finished_at"],
    }
    if state["status"] == _DOWNLOADING:
        payload["percent"] = _download_percent()
        with _lock:
            progress = dict(_progress)
        payload["current_file"] = str(progress.get("filename") or "")
        payload["downloaded_bytes"] = int(progress.get("downloaded") or 0)
        payload["total_bytes"] = int(progress.get("total") or 0)
        payload["speed_mb"] = float(progress.get("speed") or 0.0)
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
        manifest = build(SOURCE_DIR, CACHE_DIR, datetime.date.today().isoformat(), _report_sink)
        _log(f"完成：{manifest['tag_count']} 个标签")
        _set_state(_READY, "")
    except Exception as error:  # noqa: BLE001 - 任何失败都要变成可见状态，不能让线程静默死掉
        _log(f"失败：{error}")
        _set_state(_FAILED, str(error))


def _report_sink(report: str) -> None:
    for line in report.splitlines():
        _log(line)


def _download_sources(force: bool) -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    total = len(HF_FILES)
    for index, (hf_path, local_name) in enumerate(HF_FILES):
        target = SOURCE_DIR / local_name
        if not force and target.is_file() and target.stat().st_size > 0:
            _log(f"复用本地 {local_name}")
        else:
            _log(f"下载 {hf_path}")
            download_hf_file(
                SOURCE_REPO, hf_path, target,
                progress=_progress, lock=_lock,
                file_index=index, file_total=total,
                repo_type="dataset",   # 数据源是数据集仓库，地址要带 /datasets/
            )
