#!/usr/bin/env python3
"""构建 Tag Editor 用的 Danbooru 中文词典静态资源。

数据源：ame-la/danbooru-tags-data-zh（MIT），按分类分文件的 CSV：
    tag,category,aliases,zh,count,notes

输出（默认 cache/tag_dictionary/，即后端对外提供静态资源的目录）：
    manifest.json              版本指针（浏览器每次 revalidate）
    tags-core.<hash>.json      canonical / 中文 / 分类 / 图片数 / 别名
    tags-detail.<hash>.json    与 core 同序的说明文本（notes），空串表示无

后端 /api/tageditor/dictionary/install 调用的就是这个 build()：先下载 CSV，
再走同一套校验与拆分。本 CLI 用于离线重建（--input 指向已有的 CSV 目录）。

core/detail 都是"记录数组"，字段用固定下标，避免几十万条重复 key：
    0 canonical  1 translation  2 category  3 post_count  4 aliases（| 连接）

记录按图片数降序排列，因此 tagId 顺序即热门度顺序：翻译/别名精确命中可以直接
按 id 升序返回，contains 回退也能顺序扫描并提前收尾。

用法：
    python tools/dev/build_tag_dictionary.py              # 用 cache/tag_dict_src 里的 CSV 重建
    python tools/dev/build_tag_dictionary.py --download   # 先下载数据源再重建
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]

DEFAULT_INPUT = ROOT / "cache" / "tag_dict_src"
DEFAULT_OUTPUT = ROOT / "cache" / "tag_dictionary"
SOURCE_REPO = "ame-la/danbooru-tags-data-zh"
SOURCE_URL = f"https://huggingface.co/datasets/{SOURCE_REPO}/resolve/main/tags"

# 分类 ID 与 Danbooru 语义一致（2 = 已废弃的 spoiler 分类，不出现）
CATEGORIES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}
CATEGORY_FILES = ["general", "artist", "copyright", "character", "meta"]

SCHEMA_VERSION = 1
REQUIRED_FIELDS = {"tag", "category", "aliases", "zh", "count", "notes"}

# caption 用逗号分隔、换行分隔文本行，词典值一旦带这些字符会破坏结构
_FORBIDDEN_IN_TAG = (",", "\n", "\r")
_WHITESPACE = re.compile(r"\s+")


class BuildReport:
    """收集构建期的异常记录，构建结束后统一打印，不静默丢数据。"""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.samples: dict[str, list[str]] = {}

    def add(self, kind: str, detail: str) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        bucket = self.samples.setdefault(kind, [])
        if len(bucket) < 5:
            bucket.append(detail)

    def merge(self, kind: str, count: int, samples: list[str]) -> None:
        if count <= 0:
            return
        self.counts[kind] = self.counts.get(kind, 0) + count
        bucket = self.samples.setdefault(kind, [])
        for sample in samples:
            if len(bucket) >= 5:
                break
            bucket.append(sample)

    def text(self) -> str:
        if not self.counts:
            return "构建报告：无异常记录"
        lines = ["构建报告："]
        for kind in sorted(self.counts):
            lines.append(f"  {kind}: {self.counts[kind]}")
            for sample in self.samples.get(kind, []):
                lines.append(f"      {sample}")
        return "\n".join(lines)


def normalize_key(value: str) -> str:
    """词典索引键：小写、去首尾空白、空白折叠为下划线。

    与前端 tag-dictionary-lib.js 的 normalizeKey 保持一致。"""
    return _WHITESPACE.sub("_", (value or "").strip().lower())


def parse_int(value: str, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def pack_aliases(raw: str, canonical_key: str, report: BuildReport, row_name: str) -> list[str]:
    """别名只用于搜索和悬停展示，不写进 caption，因此允许逗号。

    竖线是打包时的分隔符，必须剔除。"""
    out: list[str] = []
    seen = {canonical_key}
    for part in (raw or "").split("|"):
        alias = sanitize_text(part)
        if not alias:
            continue
        if "|" in alias:
            report.add("别名含竖线（已丢弃）", f"{row_name} → {alias!r}")
            continue
        key = normalize_key(alias)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(alias)
    return out


def sanitize_text(value: str) -> str:
    """压缩换行与多余空白：说明/翻译只用于显示，不能把换行带进 UI。"""
    return _WHITESPACE.sub(" ", (value or "").strip())


def entry_from_row(row: dict, report: BuildReport, origin: str) -> dict | None:
    tag = (row.get("tag") or "").strip()
    if not tag:
        report.add("canonical 为空（已丢弃）", origin)
        return None
    for bad in _FORBIDDEN_IN_TAG:
        if bad in tag:
            report.add("canonical 含逗号或换行（已丢弃）", f"{origin} → {tag!r}")
            return None
    if tag != (row.get("tag") or ""):
        report.add("canonical 首尾有空白（已清理）", f"{origin} → {tag!r}")
    if tag != tag.lower():
        report.add("canonical 含大写（保留原样）", f"{origin} → {tag!r}")

    category = parse_int(row.get("category"), -1)
    if category not in CATEGORIES:
        report.add("分类缺失或未知（已丢弃）", f"{origin} → {tag!r} category={row.get('category')!r}")
        return None

    canonical_key = normalize_key(tag)
    translation = sanitize_text(row.get("zh") or "")
    if "," in translation:
        report.add("中文含逗号（仅显示与搜索，保留）", f"{tag} → {translation}")
    if translation and normalize_key(translation) == canonical_key:
        # 数据源在没有通用中文名时用原名回填，等同没有翻译
        report.add("中文与标签同名（视为无翻译）", f"{tag}")
        translation = ""

    description = sanitize_text(row.get("notes") or "")

    return {
        "canonical": tag,
        "canonical_key": canonical_key,
        "translation": translation,
        "category": category,
        "post_count": max(0, parse_int(row.get("count"), 0)),
        "aliases": pack_aliases(row.get("aliases") or "", canonical_key, report, tag),
        "description": description,
    }


def load_rows(input_dir: Path, report: BuildReport) -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []
    for name in CATEGORY_FILES:
        path = input_dir / f"{name}.csv"
        if not path.exists():
            raise SystemExit(f"缺少数据文件：{path}（可加 --download 拉取数据源）")
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            fields = set(reader.fieldnames or [])
            missing = REQUIRED_FIELDS - fields
            if missing:
                raise SystemExit(f"{path} 缺少字段：{sorted(missing)}（实际字段 {sorted(fields)}）")
            for index, row in enumerate(reader, start=2):
                rows.append((f"{name}.csv:{index}", row))
    return rows


def download_sources(input_dir: Path, source_url: str) -> None:
    input_dir.mkdir(parents=True, exist_ok=True)
    for name in CATEGORY_FILES:
        url = f"{source_url}/{name}.csv"
        target = input_dir / f"{name}.csv"
        print(f"下载 {url}")
        with urllib.request.urlopen(url) as response:  # noqa: S310 - 固定 HTTPS 数据源
            target.write_bytes(response.read())
        print(f"  → {target} ({target.stat().st_size} 字节)")


def build_entries(rows: list[tuple[str, dict]], report: BuildReport) -> list[dict]:
    by_key: dict[str, dict] = {}
    duplicates: list[str] = []
    for origin, row in rows:
        entry = entry_from_row(row, report, origin)
        if entry is None:
            continue
        key = entry["canonical_key"]
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = entry
            continue
        # 同帧 canonical：保留图片数更高的那条，缺字段从另一条补齐
        duplicates.append(entry["canonical"])
        if entry["post_count"] >= existing["post_count"]:
            keep, drop = entry, existing
        else:
            keep, drop = existing, entry
        keep["translation"] = keep["translation"] or drop["translation"]
        keep["description"] = keep["description"] or drop["description"]
        keep["aliases"] = list(dict.fromkeys(keep["aliases"] + drop["aliases"]))
        by_key[key] = keep
    report.merge("canonical 重复（保留图片数最高）", len(duplicates), duplicates)

    entries = list(by_key.values())
    entries.sort(key=lambda item: (-item["post_count"], item["canonical"]))
    return entries


def pack_core(entries: list[dict]) -> str:
    records = [
        [
            entry["canonical"],
            entry["translation"],
            entry["category"],
            entry["post_count"],
            "|".join(entry["aliases"]),
        ]
        for entry in entries
    ]
    return json.dumps(records, ensure_ascii=False, separators=(",", ":"))


def pack_detail(entries: list[dict]) -> str:
    return json.dumps([entry["description"] for entry in entries], ensure_ascii=False, separators=(",", ":"))


def content_hash(*payloads: str) -> str:
    digest = hashlib.sha256()
    for payload in payloads:
        digest.update(payload.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()[:8]


def prune_old_assets(output_dir: Path, keep: set[str]) -> list[str]:
    removed: list[str] = []
    for path in sorted(output_dir.glob("tags-*.json")):
        if path.name in keep:
            continue
        path.unlink()
        removed.append(path.name)
    return removed


def build(input_dir: Path, output_dir: Path, data_version: str, source_url: str,
          on_report: Callable[[str], None] | None = None) -> dict:
    """构建 core/detail/manifest。

    on_report 给出时把构建报告交给调用方（后端安装流程要把它记进状态日志），
    否则直接打印到控制台。"""
    report = BuildReport()
    rows = load_rows(input_dir, report)
    entries = build_entries(rows, report)

    core_text = pack_core(entries)
    detail_text = pack_detail(entries)
    digest = content_hash(core_text, detail_text)
    core_name = f"tags-core.{digest}.json"
    detail_name = f"tags-detail.{digest}.json"

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / core_name).write_text(core_text, encoding="utf-8", newline="\n")
    (output_dir / detail_name).write_text(detail_text, encoding="utf-8", newline="\n")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "data_version": data_version,
        "tag_count": len(entries),
        "core": core_name,
        "detail": detail_name,
        "source": {
            "name": SOURCE_REPO,
            "url": f"https://huggingface.co/datasets/{SOURCE_REPO}",
            "license": "MIT",
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    removed = prune_old_assets(output_dir, {core_name, detail_name})

    with_description = sum(1 for entry in entries if entry["description"])
    with_translation = sum(1 for entry in entries if entry["translation"])
    alias_total = sum(len(entry["aliases"]) for entry in entries)
    bytes_core = len(core_text.encode("utf-8"))
    bytes_detail = len(detail_text.encode("utf-8"))

    lines = [
        f"源数据：{input_dir}",
        f"输出目录：{output_dir}",
        f"标签数：{len(entries)}（源行 {len(rows)}）",
        f"  有中文：{with_translation}  无中文：{len(entries) - with_translation}",
        f"  有说明：{with_description}  别名总数：{alias_total}",
        f"  core   {core_name}  {bytes_core / 1048576:.2f} MB",
        f"  detail {detail_name}  {bytes_detail / 1048576:.2f} MB",
        f"  无说明的 detail 槽位：{len(entries) - with_description}",
    ]
    for category, name in sorted(CATEGORIES.items()):
        count = sum(1 for entry in entries if entry["category"] == category)
        lines.append(f"  {name:10s} {count}")
    if removed:
        lines.append("清理旧资源：" + ", ".join(removed))
    lines.append(report.text())
    text = "\n".join(lines)
    if on_report is not None:
        on_report(text)
    else:
        print(text)
    return manifest


def default_data_version(input_dir: Path) -> str:
    stamps = [path.stat().st_mtime for path in input_dir.glob("*.csv")]
    if not stamps:
        return "unknown"
    import datetime

    newest = datetime.date.fromtimestamp(max(stamps))
    return f"{newest.year:04d}-{newest.month:02d}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 Tag Editor 标签词典静态资源")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="CSV 源目录")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="静态资源输出目录")
    parser.add_argument("--data-version", default="", help="写入 manifest 的数据版本，默认取源文件月份")
    parser.add_argument("--download", action="store_true", help="先下载数据源再构建")
    parser.add_argument("--source-url", default=SOURCE_URL, help="数据源 tags 目录 URL")
    args = parser.parse_args(argv)

    if args.download:
        download_sources(args.input, args.source_url)
    data_version = args.data_version or default_data_version(args.input)
    build(args.input, args.output, data_version, args.source_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
