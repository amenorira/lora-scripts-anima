import tempfile
import unittest
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file

from backend.regularization.planning import Settings, identity
from backend.training.config.validation import validate_training_config
from backend.training.execution.sd_scripts_preflight import check_input_files
from backend.training.shape_preview import _anima_config
from tests.helpers import valid_training_config


def checkpoint(path, indices, prefix):
    save_file({f"{prefix}blocks.{i}.weight": np.zeros(1, dtype=np.float32) for i in indices}, path)


class AnimaBlockTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_depth_reaches_preview_training_and_regularization(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subset = root / "1_test"
            subset.mkdir()
            (subset / "sample.png").touch()
            for blocks, prefix in ((28, "net."), (40, "model.diffusion_model.")):
                with self.subTest(blocks=blocks):
                    model = root / "anima-00001-of-00002.safetensors"
                    checkpoint(model, range(0, blocks // 2), prefix)
                    checkpoint(root / "anima-00002-of-00002.safetensors", range(blocks // 2, blocks), prefix)
                    self.assertEqual(_anima_config(model)["num_blocks"], blocks)
                    config = valid_training_config(
                        pretrained_model_name_or_path=str(model), train_data_dir=str(root),
                        qwen3=str(root), vae=str(model), gradient_checkpointing=True,
                        blocks_to_swap=blocks - 2, gradient_checkpointing_skip_blocks=blocks,
                    )
                    self.assertEqual(validate_training_config(config), [])
                    _, error = await check_input_files(config, "anima-lora")
                    self.assertIsNone(error)
                    settings = Settings(dit=str(model), text_encoder=str(model), vae=str(model),
                                        memory_mode="manual", blocks_to_swap=blocks - 2)
                    identity(settings, root, [])
                    with self.assertRaisesRegex(ValueError, "blocks_to_swap"):
                        identity(settings.model_copy(update={"blocks_to_swap": blocks - 1}), root, [])
                    for key in ("blocks_to_swap", "gradient_checkpointing_skip_blocks"):
                        _, error = await check_input_files({**config, key: config[key] + 1}, "anima-lora")
                        self.assertIn(key, error["message"])

    def test_preview_without_weights_and_incomplete_checkpoint(self):
        self.assertEqual(_anima_config()["num_blocks"], 28)
        with tempfile.TemporaryDirectory() as folder:
            model = Path(folder) / "custom.safetensors"
            with self.assertRaisesRegex(ValueError, "Cannot read Anima"):
                _anima_config(model)
            checkpoint(model, [0, 2], "")
            with self.assertRaisesRegex(ValueError, "Missing Anima DiT blocks"):
                _anima_config(model)
