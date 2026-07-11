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
  POST /api/tageditor/restore-backup         — 还原备份
  GET  /api/tageditor/download-zip?dir=...   — 下载 zip
  GET  /api/tageditor/thumbnail?path=...     — 缩略图代理
  POST /api/tageditor/snapshots              — 创建还原点快照
  GET  /api/tageditor/snapshots              — 列出所有快照
  POST /api/tageditor/snapshots/{sid}/restore — 还原指定快照
  DELETE /api/tageditor/snapshots/{sid}       — 删除指定快照
"""
from __future__ import annotations

import asyncio
import io
import os
import shutil
import zipfile
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse

from backend.constants import REPO_ROOT
from backend.tageditor.core import (
    resolve_dir, find_caption, read_tags, write_tags,
    scan_selected_images, get_autocomplete, IMAGE_EXTENSIONS,
    _invalidate_cache, _invalidate_caches_for_path,
    get_cached_scan_images, get_cached_scan_dataset,
    get_thumbnail_path, tag_list,
)
from backend.tageditor.operations import apply_operation
from backend.tageditor.snapshots import create_snapshot, list_snapshots, restore_snapshot, delete_snapshot, clear_all_snapshots

router = APIRouter()


# ── Helper ───────────────────────────────────────────────────────

def _assert_within(img_path: str, dataset_dir: Path) -> Path | None:
    """校验图片路径必须位于数据集目录内，返回 resolved Path 或 None（越界）。
    用于 save / save-all / batch 等写盘端点，统一一道守卫（A11）。"""
    try:
        p = Path(img_path).resolve()
    except Exception:
        return None
    try:
        p.relative_to(dataset_dir.resolve())
    except ValueError:
        return None
    return p


def _resolve_target_images(data: dict, dir_path: Path) -> tuple[list[dict], str | None]:
    """根据批量操作作用域解析目标图片，并约束路径位于数据集目录内。"""
    scope = data.get("scope", "all")
    if scope in {"selected", "filtered"}:
        selected_paths = data.get("selected_paths", [])
        if not selected_paths:
            message = "未选中任何图片" if scope == "selected" else "筛选结果为空"
            return [], message
        return scan_selected_images(dir_path, set(selected_paths)), None
    if scope == "all":
        return get_cached_scan_images(dir_path, data.get("recursive", True)), None
    return [], "无效的批量操作作用域"


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

    images, tags = await asyncio.to_thread(get_cached_scan_dataset, dir_path, recursive)
    dir_name = dir_path.name or str(dir_path)

    return {
        "status": "success",
        "data": {"dir": str(dir_path), "dir_name": dir_name,
                  "count": len(images), "images": images, "tags": tags}
    }


@router.get("/tageditor/tags")
async def get_tag_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """获取所有标签及其出现频率"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images, tags_data = await asyncio.to_thread(get_cached_scan_dataset, dir_path, recursive)
    total_images = len(images)

    return {"status": "success", "data": {"tags": tags_data, "total_images": total_images}}


@router.get("/tageditor/stats")
async def get_dataset_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """数据集统计概览：图片总数、标签总数、有/无标签文件的图片数"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images = await asyncio.to_thread(get_cached_scan_images, dir_path, recursive)
    total = len(images)
    with_caption = sum(1 for i in images if i.get("has_caption"))
    without_caption = total - with_caption
    all_tags: set[str] = set()
    for img in images:
        all_tags.update(tag_list(img.get("tags", "")))

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

    suggestions = await asyncio.to_thread(get_autocomplete, dir_path, prefix, limit, recursive)
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

    images = await asyncio.to_thread(get_cached_scan_images, d, data.get("recursive", True))
    matched = []

    for img in images:
        tags = set(tag_list(img.get("tags", "")))
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
    if not img_path:
        return {"status": "error", "message": "图片路径无效"}
    p = Path(img_path).resolve()
    if not p.is_file():
        return {"status": "error", "message": "图片路径无效"}
    # A11: 校验路径未越界（save 本身无 dataset_dir 上下文，此处校验是否存在 .txt 旁文件即可）
    cap = find_caption(p) or p.with_suffix(".txt")
    if not write_tags(cap, tags):
        return {"status": "error", "message": "写入标签文件失败"}
    _invalidate_caches_for_path(p)
    return {"status": "success", "message": "已保存"}


@router.post("/tageditor/save-all")
async def save_all_tags(data: dict):
    """批量保存所有修改过的标签

    前端约定在 payload 里附带 dir（数据集目录），用于路径归属校验（A11）。
    未附带时回退为不校验以保持向后兼容。
    """
    images = data.get("images", [])
    if not images:
        return {"status": "error", "message": "无数据"}
    dir_str = data.get("dir", "")
    dataset_dir = resolve_dir(dir_str) if dir_str else None
    def _save_items() -> tuple[int, int]:
        saved_count = 0
        skipped_count = 0
        for item in images:
            img_path = item.get("path", "")
            tags = item.get("tags", "")
            if not img_path or not os.path.isfile(img_path):
                continue
            if dataset_dir is not None and _assert_within(img_path, dataset_dir) is None:
                continue  # 路径越界，静默跳过
            p = Path(img_path)
            cap_path = find_caption(p) or p.with_suffix(".txt")
            existing_tags = read_tags(cap_path) if cap_path.exists() else ""
            if existing_tags == tags.strip():
                skipped_count += 1
                continue
            if not write_tags(cap_path, tags):
                continue
            saved_count += 1
        return saved_count, skipped_count

    saved, skipped = await asyncio.to_thread(_save_items)
    if saved > 0:
        if dataset_dir is not None:
            _invalidate_cache(dataset_dir, None)
        else:
            dirs = {Path(item["path"]).parent for item in images if item.get("path")}
            for _d in dirs:
                _invalidate_cache(_d, None)
    return {"status": "success", "data": {"saved": saved, "skipped": skipped}}


@router.post("/tageditor/batch")
async def batch_edit_tags(data: dict):
    """批量操作图片标签"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    target_images, err = await asyncio.to_thread(_resolve_target_images, data, d)
    if err:
        return {"status": "error", "message": err}

    def _apply_batch() -> tuple[int, list[str]]:
        modified_count = 0
        operation_errors = []
        for img in target_images:
            img_path_str = img.get("path", "")
            if not img_path_str:
                continue
            p = Path(img_path_str)
            cap = find_caption(p) or p.with_suffix(".txt")
            tags = read_tags(cap) if cap.exists() else ""
            new_tags, operation_error = apply_operation(tags, operation, args)
            if operation_error:
                operation_errors.append(f"{img.get('name', '?')}: {operation_error}")
                continue
            if new_tags != tags:
                if not write_tags(cap, new_tags):
                    operation_errors.append(f"{img.get('name', '?')}: 写入失败")
                    continue
                modified_count += 1
        return modified_count, operation_errors

    modified, errors = await asyncio.to_thread(_apply_batch)

    if modified > 0:
        _invalidate_cache(d, None)
    return {"status": "success", "data": {"modified": modified, "errors": errors}}


@router.post("/tageditor/batch/preview")
async def preview_batch_edit(data: dict):
    """预览批量操作（不实际执行）"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    target_images, err = await asyncio.to_thread(_resolve_target_images, data, d)
    if err:
        return {"status": "error", "message": err}

    def _build_preview() -> list[dict]:
        preview_items = []
        for img in target_images:
            cap_path = img.get("path", "")
            if not cap_path:
                continue
            p = Path(cap_path)
            cap = find_caption(p) or p.with_suffix(".txt")
            tags = read_tags(cap) if cap.exists() else ""
            new_tags, operation_error = apply_operation(tags, operation, args)
            if operation_error:
                continue
            if new_tags != tags:
                preview_items.append({
                    "path": img.get("path"),
                    "name": img.get("name"),
                    "old_tags": tags,
                    "new_tags": new_tags,
                })
        return preview_items

    preview_data = await asyncio.to_thread(_build_preview)

    return {"status": "success", "data": {"modified_count": len(preview_data), "preview": preview_data}}


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
        _invalidate_cache(d, None)
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
    import urllib.parse

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

    # RFC 5987: URL-encode non-ASCII filename for Content-Disposition header
    encoded_name = urllib.parse.quote(f"{dir_name}.zip")
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.get("/tageditor/thumbnail")
async def tag_editor_thumbnail(path: str = Query(""), size: int = Query(320, ge=128, le=1600)):
    """标签编辑器缩略图代理"""
    import urllib.parse
    import mimetypes

    decoded = urllib.parse.unquote(path)
    p = Path(decoded)
    if not p.is_absolute():
        p = (REPO_ROOT / decoded).resolve()

    if not p.is_file() or p.suffix.lower() not in IMAGE_EXTENSIONS:
        return PlainTextResponse("", status_code=404)

    try:
        thumb_path = await asyncio.to_thread(get_thumbnail_path, p, size)
        return FileResponse(
            thumb_path,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )
    except Exception:
        mt = mimetypes.guess_type(p.name)[0] or "image/jpeg"
        return FileResponse(p, media_type=mt, headers={"Cache-Control": "public, max-age=3600"})


@router.post("/tageditor/snapshots")
async def api_create_snapshot(dataset_dir: str = Query(...)):
    try:
        meta = create_snapshot(dataset_dir)
        return {"status": "success", "data": meta}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/tageditor/snapshots")
async def api_list_snapshots(dataset_dir: str = Query(...)):
    try:
        snaps = list_snapshots(dataset_dir)
        return {"status": "success", "data": snaps}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/tageditor/snapshots/{sid}/restore")
async def api_restore_snapshot(sid: str, dataset_dir: str = Query(...)):
    try:
        ok = restore_snapshot(dataset_dir, sid)
        if ok:
            _invalidate_cache(resolve_dir(dataset_dir), None)
            return {"status": "success", "message": "Snapshot restored"}
        return {"status": "error", "message": "Snapshot not found"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.delete("/tageditor/snapshots/{sid}")
async def api_delete_snapshot(sid: str, dataset_dir: str = Query(...)):
    try:
        delete_snapshot(dataset_dir, sid)
        return {"status": "success", "message": "Snapshot deleted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.delete("/tageditor/snapshots-all")
async def api_clear_all_snapshots(dataset_dir: str = Query(...)):
    """清空所有快照（C5）"""
    try:
        n = clear_all_snapshots(dataset_dir)
        return {"status": "success", "message": f"Cleared {n} snapshots", "data": {"cleared": n}}
    except Exception as e:
        return {"status": "error", "message": str(e)}
