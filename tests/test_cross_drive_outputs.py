import asyncio
import json
import tempfile
import tomllib
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.monitor import artifacts, routes, run_registry
from backend.server.routes import training as training_routes


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

    def test_v1_record_falls_back_to_configured_artifact_directory(self):
        internal = self.output / "legacy_internal"
        artifact = self.external / "legacy_artifacts"
        internal.mkdir()
        artifact.mkdir()
        self._write_config(internal / "config.toml", artifact, "legacy")
        (internal / "task_meta.json").write_text(
            json.dumps({"task_id": "legacy-task", "extra": {"output_dir": str(artifact)}}),
            encoding="utf-8",
        )

        record = run_registry.load_run_record(internal)

        self.assertEqual(record["schema_version"], 1)
        self.assertEqual(record["task_id"], "legacy-task")
        self.assertEqual(record["artifact_path"], artifact.resolve())
        self.assertTrue(record["artifact_external"])
        self.assertIsNone(record["preview_enabled"])

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

    def test_output_path_info_separates_artifacts_from_monitoring_data(self):
        response = asyncio.run(training_routes.output_path_info(
            path=str(self.external),
            output_name="my model",
            resume=False,
        ))
        data = response.data

        self.assertFalse(data["is_default"])
        self.assertFalse(data["same_location"])
        self.assertTrue(data["available"])
        self.assertTrue(data["writable"])
        self.assertEqual(Path(data["preview_dir"]).parent, self.external.resolve())
        self.assertEqual(Path(data["monitor_dir"]).parent, self.output.resolve())
        self.assertTrue(Path(data["preview_dir"]).name.startswith("my_model_"))

        resume_response = asyncio.run(training_routes.output_path_info(
            path=str(self.external),
            output_name="ignored",
            resume=True,
        ))
        self.assertEqual(Path(resume_response.data["preview_dir"]), self.external.resolve())

    def test_failed_directory_probe_removes_new_empty_directory(self):
        created = self.root / "probe-created"
        not_a_directory = self.root / "probe-file"
        not_a_directory.write_text("file", encoding="utf-8")

        with self.assertRaises(OSError):
            training_routes._prepare_output_directories(created, not_a_directory)

        self.assertFalse(created.exists())
        self.assertTrue(not_a_directory.is_file())

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
                    run_train = stack.enter_context(
                        patch.object(
                            training_routes,
                            "run_train",
                            return_value={"status": "success", "data": {"task_id": "mock-task"}},
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
        self.assertIn("path=sample/preview.png", previews[0]["url"])
        self.assertTrue(preview_response["meta"]["artifact_available"])
        self.assertTrue(preview_response["meta"]["preview_enabled"])
        self.assertEqual({item["path"] for item in files}, {"route.safetensors", "sample/preview.png"})
        self.assertTrue(internal.is_dir())

    def test_run_detail_and_output_loss_read_tensorboard_from_internal_directory(self):
        internal, artifact = self._create_record()
        (artifact / "route.safetensors").write_bytes(b"weights")

        with patch.object(routes, "read_tensorboard_loss", return_value=[]) as read_tb, patch.object(
            routes, "newest_previews", return_value=[]
        ):
            detail = asyncio.run(routes.monitor_run_detail("output/route_run"))
            outputs = asyncio.run(routes.monitor_outputs(run_dir="output/route_run", task_id=""))

        self.assertEqual(detail["status"], "success")
        self.assertEqual(detail["data"]["artifact_dir"], str(artifact.resolve()))
        self.assertTrue(detail["data"]["artifact_external"])
        self.assertTrue(detail["data"]["preview_enabled"])
        self.assertEqual(outputs["status"], "success")
        self.assertEqual(outputs["data"][0]["path"], "route.safetensors")
        self.assertTrue(outputs["meta"]["artifact_available"])
        self.assertTrue(any(call.kwargs.get("run_dir") == str(internal.resolve()) for call in read_tb.call_args_list))

    def test_offline_artifact_keeps_record_but_outputs_report_unavailable(self):
        internal, artifact = self._create_record()
        artifact.rmdir()

        record = run_registry.load_run_record(internal)
        result = asyncio.run(routes.monitor_outputs(run_dir="output/route_run", task_id=""))

        self.assertFalse(record["artifact_available"])
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["data"]["artifact_available"])


class CrossDriveFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.training_source = Path("frontend/js/training-core.js").read_text(encoding="utf-8")
        cls.training_toml_source = Path("frontend/js/training-toml.js").read_text(encoding="utf-8")
        cls.monitor_source = Path("frontend/js/monitor-core.js").read_text(encoding="utf-8")
        cls.render_source = Path("frontend/js/monitor-render.js").read_text(encoding="utf-8")
        cls.css_source = Path("frontend/css/app.css").read_text(encoding="utf-8")
        cls.zh = json.loads(Path("frontend/i18n/zh-CN.json").read_text(encoding="utf-8"))
        cls.en = json.loads(Path("frontend/i18n/en-US.json").read_text(encoding="utf-8"))

    def test_output_field_keeps_only_compact_custom_or_error_hint(self):
        self.assertIn("/api/training/output-path-info?", self.training_source)
        self.assertIn("outputPathCustomSummary", self.training_source)
        self.assertIn("outputPathHintVisible", self.training_source)
        self.assertIn("return !info.is_default", self.training_source)
        self.assertNotIn("outputPathArtifactDetail", self.training_source)
        self.assertNotIn("outputPathMonitorDetail", self.training_source)
        self.assertNotIn("outputPathExternalWarning", self.training_source)
        self.assertNotIn("output-path-hint-row", self.css_source)
        self.assertIn("output-path-hint.is-error", self.css_source)
        self.assertIn("await this.refreshOutputPathInfo(true)", self.training_toml_source)
        self.assertIn("!outputPathInfo.available", self.training_toml_source)

    def test_monitor_uses_run_mapping_for_single_download_and_offline_states(self):
        self.assertIn("outputs/download-file?run_dir=", self.monitor_source)
        self.assertIn("noPreviewArtifactUnavailableHint", self.render_source)
        self.assertIn("noPreviewDisabledHint", self.render_source)
        self.assertIn("noOutputsArtifactUnavailableHint", self.render_source)
        self.assertIn("artifact_available", self.render_source)
        self.assertNotIn("externalArtifacts", self.render_source)
        self.assertNotIn("importedLegacy", self.render_source)

    def test_only_necessary_path_copy_is_present_in_both_locales(self):
        for locale in (self.zh, self.en):
            training = locale["training"]
            monitor = locale["monitor"]
            for key in (
                "outputPathCustomSummary",
                "outputPathUnavailable",
            ):
                self.assertTrue(training[key])
            for removed in (
                "outputPathDefaultSummary",
                "outputPathArtifactDetail",
                "outputPathMonitorDetail",
                "outputPathFreeSpace",
                "outputPathExternalWarning",
            ):
                self.assertNotIn(removed, training)
            for key in (
                "artifactOfflineHint",
                "noPreviewDisabledHint",
                "noOutputsArtifactUnavailableHint",
                "confirmDeleteRun",
            ):
                self.assertTrue(monitor[key])


if __name__ == "__main__":
    unittest.main()
