"""Symlinked output/ and external OUTPUT_DIR safety tests for run_registry and monitor callers."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.monitor import artifacts, checkpoints, history, run_registry


def _make_dir_link(link_path: Path, target_path: Path) -> bool:
    """Create a directory symlink (or NTFS junction on unprivileged Windows)."""
    try:
        os.symlink(target_path, link_path, target_is_directory=True)
        return True
    except OSError:
        if os.name == "nt":
            res = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link_path), str(target_path)],
                capture_output=True,
                text=True,
            )
            return res.returncode == 0 and link_path.exists()
        return False


class RunRegistrySymlinkAndExternalOutputTests(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.base = Path(self._temp.name)
        self.repo = self.base / "repo"
        self.drive = self.base / "drive" / "MyDrive" / "Anima_LoRA"
        self.drive_output = self.drive / "output"
        self.drive_autosave = self.drive / "config" / "autosave"
        self.other_disk = self.base / "other_disk" / "custom_artifacts"

        self.repo.mkdir(parents=True)
        self.drive_output.mkdir(parents=True)
        self.drive_autosave.mkdir(parents=True)
        self.other_disk.mkdir(parents=True)
        history.invalidate_history_cache()

    def tearDown(self):
        history.invalidate_history_cache()
        self._temp.cleanup()

    def _assert_full_run_lifecycle(self, output_dir: Path, autosave_dir: Path):
        with ExitStack() as stack:
            stack.enter_context(patch.object(run_registry, "REPO_ROOT", self.repo))
            stack.enter_context(patch.object(run_registry, "OUTPUT_DIR", output_dir))
            stack.enter_context(patch.object(run_registry, "CONFIG_DIR", autosave_dir.parent))
            stack.enter_context(patch.object(run_registry, "AUTOSAVE_DIR", autosave_dir))

            run_name = "violet_automagic4_dim16_20261128-044117_cbdc8f0f-be0"
            internal = (output_dir / run_name).resolve()

            # 1. Logical ref and write_run_record must NEVER raise "not in the subpath of REPO_ROOT"
            record = run_registry.write_run_record(
                internal,
                artifact_dir=internal,
                task_id="task-colab-001",
                extra={"profile_id": "anima-lora"},
            )
            self.assertEqual(record["run_dir"], f"output/{run_name}")
            self.assertEqual(record["artifact_dir"], f"output/{run_name}")
            self.assertEqual(run_registry.run_dir_ref(f"output/{run_name}"), f"output/{run_name}")
            self.assertEqual(run_registry.run_dir_ref(internal), f"output/{run_name}")

            # 2. load_run_record works via both logical "output/<run>" and absolute external path
            for ref in (f"output/{run_name}", f"./output/{run_name}", str(internal)):
                loaded = run_registry.load_run_record(ref)
                self.assertIsNotNone(loaded, f"Failed to load run via {ref}")
                self.assertEqual(loaded["run_dir"], f"output/{run_name}")
                self.assertEqual(loaded["run_path"], internal)
                self.assertEqual(loaded["artifact_path"], internal)
                self.assertTrue(loaded["artifact_available"])
                self.assertFalse(loaded["artifact_external"])

            # 3. iter_run_records and find_run_record_by_task_id discover it
            records = run_registry.iter_run_records()
            self.assertEqual([r["task_id"] for r in records], ["task-colab-001"])
            found = run_registry.find_run_record_by_task_id("task-colab-001")
            self.assertIsNotNone(found)
            self.assertEqual(found["run_dir"], f"output/{run_name}")

            # 4. Artifact files and monitor helpers resolve logical "output/<run>" cleanly
            (internal / "demo-000001.safetensors").write_bytes(b"weights")
            (internal / "train_task.log").write_text(
                "steps: 100%|###| 10/10 [00:05<00:00, avr_loss=0.1234]\n"
                "saving checkpoint: /content/drive/MyDrive/Anima_LoRA/output/demo-000001.safetensors\n",
                encoding="utf-8",
            )
            resolved_artifact = run_registry.resolve_artifact_file(f"output/{run_name}", "demo-000001.safetensors")
            self.assertEqual(resolved_artifact, (internal / "demo-000001.safetensors").resolve())

            summary = artifacts.read_output_summary(f"output/{run_name}")
            self.assertEqual(summary["count"], 3)
            listed = artifacts.list_output_files(f"output/{run_name}", internal)
            self.assertTrue(any(f["name"] == "demo-000001.safetensors" for f in listed))

            losses = checkpoints._parse_log_checkpoint_losses(f"output/{run_name}")
            self.assertAlmostEqual(losses.get("demo-000001.safetensors", 0.0), 0.1234, places=4)

            # 5. Reject bare OUTPUT_DIR root and escaping traversals
            for bad in ("", " ", ".", "output", "./output", str(output_dir), str(output_dir.resolve()),
                        "output/..", "output/../secret", "../drive/MyDrive", str(self.other_disk)):
                self.assertIsNone(
                    run_registry.resolve_internal_run_dir(bad),
                    f"Expected resolve_internal_run_dir({bad!r}) to be rejected",
                )
                with self.assertRaises(ValueError):
                    run_registry.run_dir_ref(bad)

            # 6. External artifact_dir outside both OUTPUT_DIR and REPO_ROOT stays absolute
            ext_run = (output_dir / "ext_run").resolve()
            ext_rec = run_registry.write_run_record(ext_run, artifact_dir=self.other_disk, task_id="task-ext-002")
            self.assertEqual(ext_rec["run_dir"], "output/ext_run")
            self.assertEqual(Path(ext_rec["artifact_dir"]), self.other_disk.resolve())
            loaded_ext = run_registry.load_run_record("output/ext_run")
            self.assertTrue(loaded_ext["artifact_external"])
            self.assertEqual(loaded_ext["artifact_path"], self.other_disk.resolve())

            # 7. Default user_path "./output" resolves to OUTPUT_DIR so artifact_dir == internal_dir
            self.assertEqual(run_registry.resolve_user_path("./output"), output_dir.resolve())
            self.assertEqual(run_registry.resolve_user_path(f"output/{run_name}"), internal)

            # 8. Deleting history keeps models and writes tombstone cleanly
            self.assertTrue(run_registry.mark_run_deleted(f"output/{run_name}"))
            self.assertTrue((internal / "demo-000001.safetensors").is_file())
            self.assertIsNone(run_registry.load_run_record(f"output/{run_name}"))
            meta = json.loads((internal / run_registry.RUN_META_NAME).read_text(encoding="utf-8"))
            self.assertTrue(meta["deleted"])
            self.assertEqual(meta["run_dir"], f"output/{run_name}")
            self.assertEqual(meta["artifact_dir"], f"output/{run_name}")

    def test_symlinked_output_dir_pointing_outside_repo_root(self):
        linked_output = self.repo / "output"
        linked_config = self.repo / "config"
        if not _make_dir_link(linked_output, self.drive_output):
            self.skipTest("Directory symlink/junction creation not permitted in this environment")
        self.assertTrue(_make_dir_link(linked_config, self.drive / "config"))

        self._assert_full_run_lifecycle(linked_output, linked_config / "autosave")

        # Symlink inside output/ escaping outside OUTPUT_DIR must be rejected
        escape_link = self.drive_output / "escape_dir"
        if _make_dir_link(escape_link, self.other_disk):
            with (
                patch.object(run_registry, "REPO_ROOT", self.repo),
                patch.object(run_registry, "OUTPUT_DIR", linked_output),
            ):
                self.assertIsNone(run_registry.resolve_internal_run_dir("output/escape_dir"))
                self.assertIsNone(run_registry.resolve_internal_run_dir(escape_link))

    def test_external_output_dir_without_symlink(self):
        self._assert_full_run_lifecycle(self.drive_output, self.drive_autosave)

    def test_import_legacy_external_runs_with_external_autosave_dir(self):
        ext_artifact = self.other_disk / "legacy_run"
        ext_artifact.mkdir(parents=True)
        autosave_toml = self.drive_autosave / "legacy.toml"
        autosave_toml.write_text(
            f'output_name = "legacy"\noutput_dir = "{ext_artifact.as_posix()}"\n',
            encoding="utf-8",
        )
        with (
            patch.object(run_registry, "REPO_ROOT", self.repo),
            patch.object(run_registry, "OUTPUT_DIR", self.drive_output),
            patch.object(run_registry, "CONFIG_DIR", self.drive / "config"),
            patch.object(run_registry, "AUTOSAVE_DIR", self.drive_autosave),
        ):
            stats = run_registry.import_legacy_external_runs()
            self.assertEqual(stats["imported"], 1)
            # Second call is idempotent
            stats2 = run_registry.import_legacy_external_runs()
            self.assertEqual(stats2["imported"], 0)
            self.assertGreaterEqual(stats2["skipped"], 1)

    def test_generate_monitor_demo_with_external_output_dir(self):
        from backend import constants
        from tools.dev import generate_monitor_demo

        with (
            patch.object(constants, "OUTPUT_DIR", self.drive_output),
            patch.object(run_registry, "REPO_ROOT", self.repo),
            patch.object(run_registry, "OUTPUT_DIR", self.drive_output),
        ):
            demo_path = generate_monitor_demo.create_demo_run(single=True, epochs=1)
            self.assertTrue(demo_path.is_dir())
            self.assertEqual(demo_path.resolve().parent, self.drive_output.resolve())
            rec = run_registry.load_run_record(demo_path)
            self.assertIsNotNone(rec)
            self.assertEqual(rec["run_dir"], f"output/{demo_path.name}")


if __name__ == "__main__":
    unittest.main()
