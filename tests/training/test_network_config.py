import copy
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.network_config import extract_network_form, validate_network_preset
from backend.training.config.validation import validate_training_config


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

    def test_explicit_select_overrides_native_value_and_ui_only_import_keeps_advanced_text(self):
        form = extract_network_form({"network_module": "lycoris.kohya", "lycoris_algo": "lokr",
                                     "network_args": ["algo=unknown"]})
        self.assertEqual(form["lycoris_algo"], "lokr")
        original = {"network_module": "lycoris.kohya", "train_llm_adapter": False,
                    "network_args_custom": "train_llm_adapter=true"}
        self.assertEqual(extract_network_form(original), original)

    def test_moss_aliases_are_both_consumed_regardless_of_order(self):
        for args in (["train_llm_adapter=True", "train_text_embedder=False"],
                     ["train_text_embedder=True", "train_llm_adapter=False"]):
            self.assertEqual(extract_network_form({"network_args": args}, model_train_type="moss-image-lora"),
                             {"train_text_embedder": True})

    def test_component_only_loraplus_does_not_enable_the_global_default(self):
        for module in ("networks.lora_anima", "networks.loha", "networks.lokr", "lycoris.kohya"):
            with self.subTest(module=module):
                form = extract_network_form({"network_module": module, "network_args": ["loraplus_unet_lr_ratio=4"]})
                self.assertIs(form["enable_loraplus"], True)
                self.assertEqual(form["loraplus_lr_ratio"], "")
                self.assertEqual(form["loraplus_text_encoder_lr_ratio"], "")
                self.assertEqual(form["loraplus_unet_lr_ratio"], 4)

    def test_native_anima_adapter_control_does_not_leak_to_sdxl(self):
        for module in ("networks.lora_anima", "networks.loha", "networks.lokr"):
            for profile in ("anima-lora", "sdxl-lora"):
                config, _ = adapt_config({"model_train_type": profile, "network_module": module,
                                          "train_llm_adapter": True})
                args = dict(item.split("=", 1) for item in config.get("network_args", []))
                self.assertEqual(args.get("train_llm_adapter"), "true" if profile == "anima-lora" else None)
                self.assertNotIn("train_llm_adapter", config)

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

    def test_invalid_import_arguments_and_selects_fail_explicitly(self):
        for arguments in (None, "algo=lokr", [False], ["algo=unknown"], ["preset=unknown"]):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                extract_network_form({"network_module": "lycoris.kohya", "network_args": arguments})


if __name__ == "__main__":
    unittest.main()
