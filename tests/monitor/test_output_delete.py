"""Unit tests for POST /api/monitor/outputs/delete."""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.monitor import routes, run_registry
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


def _make_link(link_path: Path, target_path: Path, *, is_dir: bool) -> bool:
    try:
        os.symlink(target_path, link_path, target_is_directory=is_dir)
        return True
    except OSError:
        if os.name == "nt" and is_dir:
            res = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link_path), str(target_path)],
                capture_output=True,
                text=True,
            )
            return res.returncode == 0 and link_path.exists()
        return False


class OutputArtifactDeleteTests(CrossDriveSandbox):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def _make_run(self, name: str = "demo", *, artifact_dir: Path | None = None, task_id: str | None = None) -> tuple[Path, Path]:
        run = self.output / name
        art = artifact_dir or self.external
        art.mkdir(parents=True, exist_ok=True)
        self._write_config(run / "config.toml", art, name)
        run_registry.write_run_record(run, artifact_dir=art, task_id=task_id)
        return run, art

    def test_delete_files_and_state_dir_tracks_exact_freed_bytes(self):
        _run, art = self._make_run("demo")
        model = art / "demo-000001.safetensors"
        model.write_bytes(b"A" * 1024)
        sample_dir = art / "sample"
        sample_dir.mkdir()
        preview = sample_dir / "demo_e000001_00_20261128000000.png"
        preview.write_bytes(b"P" * 256)
        keep_file = art / "demo-final.safetensors"
        keep_file.write_bytes(b"K" * 512)

        state_dir = art / "demo-000001-state"
        state_dir.mkdir()
        (state_dir / "optimizer.bin").write_bytes(b"O" * 2048)
        (state_dir / "model.safetensors").write_bytes(b"M" * 512)

        expected_freed = 1024 + 256 + 2048 + 512

        with patch.object(routes.tm, "training_dump", return_value=[]):
            resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={
                    "run_dir": "output/demo",
                    "files": [
                        "demo-000001.safetensors",
                        "sample/demo_e000001_00_20261128000000.png",
                        "demo-000001-state",
                    ],
                },
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["freed_bytes"], expected_freed)
        self.assertEqual(body["errors"], [])
        self.assertEqual(
            set(body["deleted"]),
            {"demo-000001.safetensors", "sample/demo_e000001_00_20261128000000.png", "demo-000001-state"},
        )
        self.assertFalse(model.exists())
        self.assertFalse(preview.exists())
        self.assertFalse(state_dir.exists())
        self.assertTrue(keep_file.is_file())

    def test_delete_blocks_active_run_with_409(self):
        _run, art = self._make_run("running_demo", task_id="task-live-1")
        model = art / "live-000001.safetensors"
        model.write_bytes(b"L" * 100)

        with patch.object(routes.tm, "training_dump", return_value=[{"id": "task-live-1", "status": "RUNNING"}]):
            resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/running_demo", "files": ["live-000001.safetensors"]},
            )
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["error_code"], "monitorRunActive")
        self.assertTrue(model.is_file())

        # Also blocks when another active run shares the exact same artifact directory
        self._make_run("sibling_resumed", artifact_dir=art, task_id="task-live-2")
        with patch.object(routes.tm, "training_dump", return_value=[{"id": "task-live-2", "status": "RUNNING"}]):
            resp2 = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/running_demo", "files": ["live-000001.safetensors"]},
            )
        self.assertEqual(resp2.status_code, 409)
        self.assertTrue(model.is_file())

    def test_delete_blocks_nested_active_run_containment_in_both_directions(self):
        shared_root = self.external / "shared_workspace"
        active_sub = shared_root / "nested_group" / "active_child"
        hist_sub = shared_root / "hist_child"
        other_sub = shared_root / "done_sibling"
        for d in (active_sub, hist_sub, other_sub):
            d.mkdir(parents=True, exist_ok=True)

        self._make_run("parent_hist", artifact_dir=shared_root)
        self._make_run("active_child_run", artifact_dir=active_sub, task_id="task-child-live")
        self._make_run("hist_child_run", artifact_dir=hist_sub)

        active_ckpt = active_sub / "child-000001.safetensors"
        active_ckpt.write_bytes(b"A" * 64)
        other_ckpt = other_sub / "done-000001.safetensors"
        other_ckpt.write_bytes(b"D" * 64)

        active_dump = [{"id": "task-child-live", "status": "RUNNING"}]
        with patch.object(routes.tm, "training_dump", return_value=active_dump):
            # 1. Deleting a file inside a nested active run via parent run -> 409
            r_child = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/parent_hist", "files": ["nested_group/active_child/child-000001.safetensors"]},
            )
            self.assertEqual(r_child.status_code, 409)
            self.assertEqual(r_child.json()["error_code"], "monitorRunActive")
            self.assertTrue(active_ckpt.is_file())

            # 2. Deleting a parent folder containing the active run -> 409
            r_parent = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/parent_hist", "files": ["nested_group"]},
            )
            self.assertEqual(r_parent.status_code, 409)
            self.assertEqual(r_parent.json()["error_code"], "monitorRunActive")
            self.assertTrue(active_ckpt.is_file())

            # 3. Unrelated sibling under shared_root can still be deleted
            r_sibling = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/parent_hist", "files": ["done_sibling/done-000001.safetensors"]},
            )
            self.assertEqual(r_sibling.status_code, 200)
            self.assertFalse(other_ckpt.exists())

        # 4. Reverse direction: parent run is active, deleting inside child historical run -> 409
        self._make_run("parent_active", artifact_dir=shared_root, task_id="task-parent-live")
        hist_ckpt = hist_sub / "hist-000001.safetensors"
        hist_ckpt.write_bytes(b"H" * 64)
        with patch.object(routes.tm, "training_dump", return_value=[{"id": "task-parent-live", "status": "CREATED"}]):
            r_rev = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/hist_child_run", "files": ["hist-000001.safetensors"]},
            )
            self.assertEqual(r_rev.status_code, 409)
            self.assertEqual(r_rev.json()["error_code"], "monitorRunActive")
            self.assertTrue(hist_ckpt.is_file())

    def test_monitor_outputs_marks_task_meta_non_deletable_and_others_deletable(self):
        run = self.output / "meta_flag_demo"
        self._make_run("meta_flag_demo", artifact_dir=run)
        (run / "model-000001.safetensors").write_bytes(b"M" * 64)
        state_dir = run / "model-000001-state"
        state_dir.mkdir()
        (state_dir / "train_state.json").write_text('{"global_step": 10}', encoding="utf-8")

        resp = self.client.get("/api/monitor/outputs", params={"run_dir": "output/meta_flag_demo"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        by_path = {item["path"]: item for item in body["data"]}
        self.assertIn("task_meta.json", by_path)
        self.assertFalse(by_path["task_meta.json"]["deletable"])
        self.assertTrue(by_path["model-000001.safetensors"]["deletable"])
        self.assertTrue(by_path["model-000001-state"]["deletable"])

    def test_delete_rejects_traversal_root_self_and_escaping_symlinks(self):
        _run, art = self._make_run("sec_demo")
        model = art / "ok.safetensors"
        model.write_bytes(b"ok")
        secret = self.external.parent / "secret.txt"
        secret.write_text("do not delete", encoding="utf-8")

        bad_cases = [
            ["../secret.txt"],
            ["."],
            ["./"],
            [str(secret)],
            ["ok.safetensors", "../secret.txt"],
        ]

        with patch.object(routes.tm, "training_dump", return_value=[]):
            for bad_files in bad_cases:
                resp = self.client.post(
                    "/api/monitor/outputs/delete",
                    json={"run_dir": "output/sec_demo", "files": bad_files},
                )
                self.assertEqual(resp.status_code, 400, f"Expected 400 for files={bad_files!r}")
                self.assertTrue(art.is_dir())
                self.assertTrue(model.is_file())
                self.assertTrue(secret.is_file())

        # Escaping symlink/junction directory inside artifact_dir (and nested child beneath it) must be rejected
        outside_dir = self.external.parent / "outside_dir"
        outside_dir.mkdir()
        (outside_dir / "keep.txt").write_text("keep", encoding="utf-8")
        escape_link = art / "escape_link"
        if _make_link(escape_link, outside_dir, is_dir=True):
            with patch.object(routes.tm, "training_dump", return_value=[]):
                for target_rel in ("escape_link", "escape_link/keep.txt"):
                    resp = self.client.post(
                        "/api/monitor/outputs/delete",
                        json={"run_dir": "output/sec_demo", "files": [target_rel]},
                    )
                    self.assertEqual(resp.status_code, 400, f"Expected 400 for symlink target={target_rel!r}")
                    self.assertTrue((outside_dir / "keep.txt").is_file())

    def test_delete_batch_loads_run_record_once(self):
        _run, art = self._make_run("batch_demo")
        files = []
        for idx in range(5):
            name = f"ckpt-{idx:02d}.safetensors"
            (art / name).write_bytes(b"B" * 32)
            files.append(name)

        with patch.object(routes.tm, "training_dump", return_value=[]), \
             patch.object(routes, "load_run_record", wraps=routes.load_run_record) as spy_load:
            resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/batch_demo", "files": files},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()["deleted"]), 5)
        self.assertEqual(spy_load.call_count, 1)

    def test_delete_rejects_task_meta_with_400_and_reports_missing_files(self):
        run = self.output / "local_demo"
        self._make_run("local_demo", artifact_dir=run)
        ckpt = run / "local-000001.safetensors"
        ckpt.write_bytes(b"X" * 128)

        # Requesting task_meta.json (even alongside a valid file) rejects the whole batch with 400
        with patch.object(routes.tm, "training_dump", return_value=[]):
            bad_resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={
                    "run_dir": "output/local_demo",
                    "files": ["local-000001.safetensors", "task_meta.json"],
                },
            )
        self.assertEqual(bad_resp.status_code, 400)
        self.assertEqual(bad_resp.json()["error_code"], "monitorInvalidPath")
        self.assertTrue((run / "task_meta.json").is_file())
        self.assertTrue(ckpt.is_file())

        # Missing file is reported cleanly in errors while valid files are deleted
        with patch.object(routes.tm, "training_dump", return_value=[]):
            resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={
                    "run_dir": "output/local_demo",
                    "files": ["local-000001.safetensors", "does_not_exist.safetensors"],
                },
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["deleted"], ["local-000001.safetensors"])
        self.assertEqual(body["freed_bytes"], 128)
        self.assertEqual(len(body["errors"]), 1)
        self.assertEqual(body["errors"][0]["file"], "does_not_exist.safetensors")
        self.assertTrue((run / "task_meta.json").is_file())
        self.assertFalse(ckpt.exists())

    def test_delete_rejects_invalid_run_dir(self):
        with patch.object(routes.tm, "training_dump", return_value=[]):
            resp = self.client.post(
                "/api/monitor/outputs/delete",
                json={"run_dir": "output/../outside", "files": ["a.safetensors"]},
            )
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
