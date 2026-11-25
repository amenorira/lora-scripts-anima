import copy
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.config.network_config import extract_network_form, validate_network_preset
from backend.training.config.training_config import TrainingConfigError
from backend.training.config.validation import validate_training_config
from backend.training.shape_preview import ShapePreviewError, inspect_network


class NetworkConfigTests(unittest.TestCase):
    def test_import_preserves_precedence_types_and_unknown_arguments(self):
        original = {
            "model_train_type": "anima-lora", "network_module": "lycoris.kohya", "lokr_factor": 4,
            "network_args": ["algo=lokr", "factor=8", "rank_dropout=0.1", "rank_dropout=0.2",
                             "use_tucker=True", "custom=a=b", "unrecognized", "preset=attn-mlp"],
            "network_args_custom": "custom=explicit\nrank_dropout=0.3\nfactor=16",
        }
        snapshot = copy.deepcopy(original)
        form = extract_network_form(original)
        self.assertEqual(original, snapshot)
        self.assertEqual(form["lokr_factor"], 4)
        self.assertEqual(form["rank_dropout"], 0.3)
        self.assertIs(form["use_tucker"], True)
        self.assertEqual(form["network_args_custom"], "custom=a=b\nunrecognized\ncustom=explicit")
        self.assertNotIn("network_args", form)
        config, _ = adapt_config(form)
        args = dict(item.split("=", 1) for item in config["network_args"])
        self.assertEqual(args["factor"], "4")
        self.assertEqual(args["custom"], "explicit")


    def test_empty_target_presets_are_rejected_at_launch_in_all_argument_forms(self):
        for preset in ("attn-only", "unet-convblock-only"):
            for setting in ({"lycoris_preset": preset}, {"network_args": [f"preset={preset}"]},
                            {"network_args_custom": f"preset={preset}"}):
                form = {"model_train_type": "anima-lora", "network_module": "lycoris.kohya", **setting}
                with self.subTest(preset=preset, setting=setting):
                    with self.assertRaisesRegex(ValueError, preset):
                        adapt_config(form)
                    with self.assertRaisesRegex(ValueError, preset):
                        validate_network_preset(form)
                    # An explicit valid control still has priority over advanced arguments.
                    adapt_config({**form, "lycoris_preset": "full"})
                    adapt_config({**form, "model_train_type": "sdxl-lora"})
            errors = validate_training_config({"model_train_type": "anima-lora", "lycoris_preset": preset})
            self.assertTrue(any("lycoris_preset" in error for error in errors))

    def test_import_and_krea2_shape_preview_emit_structured_error_codes(self):
        with self.assertRaises(TrainingConfigError) as profile_ctx:
            import_native_training_form({"model_train_type": "retired-profile"})
        self.assertEqual(profile_ctx.exception.code, "configUnknownProfile")
        self.assertEqual(profile_ctx.exception.params, {"profile": "retired-profile"})

        with self.assertRaises(TrainingConfigError) as args_ctx:
            extract_network_form({"model_train_type": "anima-lora", "network_args": 1})
        self.assertEqual(args_ctx.exception.code, "configNetworkArgsMustBeList")

        with self.assertRaises(ShapePreviewError) as preview_ctx:
            inspect_network({"model_train_type": "krea2-lora", "module_dropout": 2})
        self.assertEqual(preview_ctx.exception.code, "shapePreviewInvalidKrea2Network")
        self.assertEqual(preview_ctx.exception.params, {"fields": "module_dropout"})


if __name__ == "__main__":
    unittest.main()
