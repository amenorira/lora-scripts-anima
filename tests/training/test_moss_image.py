import importlib
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from PIL import Image

from backend.training.adapter import adapt_config
from backend.training.core_registry import resolve_training_profile, TrainingProfileError
from backend.training.field_registry import FIELDS
from backend.training.moss_image import (
    DEFAULTS, GROUP, PROFILE_ID, extract_form, validate_captions, validate_model_files,
)
from backend.training.te_cache_check import check_te_cache, delete_te_cache
from backend.training.training_config import build_training_config, extract_training_form
from backend.training.validation import validate_training_config
from backend.server.routes.training import get_sample_prompts


def moss_config(**overrides):
    config = {}
    for field in FIELDS:
        group = field.get("group")
        if group and group != "all" and GROUP not in (group if isinstance(group, list) else [group]):
            continue
        if "default" in field:
            config[field["key"]] = field.get("default_by_group", {}).get(GROUP, field["default"])
    config.update(DEFAULTS)
    config.update(model_train_type=PROFILE_ID, pretrained_model_name_or_path="dit.safetensors",
                  text_encoder="te.safetensors", vae="vae.safetensors", train_data_dir="train",
                  output_dir="output", output_name="moss_test")
    config.update(overrides)
    return config


class MossImageConfigTests(unittest.TestCase):
    def test_profile_defaults_and_native_arguments_reach_upstream_parser(self):
        config = moss_config(train_text_embedder=True, rank_dropout=0.1,
                             sample_uncond_skip_layers="", enable_loraplus=True)
        self.assertEqual(validate_training_config(config), [])
        profile = resolve_training_profile(dict(config))
        self.assertEqual(profile.engine_id, "sd_scripts")
        self.assertTrue(profile.trainer_file.endswith("moss_image_train_network.py"))
        adapted, warnings = adapt_config(config)
        self.assertFalse(warnings, warnings)
        self.assertEqual(adapted["network_module"], "networks.lora_generic")
        self.assertIn("train_llm_adapter=True", adapted["network_args"])
        self.assertIn("rank_dropout=0.1", adapted["network_args"])
        self.assertTrue(any(value.startswith("loraplus_lr_ratio=") for value in adapted["network_args"]))
        self.assertEqual(adapted["sample_uncond_skip_layers"], "")
        self.assertEqual(adapted["logit_mean"], -1.09)

        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from moss_image_train_network import setup_parser
        parser = setup_parser()
        supported = {action.dest for action in parser._actions}
        self.assertEqual(set(adapted) - supported, set())

    def test_ui_defaults_survive_native_toml_loading(self):
        from backend.training import toml_writer
        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.args import read_config_from_file
        from moss_image_train_network import setup_parser

        config = moss_config()
        adapted, _ = adapt_config(config)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "training.toml"
            path.write_text(toml_writer.dumps(adapted), encoding="utf-8")
            parser = setup_parser()
            argv = ["moss_image_train_network.py", "--config_file", str(path)]
            with patch("sys.argv", argv):
                loaded = read_config_from_file(parser.parse_args(argv[1:]), parser)
        for key in ("network_dim", "network_alpha", "network_module", "gradient_checkpointing",
                    "timestep_sampling", "weighting_scheme", "logit_mean", "logit_std",
                    "discrete_flow_shift", "lr_scheduler", "mixed_precision", "moss_max_token_length",
                    "enable_multiline_caption", "multiline_caption_separator", "convrot_int8",
                    "convrot_int8_text_encoder", "convrot_int8_bwd", "sample_uncond_skip_layers"):
            with self.subTest(key=key):
                self.assertEqual(getattr(loaded, key), config[key])

    def test_anima_and_sdxl_parameters_do_not_leak(self):
        adapted, _ = adapt_config(moss_config(qwen3="anima.safetensors", qwen3_max_token_length=512,
                                             vae_use_2d=True, min_snr_gamma=5, noise_offset=0.1))
        for key in ("qwen3", "qwen3_max_token_length", "vae_use_2d", "min_snr_gamma", "noise_offset"):
            self.assertNotIn(key, adapted)

    def test_model_paths_are_required_and_lycoris_is_rejected(self):
        for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
            with self.subTest(key=key):
                self.assertTrue(any(key in error for error in validate_training_config(moss_config(**{key: ""}))))
        config = moss_config(network_module="lycoris.kohya")
        self.assertTrue(validate_training_config(config))
        with self.assertRaises(TrainingProfileError):
            resolve_training_profile(config)
        with self.assertRaises(ValueError):
            adapt_config(config)
        for module in ("networks.loha", "networks.lokr"):
            with self.subTest(module=module):
                self.assertTrue(validate_training_config(moss_config(network_module=module)))
                with self.assertRaises(ValueError):
                    adapt_config(moss_config(network_module=module))

    def test_bounds_and_compile_block_swap_contract(self):
        self.assertEqual(validate_training_config(moss_config(blocks_to_swap=40, resolution="1040,768")), [])
        adapted, warnings = adapt_config(moss_config(blocks_to_swap=40, compile=True))
        self.assertIs(adapted["compile"], True)
        self.assertFalse(any("disabling compile" in warning for warning in warnings))
        for overrides in ({"blocks_to_swap": 41}, {"moss_max_token_length": 4097},
                          {"resolution": "1032,768"}, {"sample_width": 1032},
                          {"sample_uncond_skip_layers": "42"}, {"sample_uncond_skip_layers": "-1"},
                          {"sample_uncond_skip_layers": "22,"},
                          {"blocks_to_swap": 1, "cpu_offload_checkpointing": True},
                          {"compile": True, "compile_fullgraph": True, "split_attn": True}):
            with self.subTest(overrides=overrides):
                self.assertTrue(validate_training_config(moss_config(**overrides)))

    def test_cached_caption_dropout_and_text_encoder_training_contract(self):
        self.assertEqual(validate_training_config(moss_config(caption_dropout_rate=0.1)), [])
        for overrides in ({"network_train_unet_only": False}, {"shuffle_caption": True},
                          {"caption_tag_dropout_rate": 0.1}, {"caption_dropout_every_n_epochs": 1}):
            self.assertTrue(validate_training_config(moss_config(**overrides)))
        self.assertEqual(validate_training_config(moss_config(
            network_train_unet_only=False, cache_text_encoder_outputs=False,
            cache_text_encoder_outputs_to_disk=False)), [])

    def test_yaml_round_trip_preserves_profile_and_empty_skip_layers(self):
        original = moss_config(enable_preview=True, sample_uncond_skip_layers="", train_text_embedder=True,
                               convrot_int8=True, positive_prompts="第一行\n第二行")
        restored = extract_training_form(build_training_config(original, profile_id=PROFILE_ID))
        for key in ("sample_uncond_skip_layers", "train_text_embedder", "convrot_int8",
                    "positive_prompts", "text_encoder", "model_train_type", "moss_max_token_length"):
            self.assertEqual(restored[key], original[key])

    def test_sampling_preserves_multiline_and_layout_delimiters(self):
        prompt = '标题 --n 保持原文\n{"items": [{"text": "你好"}]}'
        negative = "模糊\n水印"
        prompts = json.loads(get_sample_prompts(moss_config(positive_prompts=prompt, negative_prompts=negative)))
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0]["prompt"], prompt)
        self.assertEqual(prompts[0]["negative_prompt"], negative)
        self.assertEqual((prompts[0]["sample_steps"], prompts[0]["scale"], prompts[0]["flow_shift"]), (50, 3, 5))

    def test_native_toml_import_restores_network_controls_and_keeps_custom_args(self):
        restored = extract_form({"network_args": ["train_llm_adapter=True", "rank_dropout=0.2",
                                                  "loraplus_lr_ratio=4", "network_reg_dims=layers.*=8"]})
        self.assertIs(restored["train_text_embedder"], True)
        self.assertIs(restored["enable_loraplus"], True)
        self.assertEqual(restored["rank_dropout"], 0.2)
        self.assertEqual(restored["network_args_custom"], "network_reg_dims=layers.*=8")
        adapted, _ = adapt_config(moss_config(**restored))
        self.assertIn("train_llm_adapter=True", adapted["network_args"])
        self.assertIn("network_reg_dims=layers.*=8", adapted["network_args"])

    def test_embedder_aliases_round_trip_and_ui_can_disable_raw_alias(self):
        restored = extract_form({"network_args": ["train_llm_adapter=False", "train_text_embedder=True",
                                                  "rank_dropout=0.1", "rank_dropout=0.2"]})
        self.assertIs(restored["train_text_embedder"], True)
        self.assertEqual(restored["rank_dropout"], 0.2)
        adapted, _ = adapt_config(moss_config(train_text_embedder=False,
                                              network_args_custom="train_text_embedder=true"))
        self.assertNotIn("train_text_embedder=true", adapted["network_args"])
        self.assertIn("train_llm_adapter=False", adapted["network_args"])

    def test_shard_preflight_checks_all_required_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {key: str(root / f"{key}.safetensors") for key in ("pretrained_model_name_or_path", "text_encoder", "vae")}
            for path in paths.values():
                Path(path).touch()
            self.assertEqual(validate_model_files(paths), [])
            paths["text_encoder"] = str(root / "model-00001-of-00002.safetensors")
            Path(paths["text_encoder"]).touch()
            self.assertTrue(any("00002" in error for error in validate_model_files(paths)))
            (root / "model-00002-of-00002.safetensors").touch()
            self.assertEqual(validate_model_files(paths), [])

    def test_quantized_models_reject_premerging_lora(self):
        for flag in ("convrot_int8", "convrot_int8_text_encoder"):
            for weights in ("prior.safetensors", ["prior.safetensors"]):
                with self.subTest(flag=flag, weights=weights):
                    config = moss_config(**{flag: True}, base_weights=weights)
                    self.assertTrue(any("base_weights" in error for error in validate_training_config(config)))
                    with self.assertRaises(ValueError):
                        adapt_config(config)
            self.assertEqual(validate_training_config(moss_config(**{flag: True}, base_weights="")), [])
        self.assertEqual(validate_training_config(moss_config(base_weights="prior.safetensors")), [])

    def test_premerge_preflight_detects_quantization_in_any_model_shard(self):
        import numpy as np
        from safetensors.numpy import save_file

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = moss_config(base_weights=["prior.safetensors"])
            for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
                path = root / f"{key}.safetensors"
                save_file({"layer.weight": np.ones((2, 2), dtype=np.float32)}, str(path))
                config[key] = str(path)
            self.assertEqual(validate_model_files(config), [])
            for key in ("pretrained_model_name_or_path", "text_encoder"):
                original = config[key]
                shards = [root / f"{key}-{index:05d}-of-00002.safetensors" for index in (1, 2)]
                save_file({"layer.weight": np.ones((2, 2), dtype=np.float32)}, str(shards[0]))
                save_file({"layer.comfy_quant": np.array([123, 125], dtype=np.uint8)}, str(shards[1]))
                config[key] = str(shards[0])
                with self.subTest(key=key):
                    self.assertTrue(any("base_weights" in error for error in validate_model_files(config)))
                    self.assertEqual(validate_model_files({**config, "base_weights": ""}), [])
                config[key] = original
            Path(config["pretrained_model_name_or_path"]).write_bytes(b"invalid header")
            self.assertTrue(any("Cannot inspect" in error for error in validate_model_files(config)))

    def test_multiline_candidate_preflight_uses_real_dataset_captions(self):
        with tempfile.TemporaryDirectory() as directory:
            subset = Path(directory) / "1_character"
            subset.mkdir()
            Image.new("RGB", (16, 16)).save(subset / "image.png")
            caption = subset / "image.txt"
            config = moss_config(train_data_dir=directory)
            caption.write_text("first line\nsecond line", encoding="utf-8")
            self.assertEqual(validate_captions(config), [])
            caption.write_text("first\n---===--- # alternative\nsecond", encoding="utf-8")
            self.assertTrue(validate_captions(config))
            config.update(cache_text_encoder_outputs=False, cache_text_encoder_outputs_to_disk=False)
            self.assertEqual(validate_captions(config), [])

    def test_caption_preflight_matches_upstream_face_crop_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            subset = Path(directory) / "1_character"
            subset.mkdir()
            Image.new("RGB", (16, 16)).save(subset / "image_0_0_16_16.png")
            caption = subset / "image.txt"
            caption.write_text("first\n---===---\nsecond", encoding="utf-8")
            self.assertTrue(validate_captions(moss_config(train_data_dir=directory)))
            caption.write_text("", encoding="utf-8")
            self.assertTrue(validate_captions(moss_config(train_data_dir=directory)))

    def test_moss_te_cache_is_checked_and_deleted_without_touching_latents(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "image_moss_te.npz"
            latent = root / "image_1024x1024_moss.npz"
            np.savez(cache, caption_dropout_rate=np.float32(0.1))
            np.savez(latent, latents=np.zeros((1,)))
            warnings = check_te_cache(moss_config(train_data_dir=directory,
                                                   cache_text_encoder_outputs_to_disk=True), PROFILE_ID)
            self.assertTrue(any(warning["code"] == "rateMismatch" for warning in warnings))
            self.assertEqual(delete_te_cache([directory]), (1, []))
            self.assertTrue(latent.exists())


class MossImageNativeNetworkTests(unittest.TestCase):
    def test_embedder_weights_reload_for_supported_network(self):
        import torch
        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.moss_image_models import MossImage

        def model():
            return MossImage(dim=64, ffn_dim=96, num_heads=4, num_layers=2,
                             text_dim=24, freq_dim=16, latent_channels=8)

        for module_name in ("networks.lora_generic",):
            with self.subTest(module=module_name), tempfile.TemporaryDirectory() as directory:
                module = importlib.import_module(module_name)
                source = model()
                network = module.create_network(1.0, 4, 4, None, [None], source, train_llm_adapter="true")
                self.assertTrue(any("text_embedder" in layer.lora_name for layer in network.unet_loras))
                network.apply_to([None], source, apply_text_encoder=False)
                path = str(Path(directory) / "network.safetensors")
                network.save_weights(path, torch.float32, {})
                for inference in (False, True):
                    target = model()
                    restored, weights = module.create_network_from_weights(1.0, path, None, [None], target,
                                                                           for_inference=inference)
                    restored.apply_to([None], target, apply_text_encoder=False)
                    restored.load_state_dict(weights, strict=True)

    def test_small_native_networks_produce_gradients(self):
        import torch
        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from library.moss_image_models import MossImage

        for module_name in ("networks.lora_generic",):
            with self.subTest(module=module_name):
                torch.manual_seed(42)
                model = MossImage(dim=64, ffn_dim=96, num_heads=4, num_layers=2,
                                  text_dim=24, freq_dim=16, latent_channels=8)
                model.requires_grad_(False)
                base_state = {key: value.clone() for key, value in model.state_dict().items()}
                module = importlib.import_module(module_name)
                network = module.create_network(1.0, 4, 4, None, [None], model)
                self.assertEqual(len(network.unet_loras), 12)
                network.apply_to([None], model, apply_text_encoder=False, apply_unet=True)
                network.train()
                inputs = (torch.randn(1, 8, 2, 2), torch.tensor([500.0]),
                          torch.randn(1, 4, 24), torch.ones(1, 4, dtype=torch.int32))
                output = model(*inputs)
                output.square().mean().backward()
                gradients = [parameter.grad for parameter in network.parameters() if parameter.grad is not None]
                self.assertTrue(gradients)
                self.assertTrue(all(torch.isfinite(gradient).all() for gradient in gradients))
                self.assertGreater(sum(gradient.abs().sum().item() for gradient in gradients), 0)
                torch.optim.SGD(network.parameters(), lr=0.1).step()
                network.eval()
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "network.safetensors"
                    network.save_weights(str(path), torch.float32, {})
                    restored_model = MossImage(dim=64, ffn_dim=96, num_heads=4, num_layers=2,
                                               text_dim=24, freq_dim=16, latent_channels=8)
                    restored_model.load_state_dict(base_state)
                    restored_network, weights = module.create_network_from_weights(
                        1.0, str(path), None, [None], restored_model)
                    restored_network.apply_to([None], restored_model, apply_text_encoder=False, apply_unet=True)
                    restored_network.load_state_dict(weights)
                    restored_network.eval()
                    torch.testing.assert_close(restored_model(*inputs), model(*inputs))


class MossImageLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_writes_native_config_dataset_and_structured_prompts(self):
        import tomllib
        from backend.server.routes import training as routes
        from backend.tasks import TaskManager

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / "train" / "1_character"
            subset.mkdir(parents=True)
            Image.new("RGB", (64, 64)).save(subset / "image.png")
            (subset / "image.txt").write_text("caption\nsecond line", encoding="utf-8")
            paths = {}
            for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
                path = root / f"{key}.safetensors"
                path.touch()
                paths[key] = str(path)
            form = moss_config(**paths, train_data_dir=str(subset.parent), output_dir=str(root / "artifacts"),
                               timestep_sampling="shift", subset_timestep_offsets={"1_character": 0.25},
                               enable_preview=True, positive_prompts="title\nsecond line",
                               sample_uncond_skip_layers="", log_timestep_count=True)
            with ExitStack() as stack:
                for name, value in (("tm", TaskManager()), ("OUTPUT_DIR", root / "runs"),
                                    ("AUTOSAVE_DIR", root / "autosave")):
                    stack.enter_context(patch.object(routes, name, value))
                launch = stack.enter_context(patch.object(routes, "run_train", return_value={"status": "success"}))
                result = await routes._prepare_training(routes._create_toml_file_reserved, dict(form))
            self.assertEqual(result["status"], "success", result)
            self.assertIn("moss_image_train_network.py", launch.call_args.args[1])
            self.assertEqual(launch.call_args.kwargs["engine_id"], "sd_scripts")
            native = tomllib.loads(Path(launch.call_args.args[0]).read_text(encoding="utf-8"))
            self.assertEqual(native["sample_uncond_skip_layers"], "")
            self.assertNotIn("engine_id", native)
            self.assertNotIn("subset_timestep_offsets", native)
            prompts_path = Path(native["sample_prompts"])
            self.assertEqual(prompts_path.suffix, ".json")
            self.assertEqual(json.loads(prompts_path.read_text(encoding="utf-8"))[0]["prompt"], "title\nsecond line")
            dataset_path = Path(launch.call_args.kwargs["extra_args"][1])
            dataset = tomllib.loads(dataset_path.read_text(encoding="utf-8"))
            self.assertEqual(dataset["datasets"][0]["subsets"][0]["custom_attributes"]["timestep_sampling"]["offset"], 0.25)
            self.assertEqual(launch.call_args.kwargs["run_metadata"]["profile_id"], PROFILE_ID)
