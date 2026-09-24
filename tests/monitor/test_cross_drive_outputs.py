import asyncio
import json
import threading
import tempfile
import time
import tomllib
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.monitor import artifacts, routes, run_registry
from backend.server.routes import training as training_routes
from backend.tasks import TaskManager, TaskStatus


def _completed_launch(*_args, **kwargs):
    """A successful launcher stub must settle its reserved task like a worker."""
    task = kwargs["reserved_task"]
    with task.lock:
        task.status = TaskStatus.FINISHED
        task.finished_at = time.time()
    return {"status": "success", "data": {"task_id": task.task_id}}


class _BodyRequest:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    async def body(self) -> bytes:
        return self._body


class CrossDriveSandbox(unittest.TestCase):
    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.root = Path(self._temp.name)
        self.output = self.root / "output"
        self.autosave = self.root / "config" / "autosave"
        self.external = self.root / "external-output"
        self.output.mkdir(parents=True)
        self.autosave.mkdir(parents=True)
        self.external.mkdir(parents=True)

        self._patches = ExitStack()
        self._patches.enter_context(patch.object(run_registry, "REPO_ROOT", self.root))
        self._patches.enter_context(patch.object(run_registry, "OUTPUT_DIR", self.output))
        self._patches.enter_context(patch.object(run_registry, "AUTOSAVE_DIR", self.autosave))
        self._patches.enter_context(patch.object(artifacts, "REPO_ROOT", self.root))
        self._patches.enter_context(patch.object(artifacts, "OUTPUT_DIR", self.output))
        self._patches.enter_context(patch.object(training_routes, "OUTPUT_DIR", self.output))
        self._patches.enter_context(patch.object(training_routes, "tm", TaskManager()))
        artifacts.invalidate_history_cache()

    def tearDown(self):
        self._patches.close()
        artifacts.invalidate_history_cache()
        self._temp.cleanup()

    @staticmethod
    def _write_config(path: Path, artifact_dir: Path, name: str = "demo") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f'output_name = "{name}"\n'
            f'output_dir = "{artifact_dir.as_posix()}"\n'
            'pretrained_model_name_or_path = "model.safetensors"\n'
            'learning_rate = 0.0001\n'
            'network_dim = 32\n'
            'max_train_epochs = 2\n',
            encoding="utf-8",
        )


class RunRegistryTests(CrossDriveSandbox):
    def test_run_route_stop_during_file_preparation_returns_cancelled_and_releases_slot(self):
        entered, release = threading.Event(), threading.Event()
        payload = {
            "model_train_type": "sdxl-lora",
            "train_data_dir": str(self.root / "train"),
            "pretrained_model_name_or_path": str(self.root / "model.safetensors"),
            "output_name": "cancelled_run",
            "output_dir": str(self.external),
        }

        def write_config(*_args, **_kwargs):
            entered.set()
            self.assertTrue(release.wait(5))

        with ExitStack() as stack:
            stack.enter_context(patch("backend.training.validate_training_config", return_value=[]))
            stack.enter_context(patch("backend.training.adapt_config", side_effect=lambda value: (dict(value), [])))
            stack.enter_context(patch.object(training_routes.train_utils, "fix_config_types"))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_data_dir", return_value=True))
            stack.enter_context(patch.object(training_routes.train_utils, "count_images", return_value=1))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_model", return_value=(True, "")))
            stack.enter_context(patch.object(training_routes, "estimate_training_steps", return_value={}))
            stack.enter_context(patch.object(training_routes, "get_sample_prompts", return_value=(None, "")))
            stack.enter_context(patch.object(training_routes, "AUTOSAVE_DIR", self.autosave))
            stack.enter_context(patch.object(training_routes, "write_training_config", side_effect=write_config))
            launch = stack.enter_context(patch.object(training_routes, "run_train"))

            async def exercise():
                request = asyncio.create_task(training_routes.create_toml_file(_BodyRequest(dict(payload))))
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                task_id = next(iter(training_routes.tm.tasks))
                training_routes.tm.terminate_task(task_id)
                self.assertIsNone(training_routes.tm.reserve_task())
                release.set()
                return await request

            try:
                response = asyncio.run(exercise())
            finally:
                release.set()

        self.assertEqual(response.status, "fail")
        self.assertEqual(response.message, "Training preparation cancelled / 训练准备已取消")
        launch.assert_not_called()
        self.assertIsNotNone(training_routes.tm.reserve_task())
        self.assertEqual(list(self.autosave.glob("*.toml")), [])
        self.assertEqual(list(self.output.iterdir()), [])

    def test_preview_cache_reuses_full_list_across_limits_and_runs(self):
        first = self.output / "preview-first"
        second = self.output / "preview-second"
        for directory in (first, second):
            sample = directory / "sample"
            sample.mkdir(parents=True)
            (sample / "000001_00_20260924120000.png").touch()
            (sample / "000002_00_20260924120001.png").touch()
        original_iter = artifacts._iter_dir
        with patch.object(artifacts, "_iter_dir", wraps=original_iter) as walk:
            newest = artifacts.newest_previews(str(first), limit=1, run_dir="first", force_refresh=True)
            full = artifacts.newest_previews(str(first), limit=0, run_dir="first")
            other = artifacts.newest_previews(str(second), limit=1, run_dir="second", force_refresh=True)
            again = artifacts.newest_previews(str(first), limit=0, run_dir="first")
            self.assertEqual(walk.call_count, 2)
        self.assertEqual(len(newest), 1)
        self.assertEqual(len(full), 2)
        self.assertEqual(len(other), 1)
        self.assertEqual(again, full)
        self.assertEqual(newest[0], full[-1])

    def test_same_second_launch_reserves_before_preflight_and_keeps_configs_distinct(self):
        entered = threading.Event()
        release = threading.Event()
        payload = {
            "model_train_type": "sdxl-lora",
            "train_data_dir": str(self.root / "train"),
            "pretrained_model_name_or_path": str(self.root / "model.safetensors"),
            "output_name": "same_name",
            "output_dir": str(self.external),
        }

        def estimate(_config):
            entered.set()
            self.assertTrue(release.wait(5))
            return {}

        with ExitStack() as stack:
            stack.enter_context(patch("backend.training.validate_training_config", return_value=[]))
            stack.enter_context(patch("backend.training.adapt_config", side_effect=lambda value: (dict(value), [])))
            stack.enter_context(patch.object(training_routes.train_utils, "fix_config_types"))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_data_dir", return_value=True))
            stack.enter_context(patch.object(training_routes.train_utils, "count_images", return_value=1))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_model", return_value=(True, "")))
            stack.enter_context(patch.object(training_routes, "estimate_training_steps", side_effect=estimate))
            stack.enter_context(patch.object(training_routes, "get_sample_prompts", return_value=(None, "")))
            stack.enter_context(patch.object(training_routes, "AUTOSAVE_DIR", self.autosave))
            stack.enter_context(patch.object(training_routes.os, "getcwd", return_value=str(self.root)))
            clock = stack.enter_context(patch.object(training_routes, "datetime"))
            clock.now.return_value.strftime.return_value = "20260924-120000"
            launch = stack.enter_context(patch.object(
                training_routes, "run_train", side_effect=_completed_launch,
            ))

            async def exercise():
                first = asyncio.create_task(training_routes.create_toml_file(_BodyRequest(dict(payload))))
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                blocked = await training_routes.create_toml_file(_BodyRequest({**payload, "output_name": "other"}))
                release.set()
                first_result = await first
                second_result = await training_routes.create_toml_file(_BodyRequest(dict(payload)))
                return first_result, blocked, second_result

            first_result, blocked, second_result = asyncio.run(exercise())

        self.assertEqual(first_result["status"], "success")
        self.assertEqual(blocked.status, "fail")
        self.assertEqual(second_result["status"], "success")
        self.assertEqual(launch.call_count, 2)
        run_dirs = [Path(call.kwargs["run_dir"]) for call in launch.call_args_list]
        self.assertNotEqual(run_dirs[0], run_dirs[1])
        self.assertEqual(len(list(self.autosave.glob("20260924-120000_*.toml"))), 2)
        self.assertTrue(all((path / "config.toml").is_file() for path in run_dirs))

    def test_v2_record_maps_external_artifacts_and_rejects_traversal(self):
        internal = self.output / "demo_20260716-120000"
        artifact = self.external / internal.name
        artifact.mkdir(parents=True)
        (artifact / "sample").mkdir()
        model = artifact / "demo.safetensors"
        model.write_bytes(b"weights")
        self._write_config(internal / "config.toml", artifact)

        run_registry.write_run_record(
            internal,
            artifact_dir=artifact,
            task_id="task-1",
            output_base_dir=self.external,
            extra={"preview_enabled": True},
        )

        record = run_registry.load_run_record("output/demo_20260716-120000")
        self.assertIsNotNone(record)
        self.assertEqual(record["schema_version"], 2)
        self.assertEqual(record["run_dir"], "output/demo_20260716-120000")
        self.assertEqual(record["artifact_path"], artifact.resolve())
        self.assertTrue(record["artifact_external"])
        self.assertTrue(record["artifact_available"])
        self.assertTrue(record["preview_enabled"])
        self.assertEqual(
            run_registry.resolve_artifact_file(record["run_dir"], "demo.safetensors"),
            model.resolve(),
        )
        self.assertIsNone(run_registry.resolve_artifact_file(record["run_dir"], "../secret.txt"))
        self.assertIsNone(run_registry.resolve_artifact_file(record["run_dir"], self.root / "secret.txt"))

    def test_relocated_cloud_run_repairs_artifact_location(self):
        # AutoDL 风格：记录里是云端绝对路径，整个运行目录被拷贝到本地 output/ 下
        internal = self.output / "narumi_toa_20260802-182942"
        internal.mkdir(parents=True)
        (internal / "sample").mkdir()
        (internal / "model.safetensors").write_bytes(b"weights")
        cloud_path = "/root/autodl-tmp/lora-scripts-anima/output/narumi_toa_20260802-182942"
        (internal / "task_meta.json").write_text(
            json.dumps({
                "schema_version": 2,
                "task_id": "cloud-task",
                "run_dir": "output/narumi_toa_20260802-182942",
                "artifact_dir": cloud_path,
                "output_base_dir": "./output",
                "autosave_file": "",
                "created_at": "2026-08-02T18:29:42.550136",
                "imported": False,
                "deleted": False,
                "extra": {"output_dir": cloud_path, "preview_enabled": True},
            }),
            encoding="utf-8",
        )
        (internal / "output_dir.txt").write_text("stale cloud reference\n", encoding="utf-8")

        record = run_registry.load_run_record(internal)

        self.assertTrue(record["artifact_available"])
        self.assertEqual(record["artifact_path"], internal.resolve())
        self.assertEqual(record["artifact_dir"], str(internal.resolve()))
        self.assertFalse(record["artifact_external"])
        # 元数据与引用文件已被修复，且幂等（再次加载不重复改动）
        repaired = json.loads((internal / "task_meta.json").read_text(encoding="utf-8"))
        self.assertEqual(repaired["artifact_dir"], str(internal.resolve()))
        self.assertEqual(repaired["task_id"], "cloud-task")
        self.assertIn(str(internal.resolve()), (internal / "output_dir.txt").read_text(encoding="utf-8"))
        self.assertEqual(run_registry.load_run_record(internal)["artifact_path"], internal.resolve())

    def test_deleting_history_keeps_models_checkpoints_and_previews(self):
        for suffix, external in (("external", True), ("default", False)):
            with self.subTest(storage=suffix):
                internal = self.output / f"delete_{suffix}"
                artifact = (self.external / internal.name) if external else internal
                artifact.mkdir(parents=True)
                self._write_config(internal / "config.toml", artifact, suffix)
                run_registry.write_run_record(internal, artifact_dir=artifact, task_id=f"task-{suffix}")

                (internal / "train_task.log").write_text("log", encoding="utf-8")
                (internal / "result.json").write_text("{}", encoding="utf-8")
                (internal / "output_dir.txt").write_text(str(artifact), encoding="utf-8")
                (internal / "log").mkdir()
                (internal / "log" / "events.out.tfevents.test").write_bytes(b"tb")
                (artifact / "sample").mkdir(exist_ok=True)
                (artifact / "sample" / "preview.png").write_bytes(b"image")
                (artifact / "demo.safetensors").write_bytes(b"weights")
                (artifact / "demo-state").mkdir()
                (artifact / "demo-state" / "state.json").write_text("{}", encoding="utf-8")

                self.assertTrue(run_registry.mark_run_deleted(internal))
                self.assertFalse((internal / "config.toml").exists())
                self.assertFalse((internal / "train_task.log").exists())
                self.assertFalse((internal / "output_dir.txt").exists())
                self.assertFalse((internal / "log").exists())
                self.assertTrue((artifact / "demo.safetensors").exists())
                self.assertTrue((artifact / "sample" / "preview.png").exists())
                self.assertTrue((artifact / "demo-state" / "state.json").exists())
                tombstone = json.loads((internal / "task_meta.json").read_text(encoding="utf-8"))
                self.assertTrue(tombstone["deleted"])
                self.assertIsNone(run_registry.load_run_record(internal))

    def test_legacy_external_import_is_idempotent_and_does_not_copy_models(self):
        artifact = self.external / "old_run"
        artifact.mkdir()
        self._write_config(artifact / "config.toml", artifact, "old")
        (artifact / "train_old.log").write_text("old log", encoding="utf-8")
        (artifact / "log").mkdir()
        (artifact / "log" / "events.out.tfevents.old").write_bytes(b"tb")
        (artifact / "old.safetensors").write_bytes(b"weights")
        autosave = self.autosave / "20260716-120000.toml"
        self._write_config(autosave, artifact, "old")

        first = run_registry.import_legacy_external_runs()
        second = run_registry.import_legacy_external_runs()

        self.assertEqual(first["imported"], 1)
        self.assertEqual(second["imported"], 0)
        records = run_registry.iter_run_records()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertTrue(record["imported"])
        internal = record["run_path"]
        self.assertTrue((internal / "config.toml").exists())
        self.assertTrue((internal / "train_old.log").exists())
        self.assertTrue((internal / "log" / "events.out.tfevents.old").exists())
        self.assertFalse((internal / "old.safetensors").exists())
        self.assertTrue((artifact / "old.safetensors").exists())


class CrossDriveRouteTests(CrossDriveSandbox):
    def _create_record(self):
        internal = self.output / "route_run"
        artifact = self.external / "route_run"
        artifact.mkdir()
        self._write_config(internal / "config.toml", artifact, "route")
        run_registry.write_run_record(
            internal,
            artifact_dir=artifact,
            task_id="route-task",
            output_base_dir=self.external,
            extra={"preview_enabled": True},
        )
        return internal, artifact

    def test_run_route_writes_monitoring_data_internal_and_artifacts_to_selected_path(self):
        cases = (
            ("default", "./output", "", True),
            ("custom", str(self.external / "custom-root"), "", False),
            (
                "resume",
                str(self.external / "existing-run"),
                str(self.external / "existing-run" / "demo-state"),
                False,
            ),
        )

        for name, requested_output, resume, same_location in cases:
            with self.subTest(storage=name):
                payload = {
                    "model_train_type": "sdxl-lora",
                    "train_data_dir": str(self.root / "train"),
                    "pretrained_model_name_or_path": str(self.root / "model.safetensors"),
                    "output_name": f"route_{name}",
                    "output_dir": requested_output,
                    "enable_preview": True,
                }
                if resume:
                    payload["resume"] = resume

                def _adapt_config(value):
                    adapted = dict(value)
                    adapted.pop("enable_preview", None)
                    return adapted, []

                with ExitStack() as stack:
                    stack.enter_context(patch("backend.training.validate_training_config", return_value=[]))
                    stack.enter_context(patch("backend.training.adapt_config", side_effect=_adapt_config))
                    stack.enter_context(patch.object(training_routes.train_utils, "fix_config_types"))
                    stack.enter_context(patch.object(training_routes.train_utils, "validate_data_dir", return_value=True))
                    stack.enter_context(patch.object(training_routes.train_utils, "count_images", return_value=1))
                    stack.enter_context(
                        patch.object(training_routes.train_utils, "validate_model", return_value=(True, ""))
                    )
                    stack.enter_context(patch.object(training_routes, "estimate_training_steps", return_value={}))
                    stack.enter_context(patch.object(training_routes, "get_sample_prompts", return_value=(None, "")))
                    stack.enter_context(patch.object(training_routes.os, "getcwd", return_value=str(self.root)))
                    stack.enter_context(
                        patch.object(training_routes, "AUTOSAVE_DIR", Path(self.root) / "config" / "autosave")
                    )
                    run_train = stack.enter_context(
                        patch.object(
                            training_routes,
                            "run_train",
                            side_effect=_completed_launch,
                        )
                    )
                    result = asyncio.run(training_routes.create_toml_file(_BodyRequest(payload)))

                self.assertEqual(result["status"], "success")
                call = run_train.call_args
                run_path = Path(call.kwargs["run_dir"])
                artifact_path = Path(call.kwargs["artifact_dir"])
                self.assertTrue(run_path.is_dir())
                self.assertTrue(artifact_path.is_dir())
                self.assertEqual(call.kwargs["output_base_dir"], requested_output)
                self.assertTrue(call.kwargs["preview_enabled"])

                saved = tomllib.loads((run_path / "config.toml").read_text(encoding="utf-8"))
                self.assertEqual(Path(saved["output_dir"]), artifact_path)
                self.assertEqual(Path(saved["logging_dir"]), run_path / "log")
                output_dir_reference = (run_path / "output_dir.txt").read_text(encoding="utf-8")
                self.assertIn("Artifact directory / 模型产物目录", output_dir_reference)
                self.assertIn("Models, checkpoints, training states, and previews are saved here.", output_dir_reference)
                self.assertEqual(output_dir_reference.splitlines()[-1], str(artifact_path))

                if same_location:
                    self.assertEqual(artifact_path, run_path)
                elif resume:
                    self.assertEqual(artifact_path, Path(requested_output).resolve())
                    self.assertNotEqual(artifact_path, run_path)
                else:
                    self.assertEqual(artifact_path.parent, Path(requested_output).resolve())
                    self.assertEqual(artifact_path.name, run_path.name)

    def test_external_previews_and_outputs_use_registered_relative_paths(self):
        internal, artifact = self._create_record()
        (artifact / "sample").mkdir()
        (artifact / "sample" / "preview.png").write_bytes(b"image")
        (artifact / "route.safetensors").write_bytes(b"weights")

        previews = artifacts.newest_previews(
            str(artifact),
            force_refresh=True,
            run_dir="output/route_run",
        )
        preview_response = asyncio.run(routes.monitor_previews(
            task_id="",
            run_dir="output/route_run",
            refresh=1,
            limit=300,
        ))
        files = artifacts.list_output_files(str(artifact))

        self.assertEqual(previews[0]["path"], "sample/preview.png")
        self.assertIn("run_dir=output%2Froute_run", previews[0]["url"])
        self.assertIn("path=sample%2Fpreview.png", previews[0]["url"])
        self.assertTrue(preview_response["meta"]["artifact_available"])
        self.assertTrue(preview_response["meta"]["preview_enabled"])
        self.assertEqual({item["path"] for item in files}, {"route.safetensors", "sample/preview.png"})
        self.assertTrue(internal.is_dir())

    def test_offline_artifact_keeps_record_but_outputs_report_unavailable(self):
        internal, artifact = self._create_record()
        artifact.rmdir()

        record = run_registry.load_run_record(internal)
        result = asyncio.run(routes.monitor_outputs(run_dir="output/route_run", task_id=""))

        self.assertFalse(record["artifact_available"])
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["data"]["artifact_available"])


if __name__ == "__main__":
    unittest.main()
