import asyncio
import json
from pathlib import Path
from unittest.mock import patch
import zipfile

from backend.monitor import history, routes, run_registry
from tests.helpers import json_request
from tests.monitor.test_cross_drive_outputs import CrossDriveSandbox


class HistoryTests(CrossDriveSandbox):
    def make_run(self, name="demo", **kwargs):
        run = self.output / name
        self._write_config(run / "config.toml", self.external, name)
        run_registry.write_run_record(run, artifact_dir=self.external, **kwargs)
        return run

    def test_partial_delete_stays_visible_and_retry_preserves_artifacts(self):
        run = self.make_run()
        log = run / "train_demo.log"
        log.write_text("log", encoding="utf-8")
        model = self.external / "model.safetensors"
        model.write_bytes(b"model")
        original = Path.unlink

        def locked(path, *args, **kwargs):
            if path == log:
                raise PermissionError("locked")
            return original(path, *args, **kwargs)

        with patch.object(Path, "unlink", locked):
            result = asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["data"]["retryable"])
        self.assertEqual(result["error_code"], "monitorCleanupFailed")
        self.assertEqual(result["error_details"], "train_demo.log")
        self.assertTrue(history.scan_history()[0]["deletion_pending"])
        self.assertEqual(history.scan_history()[0]["name"], "demo")
        self.assertTrue(log.exists())
        result = asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))
        self.assertEqual(result["status"], "success")
        self.assertEqual(history.scan_history(), [])
        self.assertEqual(model.read_bytes(), b"model")
        self.assertFalse(log.exists())

    def test_snapshot_parameters_keep_native_values_separate_from_reuse_conversion(self):
        run = self.make_run(extra={"profile_id": "anima-lora"})
        with (run / "config.toml").open("a", encoding="utf-8") as stream:
            stream.write(
                'network_module = "networks.lora_anima"\n'
                'optimizer_type = "prodigyplus.ProdigyPlusScheduleFree"\n'
                'optimizer_args = ["eps=None"]\n'
                'lr_scheduler = "piecewise_constant"\n'
                'lr_scheduler_args = ["step_rules=\'1:100,0.5\'"]\n'
                'step_rules = "1:200,0.2"\n'
            )
        result = asyncio.run(routes.get_config_from_run("output/demo"))
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertEqual(data["training_profile"], "anima-lora")
        saved = {param["key"]: param for param in data["train_params"]}
        self.assertEqual(saved["optimizer_args.eps"]["value"], "None")
        self.assertEqual(saved["lr_scheduler_args.step_rules"]["string_value"], "1:100,0.5")
        self.assertEqual(data["reuse_params"]["step_rules"], "1:200,0.2")

    def test_run_detail_keeps_log_ownership_when_artifacts_are_shared(self):
        self.make_run("original", task_id="original-task")
        self.make_run("resumed", task_id="resumed-task")
        for name in ("original", "resumed"):
            with self.subTest(name=name):
                response = asyncio.run(routes.monitor_run_detail(f"output/{name}"))
                self.assertEqual(response["status"], "success")
                self.assertEqual(response["data"]["task_id"], f"{name}-task")
                self.assertEqual(response["data"]["artifact_dir"], str(self.external))

    def test_moved_state_only_run_can_resume_after_an_unrecorded_exit(self):
        import torch
        from backend.monitor.artifacts import list_output_files

        run = self.make_run(task_id="moved-task")
        self.external.rmdir()  # The old drive is no longer available.
        state = run / "demo-000002-state"
        state.mkdir()
        (state / "train_state.json").write_text('{"current_step":240}')
        control = run / "log" / ".run-control"
        control.mkdir(parents=True)
        (control / "status.json").write_text(json.dumps({
            "schema_version": 1, "last_state": {"path": r"Z:\previous\demo-000002-state", "step": 240},
        }))
        meta = run / run_registry.RUN_META_NAME
        original = meta.read_bytes()
        self.assertFalse(run_registry.load_run_record(run)["artifact_available"])
        self.assertEqual(meta.read_bytes(), original)

        for name in ("pytorch_model.bin", "optimizer.bin", "random_states_0.pkl"):
            torch.save({}, state / name)

        def detail():
            return asyncio.run(routes.monitor_run_detail("output/demo"))["data"]

        data = detail()
        self.assertTrue(data["artifact_available"])
        self.assertEqual(Path(data["artifact_dir"]), run)
        self.assertEqual(meta.read_bytes(), original)
        self.assertNotIn("train_result", data)
        self.assertEqual((data["resume_state"], data["resume_step"]), (str(state), 240))
        with patch.object(routes.tm, "get_task") as get_task:
            get_task.return_value.snapshot.return_value = {"status": "RUNNING"}
            self.assertNotIn("resume_state", detail())

        def checkpoint():
            item, = (entry for entry in list_output_files(str(run)) if entry["category"] == "state")
            return item["ckpt_type"], item["ckpt_epoch"], item["ckpt_step"]

        self.assertEqual(checkpoint(), ("epoch", 2, 240))
        metadata = state / "train_state.json"
        metadata.write_text('{"global_step":0}')
        self.assertEqual(checkpoint(), ("epoch", 2, 0))
        metadata.unlink()
        self.assertEqual(checkpoint(), ("epoch", 2, None))
        self.external.mkdir()
        self.assertEqual(run_registry.load_run_record(run)["artifact_path"], self.external)

    def test_fsdp_checkpoints_can_be_viewed_and_downloaded_from_moved_runs(self):
        import torch

        self.external.rmdir()
        for layout, files in {
            "full": ("pytorch_model_fsdp.bin", "optimizer.bin"),
            "local": ("pytorch_model_fsdp_rank0.bin", "optimizer_0_rank0.bin"),
            "mixed": ("pytorch_model.bin", "optimizer.bin", "pytorch_model_fsdp_1_rank0.bin"),
        }.items():
            with self.subTest(layout=layout):
                run = self.make_run(layout)
                state = run / "demo-state"
                state.mkdir()
                for name in (*files, "random_states_0.pkl"):
                    torch.save({}, state / name)
                control = run / "log" / ".run-control"
                control.mkdir(parents=True)
                (control / "status.json").write_text(json.dumps({"schema_version": 1, "last_state": {"path": str(state)}}))

                run_id = f"output/{layout}"
                detail = asyncio.run(routes.monitor_run_detail(run_id))["data"]
                self.assertTrue(detail["artifact_available"])
                self.assertNotIn("resume_state", detail)
                self.assertNotIn("resume_issue", detail)
                outputs = asyncio.run(routes.monitor_outputs(run_id, ""))["data"]
                row, = (file for file in outputs if file["category"] == "state")
                self.assertFalse(row["resumable"])
                self.assertNotIn("resume_issue", row)
                response = asyncio.run(routes.download_outputs(run_id, "", path=[row["path"]]))
                try:
                    with zipfile.ZipFile(response.path) as archive:
                        for file in state.iterdir():
                            self.assertEqual(archive.read(file.relative_to(run).as_posix()), file.read_bytes())
                finally:
                    asyncio.run(response.background())

    def test_moved_deepspeed_state_exposes_remaining_shards_for_download(self):
        from backend.training.checkpoint_state import STATE_INVENTORY

        run = self.make_run()
        self.external.rmdir()
        state = run / "demo-state"
        shards = state / "pytorch_model"
        shards.mkdir(parents=True)
        control = run / "log" / ".run-control"
        control.mkdir(parents=True)
        (control / "status.json").write_text(json.dumps({
            "schema_version": 1, "last_state": {"path": str(state), "step": 20},
        }))
        shard = shards / "zero_pp_rank_1_mp_rank_00_optim_states.pt"
        shard.write_bytes(b"remaining shard")
        for indexed in (False, True):
            if indexed:
                (state / STATE_INVENTORY).write_text(json.dumps({"pytorch_model/mp_rank_00_model_states.pt": 128}))
            with self.subTest(indexed=indexed):
                detail = asyncio.run(routes.monitor_run_detail("output/demo"))["data"]
                self.assertTrue(detail["artifact_available"])
                self.assertNotIn("resume_state", detail)
                self.assertNotIn("resume_issue", detail)
                outputs = asyncio.run(routes.monitor_outputs("output/demo", ""))["data"]
                row, = (file for file in outputs if file["category"] == "state")
                self.assertFalse(row["resumable"])
                self.assertNotIn("resume_issue", row)
                response = asyncio.run(routes.download_outputs("output/demo", "", path=[row["path"]]))
                try:
                    with zipfile.ZipFile(response.path) as archive:
                        self.assertEqual(archive.read(shard.relative_to(run).as_posix()), b"remaining shard")
                finally:
                    asyncio.run(response.background())

    def test_deleting_history_from_local_fallback_keeps_original_disk_excluded(self):
        import torch

        run = self.make_run()
        self._write_config(self.autosave / "demo.toml", self.external)
        offline = self.external.with_name("disconnected")
        self.external.rename(offline)
        state = run / "demo-state"
        state.mkdir()
        for name in ("random_states_0.pkl", "pytorch_model.bin", "optimizer.bin"):
            torch.save({}, state / name)
        self.assertEqual(run_registry.load_run_record(run)["artifact_path"], run)
        log = run / "train_demo.log"
        log.touch()
        unlink = Path.unlink

        def locked(path, *args, **kwargs):
            if path == log:
                raise PermissionError("locked")
            return unlink(path, *args, **kwargs)

        def delete():
            return asyncio.run(routes.delete_history_run(json_request({"run_dir": "output/demo"})))

        with patch.object(Path, "unlink", locked):
            self.assertEqual(delete()["error_code"], "monitorCleanupFailed")
        self.assertEqual(run_registry.load_run_record(run)["artifact_path"], run)
        self.assertEqual(delete()["status"], "success")
        meta = json.loads((run / run_registry.RUN_META_NAME).read_bytes())
        self.assertEqual(run_registry.resolve_user_path(meta["artifact_dir"]), self.external)
        offline.rename(self.external)
        self.assertEqual(history.scan_history(refresh=True), [])
        self.assertTrue((state / "pytorch_model.bin").is_file())

    def test_opening_relocated_history_before_deleting_keeps_its_original_source(self):
        run = self.output / "relocated"
        self._write_config(run / "config.toml", self.external)
        self._write_config(self.autosave / "first.toml", self.external)
        self._write_config(self.autosave / "second.toml", self.external)
        local_weights = run / "demo.safetensors"
        local_weights.write_bytes(b"keep")
        offline = self.external.with_name("offline")
        self.external.rename(offline)
        rows = history.scan_history(refresh=True)
        self.assertEqual([Path(row["artifact_dir"]) for row in rows], [run])
        self.assertTrue(run_registry.mark_run_deleted(run))
        offline.rename(self.external)
        self.assertEqual(history.scan_history(refresh=True), [])
        self.assertEqual(local_weights.read_bytes(), b"keep")

    def test_old_tombstone_with_a_local_path_excludes_all_autosaves_for_its_source(self):
        autosave = self.autosave / "old.toml"
        self._write_config(autosave, self.external)
        run = self.make_run(autosave_file=autosave)
        self.assertTrue(run_registry.mark_run_deleted(run))
        marker = run / run_registry.RUN_META_NAME
        old = json.loads(marker.read_bytes())
        old["artifact_dir"] = "output/demo"
        marker.write_text(json.dumps(old), encoding="utf-8")
        self._write_config(self.autosave / "same-output.toml", self.external)
        other = self.external / "another-run"
        other.mkdir()
        self._write_config(self.autosave / "other.toml", other, "other")
        self.assertEqual(run_registry.import_legacy_external_runs()["imported"], 1)
        self.assertEqual([row["name"] for row in history.scan_history()], ["other"])

    def test_reuse_restores_moved_prompt_snapshot_and_prefers_live_yaml_source(self):
        from backend.training.config.training_config import build_training_config, write_training_config
        from backend.training.preview.prompt_file import read_prompt_entries

        run = self.make_run(extra={"profile_id": "moss-image-lora"})
        previous = self.root / "old-machine" / "demo"
        config = run / "config.toml"
        with config.open("a", encoding="utf-8") as stream:
            stream.write(f'logging_dir = "{previous.as_posix()}/log"\nsample_at_first = true\n'
                         f'sample_prompts = "{previous.as_posix()}/prompts.json"\n')
        copy = run / "prompts.json"
        copy.write_text('["archived prompt"]')

        def reuse():
            return asyncio.run(routes.get_config_from_run("output/demo"))["data"]

        native = reuse()
        self.assertEqual(native["params"]["sample_prompts"], (previous / copy.name).as_posix())
        self.assertEqual(read_prompt_entries(Path(native["reuse_params"]["sample_prompts"])), ["archived prompt"])
        source = self.root / "config" / "live-prompts.txt"
        relative = r"config\live-prompts.txt"
        for key in ("sample_prompts", "prompt_file"):
            document = build_training_config({key: relative, "enable_preview": True}, profile_id="moss-image-lora")
            write_training_config(run / "training.yaml", document)
            source.write_text("updated prompts")
            self.assertEqual(reuse()["reuse_params"][key], relative)
            source.unlink()
            self.assertEqual(reuse()["reuse_params"][key], str(copy))

        # A user's unrelated file with the same basename is not a run snapshot.
        config.write_text(f'sample_prompts = "{source.as_posix()}"\n', encoding="utf-8")
        self.assertEqual(reuse()["reuse_params"]["prompt_file"], relative)

        (run / "training.yaml").unlink()
        config.write_text(f'logging_dir = "{previous.as_posix()}/log"\ncache_text_encoder_outputs = true\n'
                          f'sample_prompts = "{previous.as_posix()}/log/.run-control/manual-preview.json"\n')
        regenerated = reuse()["reuse_params"]
        self.assertFalse(regenerated["enable_preview"])
        self.assertNotIn("sample_prompts", regenerated)

    def test_imported_external_history_copies_only_its_own_json_prompts(self):
        for name, owned in (("cached", True), ("live", False)):
            artifact = self.external / name
            artifact.mkdir()
            self._write_config(self.autosave / f"{name}.toml", artifact, name)
            prompt = f"/previous/{name}/prompts.json" if owned else "/user/prompts.json"
            with (self.autosave / f"{name}.toml").open("a", encoding="utf-8") as config:
                config.write(f'sample_prompts = "{prompt}"\nlogging_dir = "/previous/{name}/log"\n'
                             'network_module = "networks.lora_generic"\n')
            (artifact / "prompts.json").write_text('["archived"]')
        self.assertEqual(run_registry.import_legacy_external_runs()["imported"], 2)
        self.assertTrue((self.output / "cached" / "prompts.json").is_file())
        self.assertFalse((self.output / "live" / "prompts.json").exists())
        (self.output / "cached" / "prompts.json").unlink()  # Already imported by an earlier version.
        reused = asyncio.run(routes.get_config_from_run("output/cached"))["data"]["reuse_params"]
        self.assertEqual(Path(reused["sample_prompts"]), self.external / "cached" / "prompts.json")
