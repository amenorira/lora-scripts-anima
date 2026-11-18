"""训练样本、输出文件扫描与短期缓存。"""
from __future__ import annotations

import hashlib
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
from backend.monitor.sample_loss import enrich_sample_loss
from backend.monitor.sample_metadata import legacy_sample_metadata, read_sample_records, sample_manifest_version

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# 隐藏 / 缓存目录名前缀与名称，扫描时一律跳过（避免 .ipynb_checkpoints、__pycache__ 等污染）
_HIDDEN_PREFIXES = (".", "__")
_TRAINING_SAMPLE_RE = re.compile(
    r"(?:^|_)(?P<progress>e?\d{6})_(?P<prompt>\d{2,})_(?P<timestamp>\d{14})(?:_-?\d+)?(?:_\d{3})?$",
    re.IGNORECASE,
)


def _is_hidden(name: str) -> bool:
    """判断目录/文件名是否为隐藏或缓存项（.开头 或 __开头）。"""
    return name.startswith(_HIDDEN_PREFIXES)


def _iter_files(root: Path, *, recursive: bool = True):
    """Reuse directory entries for type and stat, pruning hidden directories."""
    pending = [(root, "")]
    while pending:
        directory, prefix = pending.pop()
        children = []
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if _is_hidden(entry.name):
                        continue
                    try:
                        if entry.is_file():
                            yield entry, prefix + entry.name
                        elif recursive and not entry.is_symlink() and entry.is_dir():
                            children.append((entry.path, prefix + entry.name + "/"))
                    except OSError:
                        continue
        except OSError:
            pass
        pending.extend(reversed(children))


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
_previews_cache: OrderedDict[str, tuple[float, str, list[dict]]] = OrderedDict()
_PREVIEWS_CACHE_TTL = 5.0
_PREVIEWS_CACHE_MAX_RUNS = 8


def _store_previews(cache_key: str, result: list[dict], metadata_version: str) -> None:
    with _previews_cache_lock:
        _previews_cache[cache_key] = (time.time(), metadata_version, result)
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
    metadata_version = sample_manifest_version(output_dir, force_refresh=force_refresh) if output_dir else ""
    cache_key = f"{run_dir}|{output_dir or ''}"
    with _previews_cache_lock:
        cached = _previews_cache.get(cache_key)
        if not force_refresh and cached and cached[1] == metadata_version and now - cached[0] < _PREVIEWS_CACHE_TTL:
            _previews_cache.move_to_end(cache_key)
            return cached[2][-limit:] if limit else cached[2]

    if not output_dir:
        _store_previews(cache_key, [], metadata_version)
        return []
    try:
        od = Path(output_dir).resolve()
    except OSError:
        _store_previews(cache_key, [], metadata_version)
        return []

    ordered = []
    seen: set[Path] = set()
    for root, recursive in ((od / "sample", True), (od / "outputs" / "sample", True),
                            (od, False), (od / "outputs", False)):
        for entry, _ in _iter_files(root, recursive=recursive):
            if os.path.splitext(entry.name)[1].lower() not in IMAGE_EXTENSIONS:
                continue
            path = Path(entry.path)
            if path in seen:
                continue
            seen.add(path)
            try:
                ordered.append((path, entry.stat()))
            except OSError:
                continue
    ordered.sort(key=lambda item: _preview_sort_key(item[0], item[1]))
    result = []
    for p, stat in ordered:
        rel = p.relative_to(od).as_posix()
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
    # Manual refresh retries failed/partial reads even when file stamps match.
    previous = {item["path"]: item for item in cached[2]} if not force_refresh and cached and cached[1] == metadata_version else {}
    recorded, unresolved = {}, {}
    for item in result:
        prior = previous.get(item["path"])
        if prior and prior["version"] == item["version"]:
            if prior["sample"].get("metadata_source") != "recorded":
                # Retry negative lookups on manifest changes or manual refresh.
                continue
            if prior["sample"].get("step_source") != "log":
                recorded[item["path"]] = dict(prior["sample"])
                continue
        unresolved[item["path"]] = item["version"]
    if unresolved:
        recorded.update(read_sample_records(od, unresolved))
    for item in result:
        item["sample"] = recorded.get(item["path"]) or legacy_sample_metadata(item["name"], item["path"])
        item["sample"]["metadata_version"] = metadata_version
    enrich_sample_loss(result, od, run_dir)
    for item in result:
        sample = item["sample"]
        if sample.get("step_source") == "log":
            # The recovered value can appear after the image; unrelated log
            # appends must not continuously invalidate realtime previews.
            call_digest = hashlib.sha256(sample["batch_id"].encode("utf-8")).hexdigest()[:24]
            sample["metadata_version"] += f":log-call:{call_digest}:log-step:{sample['step']}"
            if sample.get("metadata_source") == "filename" and isinstance(sample.get("params", {}).get("prompt"), str):
                prompt_digest = hashlib.sha256(sample["params"]["prompt"].encode("utf-8")).hexdigest()[:24]
                sample["metadata_version"] += f":log-prompt:{prompt_digest}"
    _store_previews(cache_key, result, metadata_version)
    return result[-limit:] if limit else result


# 日志/元数据文件在输出列表中归为"其他"分类，便于前端区分模型/样本/日志
META_FILES = {"config.toml", "training.yaml", "run_info.txt", "output_dir.txt", "prompts.txt", "result.json",
               "error.log", "task_meta.json"}


def _output_entries(run_dir: str):
    """计数与文件列表共用目录范围及隐藏项规则。"""
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    return _iter_files(rd)


def read_output_summary(run_dir: str) -> dict:
    """轻量总数与模型变更签名；不读取样本/日志等文件的元数据或解析检查点。"""
    count, image_count, models = 0, 0, []
    for entry, rel in _output_entries(run_dir):
        count += 1
        suffix = os.path.splitext(entry.name)[1].lower()
        if suffix in IMAGE_EXTENSIONS:
            image_count += 1
        elif suffix in LORA_EXTENSIONS:
            stat = entry.stat()
            models.append((rel, stat.st_size, stat.st_mtime_ns))
    return {"count": count, "image_count": image_count, "models": sorted(models)}


def list_output_files(run_dir: str) -> list[dict]:
    """列出已由调用方验证的产物目录，路径统一相对该目录返回。"""
    result = []
    for file, rel in _output_entries(run_dir):
        suffix = os.path.splitext(file.name)[1].lower()
        is_lora = suffix in LORA_EXTENSIONS
        is_image = suffix in IMAGE_EXTENSIONS
        if is_lora:
            category = "model"
        elif is_image:
            category = "sample"
        elif file.name in META_FILES or suffix in {".log", ".txt"}:
            category = "log"
        elif "events.out.tfevents" in file.name or suffix == ".tfevents":
            category = "tensorboard"
        else:
            category = "other"
        stat = file.stat()
        entry = {
            "name": file.name,
            "path": rel,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "is_lora": is_lora,
            "category": category,
        }
        # 模型文件：从文件名解析 checkpoint 编号（loss 由路由层注入，需 TB series）
        if is_lora:
            info = parse_checkpoint(file.name)
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
