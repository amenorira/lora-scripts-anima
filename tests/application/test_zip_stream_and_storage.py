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

if __name__ == "__main__":
    unittest.main()
