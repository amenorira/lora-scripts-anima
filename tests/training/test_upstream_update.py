"""Product regressions for sd-scripts 0.12.2 integration."""
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import ExitStack
from types import MethodType
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from backend.training.config.adapter import adapt_config
from backend.training.config.moss_image import validate_captions
from backend.training.config.option_contracts import validate_sd_option_dependencies
from backend.training.cache.te_cache_check import check_te_cache
from backend.training.config.training_config import build_training_config, extract_training_form
from tests.training.test_moss_image import moss_config


class BlockSwapConfigTests(unittest.TestCase):
    def test_regularization_runner_uses_current_inference_swap_contract(self):
        from backend.training.datasets.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        from backend.regularization.worker import AnimaRunner
        from library import anima_models, anima_utils, anima_train_utils, custom_offloading_utils
        from library import strategy_anima

        model = MagicMock(num_blocks=4, blocks=[])
        model.eval.return_value = model
        model.requires_grad_.return_value = model
        model.to.return_value = model
        # Use the real upstream method, so passing a legacy device object fails.
        model.enable_block_swap = MethodType(anima_models.Anima.enable_block_swap, model)
        encoder, vae = MagicMock(), MagicMock()
        settings = dict(gpu_index=0, precision="bf16", dit="unused", text_encoder="unused",
                        vae="unused", blocks_to_swap=1, memory_mode="manual")
        with ExitStack() as stack:
            stack.enter_context(patch("torch.cuda.is_available", return_value=True))
            stack.enter_context(patch("torch.cuda.set_device"))
            stack.enter_context(patch.object(anima_utils, "load_anima_model", return_value=model))
            stack.enter_context(patch.object(anima_utils, "load_qwen3_text_encoder", return_value=(encoder, None)))
            stack.enter_context(patch.object(anima_train_utils, "load_qwen_image_vae", return_value=vae))
            stack.enter_context(patch.object(strategy_anima, "AnimaTokenizeStrategy"))
            factory = stack.enter_context(patch.object(custom_offloading_utils, "create_offloader"))
            AnimaRunner(settings, lambda *args: None, lambda: None)
        config = factory.call_args.args[-1]
        self.assertIsInstance(config, custom_offloading_utils.BlockSwapConfig)
        self.assertFalse(config.supports_backward)
        self.assertFalse(config.h2d_only)
        model.switch_block_swap_for_inference.assert_called_once()

    def test_h2d_options_survive_saved_config_and_toml_for_both_profiles(self):
        for profile, module in (("anima-lora", "networks.lora_anima"),
                                ("moss-image-lora", "networks.lora_generic")):
            with self.subTest(profile=profile):
                config = moss_config(model_train_type=profile, network_module=module,
                                     blocks_to_swap=4, block_swap_h2d_only=True,
                                     block_swap_ring_size=1, use_pinned_memory_for_block_swap=True)
                saved = build_training_config(config, profile_id=profile)
                restored = extract_training_form(saved)
                native, _ = adapt_config(restored)
                self.assertTrue(native["block_swap_h2d_only"])
                self.assertTrue(native["gradient_checkpointing"])
                self.assertEqual(native["block_swap_ring_size"], 1)
                self.assertTrue(native["use_pinned_memory_for_block_swap"])
                native, _ = adapt_config({**restored, "block_swap_h2d_only": False})
                self.assertNotIn("block_swap_ring_size", native)
                self.assertNotIn("use_pinned_memory_for_block_swap", native)

    def test_invalid_h2d_combinations_are_rejected_before_launch(self):
        base = moss_config(blocks_to_swap=3, block_swap_h2d_only=True)
        for overrides, key in (
            ({"blocks_to_swap": 0}, "blocks_to_swap"),
            ({"gradient_checkpointing": False}, "gradient_checkpointing"),
            ({"block_swap_ring_size": 1.5}, "block_swap_ring_size"),
            ({"block_swap_ring_size": 0}, "block_swap_ring_size"),
            ({"block_swap_ring_size": float("inf")}, "block_swap_ring_size"),
            ({"block_swap_ring_size": True}, "block_swap_ring_size"),
            ({"cpu_offload_checkpointing": True}, "blocks_to_swap"),
            ({"unsloth_offload_checkpointing": True}, "blocks_to_swap"),
            ({"model_train_type": "sdxl-lora"}, "block_swap_h2d_only"),
        ):
            config = {**base, **overrides}
            with self.subTest(overrides=overrides):
                self.assertTrue(any(key in error for error in validate_sd_option_dependencies(config)))
                with self.assertRaises(ValueError):
                    adapt_config(config)


class MossCaptionCacheTests(unittest.TestCase):
    def test_multicandidate_preflight_allows_both_cache_modes_but_checks_read_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            subset = Path(directory) / "1_character"
            subset.mkdir()
            Image.new("RGB", (64, 64)).save(subset / "image.png")
            caption = subset / "image.txt"
            caption.write_text("long\nsecond line\n---===---\nshort", encoding="utf-8")
            for disk in (False, True):
                config = moss_config(train_data_dir=directory, cache_text_encoder_outputs=True,
                                     cache_text_encoder_outputs_to_disk=disk)
                self.assertEqual(validate_captions(config), [])
            caption.write_bytes(b"\xff")
            self.assertTrue(validate_captions(config))

    def test_new_moss_cache_uses_auto_rebuild_without_losing_legacy_or_dropout_warnings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "image_moss_te.npz"
            caption = root / "image.txt"
            caption.write_text("changed caption", encoding="utf-8")
            config = moss_config(train_data_dir=directory, cache_text_encoder_outputs_to_disk=True)
            for modern, skip, expect_caption_warning in (
                (True, False, False), (True, True, True), (False, False, True),
            ):
                with self.subTest(modern=modern, skip=skip):
                    data = {"caption_dropout_rate": np.float32(0.25)}
                    if modern:
                        data.update(num_candidates=np.int32(1), caption_0=np.array("old caption"))
                    np.savez(cache, **data)
                    os.utime(caption, (cache.stat().st_mtime + 10,) * 2)
                    warnings = check_te_cache({**config, "skip_cache_check": skip}, "moss-image-lora")
                    codes = {warning["code"] for warning in warnings}
                    self.assertEqual("captionModified" in codes, expect_caption_warning)
                    self.assertIn("rateMismatch", codes)
