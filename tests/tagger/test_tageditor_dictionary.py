"""Tag Editor 词典后端：安装状态、离线构建、静态资源白名单。

不联网：下载函数被替换或断言未被调用，构建用内存夹具 CSV。
"""
import csv
import io
import json
import sys
import tempfile
import time
from types import SimpleNamespace
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
            patch.object(dictionary, "_update_check", {}),
        ]
        for item in self._patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.join_install)

    def join_install(self):
        if dictionary._thread is not None:
            dictionary._thread.join(timeout=20)

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

    def test_update_check_compares_content_and_caches_result(self):
        dictionary.start_install()
        wait_for_install()
        hashes = dictionary.read_manifest()["source_hashes"]
        remote = SimpleNamespace(sha="revision", siblings=[
            SimpleNamespace(rfilename=path, blob_id=value["blob"], lfs=None)
            for path, value in hashes.items()])
        with patch.object(dictionary, "_remote_info", return_value=remote) as query:
            self.assertEqual(dictionary.check_update()["state"], "current")
            dictionary.check_update()
            self.assertEqual(query.call_count, 1)
            remote.siblings[0].blob_id = "new-content"
            result = dictionary.check_update(force=True)
            self.assertEqual(result["state"], "available")
            self.assertEqual(result["changed_files"], [remote.siblings[0].rfilename])
        with patch.object(dictionary, "_remote_info", side_effect=OSError("offline")):
            self.assertEqual(dictionary.check_update(force=True)["state"], "error")
            self.assertTrue(dictionary.status()["installed"])

    def build_legacy(self):
        return builder.build(self.source, self.legacy_asset, "legacy", builder.SOURCE_URL,
                             on_report=lambda _: None)

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

    def test_invalid_csv_reports_failed_instead_of_staying_busy(self):
        (self.source / "meta.csv").write_text("bad,header\n1,2\n", encoding="utf-8")
        dictionary.start_install()
        state = wait_for_install()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error_kind"], "build")

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
