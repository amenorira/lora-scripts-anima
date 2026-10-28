"""训练样本、输出文件扫描与短期缓存。"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from backend.constants import REPO_ROOT
from backend.image_preview import build_image_preview_url

from backend.monitor.checkpoints import LORA_EXTENSIONS, parse_checkpoint

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# 隐藏 / 缓存目录名前缀与名称，扫描时一律跳过（避免 .ipynb_checkpoints、__pycache__ 等污染）
_HIDDEN_PREFIXES = (".", "__")
_TRAINING_SAMPLE_RE = re.compile(
    r"(?:^|_)(?P<progress>e?\d{6})_(?P<prompt>\d{2})_(?P<timestamp>\d{14})(?:_-?\d+)?$",
    re.IGNORECASE,
)


def _is_hidden(name: str) -> bool:
    """判断目录/文件名是否为隐藏或缓存项（.开头 或 __开头）。"""
    return name.startswith(_HIDDEN_PREFIXES)


def _iter_dir(root: Path):
    """Prune hidden directories before walking them; never follow directory links."""
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if not _is_hidden(name)]
        for name in files:
            if not _is_hidden(name):
                yield Path(directory) / name


def _preview_sort_key(path: Path, stat) -> tuple[int, int, int, int, str]:
    """Return a stable generation-order key for trainer sample filenames."""
    match = _TRAINING_SAMPLE_RE.search(path.stem)
    if match:
        progress_token = match.group("progress").lower()
        progress_value = int(progress_token[1:] if progress_token.startswith("e") else progress_token)
        return (
            int(match.group("timestamp")),
            progress_value,
            int(match.group("prompt")),
            stat.st_mtime_ns,
            path.as_posix().lower(),
        )
    fallback_time = int(datetime.fromtimestamp(stat.st_mtime).strftime("%Y%m%d%H%M%S"))
    return (fallback_time, -1, -1, stat.st_mtime_ns, path.as_posix().lower())


# ── 预览样本 ──────────────────────────────────────────────

_previews_cache_lock = threading.Lock()
_previews_cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
_PREVIEWS_CACHE_TTL = 5.0
_PREVIEWS_CACHE_MAX_RUNS = 8


def _store_previews(cache_key: str, result: list[dict]) -> None:
    with _previews_cache_lock:
        _previews_cache[cache_key] = (time.time(), result)
        _previews_cache.move_to_end(cache_key)
        while len(_previews_cache) > _PREVIEWS_CACHE_MAX_RUNS:
            _previews_cache.popitem(last=False)


def newest_previews(
    output_dir: str | None = None,
    limit: int = 0,
    force_refresh: bool = False,
    run_dir: str = "",
) -> list[dict]:
    """扫描最新的训练样本图（扁平结构：run_dir/sample/ → run_dir/；兼容旧 outputs/sample/）

    limit: 返回的最新样本数量上限；0 表示返回全部（按训练生成顺序升序，最新在末尾）。
    force_refresh: True 时跳过 5s 缓存，立即重新扫描磁盘并覆盖缓存。
    """
    now = time.time()
    cache_key = f"{run_dir}|{output_dir or ''}"
    if not force_refresh:
        with _previews_cache_lock:
            cached = _previews_cache.get(cache_key)
            if cached and now - cached[0] < _PREVIEWS_CACHE_TTL:
                _previews_cache.move_to_end(cache_key)
                return cached[1][-limit:] if limit else cached[1]

    recursive_roots: list[Path] = []
    flat_roots: list[Path] = []
    if not output_dir:
        _store_previews(cache_key, [])
        return []
    if output_dir:
        try:
            od = Path(output_dir).resolve()
        except OSError:
            _store_previews(cache_key, [])
            return []
        if not od.is_dir():
            _store_previews(cache_key, [])
            return []
        recursive_roots.extend([od / "sample", od / "outputs" / "sample"])
        flat_roots.extend([od, od / "outputs"])

    found: list[Path] = []
    seen: set[Path] = set()
    for root in recursive_roots:
        if not root.exists():
            continue
        for p in _iter_dir(root):
            if not p.is_file():
                continue
            if p.suffix.lower() not in IMAGE_EXTENSIONS or p in seen:
                continue
            seen.add(p)
            found.append(p)
    for root in flat_roots:
        if not root.exists():
            continue
        for p in root.iterdir():
            if not p.is_file() or _is_hidden(p.name):
                continue
            if p.suffix.lower() not in IMAGE_EXTENSIONS or p in seen:
                continue
            seen.add(p)
            found.append(p)

    ordered: list[tuple[Path, object]] = []
    for p in found:
        try:
            ordered.append((p, p.stat()))
        except OSError:
            continue
    ordered.sort(key=lambda item: _preview_sort_key(item[0], item[1]))
    result = []
    for p, stat in ordered:
        try:
            rel = str(p.relative_to(od)).replace("\\", "/")
        except ValueError:
            continue
        version = f"{stat.st_mtime_ns}-{stat.st_size}"
        result.append({
            "name": p.name,
            "path": rel,
            "url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="original", version=version),
            "inspect_url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="inspect", version=version),
            "thumb_url": build_image_preview_url(scope="artifact", run_dir=run_dir, path=rel, variant="thumb", size=320, version=version),
            "metadata_url": f"/api/monitor/preview-metadata?run_dir={quote(run_dir, safe='')}&path={quote(rel, safe='/')}&v={version}",
            "size": stat.st_size,
            "version": version,
        })
    _store_previews(cache_key, result)
    return result[-limit:] if limit else result


# 日志/元数据文件在输出列表中归为"其他"分类，便于前端区分模型/样本/日志
META_FILES = {"config.toml", "training.yaml", "run_info.txt", "output_dir.txt", "prompts.txt", "result.json",
               "error.log", "task_meta.json"}


def _output_file_paths(run_dir: str):
    """计数与文件列表共用目录范围及隐藏项规则。"""
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    if not rd.exists() or not rd.is_dir():
        return
    for p in _iter_dir(rd):
        if not p.is_file():
            continue
        try:
            rel = str(p.relative_to(rd)).replace("\\", "/")
        except ValueError:
            continue
        yield p, rel


def read_output_summary(run_dir: str) -> dict:
    """轻量总数与模型变更签名；不读取样本/日志等文件的元数据或解析检查点。"""
    count, models = 0, []
    for path, rel in _output_file_paths(run_dir):
        count += 1
        if path.suffix.lower() in LORA_EXTENSIONS:
            stat = path.stat()
            models.append((rel, stat.st_size, stat.st_mtime_ns))
    return {"count": count, "models": sorted(models)}


def list_output_files(run_dir: str) -> list[dict]:
    """列出已由调用方验证的产物目录，路径统一相对该目录返回。"""
    result = []
    for p, rel in _output_file_paths(run_dir):
        suffix = p.suffix.lower()
        is_lora = suffix in LORA_EXTENSIONS
        is_image = suffix in IMAGE_EXTENSIONS
        if is_lora:
            category = "model"
        elif is_image:
            category = "sample"
        elif p.name in META_FILES or suffix in {".log", ".txt"}:
            category = "log"
        elif "events.out.tfevents" in p.name or suffix == ".tfevents":
            category = "tensorboard"
        else:
            category = "other"
        stat = p.stat()
        entry = {
            "name": p.name,
            "path": rel,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "is_lora": is_lora,
            "category": category,
        }
        # 模型文件：从文件名解析 checkpoint 编号（loss 由路由层注入，需 TB series）
        if is_lora:
            info = parse_checkpoint(p.name)
            if info:
                entry["ckpt_type"] = info["type"]
                entry["ckpt_epoch"] = info["epoch_no"]
                entry["ckpt_step"] = info["step"]
            else:
                entry["ckpt_type"] = None
                entry["ckpt_epoch"] = None
                entry["ckpt_step"] = None
                entry["ckpt_loss"] = None
        result.append(entry)
    # 模型文件优先，其次样本，再日志，最后其他；同类按修改时间倒序
    cat_order = {"model": 0, "sample": 1, "log": 2, "tensorboard": 3, "other": 4}
    result.sort(key=lambda f: (cat_order.get(f["category"], 9), -f["mtime"]))
    return result
