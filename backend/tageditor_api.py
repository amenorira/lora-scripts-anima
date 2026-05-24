"""
Tag Editor API — 原生标签编辑器后端

提供数据集目录下图片标签的读取、编辑、批量操作、过滤、统计。

端点:
  GET  /api/tageditor/images?dir=path              — 列出图片+标签
  GET  /api/tageditor/tags?dir=path                — 标签频率统计
  POST /api/tageditor/filter                       — 按标签过滤图片
  POST /api/tageditor/save                         — 保存单张标签
  POST /api/tageditor/save-all                     — 保存全部
  POST /api/tageditor/batch                        — 批量操作
  GET  /api/tageditor/thumbnail?path=...           — 缩略图代理
  POST /api/tageditor/move-delete                  — 文件移动/删除
"""
from __future__ import annotations

import os
import re
import shutil
import zipfile
import io
from collections import Counter
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, StreamingResponse

from backend.log import log

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
CAPTION_EXTENSIONS = {".txt", ".caption"}


def _resolve_dir(dir_path: str) -> Path:
    """解析目录路径"""
    p = Path(dir_path)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p


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
    """写入标签文件（自动备份）"""
    # 自动备份原有内容
    if cap_path.exists():
        bak_path = cap_path.with_suffix(cap_path.suffix + ".bak")
        try:
            shutil.copy2(cap_path, bak_path)
        except Exception:
            pass  # 备份失败不阻塞写入
    cap_path.write_text(tags.strip(), encoding="utf-8", errors="replace")


def _thumbnail_url(img_path: Path) -> str:
    """图片缩略图 URL"""
    try:
        rel = str(img_path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        rel = str(img_path).replace("\\", "/")
    return f"/api/tageditor/thumbnail?path={rel}"


def _scan_images(dir_path: Path, recursive: bool = True) -> list[dict]:
    """扫描目录下的所有图片，返回图片信息列表"""
    images = []
    glob_method = dir_path.rglob if recursive else dir_path.glob
    for ext in IMAGE_EXTENSIONS:
        for img in glob_method(f"*{ext}"):
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
    return images


def _tag_list(tags_str: str) -> list[str]:
    """逗号分隔字符串 → 去空格去空的标签列表"""
    return [t.strip() for t in tags_str.split(",") if t.strip()]


def _tag_str(tag_list: list[str]) -> str:
    """标签列表 → 逗号分隔字符串"""
    return ", ".join(tag_list)


# ══════════════════════════════════════════════════════════════════
#  API 端点
# ══════════════════════════════════════════════════════════════════


@router.get("/tageditor/images")
async def list_images(dir: str = Query(""), recursive: bool = Query(True)):
    """列出数据集目录下的所有图片及其标签"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = _resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    images = _scan_images(dir_path, recursive=recursive)
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


@router.get("/tageditor/tags")
async def get_tag_stats(dir: str = Query(""), recursive: bool = Query(True)):
    """获取所有标签及其出现频率（用于过滤面板）"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = _resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": f"目录不存在: {dir}"}

    counter: Counter = Counter()
    total_images = 0
    glob_method = dir_path.rglob if recursive else dir_path.glob
    for ext in IMAGE_EXTENSIONS:
        for img in glob_method(f"*{ext}"):
            if img.name.startswith("."):
                continue
            cap = _find_caption(img)
            if cap:
                tags = _tag_list(_read_tags(cap))
                counter.update(tags)
                total_images += 1

    tags_data = [
        {"tag": tag, "count": count}
        for tag, count in counter.most_common()
    ]

    return {
        "status": "success",
        "data": {
            "tags": tags_data,
            "total_images": total_images,
        }
    }


@router.post("/tageditor/filter")
async def filter_images(data: dict):
    """按标签过滤图片

    Body:
      dir: str              数据集目录
      include_tags: [str]   必须包含的标签（AND 逻辑）
      include_any_tags: [str] 包含任一标签（OR 逻辑）
      exclude_tags: [str]   必须排除的标签
      search: str           标签文本搜索（模糊匹配）
    """
    dir_path = data.get("dir", "")
    if not dir_path:
        return {"status": "error", "message": "请指定数据集目录路径"}

    d = _resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    include_tags = set(data.get("include_tags", []))
    include_any = set(data.get("include_any_tags", []))
    exclude_tags = set(data.get("exclude_tags", []))
    search_text = (data.get("search", "") or "").strip().lower()

    images = _scan_images(d, recursive=data.get("recursive", True))
    matched = []

    for img in images:
        tags = set(_tag_list(img.get("tags", "")))

        # AND 过滤：必须包含所有指定标签
        if include_tags and not include_tags.issubset(tags):
            continue

        # OR 过滤：至少包含一个
        if include_any and include_any.isdisjoint(tags):
            continue

        # 排除过滤
        if exclude_tags and not exclude_tags.isdisjoint(tags):
            continue

        # 搜索过滤
        if search_text:
            if not any(search_text in t.lower() for t in tags):
                continue

        matched.append(img)

    return {
        "status": "success",
        "data": {
            "dir": str(d),
            "count": len(matched),
            "total": len(images),
            "images": matched,
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


@router.post("/tageditor/save-all")
async def save_all_tags(data: dict):
    """批量保存所有修改过的标签"""
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


@router.post("/tageditor/batch")
async def batch_edit_tags(data: dict):
    """批量操作图片标签

    支持 operation:
      add_prefix, add_suffix          添加前缀/后缀
      find_replace                     普通查找替换
      regex_replace                    正则查找替换
      delete_tag                       删除指定标签
      dedup                            去重
      sort                             字母排序
      inject_trigger / remove_trigger  注入/删除触发词
      common_tags                      公共标签编辑（替换众图共有标签）
      delete_by_filter                 按标签条件批量删除

    可指定 scope: "all" | "filtered"（配合过滤条件）
    """
    dir_path = data.get("dir", "")
    operation = data.get("operation", "")
    args = data.get("args", {})
    scope = data.get("scope", "all")

    if not dir_path or not operation:
        return {"status": "error", "message": "缺少参数"}

    d = _resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    # 获取要操作的图片列表
    if scope == "filtered" and "filter" in data:
        # 如果有过滤条件，先过滤
        f = data["filter"]
        include_tags = set(f.get("include_tags", []))
        include_any = set(f.get("include_any_tags", []))
        exclude_tags = set(f.get("exclude_tags", []))
        images = _scan_images(d)
        target_images = []
        for img in images:
            tags_set = set(_tag_list(img.get("tags", "")))
            if include_tags and not include_tags.issubset(tags_set):
                continue
            if include_any and include_any.isdisjoint(tags_set):
                continue
            if exclude_tags and not exclude_tags.isdisjoint(tags_set):
                continue
            target_images.append(img)
    else:
        target_images = _scan_images(d)

    modified = 0
    errors = []

    for img in target_images:
        cap_path = img.get("path", "")
        if not cap_path:
            continue
        p = Path(cap_path)
        cap = p.with_suffix(".txt")
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
                    tag_list = _tag_list(tags)
                    tag_list = [t for t in tag_list if t != target]
                    new_tags = _tag_str(tag_list)

            elif operation == "delete_tags":
                targets = set(args.get("values", []))
                tag_list = _tag_list(tags)
                tag_list = [t for t in tag_list if t not in targets]
                new_tags = _tag_str(tag_list)

            elif operation == "dedup":
                tag_list = _tag_list(tags)
                seen = set()
                unique = []
                for t in tag_list:
                    if t not in seen:
                        seen.add(t)
                        unique.append(t)
                new_tags = _tag_str(unique)

            elif operation == "sort":
                tag_list = _tag_list(tags)
                tag_list.sort()
                new_tags = _tag_str(tag_list)

            elif operation == "inject_trigger":
                trigger = args.get("value", "").strip()
                if trigger and trigger not in tags:
                    new_tags = trigger + ", " + tags if tags else trigger

            elif operation == "remove_trigger":
                trigger = args.get("value", "").strip()
                if trigger:
                    tag_list = _tag_list(tags)
                    tag_list = [t for t in tag_list if t != trigger]
                    new_tags = _tag_str(tag_list)

            elif operation == "common_tags":
                # 编辑公共标签：
                # old -> new 映射（old为空表示新增）
                old_tags = args.get("old_tags", [])
                new_tags_list = args.get("new_tags", [])
                if len(old_tags) == len(new_tags_list):
                    tag_list = _tag_list(tags)
                    new_list = []
                    for t in tag_list:
                        try:
                            idx = old_tags.index(t)
                            if new_tags_list[idx]:  # 非空才保留
                                new_list.append(new_tags_list[idx])
                        except ValueError:
                            new_list.append(t)
                    # 添加新增的标签（old_tags 中为空的对应位置）
                    for i, (old, new) in enumerate(zip(old_tags, new_tags_list)):
                        if not old and new and new not in new_list:
                            if args.get("prepend"):
                                new_list.insert(0, new)
                            else:
                                new_list.append(new)
                    new_tags = _tag_str(new_list)

            elif operation == "delete_by_filter":
                # 在当前图片上删除匹配过滤条件的标签
                targets = set(args.get("values", []))
                tag_list = _tag_list(tags)
                tag_list = [t for t in tag_list if t not in targets]
                new_tags = _tag_str(tag_list)

            else:
                return {"status": "error", "message": f"未知操作: {operation}"}

        except Exception as e:
            errors.append(f"{img.get('name', '?')}: {e}")
            continue

        if new_tags != tags:
            _write_tags(cap, new_tags)
            modified += 1

    return {
        "status": "success",
        "data": {"modified": modified, "errors": errors}
    }


@router.post("/tageditor/move-delete")
async def move_or_delete_files(data: dict):
    """移动或删除文件

    Body:
      paths: [str]          图片路径列表
      action: "move" | "delete"
      dest: str             目标目录（move 时必填）
      delete_caption: bool  是否同时删除标签文件
    """
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
                if not dest_path.exists():
                    dest_path.mkdir(parents=True, exist_ok=True)
                shutil.move(str(img_path), str(dest_path / img_path.name))
                if delete_caption:
                    cap = _find_caption(img_path)
                    if cap:
                        # 同步移动标签文件
                        cap_dest = dest_path / cap.name
                        if cap.exists():
                            shutil.move(str(cap), str(cap_dest))
                result["moved"] += 1

            elif action == "delete":
                img_path.unlink()
                if delete_caption:
                    cap = _find_caption(img_path)
                    if cap and cap.exists():
                        cap.unlink()
                result["deleted"] += 1
        except Exception as e:
            result["errors"].append(f"{img_path.name}: {e}")

    return {"status": "success", "data": result}


@router.post("/tageditor/restore-backup")
async def restore_from_backup(data: dict):
    """从 .bak 备份还原标签文件

    Body:
      dir: str      数据集目录
    """
    dir_path = data.get("dir", "")
    if not dir_path:
        return {"status": "error", "message": "请指定数据集目录路径"}

    d = _resolve_dir(dir_path)
    if not d.exists():
        return {"status": "error", "message": "目录不存在"}

    restored = 0
    for ext in CAPTION_EXTENSIONS:
        for bak in d.rglob(f"*{ext}.bak"):
            orig = bak.with_suffix("")  # remove .bak
            try:
                shutil.copy2(bak, orig)
                restored += 1
            except Exception:
                pass

    return {"status": "success", "data": {"restored": restored}}


@router.get("/tageditor/download-zip")
async def download_dataset_zip(dir: str = Query("")):
    """下载数据集目录为 zip（图片 + 标签文件）"""
    if not dir:
        return {"status": "error", "message": "请指定数据集目录路径"}

    dir_path = _resolve_dir(dir)
    if not dir_path.exists():
        return {"status": "error", "message": "目录不存在"}

    dir_name = dir_path.name or "dataset"

    # 收集所有文件（图片 + 对应标签 + 备份）
    files_to_zip: list[tuple[Path, str]] = []
    seen_names = set()

    for ext in IMAGE_EXTENSIONS:
        for img in dir_path.rglob(f"*{ext}"):
            if img.name.startswith("."):
                continue
            try:
                arcname = str(img.relative_to(dir_path)).replace("\\", "/")
            except ValueError:
                arcname = img.name
            files_to_zip.append((img, arcname))
            seen_names.add(img.name)

            # 标签文件
            cap = _find_caption(img)
            if cap and cap.exists():
                try:
                    cap_arc = str(cap.relative_to(dir_path)).replace("\\", "/")
                except ValueError:
                    cap_arc = cap.name
                files_to_zip.append((cap, cap_arc))

    # 流式 zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path, arcname in files_to_zip:
            zf.write(file_path, arcname)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{dir_name}.zip"',
        },
    )


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

