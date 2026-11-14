import os
import builtins
import ctypes
import json
from multiprocessing import Value
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from backend.monitor.artifacts import newest_previews
from backend.training.preview import metadata


class SampleMetadataCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.prompt_file = self.root / "prompts.txt"
        self.prompt_file.write_text("portrait", encoding="utf-8")
        self.args = SimpleNamespace(output_dir=str(self.root), sample_prompts=str(self.prompt_file),
                                    sample_at_first=True, sample_every_n_steps=200, sample_every_n_epochs=None)
        self.accelerator = SimpleNamespace(process_index=0, num_processes=1)
        original_save = Image.Image.save
        self.addCleanup(setattr, Image.Image, "save", original_save)
        self.environment = patch.dict(os.environ, {"ANIMA_PREVIEW_LORAS_CONFIG": "", "ANIMA_SAMPLE_SESSION": "1000000", "ANIMA_TASK_ID": "test"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.counter_patch = patch.dict(metadata._COUNTERS, {}, clear=True)
        self.counter_patch.start()
        self.addCleanup(self.counter_patch.stop)

    def fake_native(self, *, architecture="anima", skip_second=False, pnginfo=None, before_save=None):
        prompts = [{"prompt": "portrait", "negative_prompt": "blur", "enum": index, "seed": 42 + index} for index in range(2)]
        loader = SimpleNamespace(load_prompts=lambda *a, **k: prompts)
        metadata._patch_save_and_loader(Image, loader)

        def do_sample(height, width, seed, dit, crossattn_emb, steps, dtype, device,
                      guidance_scale=1.0, flow_shift=3.0, neg_crossattn_emb=None):
            return "latents"

        def generate_latents(dit, prompt_embeds, prompt_mask, negative_embeds, negative_mask,
                             height, width, steps, guidance_scale, flow_shift, uncond_skip_layers,
                             seed, device, show_progress=True):
            return "latents"

        kernel = metadata._wrap_kernel(do_sample if architecture == "anima" else generate_latents, architecture)

        def image_inference(args, save_dir, prompt_dict, epoch, steps, prompt_replacement=None):
            if skip_second and prompt_dict["enum"] == 1:
                return
            if architecture == "anima":
                kernel(80, 64, prompt_dict["seed"], None, None, 12, None, None, 9.0, 3.5, None)
            else:
                kernel(None, None, None, None, None, 80, 64, 12, 9.0, 5.5, [22], prompt_dict["seed"], None)
            if before_save is not None:
                before_save(prompt_dict)
            output = Path(save_dir) / f"demo_{steps:06d}_{prompt_dict['enum']:02d}_20261114090000_{prompt_dict['seed']}.png"
            Image.new("RGB", (64, 80)).save(output, **({"pnginfo": pnginfo} if pnginfo is not None else {}))

        inference = metadata._wrap_image(image_inference, architecture)

        def sample_images(accelerator, args, epoch, steps):
            save_dir = self.root / "sample"
            save_dir.mkdir(exist_ok=True)
            for prompt in loader.load_prompts(args.sample_prompts)[accelerator.process_index::accelerator.num_processes]:
                inference(args, save_dir, prompt, epoch, steps)
            return "success"

        return metadata._wrap_batch(sample_images, architecture)

    def previews(self):
        return newest_previews(str(self.root), force_refresh=True)

    def in_training_frame(self, architecture, callback, *, epoch=3, step=200, path=None, name=None,
                          frame_args=None, frame_accelerator=None, source=None):
        _, default_name, default_path = metadata._TRAINING_FRAMES[architecture]
        name = name or default_name
        namespace = {}
        exec(compile(f"def {name}(args, accelerator, current_epoch, global_step, callback):\n    return callback()\n",
                     str(path or default_path), "exec"), namespace)
        return namespace[name](frame_args if frame_args is not None else self.args,
                               frame_accelerator if frame_accelerator is not None else self.accelerator,
                               source if source is not None else Value("i", epoch), step, callback)

    def test_step_capture_observes_actual_sd_script_epoch_without_changing_sampler_args(self):
        sampler = self.fake_native()
        self.assertEqual(self.in_training_frame("anima", lambda: sampler(self.accelerator, self.args, None, 200)), "success")
        samples = [item["sample"] for item in self.previews()]
        self.assertEqual({(sample["stage_kind"], sample["stage_value"], sample["epoch"], sample["batch_label"]) for sample in samples},
                         {("step", 200, 3, "Epoch 3 · Step 200")})
        self.assertEqual({sample["batch_status"] for sample in samples}, {"complete"})
        manifest = next((self.root / "sample" / ".anima-preview" / "batches").glob("*.json"))
        import json
        batch = json.loads(manifest.read_text(encoding="utf-8"))["batch"]
        self.assertIsNone(batch["epoch"], "the sampler's step-trigger argument is preserved")
        self.assertEqual(batch["current_epoch"], 3)

    def test_all_supported_trainers_read_their_matching_shared_epoch(self):
        for architecture in ("anima", "moss_image", "krea2"):
            with self.subTest(architecture=architecture):
                observed = self.in_training_frame(architecture, lambda: metadata._current_training_epoch(self.args, self.accelerator, 200, architecture))
                self.assertEqual(observed, 3)

    def test_epoch_probe_requires_same_process_arguments_and_step(self):
        probe = lambda: metadata._current_training_epoch(self.args, self.accelerator, 200, "anima")
        self.assertIsNone(probe(), "an unrelated caller must not invent an epoch")
        self.assertIsNone(self.in_training_frame("anima", probe, frame_args=SimpleNamespace()))
        self.assertIsNone(self.in_training_frame("anima", probe, frame_accelerator=SimpleNamespace()))
        self.assertIsNone(self.in_training_frame("anima", probe, step=201))
        self.assertIsNone(self.in_training_frame("anima", probe, source=SimpleNamespace(value=3)))
        self.assertIsNone(self.in_training_frame("anima", probe, path=self.root / "train_network.py"))
        self.assertIsNone(self.in_training_frame("anima", probe, name="other_train"))

    def test_epoch_probe_handles_pre_loop_resume_and_bad_epoch_values(self):
        for source in (Value("i", 0), Value("i", -1), Value("d", 3.0), Value(ctypes.c_bool, True)):
            with self.subTest(source=source):
                observed = self.in_training_frame("anima", lambda: metadata._current_training_epoch(self.args, self.accelerator, 200, "anima"), source=source)
                self.assertIsNone(observed)
        self.assertIsNone(self.in_training_frame("anima", lambda: metadata._current_training_epoch(self.args, self.accelerator, 0, "anima"), step=0))

        class BrokenEpoch(metadata.SynchronizedBase):
            def __init__(self):
                pass

            @property
            def value(self):
                raise RuntimeError("shared counter unavailable")

        self.assertIsNone(self.in_training_frame("anima", lambda: metadata._current_training_epoch(self.args, self.accelerator, 200, "anima"), source=BrokenEpoch()))

    def test_krea_step_wrapper_preserves_trigger_and_reads_current_epoch(self):
        observed = []

        def sample_images(self, accelerator, args, epoch, steps, sample_parameters):
            observed.append(dict(metadata._BATCH.get()["batch"]))
            return "success"

        sampler = metadata._wrap_batch(sample_images, "krea2")
        result = self.in_training_frame("krea2", lambda: sampler(SimpleNamespace(), self.accelerator, self.args, None, 200, [{}]))
        self.assertEqual(result, "success")
        self.assertIsNone(observed[0]["epoch"])
        self.assertEqual((observed[0]["current_epoch"], observed[0]["step"]), (3, 200))

    def test_first_sample_does_not_read_live_epoch_context(self):
        observed = []

        def sample_images(accelerator, args, epoch, steps):
            observed.append(dict(metadata._BATCH.get()["batch"]))
            return "success"

        sampler = metadata._wrap_batch(sample_images, "anima")
        self.assertEqual(self.in_training_frame("anima", lambda: sampler(self.accelerator, self.args, 0, 0), step=0), "success")
        self.assertEqual(observed[0]["epoch"], 0)
        self.assertIsNone(observed[0]["current_epoch"])

    def test_native_capture_uses_effective_cfg_flow_and_saved_dimensions(self):
        for architecture in ("anima", "moss_image"):
            with self.subTest(architecture=architecture):
                sampler = self.fake_native(architecture=architecture)
                self.assertEqual(sampler(self.accelerator, self.args, None, 200), "success")
                samples = self.previews()
                self.assertEqual(len(samples), 2)
                recorded = samples[0]["sample"]
                self.assertTrue(recorded["comparable"])
                self.assertEqual(recorded["params"]["cfg_scale"], 1.0)  # no negative embeddings
                self.assertEqual(recorded["params"]["flow_shift"], 3.5 if architecture == "anima" else 5.5)
                self.assertEqual((recorded["params"]["width"], recorded["params"]["height"]), (64, 80))
                self.assertEqual(recorded["batch_expected"], 2)
                self.assertEqual(recorded["batch_status"], "complete")
                for sample in samples:
                    with Image.open(self.root / sample["path"]) as png:
                        parameters = json.loads(png.info["parameters"])
                        embedded = json.loads(png.info["anima_sample"])
                    self.assertEqual(parameters, sample["sample"]["params"])
                    self.assertEqual(embedded["schema_version"], metadata.SCHEMA_VERSION)
                    self.assertEqual(embedded["params"], parameters)
                    self.assertEqual(embedded["prompt_index"], sample["sample"]["prompt_index"])
                    self.assertTrue(embedded["params_complete"])
                    self.assertEqual(embedded["batch"]["step"], 200)

    def test_png_parameters_are_passed_to_the_first_and_only_save(self):
        original = Image.Image.save
        calls = []

        def save(image, fp, *args, **kwargs):
            calls.append((fp, kwargs.get("pnginfo")))
            return original(image, fp, *args, **kwargs)

        with patch.object(Image.Image, "save", save):
            sampler = self.fake_native()
            self.assertEqual(sampler(self.accelerator, self.args, None, 200), "success")
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(isinstance(info, PngInfo) for _, info in calls))

    def test_png_metadata_preserves_caller_text_without_mutating_its_pnginfo(self):
        info = PngInfo()
        info.add_text("Comment", "caller metadata")
        chunks = list(info.chunks)
        self.fake_native(pnginfo=info)(self.accelerator, self.args, None, 200)
        self.assertEqual(info.chunks, chunks)
        for sample in self.previews():
            with Image.open(self.root / sample["path"]) as png:
                self.assertEqual(png.info["Comment"], "caller metadata")
                self.assertIn("parameters", png.info)
                self.assertIn("anima_sample", png.info)

    def test_non_sample_saves_inside_and_outside_sampling_keep_the_original_metadata(self):
        from io import BytesIO

        with tempfile.TemporaryDirectory() as external:
            paths, buffers = [], []

            def before_save(prompt):
                paths.extend((self.root / "ordinary.png", self.root / "demo_000200_07_20261114090000_42.png",
                              Path(external) / f"demo_000200_{prompt['enum']:02d}_20261114090000_{prompt['seed']}.png"))
                for path in paths[-3:]:
                    Image.new("RGB", (8, 8)).save(path)
                buffer = BytesIO()
                Image.new("RGB", (8, 8)).save(buffer, format="PNG")
                buffers.append(buffer)

            self.fake_native(before_save=before_save)(self.accelerator, self.args, None, 200)
            outside = self.root / "demo_000400_00_20261114090000_42.png"
            Image.new("RGB", (8, 8)).save(outside)
            for source in [*paths, *buffers, outside]:
                with Image.open(source) as png:
                    self.assertNotIn("parameters", png.info)
                    self.assertNotIn("anima_sample", png.info)

    def test_png_metadata_preparation_failure_still_saves_image_and_sidecar(self):
        sampler = self.fake_native()
        with (patch.object(metadata, "_sample_png_info", side_effect=TypeError("unserializable metadata")),
              patch.object(metadata.logger, "warning")):
            self.assertEqual(sampler(self.accelerator, self.args, None, 200), "success")
        samples = self.previews()
        self.assertEqual(len(samples), 2)
        for sample in samples:
            self.assertTrue(sample["sample"]["comparable"])
            with Image.open(self.root / sample["path"]) as png:
                self.assertEqual(png.size, (64, 80))
                self.assertNotIn("anima_sample", png.info)

    def test_skipped_prompt_and_rank_completion_are_explicit(self):
        sampler = self.fake_native(skip_second=True)
        sampler(self.accelerator, self.args, None, 200)
        self.assertEqual(self.previews()[0]["sample"]["batch_status"], "failed")

    def test_two_ranks_share_batch_and_wait_for_all_parts(self):
        sampler = self.fake_native()
        self.accelerator.num_processes = 2
        sampler(self.accelerator, self.args, None, 200)
        self.assertEqual(self.previews()[0]["sample"]["batch_status"], "running")
        # Each actual worker starts its own counter from the same session.
        metadata._COUNTERS.clear()
        self.accelerator.process_index = 1
        sampler(self.accelerator, self.args, None, 200)
        samples = [item["sample"] for item in self.previews()]
        self.assertEqual(len({item["batch_id"] for item in samples}), 1)
        self.assertEqual({item["batch_status"] for item in samples}, {"complete"})
        self.assertEqual({item["batch_saved"] for item in samples}, {2})

    def test_skipped_call_does_not_retry_or_write_batch(self):
        calls = []

        def sampler(accelerator, args, epoch, steps):
            calls.append(steps)
            raise RuntimeError("original error")

        with self.assertRaisesRegex(RuntimeError, "original error"):
            metadata._wrap_batch(sampler, "anima")(self.accelerator, self.args, None, 1)
        self.assertEqual(calls, [1])
        self.assertFalse((self.root / "sample").exists())
        self.assertEqual(metadata._COUNTERS, {})

    def test_krea_step_and_epoch_intervals_use_its_native_or_rule(self):
        self.args.sample_every_n_epochs = 1
        self.assertTrue(metadata._sampling_due(self.args, None, 200, "krea2"))
        self.assertFalse(metadata._sampling_due(self.args, None, 200, "anima"))

    def test_metadata_io_failure_does_not_change_sampler_result(self):
        sampler = self.fake_native()
        with patch.object(metadata, "write_sample_batch", side_effect=PermissionError("read only")), patch.object(metadata.logger, "warning"):
            self.assertEqual(sampler(self.accelerator, self.args, None, 200), "success")
        self.assertEqual(len(self.previews()), 2)
        self.assertTrue(all(not item["sample"]["comparable"] for item in self.previews()))

    def test_incompatible_import_target_is_not_partially_wrapped_or_retried(self):
        target = ModuleType("library.anima_train_utils")

        def original(accelerator, args, epoch, steps):
            return "unchanged"

        target.sample_images = original
        with (patch.dict(sys.modules, {target.__name__: target}),
              patch.object(builtins, "__import__", builtins.__import__),
              patch.object(builtins, metadata._FLAG, False, create=True),
              patch.object(metadata.logger, "warning") as warning):
            metadata.install_import_hook()
            for _ in range(4):
                __import__("json")
            self.assertIs(target.sample_images, original)
            self.assertEqual(warning.call_count, 1)

    def test_krea_random_seed_is_read_from_generator(self):
        metadata._patch_save_and_loader(Image)
        parameter = {"prompt": "portrait", "negative_prompt": "", "seed": None, "enum": 0}
        self.args.turbo_dit = None
        self.args.turbo_lora = None

        def do_inference(self, accelerator, args, sample_parameter, vae, dit_dtype, transformer,
                         discrete_flow_shift, sample_steps, width, height, frame_count, generator,
                         do_classifier_free_guidance, guidance_scale, cfg_scale, image_path=None, control_video_path=None):
            return None

        inference = metadata._wrap_krea_inference(do_inference)

        def image_inference(self, accelerator, args, sample_parameter, epoch, steps):
            inference(self, accelerator, args, sample_parameter, None, None, None, 3.0, 20, 64, 80, 1,
                      SimpleNamespace(initial_seed=lambda: 123456789), True, 1.0, None)
            directory = self_test.root / "sample"
            directory.mkdir(exist_ok=True)
            Image.new("RGB", (64, 80)).save(directory / "demo_000200_00_20261114090000_000.png")

        self_test = self
        image = metadata._wrap_image(image_inference, "krea2")

        def sample_images(self, accelerator, args, epoch, steps, sample_parameters):
            image(self, accelerator, args, sample_parameters[0], epoch, steps)

        sampler = metadata._wrap_batch(sample_images, "krea2")
        sampler(SimpleNamespace(), self.accelerator, self.args, None, 200, [parameter])
        recorded = self.previews()[0]["sample"]
        self.assertTrue(recorded["comparable"])
        self.assertEqual(recorded["seed"], 123456789)
        self.assertEqual(recorded["params"]["cfg_scale"], 5.5)
        self.assertEqual(recorded["params"]["scheduler"], "krea2_raw_mu")
        with Image.open(self.root / self.previews()[0]["path"]) as png:
            parameters = json.loads(png.info["parameters"])
            self.assertEqual(parameters["seed"], 123456789)
            self.assertEqual(parameters["steps"], 20)
            self.assertEqual(parameters["cfg_scale"], 5.5)

    def test_startup_observer_does_not_import_training_dependencies(self):
        root = Path(__file__).resolve().parents[2]
        env = {**os.environ, "ANIMA_SAMPLE_METADATA": "1", "ANIMA_PREVIEW_LORAS_CONFIG": "",
               "PYTHONPATH": os.pathsep.join((str(root / "tools/python_startup"), str(root)))}
        result = subprocess.run([sys.executable, "-B", "-c", "import sys; assert 'torch' not in sys.modules; print('ok')"],
                                env=env, capture_output=True, text=True, check=True)
        self.assertIn("ok", result.stdout)
