"""Preview math, configuration isolation, and numerical edge contracts."""
import json
from pathlib import Path
import tempfile
import unittest

import torch

from backend.training.preview.config import SAMPLERS, SCHEDULERS, prepare_config, read_config, sampling_options
from backend.training.preview.compat import check_source, PreviewCompatibilityError
from backend.training.preview.kernels import override_kernel
from backend.training.preview.schedules import build_sigmas, solver_sigmas, validate_sigmas
from backend.training.preview.solvers import sample


def velocity(x, sigma):
    return .2 * x + torch.sin(torch.as_tensor(sigma) * 3) + .1 * x.sin()


class PreviewSolverTests(unittest.TestCase):
    def test_all_options_are_finite_repeatable_and_leave_global_rng_untouched(self):
        initial = torch.ones(1, 2, 3)
        rng = torch.get_rng_state()
        for architecture in ("anima", "moss_image"):
            for scheduler in SCHEDULERS:
                if architecture == "moss_image" and scheduler == "native":
                    continue  # Native helper is exercised in real upstream subprocesses.
                for sampler in SAMPLERS:
                    for steps in (1, 2, 8):
                        with self.subTest(architecture=architecture, scheduler=scheduler, sampler=sampler, steps=steps):
                            sigmas = solver_sigmas(build_sigmas(scheduler, steps, 3, architecture), sampler, 3)
                            outputs = [sample(velocity, initial, sigmas, sampler, torch.Generator().manual_seed(42)) for _ in range(2)]
                            self.assertTrue(torch.isfinite(outputs[0]).all())
                            torch.testing.assert_close(*outputs, rtol=0, atol=0)
        self.assertTrue(torch.equal(rng, torch.get_rng_state()))

    def test_er_sde_matches_pinned_comfy_reference_across_boundary_and_stages(self):
        # Official ComfyUI b5a432157de6, same analytic velocity and supplied CPU
        # Gaussian increments (seed 42). Values cover 1st/2nd/3rd order stages.
        initial = torch.tensor([1.9415676594, -1.3424619436, -.1197318286, -.4432574213, .3207613528, -.3177544475]).reshape(1, 2, 3)
        cases = [
            (3, 1, [1.3188512325, -1.1177914143, -.2250562608, -.4529360831, .0838691592, -.3641774952]),
            (3, 2, [-.1299005747, -.7253327370, -.4908569455, -.5374275446, -1.2266576290, -.7625708580]),
            (3, 8, [.4402599633, -1.4095125198, -.3440504968, .0368333161, -.8527595401, -.1901188493]),
            (5, 1, [1.3188822269, -1.1177490950, -.2250182331, -.4528968036, .0839054137, -.3641386926]),
            (5, 2, [-.1217164993, -.5579463840, -.3802604377, -.4113587737, -1.2004472017, -.6608388424]),
            (5, 8, [.3719969988, -1.5209232569, -.3880116642, .0885889530, -.8181283474, -.2031769603]),
        ]
        for shift, steps, expected in cases:
            sigmas = solver_sigmas(build_sigmas("simple", steps, shift, "anima"), "er_sde", shift)
            actual = sample(velocity, initial, sigmas, "er_sde", torch.Generator().manual_seed(42))
            torch.testing.assert_close(actual.flatten(), torch.tensor(expected), rtol=1e-5, atol=1e-5)

    def test_deterministic_solvers_integrate_constant_velocity_and_count_calls(self):
        for sampler in ("euler", "heun", "dpmpp_2m"):
            calls = []
            sigmas = build_sigmas("simple", 8, 3, "anima")
            def constant(x, sigma):
                calls.append(sigma)
                return torch.ones_like(x) * 2
            output = sample(constant, torch.ones(2, 3), sigmas, sampler, torch.Generator())
            torch.testing.assert_close(output, torch.full((2, 3), -1.), rtol=1e-5, atol=1e-5)
            self.assertEqual(len(calls), 15 if sampler == "heun" else 8)

    def test_invalid_schedules_fail_before_model_evaluation(self):
        for values in ([1., 1., 0.], [1., float("nan"), 0.], [1., .5], [1.1, .5, 0.], [0.], [-1., 0.]):
            with self.assertRaises(ValueError):
                validate_sigmas(torch.tensor(values))
        for steps in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                build_sigmas("simple", steps, 3, "anima")
        for shift in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                build_sigmas("simple", 8, shift, "anima")

    def test_er_sde_remains_finite_near_flow_boundaries(self):
        for shift in (.01, 1, 100, 1e6):
            for scheduler in SCHEDULERS:
                with self.subTest(shift=shift, scheduler=scheduler):
                    sigmas = solver_sigmas(build_sigmas(scheduler, 8, shift, "anima"), "er_sde", shift)
                    output = sample(velocity, torch.ones(1, 2), sigmas, "er_sde", torch.Generator().manual_seed(4))
                    self.assertTrue(torch.isfinite(output).all())

    def test_kernel_override_restores_and_rejects_changed_upstream_contract(self):
        namespace = {}
        source = ("def do_sample(height,width,seed,dit,crossattn_emb,steps,dtype,device,guidance_scale=1.,flow_shift=3.,neg_crossattn_emb=None):\n    pass\n"
                  "def sample_images(accelerator,args,epoch,steps,dit,vae,text_encoder,tokenize_strategy,text_encoding_strategy):\n    pass\n"
                  "def _sample_image_inference():\n    do_sample()\n")
        exec(source, namespace)
        original = namespace["do_sample"]
        options = sampling_options("heun", "simple")
        with self.assertRaisesRegex(ValueError, "injected"):
            with override_kernel(namespace["sample_images"], "anima", options):
                self.assertIsNot(namespace["do_sample"], original)
                raise ValueError("injected")
        self.assertIs(namespace["do_sample"], original)
        namespace["do_sample"] = changed = lambda changed: None
        with self.assertRaises(PreviewCompatibilityError):
            with override_kernel(namespace["sample_images"], "anima", options):
                self.fail("changed kernel must not run")
        self.assertIs(namespace["do_sample"], changed)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "vendor/sd-scripts/library/anima_train_utils.py"
            path.parent.mkdir(parents=True)
            path.write_text(source.replace("do_sample()", "renamed_sample()"), encoding="utf-8")
            check_source("anima", folder)
            with self.assertRaises(PreviewCompatibilityError):
                check_source("anima", folder, custom_sampling=True)

    def test_sampling_without_external_loras_is_enabled_and_ui_only(self):
        from backend.training.config.adapter import adapt_config
        from backend.training.config.training_config import build_training_config, extract_training_form, TrainingConfigError
        from backend.training.config.config_import import import_native_training_form

        for profile in ("anima-lora", "moss-image-lora"):
            form = {"model_train_type": profile, "enable_preview": True, "preview_sampler": "er_sde", "preview_scheduler": "beta57"}
            document = prepare_config(form, profile)
            self.assertEqual(document["loras"], [])
            self.assertEqual(document["sampler"], "er_sde")
            check_source(document["architecture"], custom_sampling=True)
            restored = extract_training_form(build_training_config(form, profile_id=profile))
            self.assertEqual(restored["preview_scheduler"], "beta57")
            native, _ = adapt_config(form)
            self.assertNotIn("preview_sampler", native)
            self.assertNotIn("preview_scheduler", native)
            self.assertIsNone(prepare_config({**form, "enable_preview": False}, profile))
            self.assertIsNone(prepare_config({**form, "preview_sampler": "euler", "preview_scheduler": "native"}, profile))
            for key in ("preview_sampler", "preview_scheduler"):
                invalid = {**form, key: "unknown"}
                with self.assertRaises(ValueError):
                    prepare_config(invalid, profile)
                with self.assertRaises(TrainingConfigError):
                    extract_training_form(build_training_config(invalid, profile_id=profile))
                with self.assertRaises(ValueError):
                    import_native_training_form(invalid)

    def test_legacy_runtime_configuration_keeps_native_euler(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "preview.json"
            path.write_text(json.dumps({"schema_version": 1, "architecture": "anima", "loras": []}), encoding="utf-8")
            document = read_config(path)
        self.assertEqual(sampling_options(document["sampler"], document["scheduler"]), {"sampler": "euler", "scheduler": "native"})
