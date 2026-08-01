"""Structured ONNX model registry shared by the Tagger API and workspace UI."""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass

from backend.constants import HF_CACHE_DIR
from backend.monitor.hardware import gpu_info


@dataclass(frozen=True)
class TaggerModelSpec:
    id: str
    name: str
    engine: str
    family: str
    description: str
    download_bytes: int
    min_vram_gb: int
    supports_confidence: bool
    supports_categories: bool
    threshold_categories: tuple[str, ...]
    supports_character_toggle: bool
    supports_model_tag: bool


MODEL_SPECS: tuple[TaggerModelSpec, ...] = (
    TaggerModelSpec(
        "wd-eva02-large-tagger-v3", "WD EVA02 Large v3", "onnx", "tagger",
        "WD v3 EVA02-Large tagger for general, character, and rating tags",
        904_000_000, 2, True, True, (), True, False,
    ),
    TaggerModelSpec(
        "wd-vit-large-tagger-v3", "WD ViT Large v3", "onnx", "tagger",
        "WD v3 ViT-Large tagger for classic WD14 ViT workflows",
        904_000_000, 2, True, True, (), True, False,
    ),
    TaggerModelSpec(
        "cl_tagger_1_02", "CL Tagger v1.02", "onnx", "tagger",
        "Anime tagger with 42,163 tags including quality and model categories",
        747_000_000, 2, True, True,
        ("general", "character", "copyright", "artist", "meta", "quality", "rating"), False, True,
    ),
    TaggerModelSpec(
        "camie-tagger-v2", "Camie Tagger v2", "onnx", "tagger",
        "Danbooru 2024 ViT tagger with about 71K tags across seven confidence categories",
        733_000_000, 2, True, True,
        ("general", "character", "copyright", "artist", "meta", "year", "rating"), False, False,
    ),
)

MODEL_SPEC_BY_ID = {spec.id: spec for spec in MODEL_SPECS}
_onnx_install_cache: dict[str, tuple[float, bool]] = {}


def _onnx_installed(spec: TaggerModelSpec) -> bool:
    name_fragments = {
        "camie-tagger-v2": ("camie-tagger-v2.onnx",),
        "cl_tagger_1_02": ("model.onnx", "tag_mapping.json"),
        "wd-eva02-large-tagger-v3": ("model.onnx", "selected_tags.csv"),
        "wd-vit-large-tagger-v3": ("model.onnx", "selected_tags.csv"),
    }.get(spec.id, ())
    cached = _onnx_install_cache.get(spec.id)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    if not name_fragments or not HF_CACHE_DIR.exists():
        return False
    repo_dirs = {
        "camie-tagger-v2": "models--Camais03--camie-tagger-v2",
        "cl_tagger_1_02": "models--cella110n--cl_tagger",
        "wd-eva02-large-tagger-v3": "models--SmilingWolf--wd-eva02-large-tagger-v3",
        "wd-vit-large-tagger-v3": "models--SmilingWolf--wd-vit-large-tagger-v3",
    }
    repo_root = HF_CACHE_DIR / repo_dirs[spec.id]
    if not repo_root.is_dir():
        return False
    names = {path.name for path in repo_root.rglob("*") if path.is_file()}
    installed = all(name in names for name in name_fragments)
    _onnx_install_cache[spec.id] = (time.monotonic(), installed)
    return installed


def model_payload() -> dict:
    hardware = gpu_info() or {}
    models = []
    for spec in MODEL_SPECS:
        installed = _onnx_installed(spec)
        data = asdict(spec)
        data.update({
            "installed": installed,
            "status": "ready" if installed else "download_on_first_use",
        })
        models.append(data)
    return {
        "models": models,
        "hardware": {
            "nvidia": bool(hardware),
            "gpu_name": hardware.get("name", ""),
            "vram_total_mb": int(hardware.get("vram_total_mb") or 0),
        },
    }
