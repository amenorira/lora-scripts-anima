"""Unit tests for Lean Cloud Polish backend endpoints and cloud runtime fixes."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import launch_utils
from backend.monitor import hardware
from backend.monitor.monitor import TaskMonitor
from backend.server.routes import environment as env_routes
from backend.server.routes import system as system_routes
from backend.tagger import tagger_download
from backend.training import checkpoint_state
from backend.training.execution import supervisor
from tools import moss_acceleration as accel


def _create_valid_state_dir(state_dir: Path, *, step: int | None = None) -> None:
    """Create a minimal valid Accelerate state directory accepted by resumable_state()."""
    state_dir.mkdir(parents=True, exist_ok=True)
    for name in ("random_states_0.pkl", "optimizer.bin", "scheduler.bin", "pytorch_model.bin"):
        with zipfile.ZipFile(state_dir / name, "w") as zf:
            zf.writestr("data.pkl", b"ok" * 32)
    if step is not None:
        (state_dir / "train_state.json").write_text(json.dumps({"global_step": step}), encoding="utf-8")


class SystemCloudRoutesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.repo = self.base / "repo"
        self.train = self.repo / "train"
        self.models = self.repo / "models"
        self.config = self.repo / "config"
        self.output = self.repo / "output"
        self.outside = self.base / "outside"
        for d in (self.repo / "backend", self.train, self.models, self.config, self.output, self.outside):
            d.mkdir(parents=True, exist_ok=True)

        system_routes.invalidate_files_cache()
        app = FastAPI()
        app.include_router(system_routes.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        system_routes.invalidate_files_cache()

    def _patch_roots(self):
        stack = ExitStack()
        stack.enter_context(patch.object(system_routes, "REPO_ROOT", self.repo))
        stack.enter_context(patch.object(system_routes, "TRAIN_DIR", self.train))
        stack.enter_context(patch.object(system_routes, "SD_MODELS_DIR", self.models))
        stack.enter_context(patch.object(system_routes, "CONFIG_DIR", self.config))
        stack.enter_context(patch.object(system_routes, "OUTPUT_DIR", self.output))
        return stack

    def test_get_files_state_dir_lists_only_resumable_states(self):
        run_a = self.output / "anime_lora_20261128"
        epoch_state = run_a / "anime-000002-state"
        _create_valid_state_dir(epoch_state, step=420)

        run_b = self.output / "style_run"
        step_state = run_b / "style-step000750-state"
        _create_valid_state_dir(step_state)

        # Incomplete state should be ignored
        broken_state = run_a / "anime-000003-state"
        broken_state.mkdir(parents=True)
        (broken_state / checkpoint_state.SAVE_IN_PROGRESS).touch()
        (broken_state / "train_state.json").write_text('{"global_step": 600}', encoding="utf-8")

        with self._patch_roots():
            resp = self.client.get("/api/get_files", params={"pick_type": "state-dir"})
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        self.assertEqual(payload["status"], "success")
        files = payload["data"]["files"]
        by_name = {item["name"]: item for item in files}
        self.assertEqual(set(by_name.keys()), {"anime-000002-state", "style-step000750-state"})

        ep = by_name["anime-000002-state"]
        self.assertEqual(ep["run_name"], "anime_lora_20261128")
        self.assertEqual(ep["epoch"], 2)
        self.assertEqual(ep["step"], 420)
        self.assertGreater(ep["size"], 0)
        self.assertEqual(ep["size"], ep["size_bytes"])
        self.assertTrue(ep["path"].endswith("output/anime_lora_20261128/anime-000002-state"))

        st = by_name["style-step000750-state"]
        self.assertEqual(st["run_name"], "style_run")
        self.assertEqual(st["step"], 750)
        self.assertIsNone(st["epoch"])

    def test_get_files_text_file_lists_config_and_train_text_files(self):
        (self.config / "prompt.txt").write_text("masterpiece", encoding="utf-8")
        (self.config / "knowledge.md").write_text("# guide", encoding="utf-8")
        (self.config / "preset.toml").write_text("lr = 1e-4\n", encoding="utf-8")
        (self.train / "notes.yaml").write_text("k: v\n", encoding="utf-8")
        (self.train / "meta.json").write_text("{}", encoding="utf-8")
        (self.train / "ignore.png").write_bytes(b"\x89PNG")
        hidden = self.config / ".hidden"
        hidden.mkdir()
        (hidden / "secret.txt").write_text("skip", encoding="utf-8")

        with self._patch_roots():
            resp = self.client.get("/api/get_files", params={"pick_type": "text-file"})
        self.assertEqual(resp.status_code, 200)
        names = {item["name"] for item in resp.json()["data"]["files"]}
        self.assertEqual(names, {"prompt.txt", "knowledge.md", "preset.toml", "notes.yaml", "meta.json"})

    def test_mkdir_defaults_to_train_dir_and_enforces_security(self):
        with self._patch_roots():
            # Default parent -> TRAIN_DIR
            r = self.client.post("/api/files/mkdir", json={"parent": "", "name": "10_alice"})
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertEqual(body["status"], "success")
            self.assertEqual(body["name"], "10_alice")
            self.assertEqual(body["path"], "./train/10_alice")
            self.assertTrue((self.train / "10_alice").is_dir())

            # Duplicate returns 409
            r_dup = self.client.post("/api/files/mkdir", json={"parent": "./train", "name": "10_alice"})
            self.assertEqual(r_dup.status_code, 409)

            # Invalid names rejected
            for bad_name in ("", "   ", ".", "..", "a..b", "a/b", "a\\b", "bad\x01name", "c:drive"):
                resp = self.client.post("/api/files/mkdir", json={"parent": "", "name": bad_name})
                self.assertEqual(resp.status_code, 400, f"Expected 400 for name={bad_name!r}")

            # Outside writable roots rejected (including REPO_ROOT and backend/ when DATA_DIR==REPO_ROOT)
            for bad_parent in (str(self.outside), str(self.repo), "./backend", "../outside"):
                resp = self.client.post("/api/files/mkdir", json={"parent": bad_parent, "name": "pwn"})
                self.assertEqual(resp.status_code, 403, f"Expected 403 for parent={bad_parent!r}")
                self.assertFalse((self.outside / "pwn").exists())

            # Allowed inside OUTPUT_DIR and SD_MODELS_DIR
            r_out = self.client.post("/api/files/mkdir", json={"parent": "./output", "name": "custom_out"})
            self.assertEqual(r_out.status_code, 200)
            self.assertTrue((self.output / "custom_out").is_dir())

    def test_external_data_dir_does_not_bypass_writable_root_confinement(self):
        ext_data = self.base / "ext_data"
        ext_train = ext_data / "train"
        ext_models = ext_data / "models"
        ext_config = ext_data / "config"
        ext_output = ext_data / "output"
        ext_logs = ext_data / "logs"
        for d in (ext_train, ext_models, ext_config, ext_output, ext_logs):
            d.mkdir(parents=True, exist_ok=True)

        with ExitStack() as stack:
            stack.enter_context(patch.object(system_routes, "REPO_ROOT", self.repo))
            stack.enter_context(patch.object(system_routes, "TRAIN_DIR", ext_train))
            stack.enter_context(patch.object(system_routes, "SD_MODELS_DIR", ext_models))
            stack.enter_context(patch.object(system_routes, "CONFIG_DIR", ext_config))
            stack.enter_context(patch.object(system_routes, "OUTPUT_DIR", ext_output))

            # Mkdir escaping TRAIN_DIR into DATA_DIR root or LOGS_DIR MUST be 403
            for bad_parent in ("train/..", str(ext_data), str(ext_logs)):
                r_mk = self.client.post("/api/files/mkdir", json={"parent": bad_parent, "name": "escaped"})
                self.assertEqual(r_mk.status_code, 403, f"Expected 403 mkdir in {bad_parent!r}")
                self.assertFalse((ext_data / "escaped").exists())

            # Normal mkdir inside external TRAIN_DIR works cleanly
            r_ok_mk = self.client.post("/api/files/mkdir", json={"parent": "", "name": "cloud_ds"})
            self.assertEqual(r_ok_mk.status_code, 200)
            self.assertTrue((ext_train / "cloud_ds").is_dir())


class LaunchUtilsAndCloudPolishTests(unittest.TestCase):
    def test_supervisor_launcher_hint_is_platform_aware(self):
        missing_exe = Path("/nonexistent/venv/bin/python")
        fake_engine = SimpleNamespace(python_executable=missing_exe, label="Krea 2")
        dummy_script = Path(__file__)

        with patch.object(supervisor, "_get_trainer_script", return_value=dummy_script), \
             patch.object(supervisor, "get_engine", return_value=fake_engine):
            with patch.object(supervisor.sys, "platform", "win32"):
                win_res = supervisor.run_train("cfg.toml", reserved_task=MagicMock())
            with patch.object(supervisor.sys, "platform", "linux"):
                lin_res = supervisor.run_train("cfg.toml", reserved_task=MagicMock())

        self.assertEqual(win_res["status"], "error")
        self.assertIn("start.bat", win_res["message"])
        self.assertEqual(lin_res["status"], "error")
        self.assertIn("start.sh", lin_res["message"])
        self.assertNotIn("start.bat", lin_res["message"])


if __name__ == "__main__":
    unittest.main()
