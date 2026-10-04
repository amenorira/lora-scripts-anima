"""Durable, atomic manifests and confined output paths."""
import json
import os
import uuid
import copy
import threading
from collections import OrderedDict
from pathlib import Path

from backend.constants import REPO_ROOT

OUTPUT_ROOT = REPO_ROOT / "train" / "regularization"
_manifest_cache = OrderedDict()
_cache_lock = threading.Lock()


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_manifest(root: Path, manifest: dict):
    atomic_write(root / "generation.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    save_progress(root, manifest_summary(manifest))


def read_manifest(root: Path, *, readonly=False):
    path = root / "generation.json"
    with _cache_lock:
        stat = path.stat()
        revision = (stat.st_mtime_ns, stat.st_size)
        cached = _manifest_cache.get(path)
        if cached is None or cached[0] != revision:
            cached = (revision, json.loads(path.read_text(encoding="utf-8")))
            _manifest_cache[path] = cached
        _manifest_cache.move_to_end(path)
        while len(_manifest_cache) > 2:
            _manifest_cache.popitem(last=False)
        # Mutation callers own a copy; result/thumbnail readers share the latest
        # immutable view, bounded to two runs rather than every past revision.
        return cached[1] if readonly else copy.deepcopy(cached[1])


def manifest_summary(manifest):
    result = {key: manifest.get(key) for key in (
        "task_id", "status", "phase", "step", "steps", "current_index", "error", "updated_at", "master_seed")}
    items = manifest["items"]
    result.update(total=len(items), completed=0, failed=0, excluded=0)
    for item in items:
        if item["status"] in ("completed", "failed", "excluded"):
            result[item["status"]] += 1
    result["pending"] = result["total"] - result["completed"] - result["excluded"]
    return result


def save_progress(root, progress):
    atomic_write(root / "progress.json", json.dumps(progress, ensure_ascii=False).encode("utf-8"))


def read_progress(root):
    try:
        return json.loads((root / "progress.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return manifest_summary(read_manifest(root, readonly=True))


def run_path(key: str) -> Path:
    if not key or Path(key).name != key or "/" in key or "\\" in key or not key.startswith("reg_"):
        raise ValueError("Invalid result directory / 结果目录无效")
    result = OUTPUT_ROOT / key
    if result.resolve().parent != OUTPUT_ROOT.resolve() or result.is_symlink():
        raise ValueError("Result directory escapes output root / 结果目录超出输出范围")
    return result


def item_filename(item):
    """Use the persisted name; manifests predating source names retain their files."""
    index = int(item["index"])
    if index < 1:
        raise ValueError("Invalid image index")
    name = item.get("filename", f"reg_{index:06d}.png")
    if not isinstance(name, str) or not name.endswith(".png") or name == ".png" or any(c in name for c in '/\\<>:"|?*\x00'):
        raise ValueError("Invalid output filename / 输出文件名无效")
    return name


def item_path(root: Path, item: dict, suffix=".png"):
    # Names come from the server's manifest, never an HTTP filename parameter.
    name = Path(item_filename(item)).with_suffix(suffix).name
    folder = "excluded" if item.get("status") == "excluded" else "1_reg"
    target = root / folder / name
    expected_parent = root.resolve() / folder
    if target.parent.resolve() != expected_parent or target.resolve() != expected_parent / target.name:
        raise ValueError("Output image path escapes result directory / 图片路径超出结果目录")
    return target
