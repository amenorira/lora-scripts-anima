"""
Preset routes — GET/POST/DELETE /presets, PUT /presets/{name}/rename,
POST /presets/batch_delete, POST /presets/parse,
GET/POST /config/saved_params
"""
import asyncio
import os
import re

import toml
from fastapi import APIRouter, Request

from backend.constants import PRESETS_DIR
from backend.server.config import app_config
from backend.server.models import (
    APIResponseFail,
    APIResponseSuccess,
    PresetBatchDeleteRequest,
    PresetParseRequest,
    PresetSaveRequest,
    PresetRenameRequest,
)
from backend.server.state import avaliable_presets, load_presets
from backend.log import log

router = APIRouter()


def _safe_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name)


def _read_toml_file(filepath: str) -> dict:
    """同步读取并解析 TOML 文件。供 asyncio.to_thread 调用。"""
    with open(filepath, encoding="utf-8") as f:
        return toml.loads(f.read())


def _write_toml_file(filepath: str, preset: dict) -> None:
    """同步写出 TOML 文件。供 asyncio.to_thread 调用。"""
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(toml.dumps(preset))


def _find_preset_files(name: str) -> list[str]:
    """按 metadata.name 找到所有匹配的预设文件路径。

    返回所有匹配项（同名 metadata 散落在多个文件时全部返回），
    调用方按需处理冲突。这是对旧实现的修正：旧实现遇到第二个匹配项时
    continue 跳过，导致后续文件可能漏掉匹配项。
    """
    preset_dir = str(PRESETS_DIR)
    if not os.path.isdir(preset_dir):
        return []
    matches: list[str] = []
    for filename in os.listdir(preset_dir):
        if not filename.endswith(".toml"):
            continue
        filepath = os.path.join(preset_dir, filename)
        try:
            preset = _read_toml_file(filepath)
            if preset.get("metadata", {}).get("name") == name:
                matches.append(filepath)
        except (OSError, toml.TomlDecodeError):
            continue
    if len(matches) > 1:
        log.warning(
            f"Duplicate metadata.name detected / 检测到同名预设: {name} "
            f"in {len(matches)} files — returning first match"
        )
    return matches


async def _find_preset_file(name: str) -> str | None:
    files = await asyncio.to_thread(_find_preset_files, name)
    return files[0] if files else None


@router.get("/presets")
async def get_presets():
    return APIResponseSuccess(data={
        "presets": avaliable_presets
    })


@router.post("/presets")
async def save_preset(req: PresetSaveRequest):
    """Save current form data as a preset TOML file in config/presets/.

    同名 metadata.name 覆盖是预期行为（保存=更新）。
    但若 sanitize 后的文件名指向另一个不同 metadata.name 的既有文件，
    视为文件名碰撞，拒绝写入以避免静默覆盖他人预设。
    """
    preset_dir = str(PRESETS_DIR)
    await asyncio.to_thread(os.makedirs, preset_dir, exist_ok=True)

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

    # 文件名碰撞检测：若目标文件已存在但其中 metadata.name 与本次不同，拒绝
    if os.path.isfile(filepath):
        try:
            existing = await asyncio.to_thread(_read_toml_file, filepath)
            existing_name = existing.get("metadata", {}).get("name")
            if existing_name and existing_name != req.name:
                return APIResponseFail(
                    message=(
                        f"Filename collision / 文件名冲突：{safe_name}.toml "
                        f"已属于预设 \"{existing_name}\"，请改用其他名称"
                    )
                )
        except (OSError, toml.TomlDecodeError):
            # 解析失败则按"无人持有"处理，允许覆盖以清理损坏文件
            pass

    try:
        await asyncio.to_thread(_write_toml_file, filepath, preset)
    except OSError as e:
        log.error(f"Failed to save preset: {e}")
        return APIResponseFail(message=f"Failed to save preset / 保存失败: {e}")

    await load_presets()

    log.info(f"Preset saved: {safe_name}")
    return APIResponseSuccess(data={"name": req.name, "file": f"{safe_name}.toml"})


@router.delete("/presets/{name}")
async def delete_preset(name: str):
    """Delete a preset file from config/presets/."""
    filepath = await _find_preset_file(name)
    if not filepath:
        return APIResponseFail(message="Preset not found / 预设不存在")

    try:
        await asyncio.to_thread(os.remove, filepath)
    except OSError as e:
        log.error(f"Failed to delete preset: {e}")
        return APIResponseFail(message=f"Failed to delete preset / 删除失败: {e}")

    await load_presets()

    log.info(f"Preset deleted: {name}")
    return APIResponseSuccess(message=f"Preset deleted / 已删除: {name}")


@router.put("/presets/{name}/rename")
async def rename_preset(name: str, req: PresetRenameRequest):
    """Rename a preset (updates metadata.name and rewrites file)."""
    oldpath = await _find_preset_file(name)
    if not oldpath:
        return APIResponseFail(message="Preset not found / 预设不存在")

    preset_dir = str(PRESETS_DIR)
    safe_new = _safe_filename(req.new_name)
    newpath = os.path.join(preset_dir, f"{safe_new}.toml")

    if oldpath != newpath and os.path.isfile(newpath):
        # 若目标文件不属于当前预设，判断是否同名 metadata 持有者
        try:
            existing = await asyncio.to_thread(_read_toml_file, newpath)
            existing_name = existing.get("metadata", {}).get("name")
            if existing_name and existing_name != req.new_name:
                return APIResponseFail(
                    message=(
                        f"Filename collision / 文件名冲突：{safe_new}.toml "
                        f"已属于预设 \"{existing_name}\""
                    )
                )
            return APIResponseFail(message="A preset with this name already exists / 同名预设已存在")
        except (OSError, toml.TomlDecodeError):
            return APIResponseFail(message="A preset with this name already exists / 同名预设已存在")

    try:
        preset = await asyncio.to_thread(_read_toml_file, oldpath)
    except (OSError, toml.TomlDecodeError) as e:
        log.error(f"Failed to read preset for rename: {e}")
        return APIResponseFail(message=f"Failed to read preset / 读取失败: {e}")

    preset.setdefault("metadata", {})["name"] = req.new_name

    try:
        await asyncio.to_thread(_write_toml_file, newpath, preset)
    except OSError as e:
        log.error(f"Failed to write renamed preset: {e}")
        return APIResponseFail(message=f"Failed to write preset / 写入失败: {e}")

    if oldpath != newpath:
        try:
            await asyncio.to_thread(os.remove, oldpath)
        except OSError as e:
            log.warning(f"Failed to remove old preset file after rename: {e}")

    await load_presets()

    log.info(f"Preset renamed: {name} -> {req.new_name}")
    return APIResponseSuccess(data={"old_name": name, "new_name": req.new_name})


@router.post("/presets/batch_delete")
async def batch_delete_presets(req: PresetBatchDeleteRequest):
    """一次目录扫描批量删除多个预设，避免 N 次 DELETE 触发 N 次目录全表扫描。

    单次失败不阻断其余删除。last-write-wins：删除前后统一 load_presets 刷新缓存。
    """
    preset_dir = str(PRESETS_DIR)
    names = list(dict.fromkeys(req.names))  # 去重保序
    if not names:
        return APIResponseSuccess(data={"deleted": 0, "failed": []})

    # 单次扫描：filename -> filepath 映射，再按 metadata.name 索引
    if not os.path.isdir(preset_dir):
        return APIResponseFail(message="Presets dir not found / 预设目录不存在")

    name_to_files: dict[str, list[str]] = {}
    for filename in os.listdir(preset_dir):
        if not filename.endswith(".toml"):
            continue
        filepath = os.path.join(preset_dir, filename)
        try:
            preset = _read_toml_file(filepath)
        except (OSError, toml.TomlDecodeError):
            continue
        mname = preset.get("metadata", {}).get("name")
        if mname:
            name_to_files.setdefault(mname, []).append(filepath)

    deleted = 0
    failed: list[str] = []
    for nm in names:
        files = name_to_files.get(nm, [])
        if not files:
            failed.append(nm)
            continue
        ok = True
        for fp in files:
            try:
                os.remove(fp)
            except OSError as e:
                log.warning(f"Failed to delete preset {fp}: {e}")
                ok = False
        if ok:
            deleted += 1
        else:
            failed.append(nm)

    await load_presets()

    log.info(f"Batch deleted presets: {deleted}/{len(names)}")
    return APIResponseSuccess(data={"deleted": deleted, "failed": failed})


@router.post("/presets/parse")
async def parse_preset(req: PresetParseRequest):
    """解析 TOML 文本为 {metadata, data}，供前端导入预设文件使用。

    用后端 toml 库替代前端残废的 parseToml（不支持嵌套 section）。
    """
    try:
        parsed = toml.loads(req.content)
    except toml.TomlDecodeError as e:
        return APIResponseFail(message=f"Invalid TOML / TOML 解析失败: {e}")

    metadata = parsed.get("metadata", {}) or {}
    data = parsed.get("data", {}) or {}
    if not isinstance(metadata, dict) or not isinstance(data, dict):
        return APIResponseFail(message="Invalid preset shape / 预设结构无效（需含 metadata/data）")

    return APIResponseSuccess(data={"metadata": metadata, "data": data})


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