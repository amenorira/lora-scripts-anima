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


    def test_storage_space_deduplicates_same_device_and_splits_distinct_mounts(self):
        usage_a = SimpleNamespace(total=100 * 1024**3, used=40 * 1024**3, free=60 * 1024**3)
        usage_b = SimpleNamespace(total=500 * 1024**3, used=100 * 1024**3, free=400 * 1024**3)

        def fake_stat(p, **_kwargs):
            s = str(p)
            if str(self.output) in s or str(self.train) in s:
                return SimpleNamespace(st_dev=101)
            return SimpleNamespace(st_dev=202)

        def fake_usage(p):
            return usage_a if str(self.output) in str(p) or str(self.train) in str(p) else usage_b

        with self._patch_roots(), \
             patch.object(system_routes.os, "stat", side_effect=fake_stat), \
             patch.object(system_routes.shutil, "disk_usage", side_effect=fake_usage):
            resp = self.client.get("/api/storage/space")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        volumes = body["volumes"]
        self.assertEqual(len(volumes), 2)
        self.assertEqual(volumes[0]["key"], "output")
        self.assertEqual(volumes[0]["keys"], ["output", "train"])
        self.assertEqual(volumes[0]["free_bytes"], usage_a.free)
        self.assertEqual(volumes[1]["key"], "models")
        self.assertEqual(volumes[1]["keys"], ["models"])
        self.assertEqual(volumes[1]["free_bytes"], usage_b.free)


class HardwareCgroupMemoryTests(unittest.TestCase):
    def test_cgroup_v2_finite_limit_overrides_bare_metal_host_ram(self):
        with tempfile.TemporaryDirectory() as td:
            v2 = Path(td) / "v2"
            v1 = Path(td) / "v1"
            v2.mkdir()
            limit = 16 * 1024**3
            used = 4 * 1024**3
            (v2 / "memory.max").write_text(f"{limit}\n", encoding="utf-8")
            (v2 / "memory.current").write_text(f"{used}\n", encoding="utf-8")

            res = hardware._read_cgroup_memory(v2_dir=v2, v1_dir=v1, host_total=128 * 1024**3)
            self.assertEqual(res, (used, limit))

            # Unlimited ("max") returns None
            (v2 / "memory.max").write_text("max\n", encoding="utf-8")
            self.assertIsNone(hardware._read_cgroup_memory(v2_dir=v2, v1_dir=v1, host_total=128 * 1024**3))

            # Limit >= host_total returns None
            (v2 / "memory.max").write_text(f"{256 * 1024**3}\n", encoding="utf-8")
            self.assertIsNone(hardware._read_cgroup_memory(v2_dir=v2, v1_dir=v1, host_total=128 * 1024**3))

    def test_cgroup_v1_fallback_and_sys_info_raw(self):
        with tempfile.TemporaryDirectory() as td:
            v2 = Path(td) / "v2_missing"
            v1 = Path(td) / "v1"
            v1.mkdir()
            limit = 24 * 1024**3
            used = 6 * 1024**3
            (v1 / "memory.limit_in_bytes").write_text(f"{limit}\n", encoding="utf-8")
            (v1 / "memory.usage_in_bytes").write_text(f"{used}\n", encoding="utf-8")

            res = hardware._read_cgroup_memory(v2_dir=v2, v1_dir=v1, host_total=256 * 1024**3)
            self.assertEqual(res, (used, limit))

            # Huge sentinel treated as unlimited
            (v1 / "memory.limit_in_bytes").write_text("9223372036854771712\n", encoding="utf-8")
            self.assertIsNone(hardware._read_cgroup_memory(v2_dir=v2, v1_dir=v1, host_total=256 * 1024**3))

        fake_mem = SimpleNamespace(total=256 * 1024**3, used=100 * 1024**3, percent=39.1)
        with patch("psutil.cpu_percent", return_value=12.5), \
             patch("psutil.virtual_memory", return_value=fake_mem), \
             patch.object(hardware, "_get_cpu_name", return_value="Test CPU"), \
             patch.object(hardware, "_read_cgroup_memory", return_value=(8 * 1024**3, 32 * 1024**3)):
            info = hardware._sys_info_raw()
        self.assertIsNotNone(info)
        self.assertEqual(info["ram_used_gb"], 8.0)
        self.assertEqual(info["ram_total_gb"], 32.0)
        self.assertEqual(info["ram_pct"], 25.0)


class LaunchUtilsAndCloudPolishTests(unittest.TestCase):
    def test_check_environment_checks_separate_output_and_models_mounts(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            ws = base / "ws"
            out = base / "drive_out"
            models = base / "drive_models"
            for d in (ws, out, models):
                d.mkdir()

            devs = {str(ws): 1, str(out): 2, str(models): 3}
            frees = {str(ws): 50 * 1024**3, str(out): 5 * 1024**3, str(models): 20 * 1024**3}

            def fake_stat(p, **_kwargs):
                return SimpleNamespace(st_dev=devs[str(p)])

            def fake_usage(p):
                return SimpleNamespace(free=frees[str(p)], total=100 * 1024**3, used=0)

            import backend.constants as constants

            with patch.object(launch_utils, "_ENV_CHECKED", False), \
                 patch.object(launch_utils, "base_dir_path", return_value=ws), \
                 patch.object(constants, "OUTPUT_DIR", out), \
                 patch.object(constants, "SD_MODELS_DIR", models), \
                 patch.object(launch_utils.os, "stat", side_effect=fake_stat), \
                 patch.object(launch_utils.shutil, "disk_usage", side_effect=fake_usage), \
                 patch.object(launch_utils.log, "error") as log_err, \
                 patch.object(launch_utils.log, "warning") as log_warn:
                free_gb = launch_utils.check_environment()

            self.assertEqual(free_gb, 50)
            self.assertEqual(log_err.call_count, 1)
            self.assertIn("output", str(log_err.call_args))
            self.assertEqual(log_warn.call_count, 1)
            self.assertIn("models", str(log_warn.call_args))

    def test_non_tty_gates_rich_progress_in_monitor_environment_and_tagger(self):
        non_tty_console = SimpleNamespace(is_terminal=False)

        # 1. TaskMonitor skips console progress when console is non-TTY
        mon = TaskMonitor()
        with patch("backend.log.console", non_tty_console), \
             patch("backend.monitor.monitor._build_console_progress") as build_cp:
            mon._update_console_progress("task-1", {"step": 5, "total_steps": 100}, "demo")
            build_cp.assert_not_called()

        # 2. environment._start_download_job skips make_progress_bar on non-TTY
        done_event = threading.Event()

        def fake_dl_anima(*, dest_dir, progress, on_log, on_progress, files, progress_lock):
            on_progress("50%")
            done_event.set()
            return [Path("ok.safetensors")]

        with patch("backend.log.console", non_tty_console), \
             patch("backend.utils.hf_download.make_progress_bar") as mk_env_bar, \
             patch("tools.download_anima_model.MODEL_FILES", [("repo", "ok.safetensors", "ok.safetensors", 10, "anima")]), \
             patch("tools.download_anima_model.download_anima_files", side_effect=fake_dl_anima):
            job_id = env_routes._start_download_job(only_file="ok.safetensors", group="anima")
            self.assertIsNotNone(job_id)
            self.assertTrue(done_event.wait(timeout=5))
            # Wait briefly for thread finally block
            deadline = time.time() + 2
            while time.time() < deadline and not env_routes._download_job_snapshot(job_id)["done"]:
                time.sleep(0.02)
            env_routes._remove_download_job(job_id)
            mk_env_bar.assert_not_called()

        # 3. tagger_download.tagger_hub_download skips make_progress_bar on non-TTY
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "model.onnx"

            def fake_hf_dl(repo_id, filename, target, **kwargs):
                kwargs["on_progress"]("100%")
                Path(target).write_bytes(b"onnx")
                return Path(target)

            with patch("backend.log.console", non_tty_console), \
                 patch.object(tagger_download, "_snapshot_path", return_value=dest), \
                 patch.object(tagger_download, "make_progress_bar") as mk_tag_bar, \
                 patch.object(tagger_download, "download_hf_file", side_effect=fake_hf_dl):
                result = tagger_download.tagger_hub_download("org/repo", "model.onnx")
            self.assertEqual(result, dest)
            mk_tag_bar.assert_not_called()

    def test_non_tty_logs_throttled_plain_progress(self):
        non_tty_console = SimpleNamespace(is_terminal=False)
        mon = TaskMonitor()
        clock = [100.0]

        with patch("backend.log.console", non_tty_console), \
             patch("backend.monitor.monitor._build_console_progress") as build_cp, \
             patch("backend.monitor.monitor.time.monotonic", side_effect=lambda: clock[0]), \
             patch("backend.monitor.monitor.logger.info") as log_info, \
             patch.dict(os.environ, {"ANIMA_CONSOLE_PROGRESS_INTERVAL": "30"}, clear=False):
            # Step 0 should not emit yet
            mon._update_console_progress("task-1", {"step": 0, "total_steps": 100}, "my_lora")
            log_info.assert_not_called()

            # First non-zero step emits immediately, omitting empty fields
            mon._update_console_progress(
                "task-1",
                {"step": 1, "total_steps": 100, "epoch": "1/5", "loss": "0.1234", "lr": "1e-4", "speed": "1.2s/it", "eta": "01:58"},
                "my_lora",
            )
            self.assertEqual(log_info.call_count, 1)
            first_msg = log_info.call_args[0][0]
            self.assertEqual(
                first_msg,
                "Training my_lora | step 1/100 (1.0%) | epoch 1/5 | loss 0.1234 | lr 1e-4 | 1.2s/it | ETA 01:58",
            )

            # Immediate next step within interval is throttled
            clock[0] = 110.0
            mon._update_console_progress("task-1", {"step": 10, "total_steps": 100, "loss": "0.1100"}, "my_lora")
            self.assertEqual(log_info.call_count, 1)

            # Step after interval emits again (and omits missing fields like epoch/lr/speed/eta)
            clock[0] = 130.0
            mon._update_console_progress("task-1", {"step": 35, "total_steps": 100, "loss": "0.0950"}, "my_lora")
            self.assertEqual(log_info.call_count, 2)
            self.assertEqual(log_info.call_args[0][0], "Training my_lora | step 35/100 (35.0%) | loss 0.0950")

            # Final step emits immediately even within interval; duplicate completion update is ignored
            clock[0] = 135.0
            mon._update_console_progress("task-1", {"step": 100, "total_steps": 100, "loss": "0.0420"}, "my_lora")
            self.assertEqual(log_info.call_count, 3)
            self.assertEqual(log_info.call_args[0][0], "Training my_lora | step 100/100 (100.0%) | loss 0.0420")
            clock[0] = 136.0
            mon._update_console_progress("task-1", {"step": 100, "total_steps": 100, "loss": "0.0420"}, "my_lora")
            self.assertEqual(log_info.call_count, 3)

            # Switching to a new task resets throttle and emits immediately on first non-zero step
            clock[0] = 137.0
            mon._update_console_progress("task-2", {"step": 1, "total_steps": 50}, "")
            self.assertEqual(log_info.call_count, 4)
            self.assertEqual(log_info.call_args[0][0], "Training | step 1/50 (2.0%)")

            # _stop_console_progress resets tracking as well
            mon._stop_console_progress()
            clock[0] = 138.0
            mon._update_console_progress("task-2", {"step": 2, "total_steps": 50}, "retry")
            self.assertEqual(log_info.call_count, 5)
            self.assertEqual(log_info.call_args[0][0], "Training retry | step 2/50 (4.0%)")

            build_cp.assert_not_called()

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
