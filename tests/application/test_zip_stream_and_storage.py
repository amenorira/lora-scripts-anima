"""Tests for streaming ZIP/ZIP64, storage path env vars, root_path, FUSE fsync/flock, and staging."""
from __future__ import annotations

import errno
import io
import os
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import constants
from backend.utils import file_io, hf_download, zip_stream


class StreamingZipTests(unittest.TestCase):
    def test_iter_zip_chunks_valid_archive_compression_and_missing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img = root / "sample" / "图1.png"
            img.parent.mkdir(parents=True)
            img_bytes = b"\x89PNG\r\n\x1a\n" + os.urandom(4096)
            img.write_bytes(img_bytes)

            txt = root / "sample" / "图1.txt"
            txt_bytes = ("masterpiece, anime girl, detailed background, " * 80).encode("utf-8")
            txt.write_bytes(txt_bytes)

            empty = root / "empty.log"
            empty.write_bytes(b"")

            missing = root / "vanished.txt"

            entries = [
                (img, "sample/图1.png"),
                (txt, "sample/图1.txt"),
                (empty, "empty.log"),
                (missing, "vanished.txt"),
            ]
            archive_bytes = b"".join(zip_stream.iter_zip_chunks(entries, compress_text=True, chunk_size=512))

            with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as zf:
                self.assertIsNone(zf.testzip())
                self.assertEqual(zf.namelist(), ["sample/图1.png", "sample/图1.txt", "empty.log"])
                self.assertEqual(zf.read("sample/图1.png"), img_bytes)
                self.assertEqual(zf.read("sample/图1.txt"), txt_bytes)
                self.assertEqual(zf.read("empty.log"), b"")

                img_info = zf.getinfo("sample/图1.png")
                txt_info = zf.getinfo("sample/图1.txt")
                self.assertEqual(img_info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(txt_info.compress_type, zipfile.ZIP_DEFLATED)
                self.assertLess(txt_info.compress_size, txt_info.file_size)

    def test_iter_zip_chunks_zip64_format_passes_zipfile_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            weights = root / "model.safetensors"
            payload = b"SAFETENSORS_DATA_" * 1000
            weights.write_bytes(payload)

            archive_bytes = b"".join(
                zip_stream.iter_zip_chunks([(weights, "model.safetensors")], compress_text=False, force_zip64=True)
            )
            self.assertIn(b"PK\x06\x06", archive_bytes)
            self.assertIn(b"PK\x06\x07", archive_bytes)
            with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as zf:
                self.assertIsNone(zf.testzip())
                self.assertEqual(zf.read("model.safetensors"), payload)

    def test_iter_zip_chunks_propagates_permission_and_io_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "model.safetensors"
            target.write_bytes(b"weights")

            with patch.object(zip_stream, "open_read", side_effect=PermissionError(errno.EACCES, "denied")):
                with self.assertRaises(PermissionError):
                    b"".join(zip_stream.iter_zip_chunks([(target, "model.safetensors")]))

            with patch.object(zip_stream, "open_read", side_effect=OSError(errno.EIO, "disk read error")):
                with self.assertRaises(OSError) as raised:
                    b"".join(zip_stream.iter_zip_chunks([(target, "model.safetensors")]))
                self.assertEqual(raised.exception.errno, errno.EIO)

            # Vanished files (FileNotFoundError) are still skipped cleanly
            missing = root / "missing.safetensors"
            archive = b"".join(zip_stream.iter_zip_chunks([(missing, "missing.safetensors")]))
            with zipfile.ZipFile(io.BytesIO(archive), "r") as zf:
                self.assertIsNone(zf.testzip())
                self.assertEqual(zf.namelist(), [])

    def test_tageditor_download_zip_streams_images_and_captions(self):
        from backend.tageditor.routes import router as tageditor_router

        with tempfile.TemporaryDirectory() as tmp:
            ds = Path(tmp) / "数据集"
            ds.mkdir()
            (ds / "01.png").write_bytes(b"\x89PNGfake")
            (ds / "01.txt").write_text("1girl, solo", encoding="utf-8")
            (ds / "phone.JPG").write_bytes(b"photo")
            (ds / "phone.txt").write_text("portrait", encoding="utf-8")
            (ds / ".hidden.png").write_bytes(b"secret")

            app = FastAPI()
            app.include_router(tageditor_router, prefix="/api")
            with TestClient(app) as client:
                resp = client.get("/api/tageditor/download-zip", params={"dir": str(ds)})
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(resp.headers.get("content-type"), "application/zip")
                self.assertEqual(resp.headers.get("x-accel-buffering"), "no")
                self.assertIn("UTF-8''", resp.headers.get("content-disposition", ""))
                with zipfile.ZipFile(io.BytesIO(resp.content), "r") as zf:
                    self.assertIsNone(zf.testzip())
                    self.assertEqual(set(zf.namelist()), {"01.png", "01.txt", "phone.JPG", "phone.txt"})
                    self.assertEqual(zf.read("01.txt"), b"1girl, solo")


class StorageConstantsAndRootPathTests(unittest.TestCase):
    _STORAGE_ENV_KEYS = (
        "ANIMA_DATA_DIR", "ANIMA_MODELS_DIR", "ANIMA_TRAIN_DIR", "ANIMA_OUTPUT_DIR",
        "ANIMA_CONFIG_DIR", "ANIMA_LOGS_DIR", "ANIMA_CACHE_DIR", "ANIMA_HF_CACHE_DIR",
        "HF_HOME", "ANIMA_ROOT_PATH",
    )

    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in self._STORAGE_ENV_KEYS}

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        constants.refresh_storage_paths()

    def test_anima_data_dir_moves_persistent_dirs_while_cache_stays_local(self):
        for k in self._STORAGE_ENV_KEYS:
            os.environ.pop(k, None)
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "drive_data"
            os.environ["ANIMA_DATA_DIR"] = str(data_dir)
            roots = constants.refresh_storage_paths()

            self.assertEqual(roots["data_dir"], data_dir)
            self.assertEqual(roots["models_dir"], data_dir / "models")
            self.assertEqual(roots["train_dir"], data_dir / "train")
            self.assertEqual(roots["output_dir"], data_dir / "output")
            self.assertEqual(roots["config_dir"], data_dir / "config")
            self.assertEqual(roots["logs_dir"], data_dir / "logs")
            self.assertEqual(roots["autosave_dir"], data_dir / "config" / "autosave")
            # Cache dirs MUST remain local under REPO_ROOT!
            self.assertEqual(roots["cache_dir"], constants.REPO_ROOT / "cache")
            self.assertEqual(roots["hf_cache_dir"], constants.REPO_ROOT / "huggingface")

            # Logical project path resolution
            self.assertEqual(constants.resolve_project_path("output/run1"), (data_dir / "output" / "run1").resolve())
            self.assertEqual(constants.resolve_project_path("./models/a.safetensors"), (data_dir / "models" / "a.safetensors").resolve())

            # Per-directory overrides win over ANIMA_DATA_DIR
            custom_out = Path(tmp) / "fast_out"
            custom_cache = Path(tmp) / "local_ssd_cache"
            os.environ["ANIMA_OUTPUT_DIR"] = str(custom_out)
            os.environ["ANIMA_CACHE_DIR"] = str(custom_cache)
            roots2 = constants.refresh_storage_paths()
            self.assertEqual(roots2["output_dir"], custom_out)
            self.assertEqual(roots2["cache_dir"], custom_cache)
            self.assertEqual(roots2["models_dir"], data_dir / "models")

    def test_hf_cache_dir_precedence_and_hf_home_sync(self):
        for k in self._STORAGE_ENV_KEYS:
            os.environ.pop(k, None)
        with tempfile.TemporaryDirectory() as tmp:
            hf_home_dir = Path(tmp) / "hf_home_cache"
            anima_hf_dir = Path(tmp) / "anima_hf_cache"

            # 1. Default when neither is set
            roots_default = constants.refresh_storage_paths()
            self.assertEqual(roots_default["hf_cache_dir"], constants.REPO_ROOT / "huggingface")
            self.assertNotIn("HF_HOME", os.environ)

            # 2. HF_HOME fallback when ANIMA_HF_CACHE_DIR is unset
            os.environ["HF_HOME"] = str(hf_home_dir)
            roots_hf = constants.refresh_storage_paths()
            self.assertEqual(roots_hf["hf_cache_dir"], hf_home_dir)
            self.assertEqual(os.environ["HF_HOME"], str(hf_home_dir))

            # 3. ANIMA_HF_CACHE_DIR takes precedence over HF_HOME and syncs os.environ["HF_HOME"]
            os.environ["ANIMA_HF_CACHE_DIR"] = str(anima_hf_dir)
            roots_override = constants.refresh_storage_paths()
            self.assertEqual(roots_override["hf_cache_dir"], anima_hf_dir)
            self.assertEqual(os.environ["HF_HOME"], str(anima_hf_dir))

    def test_root_path_helpers_and_url_builders(self):
        from pathlib import PurePosixPath
        from backend.image_preview import build_image_preview_url
        from backend.server.routes.docs import _asset_url
        from backend import tensorboard_service

        os.environ.pop("ANIMA_ROOT_PATH", None)
        self.assertEqual(constants.get_root_path(), "")
        self.assertEqual(constants.with_root_path("/api/health"), "/api/health")
        self.assertEqual(tensorboard_service._path_prefix(), "/tensorboard")

        os.environ["ANIMA_ROOT_PATH"] = "proxy/12333/"
        self.assertEqual(constants.get_root_path(), "/proxy/12333")
        self.assertEqual(constants.with_root_path("/api/health"), "/proxy/12333/api/health")
        # Idempotent and ignores external URLs
        self.assertEqual(constants.with_root_path("/proxy/12333/api/health"), "/proxy/12333/api/health")
        self.assertEqual(constants.with_root_path("https://example.com/a"), "https://example.com/a")

        preview_url = build_image_preview_url(scope="artifact", run_dir="output/r1", path="sample/a.png", variant="thumb")
        self.assertTrue(preview_url.startswith("/proxy/12333/api/image-preview?"))
        doc_asset = _asset_url("img/diagram.png", PurePosixPath("parameters"))
        self.assertEqual(doc_asset, "/proxy/12333/api/docs/assets/parameters/img/diagram.png")
        self.assertEqual(tensorboard_service._path_prefix(), "/proxy/12333/tensorboard")


class FuseSafetyAndOptimizationTests(unittest.TestCase):
    def tearDown(self):
        file_io.clear_fs_cache()
        os.environ.pop("ANIMA_NO_FSYNC", None)
        os.environ.pop("ANIMA_MONITOR_INTERVAL", None)

    def test_proc_mounts_fuse_detection_and_fsync_skip(self):
        sample_mounts = (
            "/dev/sda1 / ext4 rw,relatime 0 0\n"
            "drive /content/drive fuse.drive rw,nosuid,nodev 0 0\n"
            "nfs_srv:/export /mnt/My\\040Share nfs4 rw,relatime 0 0\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            mounts_file = Path(tmp) / "mounts"
            mounts_file.write_text(sample_mounts, encoding="utf-8")
            with patch.object(file_io, "_PROC_MOUNTS_PATH", mounts_file):
                file_io.clear_fs_cache()
                with patch.object(file_io, "_resolve_existing_ancestor", side_effect=lambda p: str(p).replace("\\", "/")):
                    self.assertFalse(file_io.is_fuse_or_network_fs("/content/lora-scripts-anima/cache/x.tmp"))
                    self.assertTrue(file_io.should_fsync("/content/lora-scripts-anima/cache/x.tmp"))

                    self.assertTrue(file_io.is_fuse_or_network_fs("/content/drive/MyDrive/Anima_LoRA/output/run/meta.json"))
                    self.assertFalse(file_io.should_fsync("/content/drive/MyDrive/Anima_LoRA/output/run/meta.json"))

                    self.assertTrue(file_io.is_fuse_or_network_fs("/mnt/My Share/output/run/meta.json"))

                # Explicit ANIMA_NO_FSYNC=1 override skips fsync even on local disk
                os.environ["ANIMA_NO_FSYNC"] = "1"
                self.assertFalse(file_io.should_fsync("/content/lora-scripts-anima/cache/x.tmp"))

                # Verify atomic_write_text skips os.fsync when ANIMA_NO_FSYNC=1
                target = Path(tmp) / "written.txt"
                with patch.object(file_io.os, "fsync") as mock_fsync:
                    file_io.atomic_write_text(target, "hello")
                    mock_fsync.assert_not_called()
                self.assertEqual(target.read_text(encoding="utf-8"), "hello")

    def test_training_logging_flock_fallback_on_unsupported_fs(self):
        from tools.python_startup.training_logging import _OutputLock

        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "test.lock"
            lock = _OutputLock(str(lock_path))

            fake_fcntl = types.SimpleNamespace(
                LOCK_EX=2,
                LOCK_UN=8,
                flock=lambda fd, op: (_ for _ in ()).throw(OSError(errno.ENOLCK, "No locks available")),
            )
            with (
                patch.dict(sys.modules, {"fcntl": fake_fcntl}),
                patch("tools.python_startup.training_logging.os.name", "posix"),
            ):
                entered = []
                with lock.hold():
                    entered.append(1)
                # Second entry uses in-process fallback cleanly without raising
                with lock.hold():
                    entered.append(2)
                self.assertEqual(entered, [1, 2])
                self.assertTrue(lock._flock_disabled)
                self.assertIsNone(lock.fd)

    def test_supervisor_lock_placed_in_local_cache_dir(self):
        from backend.training.execution import supervisor

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_cache = root / "local_cache"
            fake_run = root / "drive" / "output" / "run_1"
            fake_run.mkdir(parents=True)
            with patch.object(supervisor, "CACHE_DIR", fake_cache):
                env = supervisor._build_train_env(
                    artifact_dir=str(fake_run),
                    task_id="abc12345",
                    run_dir=str(fake_run),
                )
            lock_path = Path(env["ANIMA_TRAIN_LOG_LOCK"])
            self.assertEqual(lock_path.parent, (fake_cache / "locks").resolve())
            self.assertEqual(lock_path.name, "abc12345.lock")
            self.assertEqual(Path(env["ANIMA_RUN_DIR"]), fake_run)
            self.assertEqual(Path(env["ANIMA_TENSORBOARD_DIR"]), (fake_run / "log").resolve())

    def test_hf_download_stages_in_local_cache_and_handles_exdev_promote(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_cache = root / "local_cache"
            dest = root / "remote_models" / "anima.safetensors"
            with patch.object(constants, "CACHE_DIR", fake_cache):
                prefix = hf_download._staging_prefix(dest)
                self.assertEqual(prefix.parent, fake_cache / "downloads")
                partial = Path(f"{prefix}.partial")
                partial.write_bytes(b"MODEL_BYTES_12345")

                real_replace = os.replace
                calls = {"n": 0}

                def exdev_first(src, dst):
                    calls["n"] += 1
                    if calls["n"] == 1:
                        raise OSError(errno.EXDEV, "Invalid cross-device link")
                    return real_replace(src, dst)

                with patch.object(hf_download.os, "replace", side_effect=exdev_first):
                    hf_download._promote_file(partial, dest)

                self.assertEqual(dest.read_bytes(), b"MODEL_BYTES_12345")
                self.assertFalse(partial.exists())

    def test_monitor_interval_env_and_fuse_auto_tuning(self):
        from backend.monitor import monitor

        with patch.object(monitor, "is_fuse_or_network_fs", return_value=False):
            self.assertEqual(monitor.resolve_monitor_interval(), 1.0)
        with patch.object(monitor, "is_fuse_or_network_fs", return_value=True):
            self.assertEqual(monitor.resolve_monitor_interval(), 2.0)
        os.environ["ANIMA_MONITOR_INTERVAL"] = "3.5"
        with patch.object(monitor, "is_fuse_or_network_fs", return_value=False):
            self.assertEqual(monitor.resolve_monitor_interval(), 3.5)

    def test_dataset_folder_stats_bounded_scan(self):
        from backend.server.routes.system import _dataset_folder_stats

        with tempfile.TemporaryDirectory() as tmp:
            ds = Path(tmp) / "ds"
            ds.mkdir()
            for i in range(10):
                (ds / f"img_{i}.png").write_bytes(b"x")
                if i % 2 == 0:
                    (ds / f"img_{i}.txt").write_text("tag", encoding="utf-8")

            full = _dataset_folder_stats(ds)
            self.assertEqual(full, {"images": 10, "captioned": 5})

            capped = _dataset_folder_stats(ds, max_entries=5)
            self.assertTrue(capped.get("truncated"))
            self.assertLessEqual(capped["images"], 5)


if __name__ == "__main__":
    unittest.main()
