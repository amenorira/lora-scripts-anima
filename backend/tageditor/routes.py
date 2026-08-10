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
  POST /api/tageditor/snapshots              — 创建还原点快照
  GET  /api/tageditor/snapshots              — 列出所有快照
  POST /api/tageditor/snapshots/{sid}/restore — 还原指定快照
  DELETE /api/tageditor/snapshots/{sid}       — 删除指定快照
"""
from __future__ import annotations

import asyncio
import io
import os
import zipfile
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from backend.tageditor.core import (
    resolve_dir, find_caption, read_tags, write_tags,
    scan_selected_images, get_autocomplete, IMAGE_EXTENSIONS,
    _invalidate_cache, _invalidate_caches_for_path,
    get_cached_scan_images, get_cached_scan_dataset, tag_list,
)
from backend.tageditor.operations import apply_operation
from backend.tageditor.repository import save_caption_transaction, restore_legacy_backups, restore_timeline_event
from backend.tageditor.sessions import dataset_sessions
from backend.tageditor.snapshots import create_snapshot, list_snapshots, restore_snapshot, delete_snapshot, clear_all_snapshots
from backend.tageditor.timeline import timeline_store

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


def _valid_directory(raw_path: str) -> Path | None:
    if not raw_path:
        return None
    path = resolve_dir(raw_path)
    return path if path.exists() and path.is_dir() else None


# ══════════════════════════════════════════════════════════════════
#  API 端点
# ══════════════════════════════════════════════════════════════════

@router.get("/tageditor/images")
async def list_images(dir: str = Query(""), recursive: bool = Query(True)):
    """列出数据集目录下的所有图片及其标签"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = _valid_directory(dir)
    if dir_path is None:
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

    dir_path = _valid_directory(dir)
    if dir_path is None:
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images, tags_data = await asyncio.to_thread(get_cached_scan_dataset, dir_path, recursive)
    total_images = len(images)

    return {"status": "success", "data": {"tags": tags_data, "total_images": total_images}}


@router.post("/tageditor/sessions")
async def create_dataset_session(data: dict):
    """Create an immutable dataset scan session and return its first page."""
    try:
        session = await asyncio.to_thread(dataset_sessions.create, data.get("dir", ""), data.get("recursive", True))
        page = await asyncio.to_thread(
            dataset_sessions.page,
            session.id,
            page=1,
            page_size=int(data.get("page_size", 60)),
        )
        return {
            "status": "success",
            "data": {
                "session_id": session.id,
                "dir": str(session.directory),
                "dir_name": session.directory.name or str(session.directory),
                "recursive": session.recursive,
                "count": len(session.images),
                "no_tag_count": sum(1 for item in session.images if not str(item.get("tags", "")).strip()),
                "tags": list(session.tags),
                **page,
            },
        }
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}


@router.get("/tageditor/sessions/{session_id}/images")
async def get_dataset_session_page(
    session_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(60, ge=30, le=240),
    search: str = Query(""),
    use_regex: bool = Query(False),
    quick_filter: str = Query("all"),
    include_tags: str = Query(""),
    exclude_tags: str = Query(""),
    tag_logic: str = Query("AND"),
    sort_by: str = Query("name"),
    sort_asc: bool = Query(True),
    sort_by2: str = Query(""),
    sort_asc2: bool = Query(True),
):
    try:
        data = await asyncio.to_thread(
            dataset_sessions.page,
            session_id,
            page=page,
            page_size=page_size,
            search=search,
            use_regex=use_regex,
            quick_filter=quick_filter,
            include_tags=tuple(tag for tag in include_tags.split("\x1f") if tag),
            exclude_tags=tuple(tag for tag in exclude_tags.split("\x1f") if tag),
            tag_logic=tag_logic,
            sort_by=sort_by,
            sort_asc=sort_asc,
            sort_by2=sort_by2,
            sort_asc2=sort_asc2,
        )
        return {"status": "success", "data": data}
    except KeyError:
        return {"status": "error", "message": "数据集会话已过期"}
    except ValueError as exc:
        return {"status": "error", "message": str(exc)}


@router.post("/tageditor/sessions/{session_id}/refresh")
async def refresh_dataset_session(session_id: str):
    try:
        session = await asyncio.to_thread(dataset_sessions.refresh, session_id)
        return {"status": "success", "data": {"session_id": session.id, "generation": session.generation, "revision": session.revision, "count": len(session.images)}}
    except KeyError:
        return {"status": "error", "message": "数据集会话已过期"}


@router.delete("/tageditor/sessions/{session_id}")
async def close_dataset_session(session_id: str):
    return {"status": "success", "data": {"closed": dataset_sessions.delete(session_id)}}


@router.get("/tageditor/stats")
async def get_dataset_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """数据集统计概览：图片总数、标签总数、有/无标签文件的图片数"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = _valid_directory(dir)
    if dir_path is None:
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

    dir_path = _valid_directory(dir)
    if dir_path is None:
        return {"status": "success", "data": {"suggestions": []}}

    suggestions = await asyncio.to_thread(get_autocomplete, dir_path, prefix, limit, recursive)
    return {"status": "success", "data": {"suggestions": suggestions}}


@router.post("/tageditor/filter")
async def filter_images(data: dict):
    """按标签过滤图片"""
    dir_path = data.get("dir", "")
    if not dir_path:
        return {"status": "error", "message": "请指定数据集目录路径"}

    d = _valid_directory(dir_path)
    if d is None:
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
    dir_path = _valid_directory(data.get("dir", ""))
    if not img_path or dir_path is None:
        return {"status": "error", "message": "图片路径或数据集目录无效"}
    result = await asyncio.to_thread(
        save_caption_transaction,
        dir_path,
        [{"path": img_path, "tags": data.get("tags", ""), "expected_revision": data.get("expected_revision")}],
        writer=write_tags,
        event_type="save",
        label="保存单张标签",
    )
    if result["saved"] == 0 and (result["failed"] or result["conflicts"]):
        return {"status": "error", "message": (result["failed"] or result["conflicts"])[0]["reason"], "data": result}
    _invalidate_cache(dir_path, None)
    dataset_sessions.invalidate_dataset(dir_path)
    return {"status": "success", "message": "已保存", "data": result}


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
    dataset_dir = _valid_directory(dir_str)
    if dataset_dir is None:
        return {"status": "error", "message": "请指定有效的数据集目录路径"}
    result = await asyncio.to_thread(
        save_caption_transaction,
        dataset_dir,
        images,
        writer=write_tags,
        event_type="save",
        label=f"保存 {len(images)} 张图片的标签",
    )
    if result["saved"]:
        _invalidate_cache(dataset_dir, None)
        dataset_sessions.invalidate_dataset(dataset_dir)
    return {"status": "success", "data": result}


@router.post("/tageditor/batch")
async def batch_edit_tags(data: dict):
    """批量操作图片标签"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = _valid_directory(dir_path)
    if d is None:
        return {"status": "error", "message": "目录不存在"}

    target_images, err = await asyncio.to_thread(_resolve_target_images, data, d)
    if err:
        return {"status": "error", "message": err}

    def _apply_batch() -> tuple[list[dict], list[str]]:
        changes = []
        operation_errors: list[str] = []
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
                changes.append({"path": img_path_str, "tags": new_tags})
        return changes, operation_errors

    changes, errors = await asyncio.to_thread(_apply_batch)
    result = await asyncio.to_thread(
        save_caption_transaction,
        d,
        changes,
        writer=write_tags,
        event_type="batch",
        label=f"批量操作: {operation}",
    ) if changes else {"saved": 0, "failed": [], "conflicts": [], "timeline_event": None}
    modified = int(result.get("saved", 0))
    errors.extend(item["reason"] for item in result.get("failed", []))
    errors.extend(item["reason"] for item in result.get("conflicts", []))

    if modified > 0:
        _invalidate_cache(d, None)
        dataset_sessions.invalidate_dataset(d)
    return {"status": "success", "data": {"modified": modified, "errors": errors, "timeline_event": result.get("timeline_event")}}


@router.post("/tageditor/batch/preview")
async def preview_batch_edit(data: dict):
    """预览批量操作（不实际执行）"""
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = _valid_directory(dir_path)
    if d is None:
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

    d = _valid_directory(dir_path)
    if d is None:
        return {"status": "error", "message": "目录不存在"}
    try:
        result = await asyncio.to_thread(restore_legacy_backups, d)
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
    if result["restored"] > 0:
        _invalidate_cache(d, None)
        dataset_sessions.invalidate_dataset(d)
    return {"status": "success", "data": result}


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


@router.get("/tageditor/timeline")
async def api_list_timeline(dataset_dir: str = Query(...), limit: int = Query(100, ge=1, le=500)):
    directory = _valid_directory(dataset_dir)
    if directory is None:
        return {"status": "error", "message": "目录不存在"}
    events = await asyncio.to_thread(timeline_store.list, directory, limit)
    return {"status": "success", "data": events}


@router.post("/tageditor/timeline/{event_id}/restore")
async def api_restore_timeline(event_id: str, dataset_dir: str = Query(...)):
    directory = _valid_directory(dataset_dir)
    if directory is None:
        return {"status": "error", "message": "目录不存在"}
    try:
        result = await asyncio.to_thread(restore_timeline_event, directory, event_id)
        _invalidate_cache(directory, None)
        dataset_sessions.invalidate_dataset(directory)
        return {"status": "success", "data": result}
    except KeyError:
        return {"status": "error", "message": "时间线事件不存在"}
    except Exception as exc:
        return {"status": "error", "message": str(exc)}


@router.delete("/tageditor/timeline/{event_id}")
async def api_delete_timeline(event_id: str, dataset_dir: str = Query(...)):
    directory = _valid_directory(dataset_dir)
    if directory is None:
        return {"status": "error", "message": "目录不存在"}
    deleted = await asyncio.to_thread(timeline_store.delete, event_id, directory)
    return {"status": "success", "data": {"deleted": deleted}}


@router.delete("/tageditor/timeline")
async def api_clear_timeline(dataset_dir: str = Query(...)):
    directory = _valid_directory(dataset_dir)
    if directory is None:
        return {"status": "error", "message": "目录不存在"}
    cleared = await asyncio.to_thread(timeline_store.clear, directory)
    return {"status": "success", "data": {"cleared": cleared}}


@router.post("/tageditor/snapshots")
async def api_create_snapshot(dataset_dir: str = Query(...)):
    try:
        directory = _valid_directory(dataset_dir)
        if directory is None:
            return {"status": "error", "message": "目录不存在"}
        meta = await asyncio.to_thread(create_snapshot, str(directory))
        return {"status": "success", "data": meta}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.get("/tageditor/snapshots")
async def api_list_snapshots(dataset_dir: str = Query(...)):
    try:
        directory = _valid_directory(dataset_dir)
        if directory is None:
            return {"status": "error", "message": "目录不存在"}
        snaps = await asyncio.to_thread(list_snapshots, str(directory))
        return {"status": "success", "data": snaps}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.post("/tageditor/snapshots/{sid}/restore")
async def api_restore_snapshot(sid: str, dataset_dir: str = Query(...)):
    try:
        directory = _valid_directory(dataset_dir)
        if directory is None:
            return {"status": "error", "message": "目录不存在"}
        ok = await asyncio.to_thread(restore_snapshot, str(directory), sid)
        if ok:
            _invalidate_cache(directory, None)
            dataset_sessions.invalidate_dataset(directory)
            return {"status": "success", "message": "Snapshot restored"}
        return {"status": "error", "message": "Snapshot not found"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.delete("/tageditor/snapshots/{sid}")
async def api_delete_snapshot(sid: str, dataset_dir: str = Query(...)):
    try:
        directory = _valid_directory(dataset_dir)
        if directory is None:
            return {"status": "error", "message": "目录不存在"}
        await asyncio.to_thread(delete_snapshot, str(directory), sid)
        return {"status": "success", "message": "Snapshot deleted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@router.delete("/tageditor/snapshots-all")
async def api_clear_all_snapshots(dataset_dir: str = Query(...)):
    """清空所有快照（C5）"""
    try:
        directory = _valid_directory(dataset_dir)
        if directory is None:
            return {"status": "error", "message": "目录不存在"}
        n = await asyncio.to_thread(clear_all_snapshots, str(directory))
        return {"status": "success", "message": f"Cleared {n} snapshots", "data": {"cleared": n}}
    except Exception as e:
        return {"status": "error", "message": str(e)}
