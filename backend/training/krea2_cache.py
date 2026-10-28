"""Krea 2 cache validation, manifests and per-stage reuse."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any

from backend.training.krea2_dataset import dataset_groups, image_files, parse_krea2_resolution

KREA2_CACHE_MANIFEST_NAME = ".krea2-cache.json"
_LEGACY_KREA2_CACHE_MANIFEST_NAMES = (".anima-krea2-cache.json",)
# Musubi uses its short architecture ID in filenames; "krea2" is metadata only.
_KREA2_CACHE_ARCHITECTURE = "kr2"
STAGES = ("latents", "text_encoder")


def _krea2_cache_conflicts(groups: list[tuple[Path, Path, list[Path]]]) -> list[str]:
    """Musubi drops image extensions; each directory must have unique cache keys."""
    conflicts = []
    for directory, _, images in groups:
        by_key: dict[str, list[str]] = {}
        for image in images:
            by_key.setdefault(os.path.normcase(image.stem), []).append(image.name)
        for names in by_key.values():
            if len(names) > 1:
                conflicts.append(
                    "Images share a Krea 2 cache key; rename the conflicting files / "
                    f"图片缓存名称冲突，请重命名同名图片: {directory}: {', '.join(names)}"
                )
    return conflicts


def _path_identity(path_value: Any) -> dict[str, Any]:
    path = Path(str(path_value or ""))
    try:
        stat = path.stat()
    except OSError:
        return {"path": str(path), "missing": True}
    return {"path": str(path.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _krea2_cache_inputs(config: dict[str, Any], images: list[Path] | None = None) -> dict:
    """Describe the inputs that determine cache contents."""

    cache_dir = config.get("dataset_cache_dir")
    root = Path(str(config.get("train_data_dir") or ""))
    entries: list[dict[str, Any]] = []
    if images is None:
        images = image_files(str(config.get("train_data_dir") or ""), cache_dir, str(config.get("caption_extension") or ".txt"))
    for image in sorted(images):
        try:
            stat = image.stat()
        except OSError:
            continue
        caption = image.with_suffix(str(config.get("caption_extension") or ".txt"))
        item: dict[str, Any] = {
            "image": str(image.relative_to(root)).replace("\\", "/"),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
        try:
            caption_stat = caption.stat()
            item["caption"] = {
                "exists": True,
                "size": caption_stat.st_size,
                "mtime_ns": caption_stat.st_mtime_ns,
            }
        except OSError:
            item["caption"] = {"exists": False}
        entries.append(item)

    width, height = parse_krea2_resolution(config.get("resolution", "1024,1024"))
    payload = {
        "schema": 2,
        "dataset": entries,
        "resolution": [width, height],
        "enable_bucket": bool(config.get("enable_bucket", True)),
        "bucket_no_upscale": bool(config.get("bucket_no_upscale", True)),
        "caption_extension": str(config.get("caption_extension") or ".txt"),
        "vae": _path_identity(config.get("vae")),
        "text_encoder": _path_identity(config.get("text_encoder")),
    }
    if config.get("krea_cache_vae_tiling"):
        payload["vae_tiling"] = True
    return payload


def krea2_cache_fingerprint(config: dict[str, Any], images: list[Path] | None = None) -> str:
    return _fingerprint_inputs(_krea2_cache_inputs(config, images))


def _fingerprint_inputs(inputs: dict) -> str:
    encoded = json.dumps(inputs, ensure_ascii=False,
                         separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cache_manifest_path(cache_dir: str | Path) -> Path:
    return Path(cache_dir) / KREA2_CACHE_MANIFEST_NAME


def read_cache_manifest(cache_dir: str | Path) -> tuple[dict[str, Any], Path]:
    """Read the current manifest first, with a one-way compatibility fallback.

    Earlier builds called the Krea-specific cache file ``.anima-krea2-cache``.
    That was only an application-owned filename, never an upstream model
    setting, but it incorrectly suggested an Anima/Krea relationship.  Keep
    old cache metadata readable so renaming it does not make users recache.
    """

    directory = Path(cache_dir)
    paths = (cache_manifest_path(directory),) + tuple(
        directory / name for name in _LEGACY_KREA2_CACHE_MANIFEST_NAMES
    )
    for path in paths:
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(manifest, dict):
            return manifest, path
    return {}, cache_manifest_path(directory)


def prepare_cache_manifest(config: dict[str, Any]) -> dict[str, Any]:
    """Persist a pending cache request before the worker process starts."""
    cache_dir = Path(str(config["dataset_cache_dir"]))
    cache_dir.mkdir(parents=True, exist_ok=True)
    previous, _ = read_cache_manifest(cache_dir)
    groups = dataset_groups(config)
    inputs = _krea2_cache_inputs(config, [image for _, _, images in groups for image in images])
    fingerprints = _stage_fingerprints(inputs)
    fingerprint = _fingerprint_inputs(inputs)
    status = _cache_status(config, groups, fingerprint, previous)
    reuse = reusable_stages(config, previous, status, fingerprints)
    payload = {
        "schema": 2,
        "profile": "krea2-lora",
        "fingerprint": fingerprint,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "stage_fingerprints": fingerprints,
        "stages": {stage: "completed" if reuse[stage] else "pending" for stage in reuse},
        "outputs": {stage: previous["outputs"][stage] for stage in reuse if reuse[stage]},
    }
    write_manifest(cache_manifest_path(cache_dir), payload)
    return payload


def mark_cache_manifest(config: dict[str, Any], status: str) -> str | None:
    """Settle both cache stages and return any completion validation error."""
    path = cache_manifest_path(config["dataset_cache_dir"])
    manifest, _ = read_cache_manifest(config["dataset_cache_dir"])
    if not manifest:
        manifest = prepare_cache_manifest(config)
    errors = []
    if status == "completed":
        try:
            cache_status = get_krea2_cache_status(config)
            if not cache_status["image_count"]:
                errors.append("Dataset has no captioned images / 数据集没有带标注的可用图片")
            if not cache_status["fingerprint_matches"]:
                errors.append("Dataset or cache inputs changed during caching; rebuild the cache / 缓存生成期间数据集或缓存输入发生变化，请重新生成缓存")
            if not cache_status["files_match"]:
                errors.append(
                    "Cache files do not match the dataset / 缓存文件缺失、多余、重复或名称不匹配 "
                    f"(images={cache_status['image_count']}, latents={cache_status['latent_count']}, "
                    f"text={cache_status['text_encoder_count']})"
                )
            for stage in STAGES:
                if (manifest.get("stages", {}).get(stage) == "completed"
                        and "outputs" in manifest and not cache_status["stage_outputs_match"][stage]):
                    errors.append(f"{stage}: cache outputs changed after completion / 阶段完成后缓存文件发生变化")
            errors.extend(cache_status["conflicts"])
            if not errors:
                manifest["outputs"] = {stage: collect_stage_outputs(config, stage) for stage in STAGES}
                manifest["stage_fingerprints"] = stage_fingerprints(config)
        except Exception as exc:
            errors.append(f"Failed to validate Krea 2 cache / Krea 2 缓存校验失败: {exc}")
    error = "; ".join(errors) or None
    succeeded = status == "completed" and not error
    if succeeded:
        manifest["stages"] = dict.fromkeys(STAGES, "completed")
    else:
        try:
            reusable = reusable_stages({**config, "krea_cache_reuse": True}, manifest,
                                       get_krea2_cache_status(config), stage_fingerprints(config))
        except (OSError, TypeError, ValueError):
            reusable = dict.fromkeys(STAGES, False)
        manifest["stages"] = {stage: "completed" if reusable[stage] else "failed" for stage in STAGES}
    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    manifest["error"] = error
    write_manifest(path, manifest)
    return error


def get_krea2_cache_status(config: dict[str, Any]) -> dict[str, Any]:
    """Inspect cache files and their fingerprint without importing musubi."""
    groups = dataset_groups(config)
    images = [image for _, _, group_images in groups for image in group_images]
    try:
        fingerprint = krea2_cache_fingerprint(config, images)
    except (TypeError, ValueError):
        fingerprint = ""
    manifest, _ = read_cache_manifest(str(config.get("dataset_cache_dir") or ""))
    return _cache_status(config, groups, fingerprint, manifest)


def _cache_status(config: dict, groups: list, fingerprint: str, manifest: dict) -> dict:
    """Evaluate a single filesystem snapshot without rescanning its dataset."""
    cache_dir = Path(str(config.get("dataset_cache_dir") or ""))
    conflicts = _krea2_cache_conflicts(groups)
    images = [image for _, _, group_images in groups for image in group_images]
    latent_files = []
    text_files = []
    complete_latents = complete_texts = True
    for _, group_cache, group_images in groups:
        group_latents = [
            path
            for path in group_cache.glob(f"*_{_KREA2_CACHE_ARCHITECTURE}.safetensors")
            if path.is_file()
        ]
        group_texts = [path for path in group_cache.glob(f"*_{_KREA2_CACHE_ARCHITECTURE}_te.safetensors") if path.is_file()]
        latent_files.extend(group_latents)
        text_files.extend(group_texts)
        # The trainer scans every latent cache in this namespace. Counts alone
        # allow unrelated entries to replace missing images, or duplicate sizes
        # of one image to enter training. Require exactly one latent per key and
        # exactly the current text-cache paths, including filesystem case rules.
        expected_keys = Counter(os.path.normcase(image.stem) for image in group_images)
        latent_keys = []
        for path in group_latents:
            match = re.fullmatch(rf"(.+)_(\d{{4,}})x(\d{{4,}})_{_KREA2_CACHE_ARCHITECTURE}\.safetensors", path.name)
            if match and int(match[2]) > 0 and int(match[3]) > 0:
                latent_keys.append(os.path.normcase(match[1]))
        expected_texts = {group_cache / f"{image.stem}_{_KREA2_CACHE_ARCHITECTURE}_te.safetensors" for image in group_images}
        complete_latents = complete_latents and (
            len(latent_keys) == len(group_latents)
            and Counter(latent_keys) == expected_keys
        )
        complete_texts = complete_texts and set(group_texts) == expected_texts

    recorded_outputs = manifest.get("outputs") if isinstance(manifest.get("outputs"), dict) else {}
    stage_outputs_match = {
        stage: outputs_match(cache_dir, files, recorded_outputs.get(stage))
        for stage, files in (("latents", latent_files), ("text_encoder", text_files))
    }
    complete_groups = complete_latents and complete_texts

    matches = bool(fingerprint and manifest.get("fingerprint") == fingerprint)
    stages = manifest.get("stages") if isinstance(manifest.get("stages"), dict) else {}
    expected = len(images)
    ready = (
        expected > 0
        and matches
        and stages.get("latents") == "completed"
        and stages.get("text_encoder") == "completed"
        and complete_groups
        and ("outputs" not in manifest or all(stage_outputs_match.values()))
        and not conflicts
    )
    return {
        "cache_dir": str(cache_dir),
        "image_count": expected,
        "latent_count": len(latent_files),
        "text_encoder_count": len(text_files),
        "fingerprint_matches": matches,
        "stages": stages,
        "files_match": complete_groups,
        "stage_files_match": {"latents": complete_latents, "text_encoder": complete_texts},
        "stage_outputs_match": stage_outputs_match,
        "conflicts": conflicts,
        "ready": ready,
    }


def stage_fingerprints(config: dict) -> dict[str, str]:
    return _stage_fingerprints(_krea2_cache_inputs(config))


def _stage_fingerprints(inputs: dict) -> dict[str, str]:
    payloads = {
        "latents": {key: inputs[key] for key in ("resolution", "enable_bucket", "bucket_no_upscale", "vae")},
        "text_encoder": {key: inputs[key] for key in ("caption_extension", "text_encoder")},
    }
    payloads["latents"]["dataset"] = [{key: value for key, value in item.items() if key != "caption"}
                                      for item in inputs["dataset"]]
    payloads["latents"]["vae_tiling"] = bool(inputs.get("vae_tiling", False))
    payloads["text_encoder"]["dataset"] = [{key: item[key] for key in ("image", "caption")}
                                           for item in inputs["dataset"]]
    return {stage: hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
            for stage, payload in payloads.items()}


def output_records(cache_dir: str | Path, files: list[Path]) -> dict[str, Any]:
    root = Path(cache_dir).resolve()
    records = {}
    for path in files:
        stat = path.stat()
        if stat.st_size <= 0:
            raise ValueError(f"Empty cache file / 缓存文件为空: {path}")
        records[path.resolve().relative_to(root).as_posix()] = [stat.st_size, stat.st_mtime_ns]
    return records


def outputs_match(cache_dir: str | Path, files: list[Path], expected: Any) -> bool:
    if not isinstance(expected, dict) or not expected:
        return False
    try:
        return output_records(cache_dir, files) == expected
    except (OSError, ValueError):
        return False


def collect_stage_outputs(config: dict, stage: str) -> dict:
    suffix = f"_{_KREA2_CACHE_ARCHITECTURE}{'_te' if stage == 'text_encoder' else ''}.safetensors"
    files = [path for _, cache, _ in dataset_groups(config)
             for path in cache.glob(f"*{suffix}") if path.is_file()]
    return output_records(config["dataset_cache_dir"], files)


def reusable_stages(config: dict, manifest: dict, status: dict, fingerprints: dict) -> dict[str, bool]:
    stages = manifest.get("stages") if isinstance(manifest.get("stages"), dict) else {}
    previous = manifest.get("stage_fingerprints") if isinstance(manifest.get("stage_fingerprints"), dict) else {}
    return {stage: bool(config.get("krea_cache_reuse", True)
                        and stages.get(stage) == "completed"
                        and previous.get(stage) == fingerprints[stage]
                        and status["stage_files_match"][stage]
                        and status["stage_outputs_match"][stage]
                        and not status["conflicts"])
            for stage in STAGES}


def write_manifest(path: Path, manifest: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def complete_stage(config: dict, stage: str) -> None:
    if stage not in STAGES:
        raise ValueError(f"Unknown cache stage: {stage}")
    manifest, _ = read_cache_manifest(config["dataset_cache_dir"])
    status = get_krea2_cache_status(config)
    if (manifest.get("stage_fingerprints", {}).get(stage) != stage_fingerprints(config)[stage]
            or not status["image_count"] or not status["stage_files_match"][stage] or status["conflicts"]):
        raise ValueError(f"{stage}: cache inputs changed or output files are incomplete / 缓存输入已变化或文件不完整")
    manifest.setdefault("outputs", {})[stage] = collect_stage_outputs(config, stage)
    manifest.setdefault("stages", {})[stage] = "completed"
    write_manifest(cache_manifest_path(config["dataset_cache_dir"]), manifest)
