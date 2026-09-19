"""Tag Editor 词典后端：安装状态、离线构建、静态资源白名单。

不联网：下载函数被替换或断言未被调用，构建用内存夹具 CSV。
"""
import csv
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.server import app  # noqa: E402
from backend.tageditor import dictionary  # noqa: E402
from tools.dev import build_tag_dictionary as builder  # noqa: E402
from tools.dev.build_tag_dictionary import CATEGORY_FILES  # noqa: E402

FIELDS = ["tag", "category", "aliases", "zh", "count", "notes"]
ROWS = {
    "general": [["long_hair", 0, "longhair", "长发", 6134076, "从肩长到腰长"],
                ["solo", 0, "", "单人", 6984063, ""]],
    "artist": [["dairi", 1, "dairi155", "ダイリ", 18783, "画师"]],
    "copyright": [["high_score_girl", 3, "", "高分少女", 135, "作品"]],
    "character": [["hatsune_miku", 4, "", "初音未来", 5000, "角色"]],
    "meta": [["highres", 5, "", "高分辨率", 8019379, "元标签"]],
}


def write_sources(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in CATEGORY_FILES:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(FIELDS)
        for row in ROWS.get(name, []):
            writer.writerow(row)
        (directory / f"{name}.csv").write_text("\ufeff" + buffer.getvalue(), encoding="utf-8", newline="")
    return directory


def wait_for_install(timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = dictionary.status()
        if state["status"] in ("ready", "failed"):
            return state
        time.sleep(0.05)
    raise AssertionError("install did not finish in time")


class DictionaryInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.asset = root / "hf" / "tag_dictionary" / "asset"
        self.source = write_sources(root / "hf" / "tag_dictionary" / "source")
        self.legacy_asset = root / "cache" / "tag_dictionary"
        self.legacy_source = root / "cache" / "tag_dict_src"
        self._patches = [
            patch.object(dictionary, "LEGACY_ASSET_DIR", self.legacy_asset),
            patch.object(builder, "LEGACY_SOURCE_DIR", self.legacy_source),
            patch.object(dictionary, "ASSET_DIR", self.asset),
            patch.object(dictionary, "SOURCE_DIR", self.source),
            patch.object(dictionary, "_state", {"status": "idle", "message": "", "finished_at": "", "log": []}),
            patch.object(dictionary, "_progress", {}),
        ]
        for item in self._patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.join_install)

    def join_install(self):
        if dictionary._thread is not None:
            dictionary._thread.join(timeout=20)

    def test_status_reports_absent_without_assets(self):
        state = dictionary.status()
        self.assertFalse(state["installed"])
        self.assertEqual(state["status"], "idle")
        self.assertEqual(state["tag_count"], 0)
        self.assertEqual(state["source"], "ame-la/danbooru-tags-data-zh")

    def test_install_builds_from_local_csv_without_downloading(self):
        with patch.object(dictionary, "download_hf_file") as download:
            download.side_effect = AssertionError("本地已有 CSV 时不该联网")
            result = dictionary.start_install()
            state = wait_for_install()
        self.assertTrue(result["started"])
        self.assertEqual(state["status"], "ready")
        self.assertTrue(state["installed"])
        self.assertEqual(state["tag_count"], 6)
        self.assertGreater(state["size_bytes"], 0)
        self.assertTrue(state["data_version"])

        manifest = json.loads((self.asset / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["tag_count"], 6)
        records = json.loads((self.asset / manifest["core"]).read_text(encoding="utf-8"))
        self.assertEqual([r[0] for r in records][0], "highres")     # 图片数最高
        self.assertEqual(records[0][1], "高分辨率")
        self.assertEqual([r[0] for r in records][-1], "high_score_girl")
        self.assertEqual([r[3] for r in records], sorted([r[3] for r in records], reverse=True))
        download.assert_not_called()

    def test_install_skipped_when_already_installed(self):
        dictionary.start_install()
        wait_for_install()
        again = dictionary.start_install()
        self.assertFalse(again["started"])
        self.assertEqual(again["reason"], "installed")

    def test_force_install_downloads_again(self):
        dictionary.start_install()
        wait_for_install()
        with patch.object(dictionary, "download_hf_file") as download:
            download.side_effect = RuntimeError("network down")
            result = dictionary.start_install(force=True)
            state = wait_for_install()
        self.assertTrue(result["started"])
        self.assertEqual(state["status"], "failed")
        self.assertIn("network down", state["message"])
        # 上一次装好的词典仍然可用，失败不会把已有资源清掉
        self.assertTrue(state["installed"])

    def test_asset_path_is_limited_to_installed_files(self):
        dictionary.start_install()
        wait_for_install()
        manifest = json.loads((self.asset / "manifest.json").read_text(encoding="utf-8"))
        self.assertIsNotNone(dictionary.asset_path("manifest.json"))
        self.assertIsNotNone(dictionary.asset_path(manifest["core"]))
        for name in ["../manifest.json", "..\\manifest.json", "tags-core.deadbeef.json",
                     "sub/manifest.json", ".hidden", "", "artist.csv"]:
            self.assertIsNone(dictionary.asset_path(name), name)

    def build_legacy(self):
        return builder.build(self.source, self.legacy_asset, "legacy", builder.SOURCE_URL,
                             on_report=lambda _: None)

    def test_legacy_assets_are_served_without_install_or_download(self):
        manifest = self.build_legacy()
        with patch.object(dictionary, "download_hf_file") as download:
            result = dictionary.start_install()
        self.assertFalse(result["started"])
        self.assertEqual(result["reason"], "installed")
        self.assertEqual(dictionary.status()["data_version"], "legacy")
        self.assertEqual(dictionary.status()["size_bytes"], sum(
            (self.legacy_asset / manifest[key]).stat().st_size for key in ("core", "detail")))
        for name in ("manifest.json", manifest["core"], manifest["detail"]):
            self.assertEqual(dictionary.asset_path(name), self.legacy_asset / name)
        download.assert_not_called()
        self.assertFalse(self.asset.exists())

    def test_new_assets_take_priority_and_incomplete_assets_fall_back(self):
        legacy = self.build_legacy()
        source = self.source / 'general.csv'
        source.write_text(source.read_text(encoding='utf-8').replace('长发', '新长发'), encoding='utf-8')
        manifest = builder.build(self.source, self.asset, "new", builder.SOURCE_URL,
                                 on_report=lambda _: None)
        self.assertEqual(dictionary.status()["data_version"], "new")
        self.assertEqual(dictionary.asset_path(legacy['detail']), self.legacy_asset / legacy['detail'])
        (self.asset / manifest["core"]).unlink()
        self.assertEqual(dictionary.status()["data_version"], "legacy")
        (self.asset / "manifest.json").write_text("{", encoding="utf-8")
        self.assertEqual(dictionary.status()["data_version"], "legacy")

    def test_legacy_sources_fill_missing_files_without_overwriting_new_data(self):
        write_sources(self.legacy_source)
        preserved = self.source / "general.csv"
        preserved.write_text(preserved.read_text(encoding="utf-8").replace("长发", "新长发"),
                             encoding="utf-8")
        expected = preserved.read_bytes()
        (self.source / "artist.csv").unlink()
        (self.source / "meta.csv").write_bytes(b"")
        with patch.object(dictionary, "download_hf_file") as download:
            dictionary.start_install()
            state = wait_for_install()
        self.assertEqual(state["status"], "ready", state)
        download.assert_not_called()
        self.assertEqual(preserved.read_bytes(), expected)
        self.assertEqual((self.source / "artist.csv").read_bytes(),
                         (self.legacy_source / "artist.csv").read_bytes())
        self.assertTrue(self.legacy_source.exists())
        self.assertEqual(set(p.name for p in self.source.iterdir()),
                         {f"{name}.csv" for name in CATEGORY_FILES})
        self.assertTrue(any("构建报告" in line for line in dictionary._state["log"]))

    def test_empty_legacy_source_is_downloaded(self):
        (self.source / "artist.csv").unlink()
        self.legacy_source.mkdir(parents=True)
        (self.legacy_source / "artist.csv").write_bytes(b"")
        with patch.object(dictionary, "download_hf_file") as download:
            dictionary._download_sources(False)
        self.assertEqual(download.call_count, 1)
        self.assertEqual(download.call_args.args[1], "tags/artist.csv")

    def test_force_download_ignores_legacy_sources(self):
        write_sources(self.legacy_source)
        with patch.object(dictionary, "download_hf_file") as download, \
                patch.object(dictionary, "reuse_legacy_sources") as reuse:
            dictionary._download_sources(True)
        self.assertEqual(download.call_count, len(CATEGORY_FILES))
        reuse.assert_not_called()

    def test_invalid_csv_reports_failed_instead_of_staying_busy(self):
        (self.source / "meta.csv").write_text("bad,header\n1,2\n", encoding="utf-8")
        dictionary.start_install()
        state = wait_for_install()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error_kind"], "build")

    def test_invalid_legacy_manifest_is_not_installed(self):
        manifest = self.build_legacy()
        (self.legacy_asset / manifest["detail"]).unlink()
        self.assertFalse(dictionary.status()["installed"])
        manifest["detail"] = "../outside.json"
        (self.legacy_asset.parent / "outside.json").write_text("[]", encoding="utf-8")
        (self.legacy_asset / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.assertFalse(dictionary.status()["installed"])

    def test_interrupted_copy_leaves_no_partial_source(self):
        write_sources(self.legacy_source)
        target = self.source / "artist.csv"
        target.unlink()
        with patch.object(builder.shutil, "copy2", side_effect=OSError("copy failed")):
            with self.assertRaisesRegex(OSError, "copy failed"):
                builder.reuse_legacy_sources(self.source)
        self.assertFalse(target.exists())
        self.assertEqual(len(list(self.source.iterdir())), len(CATEGORY_FILES) - 1)
        builder.reuse_legacy_sources(self.source)
        self.assertEqual(target.read_bytes(), (self.legacy_source / target.name).read_bytes())

    def test_cli_default_input_reuses_legacy_sources(self):
        write_sources(self.legacy_source)
        source = self.source.parent / "missing-source"
        with patch.object(builder, "DEFAULT_INPUT", source), \
                patch.object(builder, "DEFAULT_OUTPUT", self.asset), \
                patch.object(builder, "download_sources") as download, \
                patch("builtins.print"):
            self.assertEqual(builder.main([]), 0)
        download.assert_not_called()
        self.assertTrue((source / "general.csv").is_file())
        self.assertTrue(dictionary.status()["installed"])

    def test_hf_home_controls_default_directories(self):
        with patch.dict("os.environ", {"HF_HOME": str(self.source.parent.parent)}):
            self.assertEqual(builder.default_source_dir(), self.source)
            self.assertEqual(builder.default_asset_dir(), self.asset)


class DictionaryRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.asset = root / "cache"
        self.source = write_sources(root / "src")
        for item in [
            patch.object(dictionary, "LEGACY_ASSET_DIR", root / "legacy-assets"),
            patch.object(builder, "LEGACY_SOURCE_DIR", root / "legacy-source"),
            patch.object(dictionary, "ASSET_DIR", self.asset),
            patch.object(dictionary, "SOURCE_DIR", self.source),
            patch.object(dictionary, "_state", {"status": "idle", "message": "", "finished_at": "", "log": []}),
            patch.object(dictionary, "_progress", {}),
        ]:
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(DictionaryInstallTests.join_install, self)

    def test_status_endpoint(self):
        payload = self.client.get("/api/tageditor/dictionary").json()
        self.assertEqual(payload["status"], "success")
        self.assertFalse(payload["data"]["installed"])

    def test_legacy_asset_endpoint(self):
        manifest = builder.build(self.source, dictionary.LEGACY_ASSET_DIR, "legacy",
                                 builder.SOURCE_URL, on_report=lambda _: None)
        self.assertTrue(self.client.get("/api/tageditor/dictionary").json()["data"]["installed"])
        for name in ("manifest.json", manifest["core"], manifest["detail"]):
            response = self.client.get(f"/api/tageditor/dictionary/asset/{name}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, (dictionary.LEGACY_ASSET_DIR / name).read_bytes())

    def test_asset_endpoint_serves_installed_files_and_blocks_others(self):
        self.client.post("/api/tageditor/dictionary/install", json={})
        wait_for_install()
        manifest = json.loads((self.asset / "manifest.json").read_text(encoding="utf-8"))

        response = self.client.get("/api/tageditor/dictionary/asset/manifest.json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tag_count"], 6)
        self.assertIn("no-cache", response.headers["cache-control"])

        # 内容文件带 ?v= 换一年 immutable；不带查询串则保持 revalidate
        hashed = self.client.get(f"/api/tageditor/dictionary/asset/{manifest['core']}?v={manifest['core']}")
        self.assertEqual(hashed.status_code, 200)
        self.assertIn("immutable", hashed.headers["cache-control"])
        plain = self.client.get(f"/api/tageditor/dictionary/asset/{manifest['core']}")
        self.assertIn("no-cache", plain.headers["cache-control"])

        self.assertEqual(self.client.get("/api/tageditor/dictionary/asset/tags-core.0.json").status_code, 404)
        missing = self.client.get("/api/tageditor/dictionary/asset/tags-core.00000000.json?v=1")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.headers["cache-control"], "no-store")
        # 路径穿越：HTTP 客户端与服务端都会先归一化 ..，真正的防线是路由遇到带分隔符
        # 的名字直接拒绝（见 test_asset_path_is_limited_to_installed_files），
        # 这里确认这类请求拿不到词典内容。
        for path in ["/api/tageditor/dictionary/asset/../manifest.json",
                     "/api/tageditor/dictionary/asset/%2e%2e%2fmanifest.json"]:
            self.assertNotIn("schema_version", self.client.get(path).text, path)


if __name__ == "__main__":
    unittest.main()
