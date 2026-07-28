"""Structured model registry shared by the Tagger API and workspace UI."""
from __future__ import annotations

import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from backend.constants import HF_CACHE_DIR, TAGGER_MODELS_DIR, TAGGER_RUNTIME_DIR
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
    repo_id: str = ""
    model_file: str = ""
    projector_file: str = ""


MODEL_SPECS: tuple[TaggerModelSpec, ...] = (
    TaggerModelSpec(
        "camie-tagger-v2", "Camie Tagger v2", "onnx", "tagger",
        "Danbooru 2024 ViT tagger with about 71K tags across seven confidence categories", 733_000_000, 2, True, True,
    ),
    TaggerModelSpec(
        "wd-eva02-large-tagger-v3", "WD EVA02 Large v3", "onnx", "tagger",
        "WD v3 EVA02-Large tagger for general, character, and rating tags", 904_000_000, 2, True, True,
    ),
    TaggerModelSpec(
        "wd-vit-large-tagger-v3", "WD ViT Large v3", "onnx", "tagger",
        "WD v3 ViT-Large tagger for classic WD14 ViT workflows", 904_000_000, 2, True, True,
    ),
    TaggerModelSpec(
        "cl_tagger_1_02", "CL Tagger v1.02", "onnx", "tagger",
        "Anime tagger with 42,163 tags including quality and model categories", 747_000_000, 2, True, True,
    ),
    TaggerModelSpec(
        "qwen3-vl-4b-q4", "Qwen3-VL 4B Instruct Q4_K_M", "llama", "vision_llm",
        "Open-vocabulary 4B vision-language tag generation for 6 GB or larger GPUs", 3_580_000_000, 6, False, False,
        "Qwen/Qwen3-VL-4B-Instruct-GGUF",
        "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
        "mmproj-Qwen3VL-4B-Instruct-F16.gguf",
    ),
    TaggerModelSpec(
        "qwen3-vl-8b-q4", "Qwen3-VL 8B Instruct Q4_K_M", "llama", "vision_llm",
        "Open-vocabulary 8B vision-language tag generation for 10 GB or larger GPUs", 6_230_000_000, 10, False, False,
        "Qwen/Qwen3-VL-8B-Instruct-GGUF",
        "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
        "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
    ),
)

MODEL_SPEC_BY_ID = {spec.id: spec for spec in MODEL_SPECS}
_onnx_install_cache: dict[str, tuple[float, bool]] = {}


def llama_server_path() -> Path:
    name = "llama-server.exe" if sys.platform == "win32" else "llama-server"
    direct = TAGGER_RUNTIME_DIR / name
    if direct.exists():
        return direct
    matches = list(TAGGER_RUNTIME_DIR.rglob(name)) if TAGGER_RUNTIME_DIR.exists() else []
    return matches[0] if matches else direct


def model_paths(spec: TaggerModelSpec) -> tuple[Path, Path]:
    root = TAGGER_MODELS_DIR / spec.id
    return root / spec.model_file, root / spec.projector_file


def _onnx_installed(spec: TaggerModelSpec) -> bool:
    # Existing taggers use the shared Hugging Face cache and download lazily.
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


def recommended_llm_id(total_vram_gb: float) -> str:
    return "qwen3-vl-8b-q4" if total_vram_gb >= 10 else "qwen3-vl-4b-q4"


def model_payload() -> dict:
    hardware = gpu_info() or {}
    total_mb = int(hardware.get("vram_total_mb") or 0)
    total_gb = total_mb / 1024
    recommendation = recommended_llm_id(total_gb)
    runtime_ready = llama_server_path().is_file()
    models = []
    for spec in MODEL_SPECS:
        data = asdict(spec)
        if spec.engine == "llama":
            model_path, projector_path = model_paths(spec)
            files_ready = model_path.is_file() and projector_path.is_file()
            data.update({
                "installed": runtime_ready and files_ready,
                "runtime_installed": runtime_ready,
                "files_installed": files_ready,
                "recommended": spec.id == recommendation,
                "status": "ready" if runtime_ready and files_ready else "not_installed",
            })
        else:
            installed = _onnx_installed(spec)
            data.update({
                "installed": installed,
                "runtime_installed": True,
                "files_installed": installed,
                "recommended": spec.id == "camie-tagger-v2",
                "status": "ready" if installed else "download_on_first_use",
            })
        models.append(data)
    return {
        "models": models,
        "hardware": {
            "nvidia": bool(hardware),
            "gpu_name": hardware.get("name", ""),
            "vram_total_mb": total_mb,
            "recommended_llm": recommendation,
        },
    }
