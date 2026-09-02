import importlib
import inspect
import json
import shutil
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

import torch

from backend.training.adapter import adapt_config
from backend.training.field_registry import get_fields_json
from backend.training.optimizer_contracts import (
    ADAFACTOR_OPTIMIZER_TYPE,
    ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
    ADAN_OPTIMIZER_TYPE,
    ADEMAMIX8BIT_OPTIMIZER_TYPE,
    ADEMAMIX_OPTIMIZER_TYPE,
    AUTOMAGIC_OPTIMIZER_TYPE,
    CAME_OPTIMIZER_TYPE,
    EMOSENS_OPTIMIZER_TYPE,
    LORA_MUON_OPTIMIZER_TYPE,
    LORARITE_OPTIMIZER_TYPE,
    MUON_OPTIMIZER_TYPE,
    PRODIGY_OPTIMIZER_TYPE,
    PRODIGYPLUS_OPTIMIZER_TYPE,
    STABLE_ADAMW_OPTIMIZER_TYPE,
)
from backend.training.optimizer_metadata import (
    KREA2_PROFILE,
    SD_SCRIPTS_PROFILE,
    optimizer_beta_hint_map,
    optimizer_beta_lengths,
    optimizer_entries,
    optimizer_groups,
)
from backend.training.validation import validate_training_config
from tests.helpers import config_from_field_defaults


def valid_config(optimizer_type: str, train_type: str = "anima-lora") -> dict:
    config = config_from_field_defaults()
    config.update(
        {
            "model_train_type": train_type,
            "network_module": (
                "networks.lora_anima" if train_type == "anima-lora" else "networks.lora"
            ),
            "pretrained_model_name_or_path": "model.safetensors",
            "vae": "vae.safetensors",
            "qwen3": "qwen3.safetensors",
            "train_data_dir": "train",
            "resolution": "1024,1024",
            "output_name": "test",
            "output_dir": "output",
            "optimizer_type": optimizer_type,
            "gradient_accumulation_steps": 1,
            "mixed_precision": "bf16",
        }
    )
    if optimizer_type in {PRODIGY_OPTIMIZER_TYPE, PRODIGYPLUS_OPTIMIZER_TYPE}:
        config["learning_rate"] = "1.0"
    return config


def fields_by_key() -> dict[str, dict]:
    return {
        field["key"]: field
        for section in get_fields_json()["sections"]
        for field in section["fields"]
    }


def auto_value_for(field: dict, optimizer_type: str) -> object:
    for rule in field.get("autoValue", []):
        if rule.get("when") == optimizer_type:
            return rule["set"]
    raise AssertionError(f"No autoValue for {field['key']} and {optimizer_type}")


def contextual_auto_value_for(
    field: dict, optimizer_type: str, train_type: str, **conditions: object
) -> object:
    expected = {
        "optimizer_type": optimizer_type,
        "model_train_type": train_type,
        **conditions,
    }
    for rule in field.get("autoValue", []):
        if rule.get("watch") == expected:
            return rule["set"]
    raise AssertionError(
        f"No contextual autoValue for {field['key']} and {expected!r}"
    )


class OptimizerFieldContractTests(unittest.TestCase):
    def test_optimizer_metadata_defines_exact_selectors_groups_and_beta_contracts(self):
        self.assertEqual(
            [entry.selector for entry in optimizer_entries(SD_SCRIPTS_PROFILE)],
            [
                "AdamW8bit",
                "AdamW",
                "PagedAdamW8bit",
                STABLE_ADAMW_OPTIMIZER_TYPE,
                CAME_OPTIMIZER_TYPE,
                ADAN_OPTIMIZER_TYPE,
                "Lion",
                "Lion8bit",
                "PagedLion8bit",
                ADEMAMIX_OPTIMIZER_TYPE,
                ADEMAMIX8BIT_OPTIMIZER_TYPE,
                PRODIGY_OPTIMIZER_TYPE,
                PRODIGYPLUS_OPTIMIZER_TYPE,
                ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                ADAFACTOR_OPTIMIZER_TYPE,
                MUON_OPTIMIZER_TYPE,
                LORA_MUON_OPTIMIZER_TYPE,
                LORARITE_OPTIMIZER_TYPE,
                AUTOMAGIC_OPTIMIZER_TYPE,
                EMOSENS_OPTIMIZER_TYPE,
            ],
        )
        self.assertEqual(len(optimizer_entries(KREA2_PROFILE)), 11)

        self.assertEqual(
            [group["label_key"] for group in optimizer_groups(SD_SCRIPTS_PROFILE)],
            [
                "opt.optimizer_group_baseline",
                "opt.optimizer_group_stable",
                "opt.optimizer_group_fast",
                "opt.optimizer_group_longrun",
                "opt.optimizer_group_autolr",
                "opt.optimizer_group_matrix",
            ],
        )
        self.assertEqual(
            [group["label_key"] for group in optimizer_groups(KREA2_PROFILE)],
            [
                "opt.optimizer_group_baseline",
                "opt.optimizer_group_stable",
                "opt.optimizer_group_fast",
                "opt.optimizer_group_autolr",
            ],
        )
        matrix = next(
            group
            for group in optimizer_groups(SD_SCRIPTS_PROFILE)
            if group["label_key"] == "opt.optimizer_group_matrix"
        )
        muon = next(
            option
            for option in matrix["options"]
            if option["v"] == MUON_OPTIMIZER_TYPE
        )
        self.assertEqual(muon["group"], "anima")
        lora_muon = next(
            option
            for option in matrix["options"]
            if option["v"] == LORA_MUON_OPTIMIZER_TYPE
        )
        self.assertEqual(lora_muon["group"], "anima")

        for profile in (SD_SCRIPTS_PROFILE, KREA2_PROFILE):
            lengths = optimizer_beta_lengths(profile)
            hints = optimizer_beta_hint_map(profile)
            beta_entries = {
                entry.selector: entry
                for entry in optimizer_entries(profile)
                if entry.beta_arity is not None
            }
            self.assertEqual(set(lengths), set(beta_entries))
            self.assertEqual(set(hints), set(beta_entries))
            for selector, entry in beta_entries.items():
                with self.subTest(profile=profile, selector=selector):
                    self.assertEqual(lengths[selector], {entry.beta_arity})
                    self.assertEqual(hints[selector], entry.beta_hint_key)
                    self.assertTrue(entry.description_key.startswith("opt.optimizer_type_"))

    def test_frontend_shows_muon_only_for_anima(self):
        optimizer_field = fields_by_key()["optimizer_type"]
        script = r"""
global.window = { t: (key, fallback) => fallback || key };
require('./frontend/js/utils.js');
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;

function optimizerValues(trainType) {
  let selectConfig = null;
  const ctx = Object.assign({}, core, window.utilsMixin, {
    form: { model_train_type: trainType, optimizer_type: 'AdamW8bit' },
    t(key) { return key; },
    escJson(value) { selectConfig = value; return ''; },
  });
  ctx.renderField(__OPTIMIZER_FIELD__);
  return selectConfig.groups.flatMap(group => group.options.map(option => option.v));
}

console.log(JSON.stringify({
  anima: optimizerValues('anima-lora'),
  sdxl: optimizerValues('sdxl-lora'),
}));
""".replace("__OPTIMIZER_FIELD__", json.dumps(optimizer_field))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        values = json.loads(result.stdout)
        self.assertIn(MUON_OPTIMIZER_TYPE, values["anima"])
        self.assertNotIn(MUON_OPTIMIZER_TYPE, values["sdxl"])

    def test_registry_displays_product_defaults_and_anima_recommendations(self):
        from pytorch_optimizer import StableAdamW

        fields = fields_by_key()
        learning_rate = fields["learning_rate"]
        self.assertEqual(learning_rate["default"], "1e-4")
        self.assertEqual(auto_value_for(learning_rate, CAME_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE), "3e-4")
        self.assertEqual(auto_value_for(learning_rate, PRODIGY_OPTIMIZER_TYPE), "1.0")
        self.assertEqual(auto_value_for(learning_rate, AUTOMAGIC_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, STABLE_ADAMW_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, MUON_OPTIMIZER_TYPE), "1e-4")
        self.assertEqual(auto_value_for(learning_rate, LORA_MUON_OPTIMIZER_TYPE), "0.1")
        self.assertEqual(
            contextual_auto_value_for(learning_rate, "AdamW8bit", "anima-lora"),
            "2e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(learning_rate, "Lion8bit", "anima-lora"),
            "5e-6",
        )
        self.assertEqual(
            contextual_auto_value_for(learning_rate, CAME_OPTIMIZER_TYPE, "anima-lora"),
            "1.5e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, STABLE_ADAMW_OPTIMIZER_TYPE, "anima-lora"
            ),
            "2e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, MUON_OPTIMIZER_TYPE, "anima-lora"
            ),
            "2e-5",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, LORA_MUON_OPTIMIZER_TYPE, "anima-lora"
            ),
            "0.02",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate, ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, "anima-lora"
            ),
            "1e-4",
        )
        self.assertEqual(
            contextual_auto_value_for(
                learning_rate,
                ADAFACTOR_OPTIMIZER_TYPE,
                "anima-lora",
                adafactor_relative_step=False,
            ),
            "2e-5",
        )

        scheduler = fields["lr_scheduler"]
        self.assertEqual(scheduler["hintKey"], "field.lr_schedulerHint")
        self.assertTrue(
            any(
                rule.get("watch") == "model_train_type"
                and rule.get("when") == "anima-lora"
                and rule.get("set") == "constant"
                for rule in scheduler["autoValue"]
            )
        )

        weight_decay = fields["weight_decay"]
        self.assertEqual(auto_value_for(weight_decay, "AdamW8bit"), 0.01)
        self.assertEqual(auto_value_for(weight_decay, "Lion8bit"), 0.0)
        self.assertEqual(auto_value_for(weight_decay, CAME_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(auto_value_for(weight_decay, STABLE_ADAMW_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(auto_value_for(weight_decay, MUON_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(auto_value_for(weight_decay, LORA_MUON_OPTIMIZER_TYPE), 0.0)
        self.assertEqual(inspect.signature(StableAdamW).parameters["weight_decay"].default, 0.01)

        self.assertEqual(auto_value_for(fields["betas"], STABLE_ADAMW_OPTIMIZER_TYPE), "0.9, 0.99")
        self.assertEqual(auto_value_for(fields["eps"], STABLE_ADAMW_OPTIMIZER_TYPE), "1e-8")
        self.assertEqual(auto_value_for(fields["eps"], MUON_OPTIMIZER_TYPE), "1e-7")
        self.assertEqual(fields["muon_adjust_lr_fn"]["default"], "match_rms_adamw")
        self.assertEqual(fields["muon_momentum"]["default"], 0.95)
        self.assertTrue(fields["muon_nesterov"]["default"])
        self.assertEqual(fields["muon_ns_steps"]["default"], 5)
        self.assertEqual(
            fields["muon_ns_coefficients"]["default"],
            "3.4445, -4.775, 2.0315",
        )
        self.assertEqual(fields["momentum"]["default"], 0.9)
        self.assertEqual(fields["ns_steps"]["default"], 8)
        self.assertEqual(fields["inv_sqrt_steps"]["default"], 7)
        self.assertEqual(fields["network_dim"].get("autoValue", []), [])
        self.assertEqual(fields["network_alpha"].get("autoValue", []), [])
        self.assertTrue(fields["adafactor_scale_parameter"]["autoValue"][0]["setIfDefault"])
        self.assertTrue(fields["adafactor_warmup_init"]["autoValue"][0]["setIfDefault"])
        self.assertTrue(fields["split_attn"]["autoValue"][0]["setIfDefault"])
        for key, recommended in (
            ("max_grad_norm", 0),
            ("inv_sqrt_steps", 5),
        ):
            with self.subTest(key=key):
                rule = next(
                    rule
                    for rule in fields[key]["autoValue"]
                    if rule.get("watch")
                    == {
                        "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                        "model_train_type": "anima-lora",
                    }
                )
                self.assertEqual(rule["set"], recommended)
                self.assertTrue(rule["setIfDefault"])
        self.assertEqual(fields["msign_eps"]["type"], "text")
        self.assertEqual(fields["msign_eps"]["default"], "1e-20")
        self.assertEqual(fields["inv_sqrt_eps"]["type"], "text")
        self.assertEqual(fields["inv_sqrt_eps"]["default"], "1e-5")
        self.assertEqual(fields["inv_sqrt_gamma"]["type"], "text")
        self.assertEqual(fields["inv_sqrt_gamma"]["default"], "1.001")
        self.assertFalse(fields["gauge_rebalance"]["default"])
        gauge_show_if = [
            {"key": "optimizer_type", "eq": LORA_MUON_OPTIMIZER_TYPE},
            {"key": "gauge_rebalance", "eq": True},
        ]
        for key in (
            "gauge_rebalance_alpha",
            "gauge_rebalance_interval",
            "gauge_power_steps",
        ):
            with self.subTest(key=key):
                self.assertEqual(fields[key]["layoutParent"], "gauge_rebalance")
                self.assertEqual(fields[key]["showIf"], gauge_show_if)
        self.assertFalse(any(key.startswith("lora_muon_") for key in fields))
        self.assertTrue(fields["stableadamw_kahan_sum"]["default"])
        self.assertTrue(fields["stableadamw_weight_decouple"]["default"])
        self.assertEqual(fields["bnb_percentile_clipping"]["default"], 100)
        self.assertEqual(fields["bnb_min_8bit_size"]["default"], 4096)

        self.assertEqual(fields["prodigy_d0"]["default"], "1e-6")
        self.assertEqual(fields["schedulefree_warmup_steps"]["default"], 0)
        self.assertTrue(fields["adafactor_relative_step"]["default"])
        self.assertEqual(fields["adafactor_eps"]["default"], "1e-30, 1e-3")

    def test_registry_exports_nested_readonly_groups(self):
        max_grad_norm = fields_by_key()["max_grad_norm"]
        groups = max_grad_norm["readonlyIfAny"]
        stable_group = next(group for group in groups if isinstance(group, list))
        self.assertEqual(
            {condition["key"] for condition in stable_group},
            {"optimizer_type", "prodigyplus_use_stableadamw"},
        )
        self.assertEqual(max_grad_norm["min"], 0)


class OptimizerValidationTests(unittest.TestCase):
    def test_rejects_negative_or_non_finite_global_gradient_clip(self):
        for value in (-1, "-0.1", "inf"):
            with self.subTest(value=value):
                config = valid_config("AdamW")
                config["max_grad_norm"] = value
                errors = validate_training_config(config)
                self.assertTrue(any("max_grad_norm" in error for error in errors), errors)

    def test_validates_optimizer_specific_parameter_domains(self):
        cases = (
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999"}, "exactly 3"),
            (CAME_OPTIMIZER_TYPE, {"betas": "0.9, 0.999, 1.1"}, "item 2"),
            (PRODIGY_OPTIMIZER_TYPE, {"prodigy_d0": "0"}, "d0"),
            ("AdamW", {"weight_decay": -0.01}, "weight_decay"),
            ("AdamW8bit", {"optimizer_args": ["optim_bits=8"]}, "one of"),
            (ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE, {"schedulefree_warmup_steps": 1.5}, "integer"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9"}, "exactly 2"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"betas": "0.9, 1.0"}, "item 1"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"eps": "-1e-8"}, "eps"),
            (STABLE_ADAMW_OPTIMIZER_TYPE, {"stableadamw_kahan_sum": "yes"}, "true or false"),
            ("AdamW8bit", {"bnb_percentile_clipping": 0}, "percentile_clipping"),
            ("Lion8bit", {"bnb_percentile_clipping": 101}, "percentile_clipping"),
            ("PagedAdamW8bit", {"bnb_min_8bit_size": -1}, "min_8bit_size"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_steps": 0}, "ns_steps"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_steps": 100}, "ns_steps"),
            (MUON_OPTIMIZER_TYPE, {"muon_ns_coefficients": "1, 2"}, "exactly 3"),
            (MUON_OPTIMIZER_TYPE, {"muon_adjust_lr_fn": "unknown"}, "one of"),
            (LORA_MUON_OPTIMIZER_TYPE, {"ns_steps": 0}, "ns_steps"),
            (LORA_MUON_OPTIMIZER_TYPE, {"inv_sqrt_steps": 8}, "inv_sqrt_steps"),
            (LORA_MUON_OPTIMIZER_TYPE, {"momentum": 1.0}, "momentum"),
        )
        for optimizer_type, updates, expected in cases:
            with self.subTest(optimizer_type=optimizer_type, updates=updates):
                config = valid_config(optimizer_type)
                config.update(updates)
                errors = validate_training_config(config)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_rejects_unknown_arguments_for_known_optimizers(self):
        config = valid_config("AdamW")
        config["optimizer_args"] = ["silently_ignored_option=1"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_native_muon_is_limited_to_anima_profile(self):
        anima = valid_config(MUON_OPTIMIZER_TYPE, "anima-lora")
        self.assertEqual(validate_training_config(anima), [])

        sdxl = valid_config(MUON_OPTIMIZER_TYPE, "sdxl-lora")
        errors = validate_training_config(sdxl)
        self.assertTrue(any("only for Anima LoRA" in error for error in errors), errors)

    def test_lora_muon_requires_anima_native_network(self):
        valid = valid_config(LORA_MUON_OPTIMIZER_TYPE, "anima-lora")
        self.assertEqual(validate_training_config(valid), [])

        wrong_module = valid_config(LORA_MUON_OPTIMIZER_TYPE, "anima-lora")
        wrong_module["network_module"] = "networks.lora"
        errors = validate_training_config(wrong_module)
        self.assertTrue(any("LoRA-Muon" in error for error in errors), errors)

        sdxl = valid_config(LORA_MUON_OPTIMIZER_TYPE, "sdxl-lora")
        errors = validate_training_config(sdxl)
        self.assertTrue(any("LoRA-Muon" in error for error in errors), errors)

    def test_lora_muon_and_loraplus_are_rejected_together(self):
        config = valid_config(LORA_MUON_OPTIMIZER_TYPE)
        config.update(
            {
                "enable_loraplus": True,
                "loraplus_lr_ratio": 2,
            }
        )
        errors = validate_training_config(config)
        self.assertTrue(any("incompatible with LoRA+" in error for error in errors), errors)

        config = valid_config(STABLE_ADAMW_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["unknown_stability_knob=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_real_sd_scripts_factory_instantiates_stableadamw(self):
        sd_scripts = Path("vendor/sd-scripts").resolve()
        sys.path.insert(0, str(sd_scripts))
        try:
            from library.optimizer import get_optimizer

            args = type(
                "Args",
                (),
                {
                    "optimizer_type": STABLE_ADAMW_OPTIMIZER_TYPE,
                    "use_8bit_adam": False,
                    "use_lion_optimizer": False,
                    "fused_backward_pass": False,
                    "gradient_accumulation_steps": 1,
                    "learning_rate": 1e-4,
                    "optimizer_args": [
                        "betas=(0.9,0.99)",
                        "eps=1e-8",
                        "weight_decay=0",
                        "weight_decouple=True",
                        "kahan_sum=True",
                    ],
                },
            )()
            parameter = torch.nn.Parameter(torch.ones(2))
            _, _, optimizer = get_optimizer(args, [parameter])
        finally:
            sys.path.remove(str(sd_scripts))

        self.assertEqual(type(optimizer).__name__, "StableAdamW")
        self.assertEqual(optimizer.param_groups[0]["weight_decay"], 0)
        self.assertEqual(optimizer.param_groups[0]["betas"], (0.9, 0.99))

    def test_real_sd_scripts_factory_runs_native_muon_step(self):
        if not torch.cuda.is_available():
            self.skipTest("Muon CUDA smoke requires CUDA")

        config = valid_config(MUON_OPTIMIZER_TYPE)
        config.update(
            {
                "learning_rate": "2e-5",
                "weight_decay": 0,
                "eps": "1e-7",
                "muon_momentum": 0.95,
                "muon_nesterov": True,
                "muon_ns_steps": 5,
                "muon_ns_coefficients": "3.4445, -4.775, 2.0315",
                "muon_adjust_lr_fn": "match_rms_adamw",
            }
        )
        self.assertEqual(validate_training_config(config), [])
        adapted, warnings = adapt_config(config)
        self.assertEqual(warnings, [])

        sd_scripts = Path("vendor/sd-scripts").resolve()
        sys.path.insert(0, str(sd_scripts))
        try:
            from library.optimizer import get_optimizer

            args = type(
                "Args",
                (),
                {
                    "optimizer_type": MUON_OPTIMIZER_TYPE,
                    "use_8bit_adam": False,
                    "use_lion_optimizer": False,
                    "fused_backward_pass": False,
                    "gradient_accumulation_steps": 1,
                    "learning_rate": float(adapted["learning_rate"]),
                    "optimizer_args": adapted["optimizer_args"],
                },
            )()
            parameter = torch.nn.Parameter(torch.ones((4, 4), device="cuda"))
            _, _, optimizer = get_optimizer(args, [parameter])
            before = parameter.detach().clone()
            parameter.square().mean().backward()
            optimizer.step()
        finally:
            sys.path.remove(str(sd_scripts))

        self.assertIs(type(optimizer), torch.optim.Muon)
        group = optimizer.param_groups[0]
        self.assertEqual(group["lr"], 2e-5)
        self.assertEqual(group["weight_decay"], 0)
        self.assertEqual(group["momentum"], 0.95)
        self.assertTrue(group["nesterov"])
        self.assertEqual(group["ns_steps"], 5)
        self.assertEqual(group["ns_coefficients"], (3.4445, -4.775, 2.0315))
        self.assertEqual(group["eps"], 1e-7)
        self.assertEqual(group["adjust_lr_fn"], "match_rms_adamw")
        self.assertTrue(torch.isfinite(parameter).all())
        self.assertTrue(torch.ne(parameter.detach(), before).any())

        config = valid_config("AdamW8bit")
        config["optimizer_args"] = ["fused=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("unsupported argument" in error for error in errors), errors)

    def test_rejects_prodigyplus_fused_modes(self):
        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["optimizer_args"] = ["fused_back_pass=True"]
        errors = validate_training_config(config)
        self.assertTrue(any("skip all updates" in error for error in errors), errors)

        config["optimizer_args"] = ["fused_backward_pass=False"]
        errors = validate_training_config(config)
        self.assertTrue(any("not a valid optimizer argument" in error for error in errors), errors)

        config = valid_config(PRODIGYPLUS_OPTIMIZER_TYPE)
        config["fused_backward_pass"] = True
        errors = validate_training_config(config)
        self.assertTrue(any("fused_backward_pass" in error for error in errors), errors)

    def test_prodigyplus_upstream_fused_flag_skips_regular_step(self):
        from prodigyplus import ProdigyPlusScheduleFree

        parameter = torch.nn.Parameter(torch.tensor([1.0]))
        optimizer = ProdigyPlusScheduleFree(
            [parameter], lr=1.0, fused_back_pass=True
        )
        parameter.square().backward()
        before = parameter.detach().clone()
        optimizer.step()
        self.assertTrue(torch.equal(parameter.detach(), before))


class OptimizerAdapterTests(unittest.TestCase):
    def test_muon_merges_all_exposed_arguments(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": MUON_OPTIMIZER_TYPE,
                "learning_rate": "2e-5",
                "weight_decay": 0,
                "eps": "1e-7",
                "muon_momentum": 0.95,
                "muon_nesterov": True,
                "muon_ns_steps": 5,
                "muon_ns_coefficients": "3.4445, -4.775, 2.0315",
                "muon_adjust_lr_fn": "match_rms_adamw",
            }
        )

        self.assertEqual(adapted["optimizer_type"], MUON_OPTIMIZER_TYPE)
        self.assertIn("weight_decay=0", adapted["optimizer_args"])
        self.assertIn("eps=1e-7", adapted["optimizer_args"])
        self.assertIn("momentum=0.95", adapted["optimizer_args"])
        self.assertIn("nesterov=True", adapted["optimizer_args"])
        self.assertIn("ns_steps=5", adapted["optimizer_args"])
        self.assertIn(
            "ns_coefficients=(3.4445, -4.775, 2.0315)",
            adapted["optimizer_args"],
        )
        self.assertIn("adjust_lr_fn='match_rms_adamw'", adapted["optimizer_args"])
        self.assertEqual(warnings, [])

    def test_lora_muon_merges_all_exposed_arguments(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "learning_rate": "2e-5",
                "weight_decay": 0,
                "momentum": 0.9,
                "ns_steps": 8,
                "inv_sqrt_steps": 7,
                "msign_eps": "1e-20",
                "inv_sqrt_eps": "1e-5",
                "inv_sqrt_gamma": "1.001",
                "gauge_rebalance": False,
                "gauge_rebalance_alpha": 1.0,
                "gauge_rebalance_interval": 1,
                "gauge_power_steps": 2,
            }
        )
        self.assertEqual(adapted["optimizer_type"], LORA_MUON_OPTIMIZER_TYPE)
        for expected in (
            "weight_decay=0",
            "momentum=0.9",
            "ns_steps=8",
            "inv_sqrt_steps=7",
            "msign_eps=1e-20",
            "inv_sqrt_eps=1e-5",
            "inv_sqrt_gamma=1.001",
            "gauge_rebalance=False",
            "gauge_rebalance_alpha=1.0",
            "gauge_rebalance_interval=1",
            "gauge_power_steps=2",
        ):
            self.assertIn(expected, adapted["optimizer_args"])
        self.assertFalse(any("lora_muon_" in item for item in adapted["optimizer_args"]))
        self.assertEqual(warnings, [])

    def test_lora_muon_accepts_legacy_form_keys_without_leaking_them(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "learning_rate": "2e-5",
                "lora_muon_momentum": 0.85,
                "lora_muon_ns_steps": 6,
            }
        )
        self.assertIn("momentum=0.85", adapted["optimizer_args"])
        self.assertIn("ns_steps=6", adapted["optimizer_args"])
        self.assertFalse(any("lora_muon_" in item for item in adapted["optimizer_args"]))
        self.assertEqual(warnings, [])

    def test_lora_muon_accepts_direct_optimizer_args(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "learning_rate": "2e-5",
                "optimizer_args": ["momentum=0.85", "ns_steps=6"],
            }
        )
        self.assertIn("momentum=0.85", adapted["optimizer_args"])
        self.assertIn("ns_steps=6", adapted["optimizer_args"])
        self.assertEqual(warnings, [])

    def test_stableadamw_keeps_external_training_controls_and_loraplus(self):
        adapted, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "network_module": "networks.lora_anima",
                "optimizer_type": STABLE_ADAMW_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 20,
                "max_grad_norm": 1,
                "enable_loraplus": True,
                "loraplus_lr_ratio": 2,
                "weight_decay": 0,
                "stableadamw_kahan_sum": True,
                "stableadamw_weight_decouple": True,
            }
        )
        self.assertEqual(adapted["lr_scheduler"], "cosine")
        self.assertEqual(adapted["lr_warmup_steps"], 20)
        self.assertEqual(adapted["max_grad_norm"], 1)
        self.assertIn("loraplus_lr_ratio=2", adapted["network_args"])
        self.assertIn("weight_decay=0", adapted["optimizer_args"])
        self.assertIn("kahan_sum=True", adapted["optimizer_args"])
        self.assertEqual(warnings, [])

    def test_bitsandbytes_form_controls_only_apply_to_supported_optimizers(self):
        values = {
            "bnb_percentile_clipping": 99,
            "bnb_min_8bit_size": 16384,
        }
        for optimizer_type in ("AdamW8bit", "PagedAdamW8bit", "Lion8bit", "PagedLion8bit"):
            adapted, _ = adapt_config({"optimizer_type": optimizer_type, **values})
            self.assertIn("percentile_clipping=99", adapted["optimizer_args"])
            self.assertIn("min_8bit_size=16384", adapted["optimizer_args"])

        adapted, _ = adapt_config({"optimizer_type": "AdamW", **values})
        self.assertNotIn("optimizer_args", adapted)

    def test_came_fixed_decay_requires_decoupled_weight_decay(self):
        coupled, _ = adapt_config(
            {
                "optimizer_type": CAME_OPTIMIZER_TYPE,
                "weight_decay": 0.02,
                "came_weight_decouple": False,
                "came_fixed_decay": True,
            }
        )
        decoupled, _ = adapt_config(
            {
                "optimizer_type": CAME_OPTIMIZER_TYPE,
                "weight_decay": 0.02,
                "came_weight_decouple": True,
                "came_fixed_decay": True,
            }
        )

        self.assertIn("weight_decouple=False", coupled["optimizer_args"])
        self.assertNotIn("fixed_decay=True", coupled["optimizer_args"])
        self.assertIn("weight_decouple=True", decoupled["optimizer_args"])
        self.assertIn("fixed_decay=True", decoupled["optimizer_args"])

    def test_adafactor_relative_and_manual_modes(self):
        relative, warnings = adapt_config(
            {
                "model_train_type": "anima-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 50,
                "max_grad_norm": 1,
                "adafactor_relative_step": True,
                "adafactor_scale_parameter": True,
                "adafactor_warmup_init": False,
                "adafactor_clip_threshold": 1.0,
                "adafactor_eps": "1e-30, 1e-3",
            }
        )
        self.assertEqual(relative["lr_scheduler"], "constant")
        self.assertEqual(relative["lr_warmup_steps"], 0)
        self.assertEqual(relative["max_grad_norm"], 0)
        self.assertIn("relative_step=True", relative["optimizer_args"])
        self.assertIn("eps=1e-30, 1e-3", relative["optimizer_args"])
        self.assertTrue(any("relative_step" in warning for warning in warnings), warnings)

        manual, _ = adapt_config(
            {
                "model_train_type": "sdxl-lora",
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 25,
                "max_grad_norm": 1,
                "adafactor_relative_step": False,
                "adafactor_scale_parameter": False,
            }
        )
        self.assertEqual(manual["lr_scheduler"], "cosine")
        self.assertEqual(manual["lr_warmup_steps"], 25)
        self.assertEqual(manual["max_grad_norm"], 0)
        self.assertIn("relative_step=False", manual["optimizer_args"])
        self.assertIn("scale_parameter=False", manual["optimizer_args"])

    def test_adafactor_warmup_init_enables_relative_step(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": ADAFACTOR_OPTIMIZER_TYPE,
                "learning_rate": "1e-4",
                "adafactor_relative_step": False,
                "adafactor_warmup_init": True,
                "lr_scheduler": "linear",
                "lr_warmup_steps": 10,
            }
        )
        self.assertIn("relative_step=True", adapted["optimizer_args"])
        self.assertNotIn("relative_step=False", adapted["optimizer_args"])
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertTrue(any("warmup_init=True" in warning for warning in warnings), warnings)

    def test_schedulefree_uses_internal_warmup(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                "learning_rate": "0.0025",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "schedulefree_warmup_steps": 250,
            }
        )
        self.assertEqual(adapted["lr_scheduler"], "constant")
        self.assertEqual(adapted["lr_warmup_steps"], 0)
        self.assertIn("warmup_steps=250", adapted["optimizer_args"])
        self.assertTrue(any("external lr_warmup_steps" in warning for warning in warnings))

    def test_prodigy_injects_warmup_safeguard(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGY_OPTIMIZER_TYPE,
                "learning_rate": "0.5",
                "unet_lr": "0.25",
                "lr_scheduler": "cosine",
                "lr_warmup_steps": 100,
                "prodigy_safeguard_warmup": False,
                "max_grad_norm": 1,
            }
        )
        self.assertEqual(adapted["learning_rate"], 1.0)
        self.assertEqual(adapted["unet_lr"], 1.0)
        self.assertIn("safeguard_warmup=True", adapted["optimizer_args"])
        self.assertNotIn("safeguard_warmup=False", adapted["optimizer_args"])
        self.assertTrue(any("gradient clipping" in warning for warning in warnings), warnings)

    def test_prodigyplus_gradient_clip_branches(self):
        cases = (
            ({}, 0),
            ({"prodigyplus_use_stableadamw": False, "eps": "1e-8"}, 1),
            ({"prodigyplus_use_stableadamw": False, "eps": "None"}, 0),
        )
        for updates, expected in cases:
            with self.subTest(updates=updates):
                config = {
                    "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                    "learning_rate": "1.0",
                    "lr_scheduler": "constant",
                    "max_grad_norm": 1,
                }
                config.update(updates)
                adapted, _ = adapt_config(config)
                self.assertEqual(adapted["max_grad_norm"], expected)

    def test_adapter_sanitizes_prodigyplus_fused_flags(self):
        adapted, warnings = adapt_config(
            {
                "optimizer_type": PRODIGYPLUS_OPTIMIZER_TYPE,
                "learning_rate": "1.0",
                "optimizer_args": [
                    "fused_back_pass=True",
                    "fused_backward_pass=False",
                ],
                "fused_backward_pass": True,
            }
        )
        self.assertIn("fused_back_pass=False", adapted["optimizer_args"])
        self.assertFalse(
            any(item.startswith("fused_backward_pass=") for item in adapted["optimizer_args"])
        )
        self.assertNotIn("fused_backward_pass", adapted)
        self.assertTrue(any("fused" in warning for warning in warnings), warnings)

    def test_optimizer_contracts_apply_to_anima_and_sdxl(self):
        for train_type in ("anima-lora", "sdxl-lora"):
            with self.subTest(train_type=train_type):
                adapted, _ = adapt_config(
                    {
                        "model_train_type": train_type,
                        "optimizer_type": ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE,
                        "learning_rate": "0.0025",
                        "lr_scheduler": "linear",
                        "lr_warmup_steps": 5,
                        "schedulefree_warmup_steps": 20,
                    }
                )
                self.assertEqual(adapted["lr_scheduler"], "constant")
                self.assertEqual(adapted["lr_warmup_steps"], 0)
                self.assertIn("warmup_steps=20", adapted["optimizer_args"])


@unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
class OptimizerFrontendTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend checks")
    def test_lora_muon_preview_serializes_only_optimizer_args(self):
        fields = fields_by_key()
        visible_fields = []
        for key in (
                "network_dim",
                "network_alpha",
                "optimizer_type",
                "learning_rate",
                "max_grad_norm",
                "weight_decay",
                "momentum",
                "ns_steps",
                "inv_sqrt_steps",
                "msign_eps",
                "inv_sqrt_eps",
                "inv_sqrt_gamma",
                "gauge_rebalance",
                "gauge_rebalance_alpha",
                "gauge_rebalance_interval",
                "gauge_power_steps",
        ):
            field = fields[key]
            visible_fields.append(
                {
                    name: field[name]
                    for name in (
                        "key",
                        "default",
                        "omitDefault",
                        "showIf",
                        "showIfAny",
                        "role",
                        "hidden",
                    )
                    if name in field
                }
            )
        script = r"""
global.window = {};
global.document = { getElementById() { return { innerHTML: '' }; } };
require('./frontend/js/constants.js');
window.getVisibleSections = () => [{ key: 'optimizer', fields: __FIELDS__ }];
require('./frontend/js/training-toml.js');
const fieldMap = Object.fromEntries(__FIELDS__.map(field => [field.key, field]));
const ctx = Object.assign({}, window.trainingTomlMixin, {
	  form: {
	    model_train_type: 'anima-lora',
	    network_dim: 16,
	    network_alpha: 16,
	    optimizer_type: 'vendor.lora_muon.LoRA_Muon',
	    learning_rate: '2e-5',
	    max_grad_norm: 0,
	    weight_decay: 0,
	    momentum: 0.85,
	    ns_steps: 6,
	    inv_sqrt_steps: 5,
    msign_eps: '1e-20',
    inv_sqrt_eps: '1e-5',
    inv_sqrt_gamma: '1.001',
    gauge_rebalance: false,
    gauge_rebalance_alpha: 1,
    gauge_rebalance_interval: 1,
    gauge_power_steps: 2,
  },
  _fieldShowIfMet() { return true; },
  _coerceNum(value) { return value; },
  _isPathFieldRole() { return false; },
  findFieldDef(key) { return fieldMap[key] || null; },
  esc(value) { return String(value); },
  t(key, fallback) { return fallback || key; },
});
ctx.updateToml();
process.stdout.write(ctx.tomlRaw);
""".replace("__FIELDS__", json.dumps(visible_fields))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        config = tomllib.loads(result.stdout)
        self.assertEqual(
            config["optimizer_args"],
            ["momentum=0.85", "ns_steps=6", "inv_sqrt_steps=5"],
        )
        self.assertEqual(config["network_dim"], 16)
        self.assertEqual(config["network_alpha"], 16)
        self.assertEqual(config["max_grad_norm"], 0)
        self.assertNotIn("momentum", config)
        self.assertNotIn("ns_steps", config)
        self.assertNotIn("lora_muon_momentum", config)

    def test_lora_muon_frontend_keeps_native_network_pairing(self):
        script = r"""
global.window = {};
global.document = { getElementById() { return null; } };
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const optimizer = 'vendor.lora_muon.LoRA_Muon';

function context(form) {
  const toasts = [];
  const ctx = Object.assign({}, core, {
    form: { model_train_type: 'anima-lora', ...form },
    formDefaults: {}, formHistory: [], formErrors: {},
    timestepPreviewOpen: false,
    _fieldSources: {}, _profileFieldSources: {},
    _setFieldSource(key, source) { this._fieldSources[key] = source; },
    _persistProfileFieldSources() {},
    findFieldDef() { return null; },
    _allShowIfKeys() { return []; },
    queueTomlPreviewChange() {},
    _enforceEmosensUiConstraints() {},
    _automagicFusedConflicts() { return []; },
    _automagicFusedHasConflict() { return false; },
    scheduleOutputPathInfo() {}, pushHistory() {}, updateTomlDebounced() {},
    showConditionalFields() {},
    toast(message, kind) { toasts.push({ message, kind }); },
    t(key) { return key; },
  });
  return { ctx, toasts };
}

const selectOptimizer = context({
  network_module: 'networks.lokr', optimizer_type: 'AdamW8bit',
});
selectOptimizer.ctx.setField('optimizer_type', optimizer);

const selectNetwork = context({
  network_module: 'networks.lora_anima', optimizer_type: optimizer,
});
selectNetwork.ctx.setField('network_module', 'networks.loha');

console.log(JSON.stringify({
  selectOptimizer: {
    network: selectOptimizer.ctx.form.network_module,
    optimizer: selectOptimizer.ctx.form.optimizer_type,
    toasts: selectOptimizer.toasts,
  },
  selectNetwork: {
    network: selectNetwork.ctx.form.network_module,
    optimizer: selectNetwork.ctx.form.optimizer_type,
    toasts: selectNetwork.toasts,
  },
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["selectOptimizer"]["network"], "networks.lora_anima")
        self.assertEqual(state["selectOptimizer"]["optimizer"], LORA_MUON_OPTIMIZER_TYPE)
        self.assertEqual(
            state["selectOptimizer"]["toasts"],
            [{"message": "field.lora_muonNetworkAutoSelected", "kind": "warning"}],
        )
        self.assertEqual(state["selectNetwork"]["network"], "networks.loha")
        self.assertEqual(state["selectNetwork"]["optimizer"], "AdamW8bit")
        self.assertEqual(
            state["selectNetwork"]["toasts"],
            [{"message": "field.lora_muonOptimizerAutoDisabled", "kind": "warning"}],
        )

    def test_dynamic_beta_hints_match_main_form(self):
        fields = fields_by_key()
        betas_field = fields["betas"]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const messages = {
  'field.betasHint_adam': 'adam beta mechanism',
  'field.betasHint_lion': 'lion beta mechanism',
  'field.betasHint_came': 'came beta mechanism',
};
const core = window.trainingCoreMixin;
const ctx = Object.assign({}, core, {
  form: { model_train_type: 'anima-lora', optimizer_type: 'AdamW' },
  t(key) { return messages[key] || key; },
});
const field = __FIELD__;
const mainAdam = ctx._resolveFieldHintText(field, ctx.form, 'anima-lora');
ctx.form.optimizer_type = 'Lion';
const mainLion = ctx._resolveFieldHintText(field, ctx.form, 'anima-lora');

console.log(JSON.stringify({ mainAdam, mainLion }));
""".replace("__FIELD__", json.dumps(betas_field))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        self.assertEqual(
            json.loads(result.stdout),
            {
                "mainAdam": "adam beta mechanism",
                "mainLion": "lion beta mechanism",
            },
        )

    def test_optimizer_specific_hints_append_to_base_hint(self):
        fields = fields_by_key()
        script = r"""
global.window = {
  TRAIN_GROUP_MAP: { 'anima-lora': 'anima' },
  FILLED_INDICATOR_KEYS: new Set(),
  DEFAULT_DIM_KEYS: new Set(),
  OPTIMIZER_DEFAULTS: {},
};
global.document = { querySelector() { return null; } };
require('./frontend/js/utils.js');
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const messages = {
  'field.network_dim': 'LoRA Rank',
  'field.network_dimHint': 'base rank hint',
  'field.network_dimHint_lora_muon': 'Muon rank hint',
  'field.network_alpha': 'LoRA Alpha',
  'field.network_alphaHint': 'base alpha hint',
  'field.network_alphaHint_lora_muon': 'Muon alpha hint',
};

function context(optimizer) {
  return Object.assign({}, core, window.utilsMixin, {
    form: { model_train_type: 'anima-lora', optimizer_type: optimizer },
    formDefaults: {}, formErrors: {},
    t(key) { return messages[key] || key; },
    setField() {}, stepField() {}, undoField() {}, resetField() {},
    _fieldSources: {}, _profileFieldSources: {},
  });
}

function summarize(fieldKey, optimizer) {
  const ctx = context(optimizer);
  const field = __FIELDS__[fieldKey];
  const html = ctx.renderField(field);
  return {
    base: ctx._resolveFieldBaseHintText(field, 'anima-lora'),
    override: ctx._resolveFieldHintOverrideText(field, ctx.form),
    hasBaseHtml: html.includes(`class="field-hint">${messages[field.hintKey]}</div>`),
    hasOrangeBinding: html.includes('class="field-hint field-hint-warn"')
      && html.includes(`fieldHintOverrideText('${fieldKey}')`),
  };
}

console.log(JSON.stringify({
  dimMuon: summarize('network_dim', 'vendor.lora_muon.LoRA_Muon'),
  dimAdam: summarize('network_dim', 'AdamW8bit'),
  alphaMuon: summarize('network_alpha', 'vendor.lora_muon.LoRA_Muon'),
}));
""".replace("__FIELDS__", json.dumps({
            key: fields[key] for key in ("network_dim", "network_alpha")
        }))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        summary = json.loads(result.stdout)
        self.assertEqual(
            summary["dimMuon"],
            {
                "base": "base rank hint",
                "override": "Muon rank hint",
                "hasBaseHtml": True,
                "hasOrangeBinding": True,
            },
        )
        self.assertEqual(
            summary["dimAdam"],
            {
                "base": "base rank hint",
                "override": "",
                "hasBaseHtml": True,
                "hasOrangeBinding": True,
            },
        )
        self.assertEqual(
            summary["alphaMuon"],
            {
                "base": "base alpha hint",
                "override": "Muon alpha hint",
                "hasBaseHtml": True,
                "hasOrangeBinding": True,
            },
        )

    def test_anima_optimizer_automatic_values_preserve_explicit_values(self):
        fields = fields_by_key()
        rules = []
        for key in ("learning_rate", "lr_scheduler"):
            for rule in fields[key].get("autoValue", []):
                rules.append({"target": key, **rule})

        script = r"""
global.window = {};
require('./frontend/js/constants.js');
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;

function apply(modelType, optimizerType, learningRate, scheduler, source = 'default') {
  const fields = {
    learning_rate: { key: 'learning_rate', default: '1e-4' },
    lr_scheduler: { key: 'lr_scheduler', default: 'cosine_with_restarts' },
  };
  const ctx = Object.assign({}, core, {
    form: {
      model_train_type: modelType,
      optimizer_type: optimizerType,
      learning_rate: learningRate,
      lr_scheduler: scheduler,
    },
    formDefaults: {
      learning_rate: '1e-4',
      lr_scheduler: 'cosine_with_restarts',
    },
    _autoValueRules: rules,
    _fieldSources: {
      learning_rate: source,
      lr_scheduler: source,
    },
    _profileFieldSources: {},
    findFieldDef(key) { return fields[key]; },
  });
  ctx._applyInitialAutoValues();
  return {
    learning_rate: ctx.form.learning_rate,
    lr_scheduler: ctx.form.lr_scheduler,
  };
}

console.log(JSON.stringify({
  animaAdam: apply('anima-lora', 'AdamW8bit', '1e-4', 'cosine_with_restarts'),
  animaCame: apply('anima-lora', 'pytorch_optimizer.CAME', '1e-4', 'cosine_with_restarts'),
  animaLion: apply('anima-lora', 'Lion8bit', '1e-4', 'cosine_with_restarts'),
  sdxlLion: apply('sdxl-lora', 'Lion8bit', '1e-4', 'cosine_with_restarts'),
  custom: apply('anima-lora', 'pytorch_optimizer.CAME', '7e-5', 'cosine', 'user'),
}));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["animaAdam"],
            {"learning_rate": "2e-5", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["animaCame"],
            {"learning_rate": "1.5e-5", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["animaLion"],
            {"learning_rate": "5e-6", "lr_scheduler": "constant"},
        )
        self.assertEqual(
            state["sdxlLion"],
            {"learning_rate": "2e-5", "lr_scheduler": "cosine_with_restarts"},
        )
        self.assertEqual(
            state["custom"],
            {"learning_rate": "7e-5", "lr_scheduler": "cosine"},
        )

    def test_field_provenance_controls_optimizer_transitions(self):
        fields = fields_by_key()
        rules = [
            {"target": key, **rule}
            for key in ("learning_rate", "lr_scheduler")
            for rule in fields[key].get("autoValue", [])
        ]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;
const fields = {
  learning_rate: { key: 'learning_rate', default: '1e-4', type: 'text' },
  lr_scheduler: { key: 'lr_scheduler', default: 'cosine_with_restarts', type: 'select' },
  optimizer_type: { key: 'optimizer_type', default: 'AdamW8bit', type: 'select' },
};
const ctx = Object.assign({}, core, {
  form: {
    model_train_type: 'anima-lora',
    optimizer_type: 'AdamW8bit',
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  },
  formDefaults: {
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  },
  formErrors: {},
  _autoValueRules: rules,
  _fieldSources: { learning_rate: 'default', lr_scheduler: 'default' },
  _profileFieldSources: {},
  findFieldDef(key) { return fields[key] || null; },
  queueTomlPreviewChange() {},
  pushHistory() {},
  _allShowIfKeys() { return []; },
  _currentProfileFieldDefault(key) { return fields[key] ? fields[key].default : ''; },
  updateTomlDebounced() {},
  scheduleOutputPathInfo() {},
  t(_key, fallback) { return fallback || ''; },
});
ctx._applyInitialAutoValues();
const fresh = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.form.optimizer_type = 'pytorch_optimizer.CAME';
ctx._applyInitialAutoValues();
const came = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.form.optimizer_type = 'Lion';
ctx._applyInitialAutoValues();
const lion = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.setField('learning_rate', '2e-5');
ctx.setField('lr_scheduler', 'cosine_with_restarts');
ctx.form.optimizer_type = 'AdamW8bit';
ctx._applyInitialAutoValues();
const manual = { ...ctx.form, sources: { ...ctx._fieldSources } };

ctx.resetField('learning_rate');
const reset = { value: ctx.form.learning_rate, source: ctx._fieldSources.learning_rate };
console.log(JSON.stringify({ fresh, came, lion, manual, reset }));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            (state["fresh"]["learning_rate"], state["fresh"]["lr_scheduler"]),
            ("2e-5", "constant"),
        )
        self.assertEqual(
            (state["came"]["learning_rate"], state["came"]["lr_scheduler"]),
            ("1.5e-5", "constant"),
        )
        self.assertEqual(
            (state["lion"]["learning_rate"], state["lion"]["lr_scheduler"]),
            ("5e-6", "constant"),
        )
        self.assertEqual(
            (state["manual"]["learning_rate"], state["manual"]["lr_scheduler"]),
            ("2e-5", "cosine_with_restarts"),
        )
        self.assertEqual(state["manual"]["sources"]["learning_rate"], "user")
        self.assertEqual(state["manual"]["sources"]["lr_scheduler"], "user")
        self.assertEqual(state["reset"], {"value": "2e-5", "source": "auto"})

    def test_same_value_user_input_and_reset_persist_provenance(self):
        fields = fields_by_key()
        rules = [
            {"target": "learning_rate", **rule}
            for rule in fields["learning_rate"].get("autoValue", [])
        ]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;
let persistCalls = 0;
const field = { key: 'learning_rate', default: '1e-4', type: 'text' };
const ctx = Object.assign({}, core, {
  form: {
    model_train_type: 'anima-lora',
    optimizer_type: 'AdamW8bit',
    learning_rate: '2e-5',
  },
  formDefaults: { learning_rate: '2e-5' },
  formErrors: {},
  _autoValueRules: rules,
  _fieldSources: { learning_rate: 'auto' },
  _profileFieldSources: {},
  findFieldDef() { return field; },
  queueTomlPreviewChange() {},
  pushHistory() {},
  _allShowIfKeys() { return []; },
  _currentProfileFieldDefault() { return '1e-4'; },
  updateTomlDebounced() {},
  updateToml() {},
  scheduleOutputPathInfo() {},
  _persistProfileFieldSources() { persistCalls += 1; },
  t(_key, fallback) { return fallback || ''; },
});

ctx.setField('learning_rate', '2e-5');
const sameValueUser = {
  value: ctx.form.learning_rate,
  source: ctx._fieldSources.learning_rate,
  persistCalls,
};

ctx.resetField('learning_rate');
const sameValueReset = {
  value: ctx.form.learning_rate,
  source: ctx._fieldSources.learning_rate,
  persistCalls,
};

console.log(JSON.stringify({ sameValueUser, sameValueReset }));
""".replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["sameValueUser"],
            {"value": "2e-5", "source": "user", "persistCalls": 1},
        )
        self.assertEqual(
            state["sameValueReset"],
            {"value": "2e-5", "source": "auto", "persistCalls": 3},
        )

    def test_import_keys_remain_explicit(self):
        fields = fields_by_key()
        visible_fields = [
            fields["model_train_type"],
            fields["optimizer_type"],
            fields["learning_rate"],
            fields["lr_scheduler"],
            fields["network_dim"],
            fields["network_alpha"],
            fields["max_grad_norm"],
        ] + [
            fields[key]
            for key in (
                "momentum",
                "ns_steps",
                "inv_sqrt_steps",
                "msign_eps",
                "inv_sqrt_eps",
                "inv_sqrt_gamma",
                "gauge_rebalance",
                "gauge_rebalance_alpha",
                "gauge_rebalance_interval",
                "gauge_power_steps",
            )
        ]
        rules = [
            {"target": key, **rule}
            for key in (
                "learning_rate",
                "lr_scheduler",
                "network_dim",
                "network_alpha",
                "max_grad_norm",
                "inv_sqrt_steps",
            )
            for rule in fields[key].get("autoValue", [])
        ]
        script = r"""
global.window = {};
window.getVisibleSections = () => [{ key: 'optimizer', fields: __FIELDS__ }];
require('./frontend/js/training-core.js');
require('./frontend/js/training-config-io.js');
const core = window.trainingCoreMixin;
const rules = __RULES__;

function makeContext() {
  const ctx = Object.assign({}, core, window.trainingConfigIoMixin, {
    currentRoute: '',
    trainTypes: [{ v: 'anima-lora' }, { v: 'sdxl-lora' }],
    form: {
      model_train_type: 'anima-lora',
      optimizer_type: 'AdamW8bit',
      learning_rate: '1e-4',
      lr_scheduler: 'cosine_with_restarts',
    },
    formDefaults: {},
    formHistory: [],
    _profileFormDrafts: {},
    _profileFieldSources: {},
    _fieldSources: {},
    _activeTrainType: 'anima-lora',
    _autoValueRules: rules,
    updateToml() {},
    renderTrainingForm() {},
    updateReadonlyStates() {},
    rebuildForm() { this._applyInitialAutoValues(); },
    toast() {},
    t(_key, fallback) { return fallback || ''; },
    $nextTick(fn) { fn(); },
  });
  const defaults = ctx._buildFormDefaults('anima-lora');
  ctx.formDefaults = { ...defaults };
  ctx._replaceProfileFieldSources('anima-lora', defaults);
  return ctx;
}

async function imported(data) {
  const ctx = makeContext();
  await ctx._applyImportedFlatConfig({ model_train_type: 'anima-lora', ...data });
	  const result = {
	    learning_rate: ctx.form.learning_rate,
	    lr_scheduler: ctx.form.lr_scheduler,
	    lrSource: ctx._fieldSources.learning_rate,
	    schedulerSource: ctx._fieldSources.lr_scheduler,
	  };
	  if (ctx.form.optimizer_type === 'vendor.lora_muon.LoRA_Muon') {
	    result.momentum = ctx.form.momentum;
	    result.nsSteps = ctx.form.ns_steps;
	    result.networkDim = ctx.form.network_dim;
	    result.networkAlpha = ctx.form.network_alpha;
	    result.maxGradNorm = ctx.form.max_grad_norm;
	    result.invSqrtSteps = ctx.form.inv_sqrt_steps;
	    result.sources = {
	      networkDim: ctx._fieldSources.network_dim,
	      networkAlpha: ctx._fieldSources.network_alpha,
	      maxGradNorm: ctx._fieldSources.max_grad_norm,
	      invSqrtSteps: ctx._fieldSources.inv_sqrt_steps,
	    };
	    result.hasLegacyMomentum = Object.prototype.hasOwnProperty.call(ctx.form, 'lora_muon_momentum');
	  }
  return result;
}

(async () => {
  const cameExplicit = await imported({
    optimizer_type: 'pytorch_optimizer.CAME',
    learning_rate: '1e-4',
    lr_scheduler: 'cosine_with_restarts',
  });
  const cameLegacy = await imported({
    optimizer_type: 'pytorch_optimizer.CAME',
    learning_rate: '2e-4',
  });
  const stableExplicit = await imported({
    optimizer_type: 'pytorch_optimizer.StableAdamW',
    learning_rate: '1e-4',
  });
  const missingValues = await imported({ optimizer_type: 'pytorch_optimizer.CAME' });
  const loraMuonLegacy = await imported({
    optimizer_type: 'vendor.lora_muon.LoRA_Muon',
    lora_muon_momentum: 0.85,
    lora_muon_ns_steps: 6,
  });
	  const loraMuonCanonicalWins = await imported({
	    optimizer_type: 'vendor.lora_muon.LoRA_Muon',
	    momentum: 0.8,
	    lora_muon_momentum: 0.85,
	  });
	  const loraMuonExplicit = await imported({
	    optimizer_type: 'vendor.lora_muon.LoRA_Muon',
	    network_dim: 24,
	    network_alpha: 12,
	    max_grad_norm: 1,
	    inv_sqrt_steps: 7,
	  });

  console.log(JSON.stringify({
    cameExplicit,
    cameLegacy,
    stableExplicit,
    missingValues,
	    loraMuonLegacy,
	    loraMuonCanonicalWins,
	    loraMuonExplicit,
  }));
})().catch(error => { console.error(error); process.exit(1); });
""".replace("__FIELDS__", json.dumps(visible_fields)).replace("__RULES__", json.dumps(rules))

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(
            state["cameExplicit"],
            {
                "learning_rate": "1e-4",
                "lr_scheduler": "cosine_with_restarts",
                "lrSource": "import",
                "schedulerSource": "import",
            },
        )
        self.assertEqual(state["cameLegacy"]["learning_rate"], "2e-4")
        self.assertEqual(state["cameLegacy"]["lrSource"], "import")
        self.assertEqual(state["stableExplicit"]["learning_rate"], "1e-4")
        self.assertEqual(state["stableExplicit"]["lrSource"], "import")
        self.assertEqual(
            (state["missingValues"]["learning_rate"], state["missingValues"]["lr_scheduler"]),
            ("1.5e-5", "constant"),
        )
        self.assertEqual(state["missingValues"]["lrSource"], "auto")
        self.assertEqual(state["missingValues"]["schedulerSource"], "auto")
        self.assertEqual(state["loraMuonLegacy"]["momentum"], 0.85)
        self.assertEqual(state["loraMuonLegacy"]["nsSteps"], 6)
        self.assertFalse(state["loraMuonLegacy"]["hasLegacyMomentum"])
        self.assertEqual(state["loraMuonCanonicalWins"]["momentum"], 0.8)
        self.assertEqual(
            {
                key: state["loraMuonLegacy"][key]
                for key in ("networkDim", "networkAlpha", "maxGradNorm", "invSqrtSteps")
            },
            {
                "networkDim": 32,
                "networkAlpha": 32,
                "maxGradNorm": 0,
                "invSqrtSteps": 5,
            },
        )
        self.assertEqual(
            state["loraMuonLegacy"]["sources"],
            {
                "networkDim": "default",
                "networkAlpha": "default",
                "maxGradNorm": "auto",
                "invSqrtSteps": "auto",
            },
        )
        self.assertEqual(
            {
                key: state["loraMuonExplicit"][key]
                for key in ("networkDim", "networkAlpha", "maxGradNorm", "invSqrtSteps")
            },
            {
                "networkDim": 24,
                "networkAlpha": 12,
                "maxGradNorm": 1,
                "invSqrtSteps": 7,
            },
        )
        self.assertEqual(
            set(state["loraMuonExplicit"]["sources"].values()), {"import"}
        )

    def test_lora_muon_recommendations_preserve_explicit_field_sources(self):
        fields = fields_by_key()
        self.assertEqual(fields["network_dim"].get("autoValue", []), [])
        self.assertEqual(fields["network_alpha"].get("autoValue", []), [])
        keys = ("max_grad_norm", "inv_sqrt_steps")
        selected_fields = {key: fields[key] for key in keys}
        rules = [
            {"target": key, **rule}
            for key in keys
            for rule in fields[key].get("autoValue", [])
            if rule.get("watch")
            == {
                "optimizer_type": LORA_MUON_OPTIMIZER_TYPE,
                "model_train_type": "anima-lora",
            }
        ]
        script = r"""
global.window = {};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const fields = __FIELDS__;
const rules = __RULES__;
const keys = ['max_grad_norm', 'inv_sqrt_steps'];
const defaults = { max_grad_norm: 1, inv_sqrt_steps: 7 };
const explicit = { max_grad_norm: 0.5, inv_sqrt_steps: 6 };

function apply(source, values) {
  const ctx = Object.assign({}, core, {
    form: {
      model_train_type: 'anima-lora',
      optimizer_type: 'vendor.lora_muon.LoRA_Muon',
      ...values,
    },
    formDefaults: { ...defaults },
    _autoValueRules: rules,
    _fieldSources: Object.fromEntries(keys.map(key => [key, source])),
    _profileFieldSources: {},
    findFieldDef(key) { return fields[key] || null; },
  });
  ctx._applyInitialAutoValues();
  return {
    values: Object.fromEntries(keys.map(key => [key, ctx.form[key]])),
    sources: Object.fromEntries(keys.map(key => [key, ctx._fieldSources[key]])),
  };
}

console.log(JSON.stringify({
  defaults: apply('default', defaults),
  previousAuto: apply('auto', defaults),
  user: apply('user', explicit),
  imported: apply('import', explicit),
  saved: apply('saved', explicit),
}));
""".replace("__FIELDS__", json.dumps(selected_fields)).replace(
            "__RULES__", json.dumps(rules)
        )

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        recommended = {
            "max_grad_norm": 0,
            "inv_sqrt_steps": 5,
        }
        explicit = {
            "max_grad_norm": 0.5,
            "inv_sqrt_steps": 6,
        }
        for source in ("defaults", "previousAuto"):
            with self.subTest(source=source):
                self.assertEqual(state[source]["values"], recommended)
                self.assertEqual(set(state[source]["sources"].values()), {"auto"})
        for source in ("user", "imported", "saved"):
            with self.subTest(source=source):
                self.assertEqual(state[source]["values"], explicit)
                expected_source = "import" if source == "imported" else source
                self.assertEqual(
                    set(state[source]["sources"].values()), {expected_source}
                )

    def test_legacy_drafts_and_placeholder_use_registry_provenance(self):
        fields = fields_by_key()
        visible_fields = [
            fields["model_train_type"],
            fields["optimizer_type"],
            fields["learning_rate"],
            fields["lr_scheduler"],
        ]
        script = r"""
global.window = {};
window.getVisibleSections = () => [{ key: 'optimizer', fields: __FIELDS__ }];
const storage = new Map();
global.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, value); },
};
require('./frontend/js/training-core.js');
const core = window.trainingCoreMixin;
const ctx = Object.assign({}, core, {
  currentRoute: 'train-anima',
  trainTypes: [{ v: 'anima-lora' }, { v: 'sdxl-lora' }],
  form: { model_train_type: 'anima-lora' },
  _activeTrainType: 'anima-lora',
  _profileFieldSources: {},
  _fieldSources: {},
});
const defaults = ctx._buildFormDefaults('anima-lora');
const legacyDraft = {
  ...defaults,
  optimizer_type: 'pytorch_optimizer.CAME',
  learning_rate: '1e-4',
  lr_scheduler: 'cosine_with_restarts',
};
ctx._activateProfileFieldSources('anima-lora', defaults, legacyDraft, true);
const legacySources = { ...ctx._fieldSources };
ctx.form = { ...legacyDraft };
ctx.setupAutoValueWatchers = function() {
  this._autoValueRules = [];
  window.getVisibleSections('anima-lora').forEach(section => section.fields.forEach(field => {
    (field.autoValue || []).forEach(rule => this._autoValueRules.push({
      target: rule.setTarget || field.key,
      watch: rule.watch,
      when: rule.when,
      set: rule.set,
      setIfDefault: rule.setIfDefault === true,
    }));
  }));
  this._applyInitialAutoValues();
};
ctx.setupAutoValueWatchers();
const preserved = { learning_rate: ctx.form.learning_rate, lr_scheduler: ctx.form.lr_scheduler };

ctx._fieldSources.learning_rate = 'user';
ctx._fieldSources.lr_scheduler = 'auto';
ctx._captureProfileFieldSources('anima-lora');
ctx._persistProfileFieldSources();
const reloaded = Object.assign({}, core, {
  currentRoute: 'train-anima',
  trainTypes: ctx.trainTypes,
})._loadProfileFieldSources('train-anima');
storage.set(ctx._profileFieldSourceStorageKey(), JSON.stringify({
  version: 1,
  profiles: { 'anima-lora': { learning_rate: 'preset' } },
}));
const migratedPresetSources = Object.assign({}, core, {
  currentRoute: 'train-anima',
  trainTypes: ctx.trainTypes,
})._loadProfileFieldSources('train-anima');

const learningRateField = __LR_FIELD__;
const placeholders = ctx._optimizerAutoValueMap(learningRateField, 'anima-lora');
console.log(JSON.stringify({
  legacySources,
  preserved,
  reloaded,
  migratedPresetSources,
  placeholders,
  storageKey: ctx._profileFieldSourceStorageKey(),
}));
""".replace("__FIELDS__", json.dumps(visible_fields)).replace(
            "__LR_FIELD__", json.dumps(fields["learning_rate"])
        )

        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["legacySources"]["learning_rate"], "saved")
        self.assertEqual(state["legacySources"]["lr_scheduler"], "saved")
        self.assertEqual(
            state["preserved"],
            {"learning_rate": "1e-4", "lr_scheduler": "cosine_with_restarts"},
        )
        self.assertEqual(
            state["reloaded"]["anima-lora"]["learning_rate"], "user"
        )
        self.assertEqual(
            state["reloaded"]["anima-lora"]["lr_scheduler"], "auto"
        )
        self.assertEqual(
            state["migratedPresetSources"]["anima-lora"]["learning_rate"],
            "import",
        )
        self.assertEqual(
            state["storageKey"], "anima-form-profile-sources-v1-train-anima"
        )
        self.assertEqual(state["placeholders"]["AdamW8bit"], "2e-5")
        self.assertEqual(state["placeholders"][CAME_OPTIMIZER_TYPE], "1.5e-5")
        self.assertEqual(state["placeholders"]["Lion"], "5e-6")
        self.assertEqual(
            state["placeholders"][ADAMW_SCHEDULEFREE_OPTIMIZER_TYPE], "1e-4"
        )
        constants = Path("frontend/js/constants.js").read_text(encoding="utf-8")
        self.assertNotIn("ANIMA_OPTIMIZER_LR_DEFAULTS", constants)

    def test_default_omission_auto_value_provenance_and_readonly_groups(self):
        script = r"""
global.window = {};
require('./frontend/js/constants.js');
require('./frontend/js/training-core.js');
require('./frontend/js/training-toml.js');
const core = window.trainingCoreMixin;
const toml = window.trainingTomlMixin;

function args(form) {
  const ctx = Object.assign({}, core, toml, {
    form,
    findFieldDef() { return null; },
    _fieldShowIfMet() { return true; },
  });
  return ctx._buildOptimizerArgs(form);
}

const schedulefreeDefaults = args({
  optimizer_type: 'AdamWScheduleFree',
  weight_decay: 0,
  betas: '0.9, 0.999',
  eps: '1e-8',
  schedulefree_warmup_steps: 0,
});
const schedulefreeCustom = args({
  optimizer_type: 'AdamWScheduleFree',
  schedulefree_warmup_steps: 250,
});
const adafactorDefaults = args({
  optimizer_type: 'AdaFactor',
  weight_decay: 0,
  adafactor_relative_step: true,
  adafactor_scale_parameter: true,
  adafactor_warmup_init: false,
  adafactor_clip_threshold: 1,
  adafactor_eps: '1e-30, 1e-3',
});
const adafactorCustom = args({
  optimizer_type: 'AdaFactor',
  adafactor_relative_step: false,
  adafactor_scale_parameter: false,
});
const automagicDefaults = args({
  optimizer_type: 'vendor.automagic_optimizer.integration.Automagic3',
  automagic_min_lr: '1e-8',
  automagic_max_lr: '1e3',
  automagic_beta2: 0.999,
  automagic_clip_threshold: 1,
  automagic_polarity_history: 8,
  automagic_fused: false,
  eps: '1e-30',
  weight_decay: 0,
});
const stableDefaults = args({
  optimizer_type: 'pytorch_optimizer.StableAdamW',
  betas: '0.9, 0.99',
  eps: '1e-8',
  weight_decay: 0,
  stableadamw_kahan_sum: true,
  stableadamw_weight_decouple: true,
});
const stableCustom = args({
  optimizer_type: 'pytorch_optimizer.StableAdamW',
  weight_decay: 0.02,
  stableadamw_kahan_sum: false,
  stableadamw_weight_decouple: false,
});
const muonDefaults = args({
  optimizer_type: 'Muon',
  weight_decay: 0,
  eps: '1e-7',
});
const loraMuonDefaults = args({
  optimizer_type: 'vendor.lora_muon.LoRA_Muon',
  weight_decay: 0,
  momentum: 0.9,
  ns_steps: 8,
  inv_sqrt_steps: 7,
  msign_eps: '1e-20',
  inv_sqrt_eps: '1e-5',
  inv_sqrt_gamma: '1.001',
  gauge_rebalance: false,
  gauge_rebalance_alpha: 1,
  gauge_rebalance_interval: 1,
  gauge_power_steps: 2,
});
const loraMuonCustom = args({
  optimizer_type: 'vendor.lora_muon.LoRA_Muon',
  weight_decay: 0.01,
  momentum: 0.85,
  ns_steps: 6,
  inv_sqrt_steps: 5,
  msign_eps: '1e-12',
  inv_sqrt_eps: '1e-4',
  inv_sqrt_gamma: 1.01,
  gauge_rebalance: true,
  gauge_rebalance_alpha: 0.5,
  gauge_rebalance_interval: 4,
  gauge_power_steps: 3,
});
const bnbDefaults = args({
  optimizer_type: 'AdamW8bit',
  bnb_percentile_clipping: 100,
  bnb_min_8bit_size: 4096,
});
const bnbCustom = args({
  optimizer_type: 'AdamW8bit',
  bnb_percentile_clipping: 99,
  bnb_min_8bit_size: 16384,
});

const field = { key: 'lr_scheduler', default: 'cosine_with_restarts' };
const rules = [
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'Prodigy', set: 'cosine', setIfDefault: true },
  { target: 'lr_scheduler', watch: 'optimizer_type', when: 'AdamWScheduleFree', set: 'constant', setIfDefault: false },
];
function autoContext(source) {
  return Object.assign({}, core, {
    form: { optimizer_type: 'Prodigy', lr_scheduler: 'constant' },
    formDefaults: { lr_scheduler: 'constant' },
    _autoValueRules: rules,
    _fieldSources: { lr_scheduler: source },
    _profileFieldSources: {},
    findFieldDef() { return field; },
  });
}
const previousAuto = autoContext('auto');
previousAuto._applyInitialAutoValues();
const explicitCustom = autoContext('user');
explicitCustom._applyInitialAutoValues();

const weightField = { key: 'weight_decay', default: '' };
const weightContext = Object.assign({}, core, {
  form: { optimizer_type: 'AdamW', weight_decay: 0 },
  formDefaults: { weight_decay: '' },
  _fieldSources: { weight_decay: 'user' },
  _profileFieldSources: {},
  _autoValueRules: [
    { target: 'weight_decay', watch: 'optimizer_type', when: 'AdamW', set: 0.01, setIfDefault: true },
    { target: 'weight_decay', watch: 'optimizer_type', when: 'Lion', set: 0, setIfDefault: true },
  ],
  findFieldDef() { return weightField; },
});
weightContext._applyInitialAutoValues();

const readonly = Object.assign({}, core, {
  form: {
    optimizer_type: 'prodigyplus.ProdigyPlusScheduleFree',
    prodigyplus_use_stableadamw: true,
    eps: '1e-8',
  },
});
const clauses = [
  { key: 'optimizer_type', eq: 'AdaFactor' },
  [
    { key: 'optimizer_type', eq: 'prodigyplus.ProdigyPlusScheduleFree' },
    { key: 'prodigyplus_use_stableadamw', eq: true },
  ],
];
const locked = readonly._readonlyIfAnyMet(clauses);
readonly.form.prodigyplus_use_stableadamw = false;
const unlocked = readonly._readonlyIfAnyMet(clauses);

function resetWithRule({ form, key, profileDefault, expected, rules }) {
  const ctx = Object.assign({}, core, {
    form: { model_train_type: 'anima-lora', ...form },
    formDefaults: { [key]: expected },
    _autoValueRules: rules.map(rule => ({ target: key, ...rule })),
    _fieldSources: { [key]: 'user' },
    _profileFieldSources: {},
    _currentProfileFieldDefault() { return profileDefault; },
    setField(target, value) {
      this.form[target] = value;
      this._setFieldSource(target, 'user');
    },
    updateToml() {},
  });
  ctx.resetField(key);
  return {
    value: ctx.form[key],
    changed: String(ctx.form[key]) !== String(ctx.formDefaults[key]),
    source: ctx._fieldSources[key],
  };
}

const optimizerResets = {
  adamWeightDecay: resetWithRule({
    form: { optimizer_type: 'AdamW', weight_decay: 0.2 },
    key: 'weight_decay', profileDefault: '', expected: 0.01,
    rules: [{ watch: 'optimizer_type', when: 'AdamW', set: 0.01, setIfDefault: true }],
  }),
  prodigyGradClip: resetWithRule({
    form: { optimizer_type: 'Prodigy', max_grad_norm: 1 },
    key: 'max_grad_norm', profileDefault: 1, expected: 0,
    rules: [{ watch: 'optimizer_type', when: 'Prodigy', set: 0, setIfDefault: true }],
  }),
  lionBetas: resetWithRule({
    form: { optimizer_type: 'Lion', betas: '0.8, 0.9' },
    key: 'betas', profileDefault: '', expected: '0.9, 0.99',
    rules: [{ watch: 'optimizer_type', when: 'Lion', set: '0.9, 0.99', setIfDefault: true }],
  }),
  automagicEps: resetWithRule({
    form: { optimizer_type: 'vendor.automagic_optimizer.integration.Automagic3', eps: '1e-8' },
    key: 'eps', profileDefault: '', expected: '1e-30',
    rules: [{ watch: 'optimizer_type', when: 'vendor.automagic_optimizer.integration.Automagic3', set: '1e-30', setIfDefault: true }],
  }),
  schedulefreeLearningRate: resetWithRule({
    form: { optimizer_type: 'AdamWScheduleFree', learning_rate: '1e-4' },
    key: 'learning_rate', profileDefault: '1e-4', expected: '3e-4',
    rules: [{ watch: 'optimizer_type', when: 'AdamWScheduleFree', set: '3e-4', setIfDefault: true }],
  }),
  adafactorScale: resetWithRule({
    form: { optimizer_type: 'AdaFactor', adafactor_relative_step: false, adafactor_scale_parameter: true },
    key: 'adafactor_scale_parameter', profileDefault: true, expected: false,
    rules: [{ watch: 'adafactor_relative_step', when: false, set: false }],
  }),
};

console.log(JSON.stringify({
  schedulefreeDefaults,
  schedulefreeCustom,
  adafactorDefaults,
  adafactorCustom,
  automagicDefaults,
  stableDefaults,
  stableCustom,
  muonDefaults,
  loraMuonDefaults,
  loraMuonCustom,
  bnbDefaults,
  bnbCustom,
  previousAuto: previousAuto.form.lr_scheduler,
  explicitCustom: explicitCustom.form.lr_scheduler,
  explicitAlternateDefault: weightContext.form.weight_decay,
  locked,
  unlocked,
  optimizerResets,
}));
"""
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path.cwd(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertEqual(state["schedulefreeDefaults"], [])
        self.assertEqual(state["schedulefreeCustom"], ["warmup_steps=250"])
        self.assertEqual(state["adafactorDefaults"], [])
        self.assertEqual(
            state["adafactorCustom"],
            ["relative_step=False", "scale_parameter=False"],
        )
        self.assertEqual(state["automagicDefaults"], [])
        self.assertEqual(state["stableDefaults"], ["weight_decay=0"])
        self.assertEqual(
            state["stableCustom"],
            ["weight_decay=0.02", "kahan_sum=False", "weight_decouple=False"],
        )
        self.assertEqual(state["muonDefaults"], ["weight_decay=0"])
        self.assertEqual(state["loraMuonDefaults"], [])
        self.assertEqual(
            state["loraMuonCustom"],
            [
                "weight_decay=0.01",
                "momentum=0.85",
                "ns_steps=6",
                "inv_sqrt_steps=5",
                "msign_eps=1e-12",
                "inv_sqrt_eps=1e-4",
                "inv_sqrt_gamma=1.01",
                "gauge_rebalance=True",
                "gauge_rebalance_alpha=0.5",
                "gauge_rebalance_interval=4",
                "gauge_power_steps=3",
            ],
        )
        self.assertEqual(state["bnbDefaults"], [])
        self.assertEqual(
            state["bnbCustom"],
            ["percentile_clipping=99", "min_8bit_size=16384"],
        )
        self.assertEqual(state["previousAuto"], "cosine")
        self.assertEqual(state["explicitCustom"], "constant")
        self.assertEqual(state["explicitAlternateDefault"], 0)
        self.assertTrue(state["locked"])
        self.assertFalse(state["unlocked"])
        self.assertEqual(
            state["optimizerResets"],
            {
                "adamWeightDecay": {"value": 0.01, "changed": False, "source": "auto"},
                "prodigyGradClip": {"value": 0, "changed": False, "source": "auto"},
                "lionBetas": {"value": "0.9, 0.99", "changed": False, "source": "auto"},
                "automagicEps": {"value": "1e-30", "changed": False, "source": "auto"},
                "schedulefreeLearningRate": {"value": "3e-4", "changed": False, "source": "auto"},
                "adafactorScale": {"value": False, "changed": False, "source": "auto"},
            },
        )


class LorariteImportContractTests(unittest.TestCase):
    def test_registered_selector_resolves_to_lora_rite(self):
        # selector 即类真名；sd-scripts 按 __module__ + "." + __name__ 记录
        # ss_optimizer，查看器按词边界取短名，下划线安全、横线会被截断
        # （见 lora_rite.py 末尾注释）。
        module_path, _, attr = LORARITE_OPTIMIZER_TYPE.rpartition(".")
        resolved = getattr(importlib.import_module(module_path), attr)
        self.assertEqual(resolved.__name__, "LoRA_RITE")
        self.assertEqual(
            resolved.__module__ + "." + resolved.__name__,
            "vendor.lora_rite.lora_rite.LoRA_RITE",
        )


if __name__ == "__main__":
    unittest.main()
