import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import toml

from backend.training.config.krea2_network import KREA2_LYCORIS_MODULE, KREA2_PRESET_FILENAME, build_krea2_network_preset
from backend.training.config.musubi_krea2 import build_krea2_train_config, validate_krea2_config
from backend.training.config.training_config import build_training_config, dump_training_config, parse_training_config_text, extract_training_form
from backend.server.routes import training as routes
from backend.tasks import TaskManager
from tests.helpers import json_request
from tests.training.test_multi_core_krea2 import krea2_config


class Krea2NetworkConfigTests(unittest.TestCase):


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
