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
        root = Path(self.temp.name)
        self.cache = root / "cache"
        self.source = write_sources(root / "src")
        self._patches = [
            patch.object(dictionary, "CACHE_DIR", self.cache),
            patch.object(dictionary, "SOURCE_DIR", self.source),
            patch.object(dictionary, "_state", {"status": "idle", "message": "", "finished_at": "", "log": []}),
            patch.object(dictionary, "_progress", {}),
        ]
        for item in self._patches:
            item.start()
            self.addCleanup(item.stop)

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
        self.assertTrue(result["started"])
        state = wait_for_install()
        self.assertEqual(state["status"], "ready")
        self.assertTrue(state["installed"])
        self.assertEqual(state["tag_count"], 6)
        self.assertGreater(state["size_bytes"], 0)
        self.assertTrue(state["data_version"])

        manifest = json.loads((self.cache / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["tag_count"], 6)
        records = json.loads((self.cache / manifest["core"]).read_text(encoding="utf-8"))
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
        self.assertTrue(result["started"])
        state = wait_for_install()
        self.assertEqual(state["status"], "failed")
        self.assertIn("network down", state["message"])
        # 上一次装好的词典仍然可用，失败不会把已有资源清掉
        self.assertTrue(state["installed"])

    def test_asset_path_is_limited_to_installed_files(self):
        dictionary.start_install()
        wait_for_install()
        manifest = json.loads((self.cache / "manifest.json").read_text(encoding="utf-8"))
        self.assertIsNotNone(dictionary.asset_path("manifest.json"))
        self.assertIsNotNone(dictionary.asset_path(manifest["core"]))
        for name in ["../manifest.json", "..\\manifest.json", "tags-core.deadbeef.json",
                     "sub/manifest.json", ".hidden", "", "artist.csv"]:
            self.assertIsNone(dictionary.asset_path(name), name)


class DictionaryRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.cache = root / "cache"
        self.source = write_sources(root / "src")
        for item in [
            patch.object(dictionary, "CACHE_DIR", self.cache),
            patch.object(dictionary, "SOURCE_DIR", self.source),
            patch.object(dictionary, "_state", {"status": "idle", "message": "", "finished_at": "", "log": []}),
            patch.object(dictionary, "_progress", {}),
        ]:
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(app)

    def test_status_endpoint(self):
        payload = self.client.get("/api/tageditor/dictionary").json()
        self.assertEqual(payload["status"], "success")
        self.assertFalse(payload["data"]["installed"])

    def test_asset_endpoint_serves_installed_files_and_blocks_others(self):
        self.client.post("/api/tageditor/dictionary/install", json={})
        wait_for_install()
        manifest = json.loads((self.cache / "manifest.json").read_text(encoding="utf-8"))

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
        # 路径穿越：HTTP 客户端与服务端都会先归一化 ..，真正的防线是路由遇到带分隔符
        # 的名字直接拒绝（见 test_asset_path_is_limited_to_installed_files），
        # 这里确认这类请求拿不到词典内容。
        for path in ["/api/tageditor/dictionary/asset/../manifest.json",
                     "/api/tageditor/dictionary/asset/%2e%2e%2fmanifest.json"]:
            self.assertNotIn("schema_version", self.client.get(path).text, path)


if __name__ == "__main__":
    unittest.main()
