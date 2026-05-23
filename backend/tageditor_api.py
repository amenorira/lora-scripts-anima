"""
Tag Editor API — 原生标签编辑器后端

替换 Gradio iframe，完全自主可控。
提供数据集目录下图片标签的读取、编辑、批量操作。

端点:
  GET  /api/tageditor/images?dir=path      — 列出图片+标签
  POST /api/tageditor/save                  — 保存单张标签
  POST /api/tageditor/batch                 — 批量操作
  POST /api/tageditor/save-all              — 保存全部
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from backend.log import log

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
CAPTION_EXTENSIONS = {".txt", ".caption"}


def _find_caption(img_path: Path) -> Path | None:
    """查找图片对应的标签文件"""
    for ext in CAPTION_EXTENSIONS:
        cap = img_path.with_suffix(ext)
        if cap.exists():
            return cap
    return None


def _read_tags(cap_path: Path) -> str:
    """读取标签文件内容"""
    try:
        return cap_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def _write_tags(cap_path: Path, tags: str) -> None:
    """写入标签文件"""
    cap_path.write_text(tags.strip(), encoding="utf-8", errors="replace")


def _thumbnail_url(img_path: Path) -> str:
    """图片缩略图 URL（通过 FastAPI 静态文件或直接文件路径）"""
    # 使用相对路径，由 preview-image 代理
    try:
        rel = str(img_path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        rel = str(img_path).replace("\\", "/")
    return f"/api/tageditor/thumbnail?path={rel}"


@router.get("/tageditor/images")
async def list_images(dir: str = Query("")):
    """列出数据集目录下的所有图片及其标签"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = Path(dir)
    if not dir_path.is_absolute():
        dir_path = REPO_ROOT / dir_path
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images = []
    # 递归扫描所有图片
    for ext in IMAGE_EXTENSIONS:
        for img in dir_path.rglob(f"*{ext}"):
            if img.name.startswith("."):
                continue
            cap = _find_caption(img)
            tags = _read_tags(cap) if cap else ""
            try:
                rel = str(img.relative_to(dir_path)).replace("\\", "/")
            except ValueError:
                rel = img.name

            images.append({
                "name": img.name,
                "path": str(img),
                "rel_path": rel,
                "tags": tags,
                "has_caption": cap is not None,
                "thumbnail": _thumbnail_url(img),
            })

    images.sort(key=lambda x: x["name"])
    dir_name = dir_path.name or str(dir_path)

    return {
        "status": "success",
        "data": {
            "dir": str(dir_path),
            "dir_name": dir_name,
            "count": len(images),
            "images": images,
        }
    }


@router.post("/tageditor/save")
async def save_image_tags(data: dict):
    """保存单张图片的标签"""
    img_path = data.get("path", "")
    tags = data.get("tags", "")

    if not img_path or not os.path.isfile(img_path):
        return {"status": "error", "message": "图片路径无效"}

    p = Path(img_path)
    cap = p.with_suffix(".txt")
    _write_tags(cap, tags)

    return {"status": "success", "message": "已保存"}


@router.post("/tageditor/batch")
async def batch_edit_tags(data: dict):
    """批量操作所有图片的标签"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})

    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = Path(dir_path)
    if not d.is_absolute():
        d = REPO_ROOT / d
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    modified = 0
    errors = []

    for ext in IMAGE_EXTENSIONS:
        for img in d.rglob(f"*{ext}"):
            cap = img.with_suffix(".txt")
            tags = _read_tags(cap) if cap.exists() else ""
            new_tags = tags

            try:
                if operation == "add_prefix":
                    prefix = args.get("value", "")
                    if prefix:
                        new_tags = prefix + ", " + tags if tags else prefix

                elif operation == "add_suffix":
                    suffix = args.get("value", "")
                    if suffix:
                        new_tags = tags + ", " + suffix if tags else suffix

                elif operation == "find_replace":
                    find = args.get("find", "")
                    replace = args.get("replace", "")
                    if find:
                        new_tags = tags.replace(find, replace)

                elif operation == "regex_replace":
                    pattern = args.get("pattern", "")
                    replace = args.get("replace", "")
                    try:
                        new_tags = re.sub(pattern, replace, tags)
                    except re.error as e:
                        return {"status": "error", "message": f"正则表达式错误: {e}"}

                elif operation == "delete_tag":
                    target = args.get("value", "").strip()
                    if target:
                        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
                        tag_list = [t for t in tag_list if t != target]
                        new_tags = ", ".join(tag_list)

                elif operation == "dedup":
                    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
                    seen = set()
                    unique = []
                    for t in tag_list:
                        if t not in seen:
                            seen.add(t)
                            unique.append(t)
                    new_tags = ", ".join(unique)

                elif operation == "sort":
                    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
                    tag_list.sort()
                    new_tags = ", ".join(tag_list)

                elif operation == "inject_trigger":
                    trigger = args.get("value", "").strip()
                    if trigger and trigger not in tags:
                        new_tags = trigger + ", " + tags if tags else trigger

                elif operation == "remove_trigger":
                    trigger = args.get("value", "").strip()
                    if trigger:
                        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
                        tag_list = [t for t in tag_list if t != trigger]
                        new_tags = ", ".join(tag_list)

                else:
                    return {"status": "error", "message": f"未知操作: {operation}"}

            except Exception as e:
                errors.append(f"{img.name}: {e}")
                continue

            if new_tags != tags:
                _write_tags(cap, new_tags)
                modified += 1

    return {
        "status": "success",
        "data": {"modified": modified, "errors": errors}
    }


@router.post("/tageditor/save-all")
async def save_all_tags(data: dict):
    """批量保存所有修改过的标签（前端传入 {images: [{path, tags}, ...]}）"""
    images = data.get("images", [])
    if not images:
        return {"status": "error", "message": "无数据"}

    saved = 0
    for item in images:
        img_path = item.get("path", "")
        tags = item.get("tags", "")
        if not img_path:
            continue
        p = Path(img_path)
        cap = p.with_suffix(".txt")
        _write_tags(cap, tags)
        saved += 1

    return {"status": "success", "data": {"saved": saved}}


@router.get("/tageditor/thumbnail")
async def tag_editor_thumbnail(path: str = Query("")):
    """标签编辑器缩略图代理"""
    import urllib.parse
    decoded = urllib.parse.unquote(path)
    p = (REPO_ROOT / decoded).resolve()

    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTENSIONS:
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse("", status_code=404)

    import mimetypes
    mt = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return FileResponse(p, media_type=mt)
