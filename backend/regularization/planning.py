"""Read-only input scan and deterministic, reviewable generation plans."""
import hashlib
import json
import math
import re
import secrets
from collections import Counter
from pathlib import Path
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.constants import REPO_ROOT
from . import storage


class Settings(BaseModel):
    model_config = ConfigDict(validate_default=True, extra="forbid")
    source_dir: str = "./train"
    model_type: Literal["anima", "sdxl"] = "anima"
    checkpoint: str = ""
    sdxl_vae: str = ""
    dit: str = "./models/anima-base-v1.0.safetensors"
    text_encoder: str = "./models/qwen_3_06b_base.safetensors"
    vae: str = "./models/qwen_image_vae.safetensors"
    ignore_first: int = Field(0, ge=0, le=10000)
    exclude_tags: str = ""
    extra_positive: str = ""
    negative: str = ""
    per_image: int = Field(1, ge=1, le=1000)
    expand_repeats: bool = False
    seed: int = Field(-1, ge=-1, le=2**63 - 1)
    sampler: Literal["euler", "euler_a", "heun", "dpmpp_2m", "dpmpp_2m_sde", "er_sde"] = "euler_a"
    scheduler: Literal["simple", "normal", "sgm_uniform", "beta", "karras", "exponential", "flux2", "linear"] = "simple"
    steps: int = Field(32, ge=1, le=1000)
    cfg: float = Field(4, ge=0, le=100)
    flow_shift: float = Field(3, ge=.01, le=100)
    size_mode: Literal["auto", "bucket", "fixed"] = "auto"
    width: int = Field(1024, ge=32, le=4096, multiple_of=32)
    height: int = Field(1024, ge=32, le=4096, multiple_of=32)
    resolution: str = "1024,1024"
    enable_bucket: bool = True
    bucket_no_upscale: bool = False
    min_bucket_reso: int = Field(256, ge=16, le=4096)
    max_bucket_reso: int = Field(2048, ge=32, le=4096)
    bucket_reso_steps: int = Field(64, ge=16, le=512, multiple_of=16)
    memory_mode: Literal["auto", "manual"] = "auto"
    precision: Literal["bf16", "fp16"] = "bf16"
    blocks_to_swap: int = Field(0, ge=0, le=26)
    text_encoder_cpu: bool = True
    gpu_index: int = Field(0, ge=0, le=31)

    @model_validator(mode="after")
    def validate_sdxl(self):
        if self.model_type == "sdxl":
            if self.sampler == "er_sde" or self.scheduler not in {"normal", "karras", "exponential"}:
                raise ValueError("SDXL supports Euler/Euler ancestral/Heun/DPM++ with normal, karras or exponential schedules / SDXL 请使用兼容的采样器和调度器")
            if self.sampler == "euler_a" and self.scheduler != "normal":
                raise ValueError("SDXL Euler ancestral requires normal schedule / SDXL Euler ancestral 请使用 normal 调度器")
            if self.memory_mode == "manual" and self.blocks_to_swap:
                raise ValueError("SDXL does not use Anima block swap / SDXL 不支持 Anima 块交换，请使用自动显存管理")
        return self


def metadata():
    defaults = Settings().model_dump()
    defaults["seed"] = str(defaults["seed"])
    return {"defaults": defaults, "fields": Settings.model_json_schema()["properties"]}


def resolve_input(value):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else REPO_ROOT / path).resolve()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def tag_key(tag):
    return re.sub(r"[\s_]+", "", tag).casefold()


def clean_caption(caption, ignore_first=0, exclude_tags=""):
    tags = [tag.strip() for tag in caption.split(",") if tag.strip()]
    excluded = {tag_key(tag) for tag in exclude_tags.split(",") if tag.strip()}
    return ", ".join(tag for tag in tags[ignore_first:] if tag_key(tag) not in excluded)


def actual_prompt(caption, extra):
    return ", ".join(part.strip().strip(",").strip() for part in (extra, caption) if part.strip().strip(",").strip())


def source_stamp(path):
    stat = path.stat()
    return [str(path), stat.st_size, stat.st_mtime_ns]


def scan(settings: Settings, overrides=None):
    root = resolve_input(settings.source_dir)
    output_root = storage.OUTPUT_ROOT.resolve()
    if not root.is_dir() or root == root.parent:
        raise ValueError("Select a dataset directory / 请选择训练集目录")
    if root.is_relative_to(output_root):
        raise ValueError("Generated results cannot be source datasets / 不能使用本功能输出目录作为来源")
    overrides = overrides or {}
    bucket = None
    if settings.size_mode == "bucket":
        # Use precisely the same bucket selection as training, without loading models.
        from backend.training.step_estimator import _sd_dataset_helpers, _parse_resolution, _adjust_bucket_range
        BucketManager, _, _ = _sd_dataset_helpers()
        resolution = _parse_resolution(settings.resolution)
        if any(v < 32 or v > 4096 or v % 16 for v in resolution):
            raise ValueError("Training resolution must be a multiple of 16 / Anima 训练分辨率必须为 16 的倍数")
        if settings.enable_bucket:
            low, high = _adjust_bucket_range(resolution, settings.min_bucket_reso, settings.max_bucket_reso, settings.bucket_reso_steps)
            bucket = BucketManager(settings.bucket_no_upscale, resolution, low, high, settings.bucket_reso_steps)
            if not settings.bucket_no_upscale:
                bucket.make_buckets()
        else:
            bucket = BucketManager(False, resolution, None, None, None)
            bucket.set_predefined_resos([resolution])
    sources = []
    extensions = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    from backend.training.sd_dataset_config import _dreambooth_subsets
    subsets = _dreambooth_subsets(str(root), is_reg=False)
    # A training root uses the trainer's subset rules. A selected flat image
    # directory is also supported, but an explicitly disabled subset is not.
    if subsets or any(p.is_dir() and re.match(r"^-?\d+_", p.name) for p in root.iterdir()):
        scan_roots = [(Path(s["image_dir"]), s["num_repeats"]) for s in subsets]
    else:
        match = re.match(r"^(-?\d+)_", root.name)
        repeats = int(match[1]) if match else 1
        scan_roots = [(root, repeats)] if repeats > 0 else []
    paths = [(path, repeats) for directory, repeats in scan_roots for path in directory.iterdir()]
    for path, repeats in sorted(paths, key=lambda pair: str(pair[0]).casefold()):
        relative = path.relative_to(root)
        if not path.is_file() or path.suffix.lower() not in extensions or path.is_symlink():
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            continue
        if resolved.is_relative_to(output_root):
            continue
        if any(p.casefold() in {"cache", "caches", "masks", "mask", "excluded", ".cache"} or p.startswith(".") for p in relative.parts[:-1]):
            continue
        if path.stem.casefold().endswith(("_mask", "_alpha", "_depth")):
            continue
        item = {"source": str(path), "relative": relative.as_posix(), "repeats": repeats,
                "original_caption": "", "caption": "", "prompt": "", "reason": "", "stamp": source_stamp(path)}
        caption_path = path.with_suffix(".txt")
        try:
            raw = caption_path.read_bytes()
            item["caption_sha256"] = hashlib.sha256(raw).hexdigest()
            lines = raw.decode("utf-8-sig").splitlines()
            item["original_caption"] = lines[0] if lines else ""
            caption = clean_caption(item["original_caption"], settings.ignore_first, settings.exclude_tags)
            if relative.as_posix() in overrides:
                caption = str(overrides[relative.as_posix()]).strip()
                if "\n" in caption or "\r" in caption:
                    raise ValueError("Caption must be a single line / 标签必须为一行")
            item["caption"] = caption
            if not caption:
                raise ValueError("Empty caption after cleaning / 清理后标签为空")
            with Image.open(path) as image:
                w, h = image.size
                # Match the displayed orientation without decoding/resizing pixels.
                if image.getexif().get(274) in (5, 6, 7, 8):
                    w, h = h, w
            if settings.size_mode == "auto":
                # Log-ratio distance treats portrait and landscape symmetrically
                # and chooses the aspect ratio requiring the least crop.
                size = min(((1024, 1024), (832, 1216), (1216, 832)),
                           key=lambda size: abs(math.log((w / h) / (size[0] / size[1]))))
            else:
                size = bucket.select_bucket(w, h)[0] if bucket else (settings.width, settings.height)
            # No-upscale bucket selection can return a non-32 size on small inputs.
            item["width"], item["height"] = [max(32, int(v) // 32 * 32) for v in size]
            item["prompt"] = actual_prompt(caption, settings.extra_positive)
            item["count"] = settings.per_image * (repeats if settings.expand_repeats else 1)
        except FileNotFoundError:
            item["reason"] = "Missing caption txt / 缺少标签 txt"
        except Exception as exc:
            item["reason"] = str(exc)
        sources.append(item)
    if not sources:
        raise ValueError("No source images found / 没有找到源图片")
    if sum(s.get("count", 0) for s in sources if not s["reason"]) > 100000:
        raise ValueError("Plan exceeds 100000 images / 单次计划超过 100000 张图片")
    return root, sources


def identity(settings, root, sources):
    config = settings.model_dump()
    config["source_dir"] = str(root)
    model_keys = ("checkpoint", "sdxl_vae") if settings.model_type == "sdxl" and settings.sdxl_vae.strip() else ("checkpoint",) if settings.model_type == "sdxl" else ("dit", "text_encoder", "vae")
    # Preserve fingerprints of existing Anima jobs.
    if settings.model_type == "anima":
        for key in ("model_type", "checkpoint", "sdxl_vae"):
            config.pop(key)
    for key in model_keys:
        path = resolve_input(config[key])
        if not path.is_file():
            raise ValueError(f"Model not found / 模型不存在: {path}")
        config[key] = str(path)
    models = [source_stamp(Path(config[k])) for k in model_keys]
    return config, digest({"settings": config, "sources": sources, "models": models})


def choose_output(root, fingerprint, new_round=False, *, settings=None, sources=None):
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", root.name).rstrip(". ") or "dataset"
    base = "reg_" + stem
    existing = []
    number = 1
    while True:
        key = base if number == 1 else f"{base}_{number}"
        target = storage.run_path(key)
        if not target.exists():
            return key, None, existing
        try:
            manifest = storage.read_manifest(target, readonly=True)
            existing.append({"run_key": key, "completed": sum(i["status"] == "completed" for i in manifest["items"]),
                             "source_dir": manifest["settings"]["source_dir"]})
            if not new_round and manifest.get("fingerprint") == fingerprint:
                return key, manifest, existing
            if not new_round and settings is not None and sources is not None:
                previous = manifest.get("sources", [])
                current = {s["relative"]: s for s in sources}
                # Only extend an unchanged plan. Recompute its identity to also
                # check model file revisions, including for legacy manifests.
                if (previous and all(current.get(s["relative"]) == s for s in previous)
                        and identity(settings, root, previous)[1] == manifest.get("fingerprint")):
                    return key, manifest, existing
        except (OSError, ValueError, KeyError):
            existing.append({"run_key": key, "completed": 0, "unrecognized": True})
        number += 1


def numbered_filename(stem, used, counters):
    key = stem.casefold()
    number = counters.get(key, 1)
    while f"{stem}_{number:03d}.png".casefold() in used:
        number += 1
    name = f"{stem}_{number:03d}.png"
    counters[key] = number + 1
    used.add(name.casefold())
    return name


def make_items(sources, seed):
    # Addition modulo 2**63 is injective over the bounded plan and stable across machines.
    items = []
    counts = Counter()
    for source in sources:
        if not source["reason"]:
            counts[Path(source["relative"]).stem.casefold()] += source["count"]
    # Reserve natural names first: variants of cat must not take cat_001.png
    # away from a different source actually named cat_001.jpg.
    used = {stem + ".png" for stem in counts}
    counters = {}
    for source in sources:
        if source["reason"]:
            continue
        for _ in range(source["count"]):
            index = len(items) + 1
            stem = Path(source["relative"]).stem
            filename = stem + ".png" if counts[stem.casefold()] == 1 else numbered_filename(stem, used, counters)
            items.append({"index": index, "source": source["source"], "relative": source["relative"],
                          "filename": filename,
                          "caption": source["caption"], "prompt": source["prompt"], "width": source["width"],
                          "height": source["height"], "seed": (seed + index * 6364136223846793005) % (2**63),
                          "status": "pending", "error": ""})
    return items


def extend_items(manifest, sources):
    """Append new sources without renaming or reseeding any saved result."""
    import copy
    items = copy.deepcopy(manifest["items"])
    previous = {s["relative"] for s in manifest["sources"]}
    additions = make_items([s for s in sources if s["relative"] not in previous], manifest["master_seed"])
    used = {storage.item_filename(item).casefold() for item in items}
    used.update(item["filename"].casefold() for item in additions)
    occupied = {storage.item_filename(item).casefold() for item in items}
    counters = {}
    index = max((item["index"] for item in items), default=0)
    for item in additions:
        index += 1
        if item["filename"].casefold() in occupied:
            item["filename"] = numbered_filename(Path(item["relative"]).stem, used, counters)
        occupied.add(item["filename"].casefold())
        item.update(index=index, seed=(manifest["master_seed"] + index * 6364136223846793005) % (2**63))
        items.append(item)
    return items


def random_seed():
    return secrets.randbelow(2**63)
