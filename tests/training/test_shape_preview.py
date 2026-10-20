"""Compare the shape-only preview with native adapter construction and serialization."""
import json
import importlib
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.training.adapter import adapt_config
from backend.training.shape_preview import inspect_network


def moss_form(**overrides):
    return {
        "model_train_type": "moss-image-lora", "network_module": "networks.lora_generic",
        "network_dim": 16, "network_alpha": 1, "network_train_unet_only": True,
        "network_train_text_encoder_only": False, "train_text_embedder": False,
        "save_precision": "bf16", **overrides,
    }


class ShapePreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.moss = inspect_network(moss_form())
        cls.moss_text = inspect_network(moss_form(train_text_embedder=True))

    def test_moss_full_architecture_and_optional_text_embedder(self):
        result = self.moss
        self.assertEqual(result["moduleCount"], 252)
        self.assertEqual(result["params"], 16 * 42 * (4 * 6144 + 19456 + 11264))
        self.assertEqual(result["weightBytes"], 2 * (result["params"] + 252))
        groups = {row["name"]: row for row in result["groups"]}
        self.assertEqual(len(groups), 6)
        self.assertTrue(all(row["count"] == 42 for row in groups.values()))
        self.assertEqual(groups["layers.*.proj.q"]["shapes"]["lora_down.weight"], [16, 3072])
        self.assertEqual(groups["layers.*.proj.ffn_up_gate"]["shapes"]["lora_up.weight"], [16384, 16])
        self.assertEqual(groups["layers.*.proj.q"]["scale"], 1 / 16)

        result = self.moss_text
        self.assertEqual(result["moduleCount"], 263)
        self.assertEqual(result["params"] - self.moss["params"], 16 * 111616)
        self.assertGreater(result["estimatedBytes"], self.moss["estimatedBytes"])
        groups = {row["name"]: row for row in result["groups"]}
        self.assertEqual(groups["text_embedder.proj"]["in"], 4096)
        qkv = groups["text_embedder.blocks.*.qkv"]
        self.assertEqual((qkv["count"], qkv["in"], qkv["out"]), (2, 3072, 9216))
        self.assertTrue(all(not path.startswith("qwen") for row in groups.values() for path in row["paths"]))

    def test_moss_estimate_matches_native_saved_tensors_and_file_size(self):
        import torch
        from library import moss_image_models
        from safetensors.torch import save

        small = dict(dim=32, ffn_dim=48, num_heads=2, num_layers=2,
                     text_dim=64, freq_dim=16, latent_channels=8)
        algorithms = (("networks.lora_generic", 4), ("networks.loha", 4),
                      ("networks.lokr", 2), ("networks.lokr", 32))
        for (module, rank), (precision, dtype), train_text in itertools.product(
            algorithms, (("bf16", torch.bfloat16), ("fp16", torch.float16), ("float", torch.float32)), (False, True)
        ):
            with self.subTest(module=module, rank=rank, precision=precision, train_text=train_text):
                # Exercise per-layer rank overrides, skips and pattern filtering too.
                form = moss_form(save_precision=precision, train_text_embedder=train_text,
                                 network_module=module, network_dim=rank, network_alpha=0, lokr_factor=4,
                                 network_args_custom="network_reg_dims=layers.0.proj.q=2,layers.1.proj.q=0\n"
                                                     "exclude_patterns=['layers.*.proj.k']")
                with patch.dict(moss_image_models.MOSS_IMAGE_CONFIG, small, clear=True):
                    result = inspect_network(form)
                config, _ = adapt_config(form)
                kwargs = dict(item.split("=", 1) for item in config.get("network_args", []))
                model = moss_image_models.MossImage(**small)
                network = importlib.import_module(module).create_network(1, rank, 0, None, [], model, **kwargs)
                network.apply_to([], model, apply_text_encoder=False)
                self.assertEqual(result["params"], sum(p.numel() for p in network.parameters()))
                saved = {key: tensor.to(dtype) for key, tensor in network.state_dict().items()}
                self.assertEqual(result["weightBytes"], sum(t.numel() * t.element_size() for t in saved.values()))
                self.assertEqual(result["estimatedBytes"], len(save(saved)))
                for row in result["groups"]:
                    for path in row["paths"]:
                        prefix = "lora_unet_" + path.replace(".", "_") + "."
                        shapes = {key[len(prefix):]: list(t.shape) for key, t in saved.items() if key.startswith(prefix)}
                        self.assertEqual(row["shapes"], shapes)
                with tempfile.TemporaryDirectory() as directory:
                    target = Path(directory) / "moss.safetensors"
                    network.save_weights(str(target), dtype, {})
                    with target.open("rb") as stream:
                        header_length = int.from_bytes(stream.read(8), "little")
                        header = json.loads(stream.read(header_length))
                    self.assertIn("__metadata__", header)
                    del header["__metadata__"]
                    bare_length = len(json.dumps(header, separators=(",", ":")).encode("utf-8"))
                    metadata_overhead = header_length - ((bare_length + 7) // 8) * 8
                    self.assertEqual(target.stat().st_size - metadata_overhead, result["estimatedBytes"])

    def test_moss_native_algorithms_cover_main_blocks_and_optional_text_embedder(self):
        for module, algo in (("networks.loha", "loha"), ("networks.lokr", "lokr")):
            for train_text in (False, True):
                with self.subTest(module=module, train_text=train_text):
                    result = inspect_network(moss_form(network_module=module, train_text_embedder=train_text,
                                                       lokr_factor=8))
                    self.assertEqual(result["moduleCount"], 263 if train_text else 252)
                    groups = {row["name"]: row for row in result["groups"]}
                    self.assertTrue(all(row["algo"] == algo for row in groups.values()))
                    self.assertEqual("text_embedder.proj" in groups, train_text)
                    self.assertEqual(groups["layers.*.proj.q"]["count"], 42)
                    self.assertEqual(groups["layers.*.proj.ffn_up_gate"]["out"], 16384)
                    if algo == "loha":
                        baseline = self.moss_text if train_text else self.moss
                        self.assertEqual(result["params"], 2 * baseline["params"])
                        self.assertEqual(groups["layers.*.proj.q"]["shapes"]["hada_w1_a"], [3072, 16])
                    else:
                        self.assertEqual(groups["layers.*.proj.q"]["factor"], 8)
                        self.assertEqual(groups["layers.*.proj.q"]["shapes"]["lokr_w1"], [8, 8])
                    self.assertTrue(all(not path.startswith("qwen") for row in groups.values() for path in row["paths"]))

    def test_unsupported_profiles_and_moss_text_encoder_are_explicit_errors(self):
        for profile in ("sdxl-lora", "krea2-lora"):
            with self.subTest(profile=profile), self.assertRaisesRegex(ValueError, "Only Anima and MOSS"):
                inspect_network(moss_form(model_train_type=profile))
        for overrides in ({"network_train_unet_only": False}, {"dim_from_weights": True},
                          {"save_model_as": "pt"}, {"network_module": "lycoris.kohya"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                inspect_network(moss_form(**overrides))

    def test_anima_preview_still_uses_its_original_architecture(self):
        result = inspect_network(moss_form(model_train_type="anima-lora", network_module="networks.lora_anima"))
        self.assertGreater(result["moduleCount"], 0)
        self.assertTrue(any(row["name"] == "blocks.*.self_attn.q_proj" for row in result["groups"]))
        self.assertGreater(result["estimatedBytes"], result["weightBytes"])

    def test_empty_module_selection_reports_an_error_instead_of_a_zero_estimate(self):
        with self.assertRaisesRegex(ValueError, "No adapter modules matched"):
            inspect_network(moss_form(network_args_custom="exclude_patterns=['.*']"))
