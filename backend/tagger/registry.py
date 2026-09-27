"""Local model capabilities and presets shared by the API and workspace UI."""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field

from backend.constants import HF_CACHE_DIR
from backend.monitor.hardware import gpu_info
from backend.tagger.interrogators.base import CAMIE_THRESHOLD_PRESETS
from backend.tagger.interrogators.pixai import FILES, REPO_ID, REVISION

DEFAULT_MODEL_ID = "pixai-tagger-v1.0"

@dataclass(frozen=True)
class TaggerModelSpec:
    id: str
    name: str
    engine: str
    family: str
    description: str
    download_bytes: int
    min_vram_gb: int | None
    supports_confidence: bool
    supports_categories: bool
    threshold_categories: tuple[str, ...]
    supports_character_toggle: bool
    supports_model_tag: bool
    repo_id: str
    files: tuple[str, ...]
    revision: str = "main"
    threshold_presets: dict[str, dict[str, float]] = field(default_factory=dict)


MODEL_SPECS: tuple[TaggerModelSpec, ...] = (
    TaggerModelSpec(
        "wd-eva02-large-tagger-v3", "WD EVA02 Large v3", "onnx", "tagger",
        "WD v3 EVA02-Large tagger for general, character, and rating tags",
        904_000_000, 2, True, True, (), True, False,
        repo_id="SmilingWolf/wd-eva02-large-tagger-v3", files=("model.onnx", "selected_tags.csv"),
    ),
    TaggerModelSpec(
        "wd-vit-large-tagger-v3", "WD ViT Large v3", "onnx", "tagger",
        "WD v3 ViT-Large tagger for classic WD14 ViT workflows",
        904_000_000, 2, True, True, (), True, False,
        repo_id="SmilingWolf/wd-vit-large-tagger-v3", files=("model.onnx", "selected_tags.csv"),
    ),
    TaggerModelSpec(
        "cl_tagger_1_02", "CL Tagger v1.02", "onnx", "tagger",
        "Anime tagger with 42,163 tags including quality and model categories",
        747_000_000, 2, True, True,
        ("general", "character", "copyright", "artist", "meta", "quality", "rating"), False, True,
        repo_id="cella110n/cl_tagger", files=("cl_tagger_1_02/model.onnx", "cl_tagger_1_02/tag_mapping.json"),
        threshold_presets={
            "macro": {
                "general": 0.35, "character": 0.6, "copyright": 0.35,
                "artist": 0.35, "meta": 0.35, "quality": 0.35, "rating": 0.35,
            },
            "micro": {
                "general": 0.45, "character": 0.7, "copyright": 0.45,
                "artist": 0.45, "meta": 0.45, "quality": 0.45, "rating": 0.45,
            },
        },
    ),
    TaggerModelSpec(
        "camie-tagger-v2", "Camie Tagger v2", "onnx", "tagger",
        "Danbooru 2024 ViT tagger with about 71K tags across seven confidence categories",
        733_000_000, 2, True, True,
        ("general", "character", "copyright", "artist", "meta", "year", "rating"), False, False,
        repo_id="Camais03/camie-tagger-v2", files=("camie-tagger-v2.onnx", "camie-tagger-v2-metadata.json"),
        threshold_presets=CAMIE_THRESHOLD_PRESETS,
    ),
    TaggerModelSpec(
        "pixai-tagger-v1.0", "PixAI Tagger v1.0", "pytorch", "tagger",
        "Developed by PixAI Labs at anime AI art platform PixAI; about 31,000 tags including characters, franchises and styles",
        1_950_000_000, None, True, True,
        ("general", "character", "copyright", "style", "meta", "rating"), False, False,
        repo_id=REPO_ID, files=FILES, revision=REVISION,
        threshold_presets={
            "macro": {
                "general": 0.17, "character": 0.27, "style": 0.15,
                "copyright": 0.24, "meta": 0.17, "rating": 0.41,
            },
            "micro": {
                "general": 0.34, "character": 0.37, "style": 0.19,
                "copyright": 0.46, "meta": 0.47, "rating": 0.43,
            },
        },
    ),
)

MODEL_SPEC_BY_ID = {spec.id: spec for spec in MODEL_SPECS}
_install_cache: dict[str, tuple[float, bool]] = {}


def _model_installed(spec: TaggerModelSpec) -> bool:
    cached = _install_cache.get(spec.id)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    snapshots = HF_CACHE_DIR / ("models--" + spec.repo_id.replace("/", "--")) / "snapshots"
    candidates = snapshots.glob("*") if spec.revision == "main" else [snapshots / spec.revision]
    installed = any(
        all((folder / name).is_file() and (folder / name).stat().st_size > 0 for name in spec.files)
        for folder in candidates
    )
    _install_cache[spec.id] = (time.monotonic(), installed)
    return installed


def model_payload() -> dict:
    hardware = gpu_info() or {}
    models = []
    for spec in MODEL_SPECS:
        installed = _model_installed(spec)
        data = asdict(spec)
        data.update({
            "installed": installed,
            "status": "ready" if installed else "download_on_first_use",
        })
        models.append(data)
    return {
        "default_model_id": DEFAULT_MODEL_ID,
        "models": models,
        "hardware": {
            "nvidia": bool(hardware),
            "gpu_name": hardware.get("name", ""),
            "vram_total_mb": int(hardware.get("vram_total_mb") or 0),
        },
    }
