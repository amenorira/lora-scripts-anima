"""Lightweight preview configuration; safe to import without torch or a trainer."""
from __future__ import annotations

import json
import math
from pathlib import Path


ENV_KEY = "ANIMA_PREVIEW_LORAS_CONFIG"
CONFIG_NAME = "preview_loras.json"
PROFILES = {"moss-image-lora": "moss_image", "anima-lora": "anima"}
SAMPLERS = ("euler", "er_sde", "euler_a", "dpmpp_2m", "heun")
SCHEDULERS = ("native", "simple", "sgm_uniform", "beta", "beta57", "normal", "karras", "exponential")


def sampling_options(sampler=None, scheduler=None):
    sampler = "euler" if sampler in (None, "") else sampler
    scheduler = "native" if scheduler in (None, "") else scheduler
    if sampler not in SAMPLERS:
        raise ValueError(f"Unsupported preview sampler / 不支持的预览采样器: {sampler}")
    if scheduler not in SCHEDULERS:
        raise ValueError(f"Unsupported preview scheduler / 不支持的预览调度器: {scheduler}")
    return {"sampler": sampler, "scheduler": scheduler}


def custom_sampling(options):
    return options["sampler"] != "euler" or options["scheduler"] != "native"


def normalize_loras(value, *, check_files=False, allow_incomplete=False):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Preview LoRAs must be a list / 预览 LoRA 必须是列表")
    result = []
    for index, row in enumerate(value, 1):
        if not isinstance(row, dict):
            raise ValueError(f"Preview LoRA #{index}: expected path and multiplier / 需要路径和倍率")
        path = row.get("path", "")
        if not isinstance(path, str):
            raise ValueError(f"Preview LoRA #{index}: path must be text / 路径必须是文本")
        path = path.strip()
        raw = row.get("multiplier", 1.0)
        if allow_incomplete and raw in ("", None):
            result.append({"path": path, "multiplier": ""})
            continue
        try:
            multiplier = float(raw)
        except (ValueError, TypeError, OverflowError):
            multiplier = float("nan")
        if isinstance(raw, bool) or not math.isfinite(multiplier):
            raise ValueError(f"Preview LoRA #{index}: multiplier must be finite / 倍率必须是有限数值")
        if not path and multiplier != 0 and not allow_incomplete:
            raise ValueError(f"Preview LoRA #{index}: path is required / 请填写文件路径")
        file = Path(path).expanduser()
        if path and multiplier != 0 and file.suffix.lower() not in {".safetensors", ".pt", ".pth", ".ckpt", ".bin"}:
            raise ValueError(f"Preview LoRA #{index}: unsupported weight file / 不支持的权重文件格式")
        if check_files and multiplier != 0:
            if not file.is_absolute():
                file = Path(__file__).resolve().parents[3] / file
            if not file.is_file():
                raise ValueError(f"Preview LoRA #{index}: file not found / 文件不存在: {file}")
            path = str(file.resolve())
        result.append({"path": path, "multiplier": multiplier})
    return result


def normalize_form(form):
    """Normalize preview fields in place, preserving absent fields and editable drafts."""
    options = sampling_options(form.get("preview_sampler"), form.get("preview_scheduler"))
    for name, value in options.items():
        key = "preview_" + name
        if key in form:
            form[key] = value
    if "preview_loras" in form:
        form["preview_loras"] = normalize_loras(form["preview_loras"], allow_incomplete=True)


def prepare_config(form, profile_id):
    if not form.get("enable_preview") or profile_id not in PROFILES:
        return None
    loras = normalize_loras(form.get("preview_loras"), check_files=True)
    options = sampling_options(form.get("preview_sampler"), form.get("preview_scheduler"))
    if not any(row["multiplier"] != 0 for row in loras) and not custom_sampling(options):
        return None
    from .compat import check_source

    check_source(PROFILES[profile_id], custom_sampling=custom_sampling(options))
    return {"schema_version": 1, "architecture": PROFILES[profile_id], "loras": loras, **options}


def read_config(path):
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ValueError("Unsupported preview LoRA configuration / 不支持的预览 LoRA 配置")
    if document.get("architecture") not in PROFILES.values():
        raise ValueError("Unsupported preview model / 不支持的预览模型")
    return {**document, "loras": normalize_loras(document.get("loras"), check_files=True),
            **sampling_options(document.get("sampler"), document.get("scheduler"))}
