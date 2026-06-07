"""
Preset routes — GET/POST/DELETE /presets, /config/saved_params
"""
import json
import os
import re

import toml
from fastapi import APIRouter, Request

from backend.constants import PRESETS_DIR
from backend.server.config import app_config
from backend.server.models import APIResponseFail, APIResponseSuccess, PresetSaveRequest, PresetRenameRequest
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

    preset_dir = str(PRESETS_DIR)
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

    safe_name = _safe_filename(req.name)
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


def _find_preset_file(name: str):
    """Find a preset file by metadata.name. Returns filepath or None."""
    preset_dir = str(PRESETS_DIR)
    if not os.path.isdir(preset_dir):
        return None
    found = None
    for filename in os.listdir(preset_dir):
        if not filename.endswith(".toml"):
            continue
        filepath = os.path.join(preset_dir, filename)
        try:
            with open(filepath, encoding="utf-8") as f:
                preset = toml.loads(f.read())
            if preset.get("metadata", {}).get("name") == name:
                if found:
                    log.warning(f"Duplicate metadata.name detected / 检测到同名预设: {name} in {filename}")
                    continue
                found = filepath
        except (OSError, toml.TomlDecodeError):
            continue
    return found


def _safe_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name)


@router.delete("/presets/{name}")
async def delete_preset(name: str):
    """Delete a preset file from config/presets/."""

    filepath = _find_preset_file(name)
    if not filepath:
        return APIResponseFail(message="Preset not found / 预设不存在")

    try:
        os.remove(filepath)
    except OSError as e:
        log.error(f"Failed to delete preset: {e}")
        return APIResponseFail(message=f"Failed to delete preset / 删除失败: {e}")

    await load_presets()

    log.info(f"Preset deleted: {name}")
    return APIResponseSuccess(message=f"Preset deleted / 已删除: {name}")


@router.put("/presets/{name}/rename")
async def rename_preset(name: str, req: PresetRenameRequest):
    """Rename a preset file."""

    oldpath = _find_preset_file(name)
    if not oldpath:
        return APIResponseFail(message="Preset not found / 预设不存在")

    preset_dir = str(PRESETS_DIR)
    safe_new = _safe_filename(req.new_name)
    newpath = os.path.join(preset_dir, f"{safe_new}.toml")

    if oldpath != newpath and os.path.isfile(newpath):
        return APIResponseFail(message="A preset with this name already exists / 同名预设已存在")

    try:
        with open(oldpath, encoding="utf-8") as f:
            preset = toml.loads(f.read())
    except (OSError, toml.TomlDecodeError) as e:
        log.error(f"Failed to read preset for rename: {e}")
        return APIResponseFail(message=f"Failed to read preset / 读取失败: {e}")

    preset.setdefault("metadata", {})["name"] = req.new_name

    try:
        with open(newpath, "w", encoding="utf-8") as f:
            f.write(toml.dumps(preset))
    except OSError as e:
        log.error(f"Failed to write renamed preset: {e}")
        return APIResponseFail(message=f"Failed to write preset / 写入失败: {e}")

    if oldpath != newpath:
        try:
            os.remove(oldpath)
        except OSError as e:
            log.warning(f"Failed to remove old preset file after rename: {e}")

    await load_presets()

    log.info(f"Preset renamed: {name} -> {req.new_name}")
    return APIResponseSuccess(data={"old_name": name, "new_name": req.new_name})


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
