"""
Tag Editor 核心 — 文件操作、标签读写、图片扫描
"""
from __future__ import annotations

import shutil
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
CAPTION_EXTENSIONS = {".txt", ".caption"}


def resolve_dir(dir_path: str) -> Path:
    """解析目录路径，支持相对路径"""
    p = Path(dir_path)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p


def find_caption(img_path: Path) -> Path | None:
    """查找图片对应的标签文件 (.txt / .caption)"""
    for ext in CAPTION_EXTENSIONS:
        cap = img_path.with_suffix(ext)
        if cap.exists():
            return cap
    return None


def read_tags(cap_path: Path) -> str:
    """读取标签文件内容"""
    try:
        return cap_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def write_tags(cap_path: Path, tags: str) -> None:
    """写入标签文件（自动 .bak 备份）"""
    if cap_path.exists():
        bak_path = cap_path.with_suffix(cap_path.suffix + ".bak")
        try:
            shutil.copy2(cap_path, bak_path)
        except Exception:
            pass
    cap_path.write_text(tags.strip(), encoding="utf-8", errors="replace")


def thumbnail_url(img_path: Path) -> str:
    """图片缩略图 API URL"""
    try:
        rel = str(img_path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        rel = str(img_path).replace("\\", "/")
    return f"/api/tageditor/thumbnail?path={rel}"


def scan_images(dir_path: Path, recursive: bool = True) -> list[dict]:
    """扫描目录下所有图片及对应标签"""
    images = []
    glob_method = dir_path.rglob if recursive else dir_path.glob
    for ext in IMAGE_EXTENSIONS:
        for img in glob_method(f"*{ext}"):
            if img.name.startswith("."):
                continue
            cap = find_caption(img)
            tags = read_tags(cap) if cap else ""
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
                "thumbnail": thumbnail_url(img),
            })
    images.sort(key=lambda x: x["name"])
    return images


def tag_list(tags_str: str) -> list[str]:
    """逗号分隔字符串 → 去空格的标签列表"""
    return [t.strip() for t in tags_str.split(",") if t.strip()]


def tag_str(tag_list: list[str]) -> str:
    """标签列表 → 逗号分隔字符串"""
    return ", ".join(tag_list)


def count_tags(dir_path: Path, recursive: bool = True) -> tuple[list[dict], int]:
    """统计所有标签出现频率"""
    counter: Counter = Counter()
    total_images = 0
    glob_method = dir_path.rglob if recursive else dir_path.glob
    for ext in IMAGE_EXTENSIONS:
        for img in glob_method(f"*{ext}"):
            if img.name.startswith("."):
                continue
            cap = find_caption(img)
            if cap:
                tags = tag_list(read_tags(cap))
                counter.update(tags)
                total_images += 1

    tags_data = [
        {"tag": tag, "count": count}
        for tag, count in counter.most_common()
    ]
    return tags_data, total_images
