"""
Preset routes — GET/POST/DELETE /presets, /config/saved_params
"""
import json
import os
import re

import toml
from fastapi import APIRouter, Request

from backend.server.config import app_config
from backend.server.models import APIResponseFail, APIResponseSuccess, PresetSaveRequest
from backend.server.state import avaliable_presets, load_presets
from backend.log import log

router = APIRouter()


@router.get("/presets")
async def get_presets():


    return APIResponseSuccess(data={
        "presets": avaliable_presets
    })


@router.post("/presets")
async def save_preset(req: PresetSaveRequest):
    """Save current form data as a preset TOML file in config/presets/."""

    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    os.makedirs(preset_dir, exist_ok=True)

    meta = {
        "name": req.name,
        "version": req.version,
        "author": req.author,
        "train_type": req.train_type,
        "description": req.description,
    }
    preset = {"metadata": meta, "data": req.data}
    toml_str = toml.dumps(preset)

    safe_name = re.sub(r'[\\/*?:"<>|]', "_", req.name)
    filepath = os.path.join(preset_dir, f"{safe_name}.toml")

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(toml_str)
    except OSError as e:
        log.error(f"Failed to save preset: {e}")
        return APIResponseFail(message=f"Failed to save preset / 保存失败: {e}")

    await load_presets()

    log.info(f"Preset saved: {safe_name}")
    return APIResponseSuccess(data={"name": req.name, "file": f"{safe_name}.toml"})


@router.delete("/presets/{name}")
async def delete_preset(name: str):
    """Delete a preset file from config/presets/."""

    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", name)
    filepath = os.path.join(preset_dir, f"{safe_name}.toml")

    if not os.path.isfile(filepath):
        return APIResponseFail(message="Preset not found / 预设不存在")

    try:
        os.remove(filepath)
    except OSError as e:
        log.error(f"Failed to delete preset: {e}")
        return APIResponseFail(message=f"Failed to delete preset / 删除失败: {e}")

    await load_presets()

    log.info(f"Preset deleted: {safe_name}")
    return APIResponseSuccess(message=f"Preset deleted / 已删除: {name}")


@router.get("/config/saved_params")
async def get_saved_params():
    saved_params = app_config["saved_params"]
    return APIResponseSuccess(data=saved_params)


@router.post("/config/saved_params")
async def save_params(request: Request):
    body = await request.json()
    app_config["saved_params"] = body.get("params", {})
    app_config.save_config()
    return APIResponseSuccess()
