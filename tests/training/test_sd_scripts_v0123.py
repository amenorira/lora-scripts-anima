"""Release integration: persisted behavior, native args, preview parity and INT8 compilation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.fields.field_registry import FIELDS, field_applies_to_profile
from backend.training.config.moss_image import validate_model_files
from backend.training.config.option_contracts import validate_sd_option_dependencies
from backend.training.config.training_config import build_training_config, extract_training_form
from tests.training.test_moss_image import moss_config


class ReleaseConfigTests(unittest.TestCase):
    def test_recommended_and_legacy_schedules_round_trip_without_changing_behavior(self):
        self.assertEqual(moss_config()["timestep_sampling"], "truncated_logit_normal")
        for profile, module in (("anima-lora", "networks.lora_anima"),
                                ("moss-image-lora", "networks.lora_generic")):
            for sampling, weighting in (("truncated_logit_normal", "uniform"), ("sigma", "logit_normal")):
                with self.subTest(profile=profile, sampling=sampling):
                    form = moss_config(model_train_type=profile, network_module=module,
                                       timestep_sampling=sampling, weighting_scheme=weighting,
                                       timestep_cutoff=0.8, timestep_uniform_ratio=0.2,
                                       logit_mean=-0.6, logit_std=0.7,
                                       subset_timestep_offsets={"1_face": 0.3})
                    restored = extract_training_form(build_training_config(form, profile_id=profile))
                    native, warnings = adapt_config(restored)
                    self.assertFalse(warnings, warnings)
                    self.assertEqual(native["timestep_sampling"], sampling)
                    self.assertEqual(native["weighting_scheme"], weighting)
                    self.assertEqual(native["logit_mean"], -0.6)
                    self.assertEqual(restored["subset_timestep_offsets"], {"1_face": 0.3})
                    if sampling == "truncated_logit_normal":
                        self.assertEqual(native["timestep_cutoff"], 0.8)
                        self.assertEqual(native["timestep_uniform_ratio"], 0.2)
                    else:
                        self.assertNotIn("timestep_cutoff", native)
                        self.assertNotIn("timestep_uniform_ratio", native)

    def test_sparse_native_import_keeps_argparse_defaults_and_explicit_old_values(self):
        form = import_native_training_form({"network_module": "networks.lora_generic"})
        self.assertEqual(form["timestep_sampling"], "sigmoid")
        self.assertEqual(form["weighting_scheme"], "uniform")
        self.assertEqual(form["logit_mean"], 0)
        old = {"network_module": "networks.lora_generic", "timestep_sampling": "sigma",
               "weighting_scheme": "logit_normal", "logit_mean": -1.09, "logit_std": 0.95}
        restored = import_native_training_form(old)
        for key, value in old.items():
            self.assertEqual(restored[key], value)

    def test_truncation_bounds_are_checked_at_adapter_entry_and_legacy_zero_std_stays_valid(self):
        for key, values in (("timestep_cutoff", [0, -0.1, 1.1, float("nan"), True]),
                            ("timestep_uniform_ratio", [-0.1, 1.1, float("inf"), True]),
                            ("logit_std", [0, -1, float("nan"), True])):
            for value in values:
                with self.subTest(key=key, value=value):
                    config = moss_config(**{key: value})
                    self.assertTrue(any(key in error for error in validate_sd_option_dependencies(config)))
                    with self.assertRaises(ValueError):
                        adapt_config(config)
        for ratio in (0, 1):
            self.assertFalse(validate_sd_option_dependencies(moss_config(timestep_cutoff=1, timestep_uniform_ratio=ratio)))
        native, _ = adapt_config(moss_config(timestep_sampling="sigma", weighting_scheme="logit_normal", logit_std=0))
        self.assertEqual(native["logit_std"], 0)

    def test_new_controls_are_scoped_to_supported_profiles(self):
        for field in (field for field in FIELDS if field["key"] in {"timestep_cutoff", "timestep_uniform_ratio"}):
            for profile in ("anima-lora", "moss-image-lora", "sdxl-lora", "krea2-lora"):
                self.assertEqual(field_applies_to_profile(field, profile), profile in ("anima-lora", "moss-image-lora"))

    def test_quantized_fullgraph_is_allowed_and_other_conflicts_remain(self):
        import numpy as np
        from safetensors.numpy import save_file

        config = moss_config(compile=True, compile_fullgraph=True, convrot_int8=True)
        native, _ = adapt_config(config)
        self.assertTrue(native["compile_fullgraph"])
        for overrides in ({"blocks_to_swap": 2}, {"split_attn": True}, {"attn_mode": "xformers"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                adapt_config({**config, **overrides})
        with tempfile.TemporaryDirectory() as directory:
            for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
                path = Path(directory) / f"{key}.safetensors"
                save_file({"layer.comfy_quant": np.array([123, 125], dtype=np.uint8)}, str(path))
                config[key] = str(path)
            self.assertEqual(validate_model_files(config), [])
            errors = validate_model_files({**config, "base_weights": ["prior.safetensors"]})
            self.assertTrue(any("base_weights" in error for error in errors))


class UpstreamCompileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        path = Path(__file__).resolve().parents[2] / "vendor/sd-scripts/tests/test_convrot_int8.py"
        spec = importlib.util.spec_from_file_location("sd_v0123_convrot_tests", path)
        cls.upstream = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(cls.upstream)
        except ModuleNotFoundError as exc:
            if exc.name != "pytest":
                raise
            cls.upstream = None  # The production unittest suite does not require pytest.

    def test_both_trainers_accept_the_exported_sampling_arguments(self):
        from argparse import ArgumentParser
        from library.args import add_dit_training_arguments
        from library.anima_train_utils import add_anima_training_arguments
        from library.moss_image_train_utils import add_moss_image_training_arguments

        for add_model_arguments in (add_anima_training_arguments, add_moss_image_training_arguments):
            parser = ArgumentParser()
            add_dit_training_arguments(parser)
            add_model_arguments(parser)
            args = parser.parse_args(["--timestep_sampling", "truncated_logit_normal",
                                      "--timestep_cutoff", "0.8", "--timestep_uniform_ratio", "0.2",
                                      "--logit_mean", "-1.09", "--logit_std", "0.95"])
            self.assertEqual(args.timestep_cutoff, 0.8)
            self.assertEqual(args.timestep_uniform_ratio, 0.2)

    def test_quantized_moss_block_has_no_graph_breaks(self):
        if self.upstream is None:
            self.skipTest("Upstream compilation tests require optional pytest")
        self.upstream.test_moss_image_block_with_int8_projections_compiles_without_graph_breaks()
        self.upstream.test_compiled_block_aot_eager_matches_eager_forward_and_backward()

    def test_cuda_int8_fullgraph_forward_and_backward(self):
        import torch
        if self.upstream is None:
            self.skipTest("Upstream compilation tests require optional pytest")
        if not torch.cuda.is_available() or not self.upstream.kernels.HAS_TRITON:
            self.skipTest("CUDA and Triton required")
        self.upstream.test_compiled_block_inductor_cuda_matches_eager("bf16")
