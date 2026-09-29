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
from types import SimpleNamespace
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


    def build_legacy(self):
        return builder.build(self.source, self.legacy_asset, "legacy", builder.SOURCE_URL,
                             on_report=lambda _: None)


    def test_invalid_csv_reports_failed_instead_of_staying_busy(self):
        previous = self.build_legacy()
        (self.source / "meta.csv").write_text("bad,header\n1,2\n", encoding="utf-8")
        with patch.object(dictionary, "_download_sources"):
            dictionary.start_install(force=True)
            state = wait_for_install()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["error_kind"], "build")
        self.assertEqual(dictionary.read_manifest(), previous)
        self.assertTrue(dictionary.asset_path(previous["core"]).is_file())

    def test_update_downloads_all_files_at_one_revision_and_checks_hashes(self):
        previous = self.build_legacy()
        hashes = builder.source_hashes(self.source)
        info = SimpleNamespace(sha="fixed-revision", siblings=[
            SimpleNamespace(rfilename=path, lfs=None, blob_id=hashes[path]["blob"])
            for path, _ in dictionary.HF_FILES])
        info.siblings[-1].lfs = SimpleNamespace(sha256=hashes[info.siblings[-1].rfilename]["sha256"])
        with patch.object(dictionary, "HfApi") as api, \
                patch.object(dictionary, "download_hf_file") as download:
            api.return_value.dataset_info.return_value = info
            dictionary._download_sources(True)
            self.assertEqual(download.call_count, 5)
            self.assertTrue(all(call.kwargs["revision"] == info.sha for call in download.call_args_list))
            info.siblings[0].blob_id = "bad"
            with self.assertRaises(dictionary.IntegrityError):
                dictionary._download_sources(True)
            self.assertFalse((self.source / "general.csv").exists())
        self.assertEqual(dictionary.read_manifest(), previous)
        self.assertTrue(dictionary.asset_path(previous["detail"]).is_file())

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


class DictionaryUpdateTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"core": "core.json", "tag_count": 6, "source_hashes": {
            path: {"blob": "old", "sha256": "old-lfs"} for path, _ in dictionary.HF_FILES}}
        for item in [patch.object(dictionary, "read_manifest", return_value=self.manifest),
                     patch.object(dictionary, "_update_check", {})]:
            item.start()
            self.addCleanup(item.stop)

    def info(self, changed=False):
        info = SimpleNamespace(sha="revision", siblings=[
            SimpleNamespace(rfilename=path, lfs=None, blob_id="old")
            for path, _ in dictionary.HF_FILES])
        info.siblings[0].lfs = SimpleNamespace(sha256="new-lfs" if changed else "old-lfs")
        return info

    def test_same_tag_count_with_changed_content_uses_official_not_stale_mirror(self):
        with patch.object(dictionary, "HfApi") as api:
            api.return_value.dataset_info.return_value = self.info(changed=True)
            result = dictionary.check_update(True)
        api.assert_called_once_with(endpoint="https://huggingface.co")
        self.assertEqual(result["state"], "available")
        self.assertEqual(result["changed_files"], [dictionary.HF_FILES[0][0]])

    def test_official_failure_does_not_report_current_from_mirror(self):
        with patch.object(dictionary, "HfApi") as api:
            api.return_value.dataset_info.side_effect = OSError("official unavailable")
            result = dictionary.check_update(True)
        api.assert_called_once_with(endpoint="https://huggingface.co")
        self.assertEqual(result["state"], "error")
        self.assertEqual(result["error_kind"], "source")

    def test_manual_check_bypasses_cached_current_result(self):
        with patch.object(dictionary, "HfApi") as api:
            remote = api.return_value.dataset_info
            remote.side_effect = [self.info(), self.info(True)]
            self.assertEqual(dictionary.check_update()["state"], "current")
            self.assertEqual(dictionary.check_update()["state"], "current")
            self.assertEqual(dictionary.check_update(True)["state"], "available")
        self.assertEqual(remote.call_count, 2)

    def test_repository_revision_change_without_csv_changes_is_current(self):
        info = self.info()
        info.sha = "readme-only-commit"
        with patch.object(dictionary, "HfApi") as api:
            api.return_value.dataset_info.return_value = info
            self.assertEqual(dictionary.check_update(True)["state"], "current")

    def test_incomplete_official_metadata_blocks_check_and_download(self):
        for defect in ("revision", "file", "fingerprint"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory, \
                    patch.object(dictionary, "SOURCE_DIR", Path(directory)), \
                    patch.object(dictionary, "HfApi") as api, \
                    patch.object(dictionary, "download_hf_file") as download:
                info = self.info()
                if defect == "revision":
                    info.sha = None
                elif defect == "file":
                    info.siblings.pop()
                else:
                    info.siblings[0].lfs.sha256 = None
                api.return_value.dataset_info.return_value = info
                self.assertEqual(dictionary.check_update(True)["state"], "error")
                with self.assertRaises(RuntimeError):
                    dictionary._download_sources(True)
                download.assert_not_called()

    def test_install_does_not_fall_back_to_stale_mirror_metadata(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(dictionary, "SOURCE_DIR", Path(directory)), \
                patch.object(dictionary, "HfApi") as api, \
                patch.object(dictionary, "download_hf_file") as download:
            api.return_value.dataset_info.side_effect = OSError("offline")
            with self.assertRaises(dictionary.DictionarySourceError):
                dictionary._download_sources(True)
        api.assert_called_once_with(endpoint="https://huggingface.co")
        download.assert_not_called()


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

    def test_update_endpoint_forwards_force(self):
        with patch.object(dictionary, "check_update", return_value={"state": "available"}) as check:
            response = self.client.get("/api/tageditor/dictionary/update?force=true")
        check.assert_called_once_with(True)
        self.assertEqual(response.json()["data"]["state"], "available")

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
