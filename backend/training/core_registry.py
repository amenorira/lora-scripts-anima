"""Training runtime and profile registry.

The application historically treated model_train_type as both a UI preset and
an executable backend selector. That works while every run is handled by
sd-scripts, but becomes unsafe as soon as a profile has a different command
line, dataset format, or import environment. This module makes that boundary
explicit while preserving the legacy model_train_type values.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from pathlib import Path
from typing import Any

from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR, VENDOR_ROOT


MUSUBI_TUNER_DIR = VENDOR_ROOT / "musubi-tuner"
MUSUBI_VENV_DIR = REPO_ROOT / "venv" / "cores" / "musubi"
MUSUBI_PYTHON = MUSUBI_VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
MAIN_VENV_DIR = REPO_ROOT / "venv"


def venv_site_packages(venv_dir: Path) -> Path:
    """Return the conventional site-packages directory without importing its Python."""

    if os.name == "nt":
        return venv_dir / "Lib" / "site-packages"
    candidates = sorted((venv_dir / "lib").glob("python*/site-packages"))
    return candidates[0] if candidates else venv_dir / "lib" / "site-packages"


MAIN_VENV_SITE_PACKAGES = venv_site_packages(MAIN_VENV_DIR)
MUSUBI_VENV_SITE_PACKAGES = venv_site_packages(MUSUBI_VENV_DIR)


class TrainingProfileError(ValueError):
    """Raised when a requested profile and runtime do not agree."""


@dataclass(frozen=True)
class TrainingEngine:
    """A process runtime with its own source tree and environment policy."""

    id: str
    label: str
    root: Path
    pythonpath: tuple[Path, ...]
    uses_sd_scripts_hooks: bool
    description: str
    python_executable: Path | None = None


@dataclass(frozen=True)
class TrainingProfile:
    """A user-selectable model/training combination executed by one runtime."""

    id: str
    engine_id: str
    label: str
    trainer_file: str
    adapter_id: str
    group: str
    description: str
    host_engine_id: str | None = None


@dataclass(frozen=True)
class TrainingAdapter:
    """A first-class adaptation core, optionally mounted on an engine."""

    id: str
    host_engine_id: str
    label: str
    description: str
    network_module: str | None = None
    mounted: bool = False


ENGINES: dict[str, TrainingEngine] = {
    "sd_scripts": TrainingEngine(
        id="sd_scripts",
        label="sd-scripts",
        root=SD_SCRIPTS_DIR,
        pythonpath=(),
        uses_sd_scripts_hooks=True,
        description="Existing SDXL and Anima trainer runtime.",
    ),
    "musubi_tuner": TrainingEngine(
        id="musubi_tuner",
        label="musubi-tuner",
        root=MUSUBI_TUNER_DIR,
        pythonpath=(MUSUBI_TUNER_DIR / "src",),
        uses_sd_scripts_hooks=False,
        description=(
            "Independent musubi-tuner runtime for Krea 2 and future profiles; "
            "uses a dedicated venv with a read-only bridge to the main CUDA/PyTorch stack, "
            "so its transformers dependency cannot alter sd-scripts."
        ),
        python_executable=MUSUBI_PYTHON,
    ),
}


PROFILES: dict[str, TrainingProfile] = {
    "sdxl-lora": TrainingProfile(
        id="sdxl-lora",
        engine_id="sd_scripts",
        label="SDXL LoRA",
        trainer_file="./vendor/sd-scripts/sdxl_train_network.py",
        adapter_id="sd_native",
        group="sdxl",
        description="sd-scripts SDXL LoRA profile.",
    ),
    "anima-lora": TrainingProfile(
        id="anima-lora",
        engine_id="sd_scripts",
        label="Anima LoRA",
        trainer_file="./vendor/sd-scripts/anima_train_network.py",
        adapter_id="sd_native",
        group="anima",
        description="sd-scripts Anima LoRA profile.",
    ),
    "krea2-lora": TrainingProfile(
        id="krea2-lora",
        engine_id="musubi_tuner",
        label="Krea 2 LoRA",
        trainer_file="./vendor/musubi-tuner/krea2_train_network.py",
        adapter_id="musubi_lora",
        group="krea2",
        description="musubi-tuner Krea 2 RAW DiT LoRA profile.",
    ),
}


ADAPTERS: dict[str, TrainingAdapter] = {
    "sd_native": TrainingAdapter(
        id="sd_native",
        host_engine_id="sd_scripts",
        label="sd-scripts native LoRA",
        description="Native sd-scripts LoRA/LoHa/LoKr network modules.",
    ),
    "lycoris": TrainingAdapter(
        id="lycoris",
        host_engine_id="sd_scripts",
        label="LyCORIS",
        description="Independent LyCORIS adapter core mounted into sd-scripts via lycoris.kohya.",
        network_module="lycoris.kohya",
        mounted=True,
    ),
    "musubi_lora": TrainingAdapter(
        id="musubi_lora",
        host_engine_id="musubi_tuner",
        label="musubi Krea 2 LoRA",
        description="Krea 2 LoRA network implemented by musubi-tuner.",
        network_module="networks.lora_krea2",
    ),
}


def get_engine(engine_id: str) -> TrainingEngine:
    try:
        return ENGINES[engine_id]
    except KeyError as exc:
        raise TrainingProfileError(
            f"Unsupported training engine: {engine_id} / 不支持的训练核心: {engine_id}"
        ) from exc


def get_profile(profile_id: str) -> TrainingProfile:
    try:
        return PROFILES[profile_id]
    except KeyError as exc:
        raise TrainingProfileError(
            f"Unsupported training profile: {profile_id} / 不支持的训练配置档: {profile_id}"
        ) from exc


def get_adapter(adapter_id: str) -> TrainingAdapter:
    try:
        return ADAPTERS[adapter_id]
    except KeyError as exc:
        raise TrainingProfileError(
            f"Unsupported training adapter: {adapter_id} / 不支持的适配器核心: {adapter_id}"
        ) from exc


def resolve_training_profile(config: dict[str, Any]) -> TrainingProfile:
    """Resolve and normalize legacy/new runtime selectors in-place.

    model_train_type remains the persisted profile key for backward
    compatibility. New clients may also send engine_id and adapter_id; those
    values are verified rather than trusted as executable paths.
    """

    profile_id = str(config.get("model_train_type") or "sdxl-lora")
    profile = get_profile(profile_id)

    requested_engine = config.get("engine_id")
    if requested_engine not in (None, "", profile.engine_id):
        raise TrainingProfileError(
            f"Profile {profile_id} belongs to {profile.engine_id}, not {requested_engine} / "
            "训练配置档与训练核心不匹配"
        )

    # LyCORIS is independently selectable in the product, but deliberately
    # remains mounted on sd-scripts rather than becoming a duplicate runtime.
    requested_adapter = str(config.get("adapter_id") or "")
    adapter_id = requested_adapter or profile.adapter_id
    if profile.engine_id == "sd_scripts" and config.get("network_module") == "lycoris.kohya":
        if requested_adapter and requested_adapter != "lycoris":
            raise TrainingProfileError(
                "lycoris.kohya requires the LyCORIS adapter / lycoris.kohya 必须使用 LyCORIS 适配器核心"
            )
        adapter_id = "lycoris"
    if profile.id == "krea2-lora":
        if requested_adapter and requested_adapter != "musubi_lora":
            raise TrainingProfileError(
                "Krea 2 requires the musubi LoRA adapter / Krea 2 必须使用 musubi LoRA 适配器核心"
            )
        adapter_id = "musubi_lora"

    adapter = get_adapter(adapter_id)
    if adapter.host_engine_id != profile.engine_id:
        raise TrainingProfileError(
            f"Adapter {adapter_id} cannot run on {profile.engine_id} / 适配器核心与训练引擎不兼容"
        )
    if adapter.network_module:
        requested_network = config.get("network_module")
        if requested_network in (None, "", adapter.network_module):
            config["network_module"] = adapter.network_module
        else:
            raise TrainingProfileError(
                f"Adapter {adapter_id} requires network_module={adapter.network_module} / "
                f"适配器核心必须使用 network_module={adapter.network_module}"
            )

    config["model_train_type"] = profile.id
    config["engine_id"] = profile.engine_id
    config["adapter_id"] = adapter_id
    return profile


def profile_payload() -> dict[str, Any]:
    """Return a JSON-safe capability summary for environment/UI consumers."""

    engines = []
    for engine in ENGINES.values():
        item = asdict(engine)
        item["root"] = str(engine.root)
        item["pythonpath"] = [str(path) for path in engine.pythonpath]
        if engine.python_executable is not None:
            item["python_executable"] = str(engine.python_executable)
            item["runtime_ready"] = engine.python_executable.is_file()
        else:
            item["python_executable"] = None
            item["runtime_ready"] = True
        item["available"] = engine.root.is_dir() and item["runtime_ready"]
        engines.append(item)

    profiles = []
    for profile in PROFILES.values():
        item = asdict(profile)
        engine = ENGINES[profile.engine_id]
        item["available"] = engine.root.is_dir() and (
            engine.python_executable is None or engine.python_executable.is_file()
        )
        profiles.append(item)

    adapters = []
    for adapter in ADAPTERS.values():
        item = asdict(adapter)
        host = ENGINES[adapter.host_engine_id]
        item["available"] = host.root.is_dir() and (
            host.python_executable is None or host.python_executable.is_file()
        )
        adapters.append(item)

    return {"engines": engines, "profiles": profiles, "adapters": adapters}


def engine_pythonpaths(engine_id: str) -> tuple[Path, ...]:
    engine = get_engine(engine_id)
    if engine.id == "musubi_tuner":
        # PYTHONPATH has higher priority than the interpreter's automatic
        # site directories. Put the isolated core before the read-only host
        # bridge so transformers/diffusers resolve from musubi, while torch
        # and torchvision resolve from the main CUDA-enabled environment.
        return (*engine.pythonpath, MUSUBI_VENV_SITE_PACKAGES, MAIN_VENV_SITE_PACKAGES)
    return engine.pythonpath
