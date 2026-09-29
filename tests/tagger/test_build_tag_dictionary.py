"""Tag Editor 词典构建脚本的单元测试。

全部使用内存里的 CSV 夹具，不访问 Hugging Face，也不依赖仓库里生成的静态资源。
"""
import csv
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.dev.build_tag_dictionary import CATEGORY_FILES, build

FIELDS = ["tag", "category", "aliases", "zh", "count", "notes"]

ROWS = {
    "general": [
        ["long_hair", 0, "longhair|长髪|LONGHAIR|", "长发", 6134076, "从肩长到腰长的头发"],
        ["solo", 0, "", "单人", 6984063, ""],
        ["my_custom_tag", 0, "", "", 950, ""],
    ],
    "artist": [
        ["dairi", 1, "dairi155|ダイリ", "ダイリ", 18783, "zh 用日文原名"],
        ["dup_artist", 1, "a|b", "重复画师", 500, "先出现但更冷门"],
        ["dup_artist", 1, "c", "", 900, "后出现但更热门"],
    ],
    "copyright": [
        ["high_score_girl", 3, "High Score Girl|ハイスコアガール", "高分少女", 135, "漫画/动画"],
    ],
    "character": [
        ["hatsune_miku_(append)", 4, "", "初音未来（追加）", 1200, ""],
    ],
    "meta": [
        ["highres", 5, "high_res", "高分辨率", 8019379, ""],
        ["", 5, "", "空标签", 10, "空 canonical 应被丢弃"],
        ["bad,category", 5, "", "逗号标签", 10, "canonical 含逗号应被丢弃"],
        ["unknown_category", 7, "", "未知分类", 10, "未知分类应被丢弃"],
    ],
}


def write_source(root: Path, rows: dict | None = None) -> Path:
    source = root / "src"
    source.mkdir(parents=True, exist_ok=True)
    data = rows if rows is not None else ROWS
    for name in CATEGORY_FILES:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(FIELDS)
        for row in data.get(name, []):
            writer.writerow(row)
        # 数据源文件带 BOM，脚本要能处理
        (source / f"{name}.csv").write_text("\ufeff" + buffer.getvalue(), encoding="utf-8", newline="")
    return source


def read_build(root: Path, rows: dict | None = None, data_version: str = "2026-08") -> tuple[dict, list, list, Path]:
    source = write_source(root, rows)
    output = root / "out"
    manifest = build(source, output, data_version, "https://example.invalid/tags")
    core = json.loads((output / manifest["core"]).read_text(encoding="utf-8"))
    detail = json.loads((output / manifest["detail"]).read_text(encoding="utf-8"))
    return manifest, core, detail, output


class BuildTagDictionaryTests(unittest.TestCase):
    def test_failed_manifest_publish_preserves_installed_version(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first, _, _, output = read_build(root)
            previous = (output / "manifest.json").read_bytes()
            rows = dict(ROWS)
            rows["general"] = [["new_tag", 0, "", "新标签", 1, ""]]
            source = write_source(root, rows)
            replace = Path.replace

            def fail_manifest(path, target):
                if target.name == "manifest.json":
                    raise OSError("publish failed")
                return replace(path, target)

            with patch.object(Path, "replace", fail_manifest):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    build(source, output, "new", "https://example.invalid/tags")
            self.assertEqual((output / "manifest.json").read_bytes(), previous)
            self.assertTrue((output / first["core"]).is_file())
            self.assertFalse(any(p.name.startswith("tmp") for p in output.iterdir()))

    def test_empty_dictionary_cannot_replace_installed_assets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _, _, _, output = read_build(root)
            previous = (output / "manifest.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "没有有效标签"):
                build(write_source(root, {}), output, "new", "https://example.invalid/tags")
            self.assertEqual((output / "manifest.json").read_bytes(), previous)

    def test_canonical_only_keeps_caption_safe_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            _, core, _, _ = read_build(Path(temp_dir))
            for record in core:
                canonical = record[0]
                self.assertTrue(canonical)
                self.assertNotIn(",", canonical)
                self.assertNotIn("\n", canonical)
                self.assertEqual(canonical, canonical.strip())

    def test_empty_category_cannot_replace_installed_assets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _, _, _, output = read_build(root)
            previous = (output / "manifest.json").read_bytes()
            for invalid in ([], [["", 0, "", "", 1, ""]]):
                with self.subTest(rows=invalid):
                    source = write_source(root, {**ROWS, "general": invalid})
                    with self.assertRaisesRegex(ValueError, "分类没有有效标签"):
                        build(source, output, "new", "https://example.invalid/tags")
                    self.assertEqual((output / "manifest.json").read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()
