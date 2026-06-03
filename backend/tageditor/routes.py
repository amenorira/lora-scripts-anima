"""
Tag Editor API 路由

  GET  /api/tageditor/images?dir=...         — 列出图片+标签
  GET  /api/tageditor/tags?dir=...           — 标签频率统计
  GET  /api/tageditor/stats?dir=...          — 数据集统计概览
  GET  /api/tageditor/autocomplete?dir=...   — 标签自动补全
  POST /api/tageditor/filter                 — 按标签过滤
  POST /api/tageditor/save                   — 保存单张标签
  POST /api/tageditor/save-all               — 批量保存
  POST /api/tageditor/batch                  — 批量操作（支持 scope=selected）
  POST /api/tageditor/move-delete            — 文件移动/删除
  POST /api/tageditor/restore-backup         — 还原备份
  GET  /api/tageditor/download-zip?dir=...   — 下载 zip
  GET  /api/tageditor/thumbnail?path=...     — 缩略图代理
"""
from __future__ import annotations

import io
import os
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, StreamingResponse

from backend.constants import REPO_ROOT
from backend.log import log
from backend.tageditor.core import (
    resolve_dir, find_caption, read_tags, write_tags,
    scan_images, count_tags, get_autocomplete, IMAGE_EXTENSIONS,
    _invalidate_cache,
)
from backend.tageditor.operations import apply_operation

router = APIRouter()


# ══════════════════════════════════════════════════════════════════
#  API 端点
# ══════════════════════════════════════════════════════════════════

@router.get("/tageditor/images")
async def list_images(dir: str = Query(""), recursive: bool = Query(True)):
    """列出数据集目录下的所有图片及其标签"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images = scan_images(dir_path, recursive=recursive)
    dir_name = dir_path.name or str(dir_path)

    return {
        "status": "success",
        "data": {"dir": str(dir_path), "dir_name": dir_name,
                  "count": len(images), "images": images}
    }


@router.get("/tageditor/tags")
async def get_tag_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """获取所有标签及其出现频率"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    tags_data, total_images = count_tags(dir_path, recursive=recursive)

    return {"status": "success", "data": {"tags": tags_data, "total_images": total_images}}


@router.get("/tageditor/stats")
async def get_dataset_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """数据集统计概览：图片总数、标签总数、有/无标签文件的图片数"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images = scan_images(dir_path, recursive=recursive)
    total = len(images)
    with_caption = sum(1 for i in images if i.get("has_caption"))
    without_caption = total - with_caption
    from backend.tageditor.core import tag_list as _tag_list
    all_tags: set[str] = set()
    for img in images:
        for t in _tag_list(img.get("tags", "")):
            all_tags.add(t)

    return {
        "status": "success",
        "data": {
            "total_images": total,
            "with_caption": with_caption,
            "without_caption": without_caption,
            "unique_tags": len(all_tags),
        }
    }


@router.get("/tageditor/autocomplete")
async def tag_autocomplete(
    dir: str = Query(""),
    prefix: str = Query(""),
    limit: int = Query(20),
    recursive: bool = Query(True),
):
    """标签自动补全"""
    if not dir or not prefix:
        return {"status": "success", "data": {"suggestions": []}}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "success", "data": {"suggestions": []}}

    suggestions = get_autocomplete(dir_path, prefix, limit=limit, recursive=recursive)
    return {"status": "success", "data": {"suggestions": suggestions}}


@router.post("/tageditor/filter")
async def filter_images(data: dict):
    """按标签过滤图片"""
    dir_path = data.get("dir", "")
    if not dir_path:
        return {"status": "error", "message": "请指定数据集目录路径"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    include_tags = set(data.get("include_tags", []))
    include_any = set(data.get("include_any_tags", []))
    exclude_tags = set(data.get("exclude_tags", []))
    search_text = (data.get("search", "") or "").strip().lower()

    images = scan_images(d, recursive=data.get("recursive", True))
    matched = []

    for img in images:
        tags = set(t.strip() for t in img.get("tags", "").split(",") if t.strip())
        if include_tags and not include_tags.issubset(tags):
            continue
        if include_any and include_any.isdisjoint(tags):
            continue
        if exclude_tags and not exclude_tags.isdisjoint(tags):
            continue
        if search_text:
            if not any(search_text in t.lower() for t in tags):
                continue
        matched.append(img)

    return {"status": "success", "data": {"dir": str(d), "count": len(matched),
                                           "total": len(images), "images": matched}}


@router.post("/tageditor/save")
async def save_image_tags(data: dict):
    """保存单张图片的标签"""
    img_path = data.get("path", "")
    tags = data.get("tags", "")
    if not img_path or not os.path.isfile(img_path):
        return {"status": "error", "message": "图片路径无效"}
    p = Path(img_path)
    cap = find_caption(p) or p.with_suffix(".txt")
    if not write_tags(cap, tags):
        return {"status": "error", "message": "写入标签文件失败"}
    _invalidate_cache(p.parent)
    return {"status": "success", "message": "已保存"}


@router.post("/tageditor/save-all")
async def save_all_tags(data: dict):
    """批量保存所有修改过的标签"""
    images = data.get("images", [])
    if not images:
        return {"status": "error", "message": "无数据"}
    saved = 0
    skipped = 0
    for item in images:
        img_path = item.get("path", "")
        tags = item.get("tags", "")
        if not img_path or not os.path.isfile(img_path):
            continue
        p = Path(img_path)
        cap_path = find_caption(p) or p.with_suffix(".txt")
        # 安全检查：确保标签文件与图片在同一目录下
        cap_resolved = cap_path.resolve()
        img_resolved = p.resolve()
        if cap_resolved.parent != img_resolved.parent:
            continue
        existing_tags = read_tags(cap_path) if cap_path.exists() else ""
        if existing_tags == tags.strip():
            skipped += 1
            continue
        if not write_tags(cap_path, tags):
            continue
        saved += 1
    if saved > 0:
        dirs = {Path(item["path"]).parent for item in images if item.get("path")}
        for _d in dirs:
            _invalidate_cache(_d)
    return {"status": "success", "data": {"saved": saved, "skipped": skipped}}


@router.post("/tageditor/batch")
async def batch_edit_tags(data: dict):
    """批量操作图片标签"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    scope = data.get("scope", "all")

    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    if scope == "selected":
        selected_paths = data.get("selected_paths", [])
        if not selected_paths:
            return {"status": "error", "message": "未选中任何图片"}
        selected_set = set(selected_paths)
        all_images = scan_images(d)
        target_images = [img for img in all_images if img.get("path", "") in selected_set]
    elif scope == "filtered":
        selected_paths = data.get("selected_paths", [])
        if not selected_paths:
            return {"status": "error", "message": "筛选结果为空"}
        selected_set = set(selected_paths)
        all_images = scan_images(d)
        target_images = [img for img in all_images if img.get("path", "") in selected_set]
    else:
        target_images = scan_images(d)

    modified = 0
    errors = []

    for img in target_images:
        img_path_str = img.get("path", "")
        if not img_path_str:
            continue
        p = Path(img_path_str)
        cap = find_caption(p) or p.with_suffix(".txt")
        tags = read_tags(cap) if cap.exists() else ""
        new_tags, err = apply_operation(tags, operation, args)
        if err:
            errors.append(f"{img.get('name', '?')}: {err}")
            continue
        if new_tags != tags:
            if not write_tags(cap, new_tags):
                errors.append(f"{img.get('name', '?')}: 写入失败")
                continue
            modified += 1

    if modified > 0:
        _invalidate_cache(d)
    return {"status": "success", "data": {"modified": modified, "errors": errors}}


@router.post("/tageditor/batch/preview")
async def preview_batch_edit(data: dict):
    """预览批量操作（不实际执行）"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    scope = data.get("scope", "all")

    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    if scope == "selected":
        selected_paths = data.get("selected_paths", [])
        if not selected_paths:
            return {"status": "error", "message": "未选中任何图片"}
        selected_set = set(selected_paths)
        all_images = scan_images(d)
        target_images = [img for img in all_images if img.get("path", "") in selected_set]
    elif scope == "filtered":
        selected_paths = data.get("selected_paths", [])
        if not selected_paths:
            return {"status": "error", "message": "筛选结果为空"}
        selected_set = set(selected_paths)
        all_images = scan_images(d)
        target_images = [img for img in all_images if img.get("path", "") in selected_set]
    else:
        target_images = scan_images(d)

    preview_data = []
    for img in target_images:
        cap_path = img.get("path", "")
        if not cap_path:
            continue
        p = Path(cap_path)
        cap = find_caption(p) or p.with_suffix(".txt")
        tags = read_tags(cap) if cap.exists() else ""
        new_tags, err = apply_operation(tags, operation, args)
        if err:
            continue
        if new_tags != tags:
            preview_data.append({
                "path": img.get("path"),
                "name": img.get("name"),
                "old_tags": tags,
                "new_tags": new_tags,
            })

    return {"status": "success", "data": {"modified_count": len(preview_data), "preview": preview_data}}


@router.post("/tageditor/move-delete")
async def move_or_delete_files(data: dict):
    """移动或删除文件"""
    paths = data.get("paths", [])
    action = data.get("action", "delete")
    dest = data.get("dest", "")
    delete_caption = data.get("delete_caption", True)

    if not paths:
        return {"status": "error", "message": "未指定文件"}

    result = {"moved": 0, "deleted": 0, "errors": []}

    for img_path_str in paths:
        img_path = Path(img_path_str)
        if not img_path.exists():
            result["errors"].append(f"不存在: {img_path.name}")
            continue

        try:
            if action == "move":
                dest_path = Path(dest)
                dest_path.mkdir(parents=True, exist_ok=True)
                shutil.move(str(img_path), str(dest_path / img_path.name))
                if delete_caption:
                    cap = find_caption(img_path)
                    if cap and cap.exists():
                        shutil.move(str(cap), str(dest_path / cap.name))
                result["moved"] += 1
                # 清理 .bak 备份文件
                for bak_ext in [".txt.bak", ".caption.bak"]:
                    bak_file = img_path.with_suffix(bak_ext)
                    if bak_file.exists():
                        try:
                            shutil.move(str(bak_file), str(dest_path / bak_file.name))
                        except Exception:
                            pass
            elif action == "delete":
                img_path.unlink()
                if delete_caption:
                    cap = find_caption(img_path)
                    if cap and cap.exists():
                        cap.unlink()
                # 清理 .bak 备份文件
                for bak_ext in [".txt.bak", ".caption.bak"]:
                    bak_file = img_path.with_suffix(bak_ext)
                    if bak_file.exists():
                        try:
                            bak_file.unlink()
                        except Exception:
                            pass
                result["deleted"] += 1
        except Exception as e:
            result["errors"].append(f"{img_path.name}: {e}")

    if result["moved"] > 0 or result["deleted"] > 0:
        dirs_to_invalidate = {img_path.parent for img_path in [Path(p) for p in paths]}
        if action == "move" and dest:
            dirs_to_invalidate.add(Path(dest))
        for d in dirs_to_invalidate:
            _invalidate_cache(d)
    return {"status": "success", "data": result}


@router.post("/tageditor/restore-backup")
async def restore_from_backup(data: dict):
    """从 .bak 备份还原标签文件"""
    dir_path = data.get("dir", "")
    if not dir_path:
        return {"status": "error", "message": "请指定数据集目录路径"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    restored = 0
    for ext in {".txt", ".caption"}:
        for bak in d.rglob(f"*{ext}.bak"):
            orig = bak.with_suffix("")
            try:
                shutil.copy2(bak, orig)
                restored += 1
            except Exception:
                pass

    if restored > 0:
        _invalidate_cache(d)
    return {"status": "success", "data": {"restored": restored}}


@router.get("/tageditor/download-zip")
async def download_dataset_zip(dir: str = Query("")):
    """下载数据集目录为 zip"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": "目录不存在"}

    dir_name = dir_path.name or "dataset"

    files_to_zip: list[tuple[Path, str]] = []
    for ext in IMAGE_EXTENSIONS:
        for img in dir_path.rglob(f"*{ext}"):
            if img.name.startswith("."):
                continue
            try:
                arcname = str(img.relative_to(dir_path)).replace("\\", "/")
            except ValueError:
                arcname = img.name
            files_to_zip.append((img, arcname))
            cap = find_caption(img)
            if cap and cap.exists():
                try:
                    cap_arc = str(cap.relative_to(dir_path)).replace("\\", "/")
                except ValueError:
                    cap_arc = cap.name
                files_to_zip.append((cap, cap_arc))

    import asyncio

    def _write_zip():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path, arcname in files_to_zip:
                try:
                    zf.write(file_path, arcname)
                except FileNotFoundError:
                    pass  # file deleted during zip building
        buf.seek(0)
        return buf

    loop = asyncio.get_event_loop()
    buf = await loop.run_in_executor(None, _write_zip)

    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{dir_name}.zip"'},
    )


@router.get("/tageditor/thumbnail")
async def tag_editor_thumbnail(path: str = Query("")):
    """标签编辑器缩略图代理"""
    import urllib.parse
    import mimetypes

    decoded = urllib.parse.unquote(path)
    p = Path(decoded)
    if not p.is_absolute():
        p = (REPO_ROOT / decoded).resolve()

    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTENSIONS:
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse("", status_code=404)

    mt = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    return FileResponse(p, media_type=mt)
