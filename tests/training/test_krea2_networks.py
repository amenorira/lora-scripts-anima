import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import toml

from backend.training.config.krea2_network import (
    KREA2_LYCORIS_MODULE, KREA2_NETWORK_MODULE, KREA2_PRESET_FILENAME,
    build_krea2_network_preset, linear_target_names, selected_targets,
)
from backend.training.config.musubi_krea2 import build_krea2_train_config, validate_krea2_config
from backend.training.execution.krea2_preflight import krea2_preflight
from backend.training.config.network_config import extract_network_form
from backend.training.core_registry import resolve_training_profile, TrainingProfileError
from backend.training.execution.supervisor import _build_train_env
from backend.training.config.training_config import build_training_config, dump_training_config, parse_training_config_text, extract_training_form
from backend.server.routes import training as routes
from backend.tasks import TaskManager
from tests.helpers import json_request
from tests.training.test_multi_core_krea2 import krea2_config


class Krea2NetworkConfigTests(unittest.TestCase):
    def test_engine_adapter_and_subprocess_import_contract(self):
        config = {"model_train_type": "krea2-lora", "network_module": KREA2_LYCORIS_MODULE}
        resolve_training_profile(config)
        self.assertEqual(config["adapter_id"], "musubi_lycoris")
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile({**config, "adapter_id": "musubi_lora"})
        with tempfile.TemporaryDirectory() as tmp:
            env = _build_train_env(tmp, "krea2-test", engine_id="musubi_tuner")
            paths = env["PYTHONPATH"].split(os.pathsep)
            self.assertLess(next(i for i, p in enumerate(paths) if p.endswith("musubi-tuner\\src") or p.endswith("musubi-tuner/src")),
                            next(i for i, p in enumerate(paths) if Path(p).name == "vendor"))
            for enabled in ("0", "1"):
                with self.subTest(flash=enabled):
                    process = subprocess.run([sys.executable, "-B", "-c", """
import importlib.util, os, sys
from pathlib import Path
assert ('flash_attn' in sys.modules and sys.modules['flash_attn'] is None) == (os.environ['ANIMA_ENABLE_FLASH_ATTN'] == '0')
assert Path(importlib.util.find_spec('lycoris').origin).parent.parent.name == 'vendor'
assert 'musubi-tuner' in importlib.util.find_spec('musubi_tuner').origin
"""], env={**env, "ANIMA_ENABLE_FLASH_ATTN": enabled}, capture_output=True, text=True, timeout=30)
                    self.assertEqual(process.returncode, 0, process.stderr)

    def test_target_counts_and_custom_fullmatch_exclusions(self):
        self.assertEqual(len(set(linear_target_names())), 264)
        for mode, count in (("all", 264), ("attention", 140), ("attention_mlp", 224)):
            self.assertEqual(len(selected_targets({"krea_target_mode": mode})), count)
        targets = selected_targets({"krea_target_mode": "custom", "krea_target_include": "blocks\\.0\\..*\nfirst",
                                    "krea_target_exclude": ".*\\.mlp\\..*"})
        self.assertEqual(len(targets), 6)
        self.assertIn("first", targets)
        self.assertNotIn("blocks.0.mlp.up", targets)

    def test_serialization_and_portable_yaml_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = krea2_config(root)
            config.update(network_module=KREA2_LYCORIS_MODULE, lycoris_algo="lokr", lokr_factor=8,
                          full_matrix=True, use_scalar=True, rs_lora=True, module_dropout=0.1,
                          krea_target_mode="custom", krea_target_include="blocks\\.0\\..*\nfirst",
                          krea_target_exclude=".*\\.mlp\\..*", krea_attention_backend="flash_attn")
            self.assertEqual(validate_krea2_config(config), [])
            native = build_krea2_train_config(config, root / "dataset.toml", root, root / "log")
            arguments = dict(item.split("=", 1) for item in native["network_args"])
            self.assertEqual(native["network_module"], KREA2_LYCORIS_MODULE)
            self.assertTrue(native["flash_attn"])
            self.assertTrue(native["split_attn"])
            self.assertNotIn("network_dropout", native)
            self.assertNotIn("sdpa", native)
            self.assertEqual(arguments["algo"], "lokr")
            self.assertEqual(arguments["factor"], "8")
            self.assertEqual(arguments["full_matrix"], "True")
            self.assertEqual(arguments["module_dropout"], "0.1")
            self.assertEqual(Path(arguments["preset"]), root / KREA2_PRESET_FILENAME)
            self.assertEqual(toml.loads(toml.dumps(native)), native)
            preset = build_krea2_network_preset(config)
            self.assertEqual(len(preset["unet_target_name"]), 6)
            self.assertEqual(toml.loads(toml.dumps(preset)), preset)
            document = build_training_config(config, profile_id="krea2-lora")
            restored = extract_training_form(parse_training_config_text(dump_training_config(document)))
            response = asyncio.run(routes.parse_training_toml(
                routes.TrainingTomlParseRequest(content=dump_training_config(document)))).model_dump()
            self.assertEqual(response["status"], "success", response)
            self.assertEqual(response["data"]["data"], restored)
            self.assertEqual(validate_krea2_config(restored), [])
            self.assertEqual(build_krea2_network_preset(restored), preset)
            self.assertEqual(build_krea2_train_config(restored, root / "dataset.toml", root, root / "log"), native)

    def test_algorithm_switch_does_not_leak_lokr_settings_into_loha(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = krea2_config(Path(tmp))
            config.update(network_module=KREA2_LYCORIS_MODULE, lycoris_algo="loha", lokr_factor=8,
                          full_matrix=True, decompose_both=True, unbalanced_factorization=True,
                          rank_dropout=0.2, module_dropout=0.1)
            self.assertEqual(validate_krea2_config(config), [])
            native = build_krea2_train_config(config, Path(tmp) / "dataset.toml", tmp, tmp)
            args = dict(item.split("=", 1) for item in native["network_args"])
            self.assertEqual(args["algo"], "loha")
            self.assertEqual(args["rank_dropout"], "0.2")
            self.assertTrue({"factor", "decompose_both", "full_matrix", "unbalanced_factorization"}.isdisjoint(args))

    def test_disabled_decompose_both_omits_truthy_upstream_string(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = krea2_config(Path(tmp))
            config.update(network_module=KREA2_LYCORIS_MODULE, lokr_factor=8, network_dim=1, network_alpha=1)
            for enabled in (False, True):
                config["decompose_both"] = enabled
                native = build_krea2_train_config(config, "dataset.toml", tmp, tmp)
                args = dict(item.split("=", 1) for item in native["network_args"])
                self.assertEqual(args.get("decompose_both"), "True" if enabled else None)

    def test_invalid_and_ineffective_settings_fail_before_launch(self):
        cases = [({"network_module": "networks.lokr"}, "network_module"),
                 ({"network_module": []}, "network_module"),
                 ({"lycoris_algo": "unknown"}, "lycoris_algo"),
                 ({"lycoris_algo": []}, "lycoris_algo"),
                 ({"lycoris_kernel_backend": []}, "lycoris_kernel_backend"),
                 ({"lokr_factor": 0}, "lokr_factor"), ({"lokr_factor": 1.5}, "lokr_factor"),
                 ({"rank_dropout": 0.1}, "rank_dropout"),
                 ({"krea_target_mode": "custom", "krea_target_include": "["}, "regex"),
                 ({"krea_target_mode": "custom", "krea_target_include": "no-such-layer"}, "no Krea"),
                 ({"krea_target_mode": "custom", "krea_target_exclude": ".*"}, "no Krea"),
                 ({"network_args_custom": "preset=full"}, "managed"),
                 ({"network_args_custom": "dropout=0.1"}, "managed"),
                 ({"network_args_custom": "use_tucker=True"}, "unsupported"),
                 ({"use_scalar": "false"}, "boolean"),
                 ({"fp8_base": True, "dora_wd": True}, "DoRA"),
                 ({"bypass_mode": True, "dora_wd": True}, "DoRA")]
        for changes, message in cases:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as tmp:
                config = krea2_config(Path(tmp))
                config.update(network_module=KREA2_LYCORIS_MODULE, lycoris_algo="lokr")
                config.update(changes)
                self.assertTrue(any(message in e for e in validate_krea2_config(config)))
                with self.assertRaises(ValueError):
                    build_krea2_train_config(config, "dataset.toml", tmp, tmp)

    def test_fp8_requires_bypass_and_native_lora_filters_remain_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = krea2_config(Path(tmp))
            config.update(network_module=KREA2_LYCORIS_MODULE, lycoris_algo="loha", fp8_base=True)
            self.assertEqual(validate_krea2_config(config), [])
            self.assertTrue(config["bypass_mode"])
            config.update(network_module=KREA2_NETWORK_MODULE, fp8_base=False,
                          network_args_custom="exclude_patterns=['first']\ninclude_patterns=['first']")
            self.assertEqual(validate_krea2_config(config), [])
            native = build_krea2_train_config(config, "dataset.toml", tmp, tmp)
            self.assertEqual(len(native["network_args"]), 2)
            self.assertFalse(any(a.startswith("algo=") for a in native["network_args"]))

    def test_native_argument_import_restores_guided_controls(self):
        imported = extract_network_form({"model_train_type": "krea2-lora", "network_module": KREA2_LYCORIS_MODULE,
            "network_args": ["algo=loha", "rank_dropout=0.1", "use_scalar=true", "factor=8"]})
        self.assertEqual(imported["lycoris_algo"], "loha")
        self.assertEqual(imported["rank_dropout"], 0.1)
        self.assertIs(imported["use_scalar"], True)
        self.assertEqual(imported["lokr_factor"], 8)
        self.assertNotIn("network_args", imported)
        imported = extract_network_form({"model_train_type": "krea2-lora", "network_module": KREA2_LYCORIS_MODULE,
            "network_args": ["algo=lokr", "factor=4"], "network_args_custom": "algo=loha\nfactor=8"})
        self.assertEqual(imported["lycoris_algo"], "loha")
        self.assertEqual(imported["lokr_factor"], 8)

    def test_legacy_dropout_text_preserves_last_value_and_explicit_control_precedence(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = krea2_config(Path(tmp))
            config["network_args_custom"] = "rank_dropout=0.1\nrank_dropout=0.2"
            self.assertEqual(validate_krea2_config(config), [])
            self.assertEqual(config["rank_dropout"], 0.2)
            self.assertEqual(config["network_args_custom"], "")
            config.update(rank_dropout=0.3, network_args_custom="rank_dropout=0.2")
            self.assertEqual(validate_krea2_config(config), [])
            self.assertEqual(config["rank_dropout"], 0.3)

    def test_flash_uses_existing_package_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = krea2_config(Path(tmp))
            config["krea_attention_backend"] = "flash_attn"
            with patch("backend.training.execution.krea2_preflight.shared_runtime_status", return_value={"errors": []}), \
                 patch("tools.flash_attention.package_version", return_value=None) as version:
                result = krea2_preflight(config, require_cache=False)
                self.assertFalse(result["ok"])
                self.assertTrue(any("FlashAttention" in e for e in result["errors"]))
                version.assert_called_once_with("flash-attn")

    def test_launch_writes_preset_and_enables_selected_process_backends(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = krea2_config(root)
            config.update(network_module=KREA2_LYCORIS_MODULE, lycoris_algo="loha",
                          krea_attention_backend="flash_attn", lycoris_kernel_backend="torch")
            with patch.object(routes, "tm", TaskManager()), \
                 patch.object(routes.launch_krea2, "OUTPUT_DIR", root / "runs"), \
                 patch.object(routes.launch_krea2, "AUTOSAVE_DIR", root / "autosave"), \
                 patch.object(routes.launch_krea2, "detect_lycoris_kernel_backend", return_value=("torch", "kernel fallback")), \
                 patch.object(routes.launch_krea2, "krea2_preflight", return_value={"ok": True, "errors": [], "cache": {"ready": True}}), \
                 patch.object(routes, "run_train", return_value={"status": "success", "data": {}}) as launch:
                response = asyncio.run(routes.create_toml_file(json_request(config)))
                self.assertEqual(response["status"], "success", response)
                self.assertEqual(response["data"]["warnings"], ["kernel fallback"])
                env = launch.call_args.kwargs["extra_env"]
                self.assertEqual(env["ANIMA_ENABLE_FLASH_ATTN"], "1")
                self.assertEqual(env["LYCORIS_KERNEL_BACKEND"], "torch")
                native = toml.load(launch.call_args.args[0])
                args = dict(arg.split("=", 1) for arg in native["network_args"])
                self.assertEqual(len(toml.load(args["preset"])["unet_target_name"]), 264)
                launch.return_value = {"status": "error", "message": "cancelled", "data": None}
                with patch.object(routes, "tm", TaskManager()):
                    cancelled = asyncio.run(routes.create_toml_file(json_request(config)))
                self.assertEqual(cancelled.status, "fail")
                self.assertEqual(cancelled.message, "cancelled")


if __name__ == "__main__":
    unittest.main()
