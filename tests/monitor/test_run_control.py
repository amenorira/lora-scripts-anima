import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path

from backend.monitor.run_control import ControlRequest, TrainingControl, read_object, saved_training_state
from backend.monitor.sample_loss import _apply_sample_events


class TrainingControlTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.manifest = {"run_id": "run", "script": "anima_train_network.py", "args": {},
                         "preview_prompts": [{"prompt": "manual", "sample_steps": 0}]}
        self.status = {"schema_version": 1, "run_id": "run", "state": "running"}
        self.control = TrainingControl(self.root, False)
        self.write_run()

    def write_run(self):
        for name, data in (("status", self.status), ("manifest", self.manifest)):
            (self.root / (name + ".json")).write_text(json.dumps(data), encoding="utf-8")
        self.control.manifest = {}

    def submit(self, action, **options):
        return self.control.submit(ControlRequest(action=action, **options), {})

    def run_trainer(self, source, filename="trainer.py"):
        project = Path(__file__).resolve().parents[2]
        trainer = self.root / filename
        trainer.write_text(textwrap.dedent(source), encoding="utf-8")
        env = {**os.environ, "ANIMA_RUN_CONTROL_DIR": str(self.root),
               "PYTHONPATH": os.pathsep.join((str(project / "vendor/sd-scripts"), str(project)))}
        result = subprocess.run([sys.executable, "-B", str(project / "backend/training/execution/sd_scripts_entry.py"),
                                 str(trainer)], env=env, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))

    def test_stop_modes_are_serialized_and_acknowledged_by_the_same_run(self):
        self.assertEqual(ControlRequest(action="stop").mode, "discard")
        for mode, save, state in (("discard", False, False), ("weights", True, False),
                                  ("state", False, True), ("both", True, True)):
            command = self.submit("stop", mode=mode)["command"]
            queue = self.root / "commands"
            self.assertEqual(read_object(queue / command["id"]), {"command": "stop", "save": save, "save_state": state})
            done = queue / "done"
            done.mkdir(exist_ok=True)
            receipt = done / command["id"]
            receipt.write_text(json.dumps({"run_id": "old", "status": "ok"}))
            with self.assertRaisesRegex(ValueError, "pending"):
                self.submit("save")
            receipt.write_text(json.dumps({"run_id": "run", "status": "ok"}))
            self.assertEqual(self.control.view()["command"]["status"], "ok")

    def test_pause_capabilities_and_cached_prompt_selection(self):
        self.manifest["args"].update(cache_text_encoder_outputs=True, blocks_to_swap=4, block_swap_h2d_only=True)
        self.write_run()
        self.assertNotIn("pause", self.control.view()["allowed"])
        self.assertTrue(self.control.view()["new_prompt"])
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.submit("sample", index=1)
        command = self.submit("sample", index=0, steps=5, seed=0)["command"]
        self.assertEqual(read_object(self.root / "commands" / command["id"]),
                         {"command": "sample", "indices": [0], "overrides": {"seed": 0, "sample_steps": 5}})
        self.status["state"] = "paused"
        self.write_run()
        self.assertEqual(self.control.view()["allowed"], ["stop", "resume"])
        self.manifest["training"] = {"num_processes": 2}
        self.write_run()
        self.assertEqual(self.control.view()["allowed"], [])

    def test_missing_receipt_reconciles_events_and_status_for_the_same_command(self):
        cmd = self.submit("save")["command"]["id"]
        log = self.root / "events.jsonl"
        event = {"event": "command_finished", "file": cmd, "status": "ok", "result": {"path": "saved"}}
        log.write_text(json.dumps(dict(event, run_id="other")) + "\n")
        self.status["last_command"] = {"file": "previous", "status": "ok"}
        self.write_run()
        with self.assertRaisesRegex(ValueError, "pending"):
            self.submit("stop")
        with log.open("a") as stream:
            stream.write(json.dumps(dict(event, run_id="run")) + "\n")
        self.assertEqual(self.control.view()["command"]["result"], {"path": "saved"})
        second = self.submit("save_state")["command"]["id"]
        self.status["last_command"] = {"file": second, "status": "ok"}
        self.write_run()
        self.assertEqual(self.control.view()["command"]["status"], "ok")
        self.assertEqual(self.submit("stop")["command"]["action"], "stop")

    def test_full_width_seeds_are_exact_in_browser_and_native_commands(self):
        seed = 2**64 - 1
        self.manifest["preview_prompts"][0]["seed"] = seed
        self.manifest["preview_defaults"] = {"seed": 2**53 + 1}
        self.write_run()
        view = self.control.view(prompts=True)
        self.assertEqual(view["prompts"][0]["seed"], str(seed))
        self.assertEqual(view["preview_defaults"]["seed"], str(2**53 + 1))
        cmd = self.submit("sample", base_index=0, prompt="edited", seed=str(-(2**63)))["command"]
        native = read_object(self.root / "commands" / cmd["id"])
        self.assertEqual(native["prompts"][0]["seed"], seed)
        self.assertEqual(native["overrides"]["seed"], -(2**63))
        self.assertEqual(ControlRequest(action="sample", seed="-1").seed, -1)
        self.assertEqual(ControlRequest(action="sample", seed=str(seed)).seed, seed)
        with self.assertRaises(ValueError):
            ControlRequest(action="sample", seed=str(seed + 1))
        with self.assertRaises(ValueError):
            ControlRequest(action="sample", seed=str(-(2**63) - 1))

    def test_read_progress_and_only_offer_existing_saved_states(self):
        self.status.update(lr={"unet": 0.001}, loss={"current": float("nan")},
                           progress={"global_step": 19, "max_train_steps": 38, "epoch": 3, "num_train_epochs": 6},
                           speed={"eta_sec": 65, "sec_per_step": 1.5},
                           last_state={"path": "/original/run/saved-state", "step": 19}, last_checkpoint={"step": 0})
        self.write_run()
        self.assertEqual(self.control.view()["progress"], {"step": 19, "total_steps": 38, "percent": 50,
                         "epoch": "3/6", "eta": "01:05", "lr": 0.001, "speed": "1.50s/it"})
        self.assertEqual(saved_training_state(self.root, self.root), {})
        self.assertEqual(self.control.view()["last_checkpoint_step"], 0)
        self.assertEqual(self.control.view()["last_state_step"], 19)
        saved = self.root / "saved-state"
        saved.mkdir()
        (saved / "train_state.json").write_text('{"current_step":19}')
        self.assertEqual(saved_training_state(self.root, self.root), {})
        from safetensors.numpy import save_file
        import torch
        save_file({}, saved / "model.safetensors")
        for name in ("optimizer.bin", "scheduler.bin"):
            torch.save({}, saved / name)
        with zipfile.ZipFile(saved / "random_states_0.pkl", "w") as rng:
            rng.writestr("archive/data.pkl", "data")
        self.assertEqual(saved_training_state(self.root, self.root), {"resume_state": str(saved), "resume_step": 19})

    def test_cached_run_can_accept_manual_text_without_preset_choices(self):
        from backend.training.execution.launch_sd_scripts import write_manual_preview_cache
        path = write_manual_preview_cache(self.root, {"sample_width": 512, "sample_seed": 0})
        self.assertEqual(json.loads(path.read_text()), [{"width": 512, "seed": 0, "prompt": "", "sample_steps": 0}])
        self.manifest.update(preview_prompts=[], args={"cache_text_encoder_outputs": True})
        self.write_run()
        self.assertNotIn("sample", self.control.view()["allowed"])
        self.manifest["manual_preview_cache"] = True
        self.write_run()
        view = self.control.view(prompts=True)
        self.assertTrue(view["new_prompt"] and view["external_encoder"])
        self.assertEqual(view["prompts"], [])
        self.assertIn("sample", view["allowed"])

    def test_artifact_notifications_consume_only_complete_lines(self):
        path = self.root / "events.jsonl"
        path.write_bytes(b'{"event":"samples_generated"}\n{"event":')
        self.assertEqual(self.control.artifact_events(), {"samples_generated"})
        self.assertEqual(self.control.artifact_events(), set())
        with path.open("ab") as stream:
            stream.write(b'"state_saved"}\nnot-json\n')
        self.assertEqual(self.control.artifact_events(), {"state_saved"})
        self.assertEqual(self.control.artifact_events(), set())
        with path.open("ab") as stream:
            stream.write(b'{"event":"command_finished","command":"sample","status":"ok"}\n')
        self.assertEqual(self.control.artifact_events(), {"samples_generated"})
        self.assertEqual(self.control.artifact_events(), set())

    def test_native_pause_reports_the_step_at_which_training_is_suspended(self):
        self.run_trainer("""
            from types import SimpleNamespace
            from library import run_control

            control = run_control.create_run_controller(SimpleNamespace(run_control=True))
            control.start({}, max_train_steps=10)
            control.on_step_end(global_step=3, loss=1.0, logs={"lr/unet": 0.0003})
            control.set_paused(True, step=4)
            from pathlib import Path
            import json
            status = json.loads((Path(control.run_dir) / "status.json").read_text())
            assert (status["state"], status["progress"]["global_step"]) == ("paused", 4)
            from backend.monitor.run_control import reported_progress
            p = reported_progress(status)
            assert (p["metrics_step"], p["loss"], p["lr"]) == (3, 1.0, 0.0003)
            control.set_paused(False, step=4)
            control.on_step_end(global_step=4, loss=0.7, logs={"lr/unet": 0.0002})
            control.finish("stopped")
            p = reported_progress(json.loads((Path(control.run_dir) / "status.json").read_text()))
            assert (p["step"], p["metrics_step"], p["loss"]) == (4, 4, 0.7)
        """)
        self.assertTrue(self.control.stopped_at_exit())

    def test_cpu_state_interrupted_during_overwrite_can_only_resume_after_successful_retry(self):
        self.run_trainer("""
            import os
            from pathlib import Path
            import torch
            from accelerate import Accelerator
            from backend.monitor.artifacts import list_output_files
            from backend.monitor.routes import _output_archive_files
            from library.optimizer import get_dummy_scheduler
            acc = Accelerator(cpu=True)
            model = torch.nn.Linear(2, 1)
            opt = torch.optim.SGD(model.parameters(), lr=0.1)
            acc.prepare(model, opt, get_dummy_scheduler(opt))
            root = Path(os.environ["ANIMA_RUN_CONTROL_DIR"]) / "outputs"
            state = root / "demo-state"
            acc.save_state(state)
            assert not (state / "scheduler.bin").exists()
            acc.load_state(state)
            assert list_output_files(str(root))[0]["resumable"]
            def interrupt(models, weights, directory):
                (Path(directory) / "train_state.json").write_text('{"current_step":42}')
                raise OSError("save interrupted")
            hook = acc.register_save_state_pre_hook(interrupt)
            try:
                acc.save_state(state)
            except OSError as error:
                assert str(error) == "save interrupted"
            item, = list_output_files(str(root))
            assert item["category"] == "state" and not item["resumable"]
            from shutil import copyfile
            extracted = root.parent / "extracted"
            for src, rel in _output_archive_files(root, [state.name]):
                dst = extracted / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                copyfile(src, dst)
            assert not list_output_files(str(extracted))[0]["resumable"]
            hook.remove()
            acc.save_state(state)
            acc.load_state(state)
            assert list_output_files(str(root))[0]["resumable"]

            acc.prepare(torch.optim.lr_scheduler.StepLR(opt, step_size=1))
            acc.save_state(state)
            acc.load_state(state)
            assert list_output_files(str(root))[0]["resumable"]
            for name in ("scheduler.bin", "optimizer.bin", "model.safetensors"):
                file = state / name
                original = file.read_bytes()
                file.unlink()
                assert not list_output_files(str(root))[0]["resumable"], name
                file.write_bytes(original[:-1])
                assert not list_output_files(str(root))[0]["resumable"], name
                file.write_bytes(bytes(len(original)))
                assert not list_output_files(str(root))[0]["resumable"], name
                file.write_bytes(original)
            from backend.training.checkpoint_state import STATE_INVENTORY
            (state / STATE_INVENTORY).unlink()
            for name in ("optimizer.bin", "model.safetensors"):
                file = state / name
                original = file.read_bytes()
                file.write_bytes(original[:24])
                assert not list_output_files(str(root))[0]["resumable"], name
                file.write_bytes(original)
            (state / "scheduler.bin").unlink()
            internal = root.parent / "separate-run-directory"
            internal.mkdir()
            from backend.monitor.run_control import saved_training_state
            import json
            (internal / "status.json").write_text(json.dumps({"last_state": {"path": str(state)}, "schema_version": 1}))
            for kind, valid in (("AdamW", False), ("AdamWScheduleFree", True)):
                (internal / "config.toml").write_text(f'optimizer_type = "{kind}"')
                assert list_output_files(str(root), internal)[0]["resumable"] == valid
                assert bool(saved_training_state(internal, root, internal)) == valid
        """)

    def test_selected_and_edited_prompts_use_complete_startup_snapshot(self):
        self.run_trainer("""
            import os
            from pathlib import Path
            from types import SimpleNamespace
            from library import run_control, sampling
            root = Path(os.environ["ANIMA_RUN_CONTROL_DIR"])
            source = root / "prompts.TXT"
            source.write_text("cat --ss euler_a --w 768\\ndog --ss ddim")
            args = SimpleNamespace(output_dir=str(root), output_name="test", sample_prompts=str(source))
            manifest = run_control.build_manifest(args)
            source.write_text("dog --ss ddim\\ncat --ss euler_a --w 768")
            assert sampling.get_sample_prompts(args)[0]["prompt"] == "dog"
            selected, = sampling.build_forced_prompts(args, indices=[0])
            assert (selected["prompt"], selected["sample_sampler"], selected["_anima_preset_index"]) == ("cat", "euler_a", 0)
            preset = manifest["preview_prompts"][0]
            edited, = sampling.build_forced_prompts(args, prompts=[{**preset, "prompt": "red cat"}])
            assert (edited["prompt"], edited["sample_sampler"], edited["width"]) == ("red cat", "euler_a", 768)
        """)

    def test_moss_live_prompt_reload_converts_flow_shift_like_native_sampling(self):
        self.run_trainer("""
            import os
            from pathlib import Path
            from library import sampling
            source = Path(os.environ["ANIMA_RUN_CONTROL_DIR"]) / "live.json"
            for shift in ("1.5", "2e0"):
                source.write_text('[{"flow_shift":"' + shift + '"}]')
                assert sampling.load_prompts(source)[0]["flow_shift"] == float(shift)
        """, filename="moss_image_train_network.py")

    def test_native_progress_and_subprocess_error_share_the_same_snapshot(self):
        from backend.monitor.live_snapshot import read_run_log_progress
        control = self.root / "log/.run-control"
        control.mkdir(parents=True)
        self.status["progress"] = {"global_step": 8, "max_train_steps": 20}
        (control / "status.json").write_text(json.dumps(self.status))
        (self.root / "train_demo.log").write_text("steps: 10%|  | 2/20\nTraceback\nRuntimeError: CUDA out of memory\n")
        progress = read_run_log_progress(self.root, 100)
        self.assertEqual((progress["step"], progress["has_error"], progress["error_msg"]), (8, True, "CUDA out of memory"))

    def test_stop_at_exit_recovers_only_the_current_runs_terminal_event(self):
        events = self.root / "events.jsonl"

        def end(run_id, state):
            return json.dumps({"run_id": run_id, "event": "run_end", "state": state}) + "\n"

        events.write_text(end("old", "stopped") + '{"run_id":')
        self.assertFalse(self.control.stopped_at_exit())
        events.write_text(end("old", "finished") + end("run", "stopped"))
        self.assertTrue(self.control.stopped_at_exit())
        (self.root / "status.json").unlink()
        self.assertTrue(self.control.stopped_at_exit())
        self.status["state"] = "finished"
        self.write_run()
        self.assertFalse(self.control.stopped_at_exit())

    def test_preview_epoch_uses_native_event_and_rejects_replaced_images(self):
        root = self.root / "log/.run-control"
        root.mkdir(parents=True)
        event = {"event": "samples_generated", "ts": 100, "step": 7, "epoch": 2, "files": ["a.png", "b.png"]}
        (root / "events.jsonl").write_text(json.dumps(event) + "\n")
        a, b = [{"path": "sample/" + name, "version": str(stamp * 10**9) + "-256",
                 "sample": {"metadata_source": "filename"}} for name, stamp in (("a.png", 99), ("b.png", 105))]
        _apply_sample_events([a, b], {"run_path": self.root, "task_id": "current"})
        self.assertEqual((a["sample"]["step"], a["sample"]["epoch"], a["sample"]["step_source"]), (7, 2, "event"))
        self.assertNotIn("step", b["sample"])

    def test_state_directories_are_grouped_and_excluded_from_model_checkpoints(self):
        from backend.monitor.artifacts import list_output_files, read_output_summary

        out = self.root / "artifacts"
        out.mkdir()
        (out / "smoke-step00000042.safetensors").write_bytes(b"lora")
        state_dir = out / "smoke-step00000042-state"
        state_dir.mkdir()
        (state_dir / "train_state.json").write_text('{"current_step": 42}', encoding="utf-8")
        (state_dir / "model.safetensors").write_bytes(b"internal-state-weights")
        (state_dir / "scaler.pt").write_bytes(b"scaler")
        (state_dir / "optimizer.bin").write_bytes(b"opt")
        (out / "config.toml").write_text("epochs = 5\n", encoding="utf-8")

        files = list_output_files(str(out))
        summary = read_output_summary(str(out))
        self.assertEqual(summary["count"], len(files))
        models = [item for item in files if item["category"] == "model"]
        states = [item for item in files if item["category"] == "state"]
        configs = [item for item in files if item["category"] == "config"]
        self.assertEqual([item["name"] for item in models], ["smoke-step00000042.safetensors"])
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]["name"], "smoke-step00000042-state")
        self.assertTrue(states[0]["is_dir"])
        self.assertFalse(states[0]["is_lora"])
        self.assertEqual(states[0]["ckpt_type"], "step")
        self.assertEqual(states[0]["ckpt_step"], 42)
        self.assertEqual(states[0]["size"], sum(p.stat().st_size for p in state_dir.iterdir()))
        self.assertEqual([item["name"] for item in configs], ["config.toml"])

    def test_accelerate_state_without_train_state_json_is_grouped(self):
        from backend.monitor.artifacts import list_output_files, read_output_summary

        state = self.root / "krea-000002-state"
        ordinary = self.root / "other-state"
        for directory in (state, ordinary):
            directory.mkdir()
            (directory / "model.safetensors").touch()
            (directory / "optimizer.bin").touch()
        (state / "random_states_0.pkl").touch()
        files = list_output_files(str(self.root))
        self.assertEqual([(item["name"], item["ckpt_epoch"]) for item in files if item["category"] == "state"],
                         [(state.name, 2)])
        self.assertEqual([model[0] for model in read_output_summary(str(self.root))["models"]],
                         ["other-state/model.safetensors"])

    def test_edited_preset_inherits_selected_preset_parameters_instead_of_first(self):
        self.manifest["preview_defaults"] = {"width": 1024, "height": 1024, "scale": 4.0, "sample_steps": 20}
        self.manifest["preview_prompts"] = [
            {"prompt": "first", "width": 1024, "height": 1024, "scale": 4.0, "seed": 11, "sample_steps": 20},
            {"prompt": "second", "width": 768, "height": 512, "scale": 5.5, "negative_prompt": "blurry",
             "seed": 77, "sample_steps": 0, "sample_sampler": "euler_a", "controlnet_image": "guide.png"},
        ]
        self.write_run()
        cmd = self.submit("sample", prompt="second edited", base_index=1, width=832, height=1216, scale=6.0)["command"]
        written = read_object(self.root / "commands" / cmd["id"])
        self.assertEqual(written["prompts"], [{
            "width": 768, "height": 512, "scale": 5.5, "sample_steps": 0, "sample_sampler": "euler_a",
            "controlnet_image": "guide.png",
            "prompt": "second edited", "negative_prompt": "blurry", "seed": 77,
        }])
        self.assertEqual(written["overrides"], {"width": 832, "height": 1216, "scale": 6.0})

    def test_manual_sample_filename_and_receipt_recover_origin_without_guessing_index(self):
        from backend.monitor.sample_metadata import _normalize, legacy_sample_metadata

        meta = legacy_sample_metadata("smoke_000041_100_20261121165001_42.png", "sample/smoke_000041_100_20261121165001_42.png")
        recorded = _normalize({"id": "old"}, {"prompt_index": 100}, "complete", 1)
        for sample in (meta, recorded):
            self.assertEqual((sample["sample_origin"], sample["prompt_index"], sample["prompt_label"]),
                             ("scheduled", 100, "Prompt 101"))

        root = self.root / "log/.run-control"
        done = root / "commands/done"
        done.mkdir(parents=True)
        (done / "1_sample.json").write_text(json.dumps({
            "status": "ok",
            "command": {"command": "sample", "indices": [6]},
            "result": {"files": ["/out/sample/smoke_000041_100_20261121165001_42.png"]},
        }), encoding="utf-8")
        (root / "events.jsonl").write_text(
            json.dumps({"event": "samples_generated", "ts": 100, "step": 41, "epoch": 2, "files": ["smoke_000041_100_20261121165001_42.png"]}) + "\n"
            + json.dumps({"event": "command_finished", "ts": 100, "step": 41, "epoch": 2, "file": "1_sample.json",
                          "command": "sample", "status": "ok", "result": {
                              "files": ["/out/sample/smoke_000041_100_20261121165001_42.png"]}}) + "\n",
            encoding="utf-8",
        )
        preview = {
            "path": "sample/smoke_000041_100_20261121165001_42.png",
            "version": str(99 * 10**9) + "-100",
            "sample": meta,
        }
        _apply_sample_events([preview], {"run_path": self.root, "task_id": "current"})
        self.assertEqual(preview["sample"]["sample_origin"], "manual")
        self.assertEqual(preview["sample"]["source_prompt_index"], 6)
        self.assertEqual(preview["sample"]["prompt_index"], 6)

        (done / "1_sample.json").unlink()
        preview["sample"] = legacy_sample_metadata(Path(preview["path"]).name, preview["path"])
        _apply_sample_events([preview], {"run_path": self.root, "task_id": "current"})
        self.assertEqual(preview["sample"]["sample_origin"], "manual")
        self.assertIsNone(preview["sample"]["prompt_index"])
        self.assertNotIn("source_prompt_index", preview["sample"])

        for append_later_event in (False, True):
            if append_later_event:
                with (root / "events.jsonl").open("a", encoding="utf-8") as stream:
                    event = {"event": "samples_generated", "ts": 103, "step": 42, "epoch": 2,
                             "files": [Path(preview["path"]).name]}
                    stream.write(json.dumps(event) + "\n")
            preview.update(version=str(102 * 10**9) + "-100", sample={"metadata_source": "filename"})
            _apply_sample_events([preview], {"run_path": self.root, "task_id": "current"})
            self.assertNotIn("source_prompt_index", preview["sample"])
            self.assertEqual(preview["sample"].get("step"), 42 if append_later_event else None)
