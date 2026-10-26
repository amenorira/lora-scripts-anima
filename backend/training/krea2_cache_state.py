"""Per-stage cache reuse with input fingerprints and unchanged output files."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

STAGES = ("latents", "text_encoder")


def stage_fingerprints(config: dict) -> dict[str, str]:
    from backend.training.musubi_krea2 import _krea2_cache_inputs

    inputs = _krea2_cache_inputs(config)
    payloads = {
        "latents": {key: inputs[key] for key in ("resolution", "enable_bucket", "bucket_no_upscale", "vae")},
        "text_encoder": {key: inputs[key] for key in ("caption_extension", "text_encoder")},
    }
    payloads["latents"]["dataset"] = [{key: value for key, value in item.items() if key != "caption"}
                                      for item in inputs["dataset"]]
    payloads["latents"]["vae_tiling"] = bool(config.get("krea_cache_vae_tiling", False))
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
    from backend.training.musubi_krea2 import _krea2_dataset_groups, _KREA2_CACHE_ARCHITECTURE

    suffix = f"_{_KREA2_CACHE_ARCHITECTURE}{'_te' if stage == 'text_encoder' else ''}.safetensors"
    files = [path for _, cache, _ in _krea2_dataset_groups(config)
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
    from backend.training.musubi_krea2 import _read_cache_manifest, cache_manifest_path, get_krea2_cache_status

    if stage not in STAGES:
        raise ValueError(f"Unknown cache stage: {stage}")
    manifest, _ = _read_cache_manifest(config["dataset_cache_dir"])
    status = get_krea2_cache_status(config)
    if (manifest.get("stage_fingerprints", {}).get(stage) != stage_fingerprints(config)[stage]
            or not status["image_count"] or not status["stage_files_match"][stage] or status["conflicts"]):
        raise ValueError(f"{stage}: cache inputs changed or output files are incomplete / 缓存输入已变化或文件不完整")
    manifest.setdefault("outputs", {})[stage] = collect_stage_outputs(config, stage)
    manifest.setdefault("stages", {})[stage] = "completed"
    write_manifest(cache_manifest_path(config["dataset_cache_dir"]), manifest)
