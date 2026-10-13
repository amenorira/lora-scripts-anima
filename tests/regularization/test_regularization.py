"""Generation and numerical contracts using the existing unittest runner."""
import math
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image

from backend.regularization import planning, sampling, service, storage, worker
from backend.tasks import TaskManager


class FakeRunner:
    def __init__(self, settings, report, check):
        self.check = check
    def generate(self, item):
        self.check()
        return Image.new("RGB", (item["width"], item["height"]), "red")


class GenerationTests(unittest.TestCase):
    def test_sdxl_rejects_flow_options_and_anima_block_swap(self):
        for extra in ({"scheduler": "flux2"}, {"sampler": "er_sde"},
                      {"sampler": "euler_a", "scheduler": "karras"},
                      {"memory_mode": "manual", "blocks_to_swap": 2}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                planning.Settings(model_type="sdxl", **{"scheduler": "normal", **extra})

    def test_sdxl_scheduler_runs_supported_combinations(self):
        from backend.regularization.sdxl import create_scheduler
        for sampler in ("euler", "euler_a", "heun", "dpmpp_2m", "dpmpp_2m_sde"):
            for schedule in (("normal",) if sampler == "euler_a" else ("normal", "karras", "exponential")):
                with self.subTest(sampler=sampler, schedule=schedule):
                    scheduler = create_scheduler({"sampler": sampler, "scheduler": schedule})
                    scheduler.set_timesteps(4)
                    latent = torch.ones(1, 4, 8, 8) * scheduler.init_noise_sigma
                    for timestep in scheduler.timesteps:
                        scheduler.scale_model_input(latent, timestep)
                        latent = scheduler.step(torch.zeros_like(latent), timestep, latent).prev_sample
                    self.assertTrue(torch.isfinite(latent).all())

    def test_worker_dispatches_sdxl_and_writes_matching_metadata(self):
        root, manifest = self.stored_run(status="pending")
        manifest["settings"]["model_type"] = "sdxl"
        storage.save_manifest(root, manifest)
        with patch("backend.regularization.sdxl.SdxlRunner", FakeRunner):
            self.assertEqual(worker.run(root), 0)
        with Image.open(storage.item_path(root, manifest["items"][0])) as image:
            self.assertIn("Model type: SDXL", image.info["parameters"])
            self.assertNotIn("Flow shift", image.info["parameters"])
        self.assertEqual(storage.read_manifest(root)["runtime"]["vae_implementation"], "sdxl")

    def test_automatic_offload_reserves_workspace_and_keeps_two_blocks(self):
        model = torch.nn.Module()
        model.blocks = torch.nn.ModuleList([torch.nn.Linear(8, 8, bias=False) for _ in range(6)])
        block_size = worker.module_bytes(model.blocks[0])
        total = worker.module_bytes(model)
        self.assertEqual(worker.automatic_swap_count(model, total + 100, 100), 0)
        self.assertEqual(worker.automatic_swap_count(model, total + 99, 100), 1)
        self.assertEqual(worker.automatic_swap_count(model, total - block_size + 99, 100), 2)
        self.assertEqual(worker.automatic_swap_count(model, 0, 100), 4)
        self.assertEqual(planning.Settings().memory_mode, "auto")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "chara"
        subset = self.source / "2_face"
        subset.mkdir(parents=True)
        Image.new("RGB", (64, 96), "white").save(subset / "a.png")
        self.caption_path = subset / "a.txt"
        self.caption_path.write_text("trigger, Blue_Hair, 多词 标签, masterpiece\nignored line", encoding="utf-8")
        models = {}
        for key in ("dit", "text_encoder", "vae"):
            path = self.root / f"{key}.safetensors"
            path.write_bytes(b"model")
            models[key] = str(path)
        self.settings = dict(source_dir=str(self.source), **models, size_mode="fixed", width=64, height=64)
        for module, key, value in [(storage, "OUTPUT_ROOT", self.root / "output"), (service, "tm", TaskManager()),
                                   (service, "_plans", {}), (service, "_tasks", {}), (service, "_recovery_started", False)]:
            mocked = patch.object(module, key, value)
            mocked.start(); self.addCleanup(mocked.stop)

    def stored_run(self, status="completed", quantity=1, source_names=False):
        settings = planning.Settings(**self.settings, seed=19, per_image=quantity)
        source, sources = planning.scan(settings)
        config, fingerprint = planning.identity(settings, source, sources)
        root = storage.run_path("reg_chara")
        root.mkdir(parents=True)
        items = planning.make_items(sources, 19)
        for item in items:
            item["status"] = status
            if not source_names:
                item.pop("filename")  # Existing manifests used sequential names.
        manifest = dict(task_id="old", run_key=root.name, fingerprint=fingerprint, settings=config, sources=sources,
                        items=items, master_seed=19, status="finished", updated_at=1)
        if status == "completed":
            (root / "1_reg").mkdir()
            for item in items:
                Image.new("RGB", (64, 64), "white").save(storage.item_path(root, item))
                storage.atomic_write(storage.item_path(root, item, ".txt"), item["caption"].encode())
        storage.save_manifest(root, manifest)
        return root, manifest

    def test_caption_rules(self):
        examples = [("trigger, blue_hair, blue hairpin, 中文 多词, quality", 1, "BLUE HAIR", "blue hairpin, 中文 多词, quality"),
                    ("one natural language caption", 0, "natural", "one natural language caption"),
                    ("one natural language caption", 1, "", ""), (" , a, , b , c ", 1, "C", "b")]
        for caption, ignore, exclude, expected in examples:
            with self.subTest(caption=caption):
                self.assertEqual(planning.clean_caption(caption, ignore, exclude), expected)

    def test_added_sources_extend_existing_run_without_touching_completed_pairs(self):
        root, old = self.stored_run(source_names=True)
        original = (root / "1_reg/a.png").read_bytes()
        # A new, earlier-sorting source with the same stem must not rename a.png.
        subset = self.source / "1_new"
        subset.mkdir()
        Image.new("RGB", (64, 64)).save(subset / "a.jpg")
        (subset / "a.txt").write_text("new caption")
        body = {"settings": old["settings"]}
        plan = service.preview(body)
        self.assertEqual((plan["run_key"], plan["completed"], plan["pending"]), (root.name, 1, 1))
        def launch(task, output, manifest):
            storage.save_manifest(output, manifest)
            service.tm.release_reserved(task)
            return manifest
        with patch.object(service, "_launch", launch):
            manifest = service.start(plan["token"])
        self.assertEqual(manifest["items"][0], old["items"][0])
        self.assertEqual(manifest["items"][1]["filename"], "a_001.png")
        worker.run(root, FakeRunner)
        self.assertEqual((root / "1_reg/a.png").read_bytes(), original)
        self.assertEqual(service.preview(body)["pending"], 0)
        self.assertNotEqual(service.preview(dict(body, new_round=True))["run_key"], root.name)

    def test_same_folder_name_at_different_absolute_paths_does_not_reuse_run(self):
        import shutil
        root, old = self.stored_run()
        other = self.root / "another_dataset" / self.source.name
        shutil.copytree(self.source, other)
        settings = dict(old["settings"], source_dir=str(other))
        for add_image in (False, True):
            with self.subTest(add_image=add_image):
                if add_image:
                    subset = other / "2_face"
                    Image.new("RGB", (64, 64)).save(subset / "b.png")
                    (subset / "b.txt").write_text("new caption")
                plan = service.preview({"settings": settings})
                self.assertNotEqual(plan["run_key"], root.name)
                self.assertFalse(plan["resume"])
                self.assertEqual(plan["completed"], 0)
                self.assertEqual(plan["pending"], 2 if add_image else 1)

    def test_additions_do_not_reuse_changed_settings_models_or_sources(self):
        root, old = self.stored_run()
        Image.new("RGB", (64, 64)).save(self.caption_path.with_name("b.png"))
        self.caption_path.with_name("b.txt").write_text("new caption")
        settings = old["settings"]
        self.assertNotEqual(service.preview({"settings": dict(settings, steps=33)})["run_key"], root.name)
        self.caption_path.write_text("changed caption")
        self.assertNotEqual(service.preview({"settings": settings})["run_key"], root.name)
        self.caption_path.write_text("trigger, Blue_Hair, 多词 标签, masterpiece\nignored line", encoding="utf-8")
        Path(settings["dit"]).write_bytes(b"changed model")
        self.assertNotEqual(service.preview({"settings": settings})["run_key"], root.name)

    def test_scan_preserves_source_and_generation_only_prefix(self):
        before = self.caption_path.read_bytes()
        settings = planning.Settings(**self.settings, ignore_first=1, exclude_tags="blue hair", extra_positive="masterpiece, best quality")
        _, sources = planning.scan(settings)
        self.assertEqual(sources[0]["caption"], "多词 标签, masterpiece")
        self.assertEqual(sources[0]["prompt"], "masterpiece, best quality, 多词 标签, masterpiece")
        self.assertEqual(self.caption_path.read_bytes(), before)


    def test_repeats_and_stable_distinct_seeds(self):
        for expand, count in [(False, 3), (True, 6)]:
            _, sources = planning.scan(planning.Settings(**self.settings, per_image=3, expand_repeats=expand))
            a = planning.make_items(sources, 123)
            self.assertEqual(len(a), count)
            self.assertEqual(a, planning.make_items(sources, 123))
            self.assertEqual(len({i["seed"] for i in a}), count)

    def test_output_names_preserve_source_stems_and_avoid_collisions(self):
        _, sources = planning.scan(planning.Settings(**self.settings))
        self.assertEqual(planning.make_items(sources, 1)[0]["filename"], "a.png")
        fixtures = []
        for relative, count in [("2_face/猫.jpg", 2), ("1_body/猫.png", 1),
                                ("2_face/猫_001.webp", 1), ("1_body/A.jpg", 1), ("2_face/a.png", 1)]:
            fixtures.append(dict(sources[0], relative=relative, count=count))
        items = planning.make_items(fixtures, 1)
        names = [i["filename"] for i in items]
        self.assertEqual(names, ["猫_002.png", "猫_003.png", "猫_004.png", "猫_001.png", "A_001.png", "a_002.png"])
        self.assertEqual(len({name.casefold() for name in names}), len(names))

    def test_named_outputs_generate_exclude_regenerate_and_restore(self):
        root, _ = self.stored_run("pending", source_names=True)
        worker.run(root, FakeRunner)
        self.assertTrue((root / "1_reg/a.png").exists())
        self.assertTrue((root / "1_reg/a.txt").exists())
        def launch(task, root, manifest):
            service.tm.release_reserved(task)
            return {"task_id": task.task_id}
        with patch.object(service, "_launch", launch):
            service.mutate(root.name, 1, "regenerate")
        self.assertTrue((root / "excluded/a.png").exists())
        worker.run(root, FakeRunner)
        self.assertTrue((root / "1_reg/a_001.png").exists())
        service.mutate(root.name, 1, "restore")
        self.assertTrue((root / "1_reg/a.png").exists())
        self.assertTrue((root / "1_reg/a_001.txt").exists())

    def test_output_names_cannot_escape_result_directory(self):
        for name in ("../a.png", "..\\a.png", "C:a.png", "/tmp/a.png"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                storage.item_path(self.root, {"index": 1, "filename": name})


    def test_all_failed_and_partial_failure_have_truthful_task_status(self):
        root, manifest = self.stored_run("pending", 2)
        class Failed(FakeRunner):
            def generate(self, item):
                raise ValueError("invalid generation")
        self.assertEqual(worker.run(root, Failed), 1)
        self.assertEqual(service.summary(root)["status"], "failed")
        self.assertIn("2 failed", service.summary(root)["error"])
        class Partial(FakeRunner):
            def generate(self, item):
                if item["index"] == 2:
                    raise ValueError("invalid generation")
                return super().generate(item)
        self.assertEqual(worker.run(root, Partial), 0)
        result = service.summary(root)
        self.assertEqual((result["status"], result["completed"], result["failed"]), ("finished", 1, 1))
        self.assertIn("1 failed", result["error"])

    def test_auto_decode_offloads_and_restores_model_between_images(self):
        runner = object.__new__(worker.AnimaRunner)
        runner.settings = planning.Settings(cfg=1, steps=1).model_dump()
        runner.device, runner.dtype = "cpu", torch.float32
        runner.automatic, runner.model_offloaded = True, False
        runner.blocks_to_swap = runner.vae_bytes = 0
        runner.check = lambda: None
        runner.report = lambda *args: None
        runner.negative = runner.positive = runner.positive_prompt = None
        runner.encode = lambda prompt: torch.zeros(1)
        moves = []
        runner.model = SimpleNamespace(LATENT_CHANNELS=16, to=lambda device: moves.append(device))
        runner.vae = SimpleNamespace(to=lambda *args: None, decode_to_pixels=lambda latent: torch.zeros(1, 3, 64, 64))
        with patch.object(torch.cuda, "mem_get_info", return_value=(0, 0)), \
             patch.object(worker, "sample", return_value=torch.zeros(1, 16, 1, 8, 8)):
            for seed in (1, 2):
                runner.generate(dict(prompt="same caption", seed=seed, width=64, height=64))
        # First decode offloads; the second image restores even with cached text.
        self.assertEqual(moves, ["cpu", runner.device, "cpu"])
        self.assertTrue(runner.model_offloaded)


    def test_pair_review_is_read_only_and_repair_requires_ownership(self):
        root, manifest = self.stored_run()
        caption = root / "1_reg/reg_000001.txt"
        caption.unlink()
        service._validate_pairs(root, manifest)
        self.assertEqual(manifest["items"][0]["status"], "pending")
        self.assertTrue((root / "1_reg/reg_000001.png").exists())
        service._validate_pairs(root, manifest, repair=True)
        self.assertFalse((root / "1_reg/reg_000001.png").exists())

    def test_collision_resume_and_input_changes(self):
        root, manifest = self.stored_run()
        plan = service.preview({"settings": dict(self.settings, seed=19)})
        self.assertTrue(plan["resume"])
        self.assertEqual((plan["completed"], plan["pending"], plan["master_seed"]), (1, 0, "19"))
        fresh = service.preview({"settings": dict(self.settings, seed=19), "new_round": True})
        self.assertEqual(fresh["run_key"], "reg_chara_2")
        changed = service.preview({"settings": dict(self.settings, seed=19, extra_positive="quality")})
        self.assertEqual(changed["run_key"], "reg_chara_2")
        other = self.root / "elsewhere/chara/1_body"
        other.mkdir(parents=True)
        Image.new("RGB", (64, 64)).save(other / "b.png")
        (other / "b.txt").write_text("caption")
        same_name = service.preview({"settings": dict(self.settings, source_dir=str(other.parent))})
        self.assertEqual(same_name["run_key"], "reg_chara_2")
        self.assertEqual(storage.read_manifest(root), manifest)

    def test_directory_race_requires_second_start(self):
        plan = service.preview({"settings": self.settings})
        storage.run_path(plan["run_key"]).mkdir(parents=True)
        with self.assertRaises(service.PlanChanged) as error:
            service.start(plan["token"])
        self.assertEqual(error.exception.plan["run_key"], "reg_chara_2")
        self.assertEqual(service.tm.tasks, {})


    def test_executed_plan_uses_saved_sources_and_cannot_start_as_a_draft(self):
        root, manifest = self.stored_run("pending")
        self.caption_path.write_text("changed after start")
        plan = service.run_plan(root.name)
        sources = service.plan_items(plan["token"])["items"]
        self.assertEqual(sources, manifest["sources"])
        with self.assertRaisesRegex(ValueError, "resume"):
            service.start(plan["token"])


    def test_worker_launch_failure_is_terminal_and_releases_preparation(self):
        plan = service.preview({"settings": self.settings})
        with patch.object(service, "REPO_ROOT", self.root):
            with self.assertRaises(RuntimeError):
                service.start(plan["token"])
        manifest = storage.read_manifest(storage.run_path(plan["run_key"]))
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(service.tm.tasks, {})

    def test_old_task_id_keeps_terminal_snapshot_and_cannot_cancel_replacement(self):
        root, manifest = self.stored_run("pending")
        task = service._reserve()
        with patch.object(service, "REPO_ROOT", self.root):
            with self.assertRaises(RuntimeError):
                service._launch(task, root, manifest)
        service.tm.release_reserved(task)
        self.assertEqual(service.task_snapshot("old")["status"], "finished")
        with self.assertRaises(ValueError):
            service.cancel("old")
        self.assertFalse((root / ".cancel").exists())

    def test_generator_owns_gpu_without_becoming_a_training_task(self):
        task = service._reserve()
        self.assertEqual(service.tm.training_dump(), [])
        self.assertEqual(service.tm.dump()[0]["kind"], "regularization")
        self.assertTrue(service.tm.regularization_active())
        self.assertIsNone(service.tm.reserve_task())
        self.assertFalse(service.tm.claim_external("tagger:blocked"))
        task.terminate()
        self.assertTrue(service.tm.regularization_active())
        service.tm.release_reserved(task)
        self.assertFalse(service.tm.regularization_active())
        self.assertTrue(service.tm.claim_external("tagger:available"))
        service.tm.release_external("tagger:available")

        self.assertTrue(service.tm.claim_external("regularization-recovery:reg_test"))
        self.assertTrue(service.tm.regularization_active())
        self.assertIsNone(service.tm.reserve_task())
        self.assertFalse(service.tm.claim_external("tagger:blocked"))
        service.tm.release_external("regularization-recovery:reg_test")
        self.assertFalse(service.tm.regularization_active())

    def test_caption_race_requires_second_start(self):
        plan = service.preview({"settings": self.settings})
        self.caption_path.write_text("changed")
        with self.assertRaises(service.PlanChanged):
            service.start(plan["token"])
        self.assertEqual(service.tm.tasks, {})

    def test_exclude_restore_and_training_subsets(self):
        root, manifest = self.stored_run()
        from backend.training.sd_dataset_config import _dreambooth_subsets
        self.assertEqual(len(_dreambooth_subsets(root, is_reg=True)), 1)
        service.mutate(root.name, 1, "exclude")
        self.assertEqual(storage.read_manifest(root)["items"][0]["status"], "excluded")
        self.assertTrue((root / "excluded/reg_000001.png").exists())
        self.assertFalse(list((root / "1_reg").glob("*.png")))
        self.assertEqual(len(_dreambooth_subsets(root, is_reg=True)), 1)
        service.mutate(root.name, 1, "restore")
        self.assertEqual(storage.read_manifest(root)["items"][0]["seed"], manifest["items"][0]["seed"])
        self.assertTrue((root / "1_reg/reg_000001.png").exists())

    def test_existing_tag_editor_caption_changes_remain_complete(self):
        root, manifest = self.stored_run()
        (root / "1_reg/reg_000001.txt").write_text("edited caption", encoding="utf-8")
        service._validate_pairs(root, manifest)
        self.assertEqual(manifest["items"][0]["status"], "completed")
        self.assertEqual(manifest["items"][0]["caption"], "edited caption")
        self.assertEqual(manifest["items"][0]["generated_caption"], "trigger, Blue_Hair, 多词 标签, masterpiece")

    def test_gpu_and_mutation_exclusion(self):
        root, _ = self.stored_run()
        reserved = service.tm.reserve_task()
        with self.assertRaises(RuntimeError):
            service.start(service.preview({"settings": self.settings})["token"])
        with self.assertRaises(RuntimeError):
            service.mutate(root.name, 1, "regenerate")
        with self.assertRaises(RuntimeError):
            service.mutate(root.name, 1, "exclude")
        with self.assertRaises(RuntimeError):
            service.resume(root.name)
        service.tm.release_reserved(reserved)
        self.assertTrue(service.tm.claim_external("tagger"))
        with self.assertRaises(RuntimeError):
            service.start(service.preview({"settings": self.settings})["token"])
        service.tm.release_external("tagger")

    def test_restart_recovers_valid_pairs(self):
        root, manifest = self.stored_run()
        manifest.update(status="running", worker={"pid": 99999999, "created": 0})
        manifest["items"][0]["status"] = "running"
        storage.save_manifest(root, manifest)
        service.recover()
        self.assertEqual(storage.read_manifest(root)["status"], "terminated")
        self.assertEqual(service.preview({"settings": dict(self.settings, seed=19)})["completed"], 1)

    def test_worker_output_and_seed_resume(self):
        root, manifest = self.stored_run("pending")
        self.assertEqual(worker.run(root, FakeRunner), 0)
        result = storage.read_manifest(root)
        self.assertEqual(result["items"][0]["status"], "completed")
        self.assertEqual((root / "1_reg/reg_000001.txt").read_text(encoding="utf-8"), result["items"][0]["caption"])
        self.assertEqual(result["items"][0]["seed"], manifest["items"][0]["seed"])

    def test_ordinary_failure_continues_and_oom_preserves_completed(self):
        root, manifest = self.stored_run("pending", 3)
        class Failing(FakeRunner):
            def generate(self, item):
                if item["index"] == 2:
                    raise RuntimeError("ordinary")
                return super().generate(item)
        worker.run(root, Failing)
        self.assertEqual([i["status"] for i in storage.read_manifest(root)["items"]], ["completed", "failed", "completed"])
        manifest["items"][0]["status"] = "completed"
        storage.save_manifest(root, manifest)
        class OOM(FakeRunner):
            def generate(self, item):
                raise torch.cuda.OutOfMemoryError("OOM")
        self.assertEqual(worker.run(root, OOM), 1)
        result = storage.read_manifest(root)
        self.assertEqual(result["status"], "failed")
        self.assertEqual([i["status"] for i in result["items"]], ["completed", "pending", "pending"])

    def test_cooperative_cancel_retains_seed(self):
        root, manifest = self.stored_run("pending")
        (root / ".cancel").write_text("stop")
        worker.run(root, FakeRunner)
        result = storage.read_manifest(root)
        self.assertEqual(result["status"], "terminated")
        self.assertEqual(result["items"][0]["seed"], manifest["items"][0]["seed"])

    def test_failed_retry_selection_and_half_pair(self):
        root, manifest = self.stored_run("pending", 3)
        manifest["items"][0]["status"] = "failed"
        manifest["selection"] = [1]
        storage.save_manifest(root, manifest)
        real_write = worker.atomic_write
        def fail_txt(path, data):
            if path.suffix == ".txt":
                raise OSError("disk full")
            real_write(path, data)
        with patch.object(worker, "atomic_write", fail_txt):
            worker.run(root, FakeRunner)
        self.assertEqual([i["status"] for i in storage.read_manifest(root)["items"]], ["failed", "pending", "pending"])
        self.assertFalse((root / "1_reg/reg_000001.png").exists())
        worker.run(root, FakeRunner)
        self.assertEqual([i["status"] for i in storage.read_manifest(root)["items"]], ["completed", "pending", "pending"])


class SamplingTests(unittest.TestCase):
    def test_all_supported_combinations_and_reproducibility(self):
        fields = planning.metadata()["fields"]
        for sampler in fields["sampler"]["enum"]:
            for scheduler in fields["scheduler"]["enum"]:
                with self.subTest(sampler=sampler, scheduler=scheduler):
                    sigmas = sampling.schedule(scheduler, 8, 512, 768)
                    sigmas = sampling.sampling_sigmas(sigmas, sampler)
                    clean, noise = torch.tensor([.7, -.3]), torch.tensor([1.2, -2.])
                    velocity = lambda x, t: (x - clean) / t
                    a = sampling.sample(velocity, noise, sigmas, sampler, torch.Generator().manual_seed(1))
                    b = sampling.sample(velocity, noise, sigmas, sampler, torch.Generator().manual_seed(1))
                    self.assertTrue(torch.allclose(a, clean, atol=1e-6))
                    self.assertTrue(torch.equal(a, b))


    def test_dpmpp_sde_against_diffusers_flow_solver(self):
        from diffusers import DPMSolverMultistepScheduler

        sigmas = sampling.sampling_sigmas(sampling.schedule("beta", 12, 512, 512), "dpmpp_2m_sde")
        reference = DPMSolverMultistepScheduler(prediction_type="flow_prediction", use_flow_sigmas=True,
                                               algorithm_type="sde-dpmsolver++", solver_order=2,
                                               solver_type="midpoint", lower_order_final=False)
        reference.set_timesteps(len(sigmas) - 1)
        # Supply identical noise levels and Gaussian increments to isolate the solver.
        reference.sigmas = sigmas
        generator = torch.Generator().manual_seed(17)
        initial = torch.tensor([.4, -.6, 1.2])
        velocity = lambda x, t: .2 * x + math.sin(t)
        expected = initial.clone()
        for index, timestep in enumerate(reference.timesteps):
            expected = reference.step(velocity(expected, float(sigmas[index])), timestep, expected,
                                      variance_noise=torch.randn(initial.shape, generator=generator)).prev_sample
        actual = sampling.sample(velocity, initial, sigmas, "dpmpp_2m_sde", torch.Generator().manual_seed(17))
        torch.testing.assert_close(actual, expected, atol=2e-6, rtol=2e-6)

    def test_ancestral_signal_and_noise_variance(self):
        generator = torch.Generator().manual_seed(11)
        clean, t, q = 2., .8, .4
        x = (1-t)*clean + t*torch.randn(100000, generator=generator)
        result = sampling.ancestral_step(x, torch.full_like(x, clean), t, q, torch.randn(x.shape, generator=generator))
        self.assertLess(abs(float(result.mean()) - (1-q)*clean), .005)
        self.assertLess(abs(float(result.var()) - q*q), .005)

    def test_er_coefficients_against_independent_integrator(self):
        from scipy.integrate import quad
        current, following = 3., .7
        phi = lambda s: s*(math.exp(s**.3)+10)
        ratio, first, second = sampling.er_coefficients(current, following)
        expected_first = following-current + phi(following)*quad(lambda s: 1/phi(s), following, current)[0]
        expected_second = (following-current)**2/2 + phi(following)*quad(lambda s: (s-current)/phi(s), following, current)[0]
        self.assertAlmostEqual(ratio, phi(following)/phi(current), places=10)
        self.assertAlmostEqual(first, expected_first, places=10)
        self.assertAlmostEqual(second, expected_second, places=10)

    def test_er_sde_flow_marginals(self):
        trajectory, clean = [], 1.5
        def velocity(x, t):
            trajectory.append((t, x.clone()))
            return (x-clean)/t
        generator = torch.Generator().manual_seed(20)
        sampling.sample(velocity, torch.randn(50000, generator=generator), sampling.schedule("linear", 8, 64, 64), "er_sde", generator)
        for t, x in trajectory[1:]:
            self.assertLess(abs(float(x.mean()) - (1-t)*clean), .012)
            self.assertLess(abs(float(x.var()) - t*t), .012)


if __name__ == "__main__":
    unittest.main()
