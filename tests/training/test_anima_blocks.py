import pickle
import tempfile
import unittest
from pathlib import Path

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient
from safetensors.numpy import save_file

from backend.regularization.planning import Settings, identity
from backend.server.routes.training import router as training_router
from backend.training.config.validation import validate_training_config
from backend.training.execution.sd_scripts_preflight import check_input_files
from backend.training.shape_preview import ShapePreviewError, _anima_config, inspect_network
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
            with self.assertRaisesRegex(ShapePreviewError, "Cannot read Anima") as read_ctx:
                _anima_config(model)
            self.assertEqual(read_ctx.exception.code, "shapePreviewAnimaCheckpointReadFailed")
            self.assertEqual(read_ctx.exception.params["path"], str(model))
            self.assertTrue(read_ctx.exception.params["detail"])
            checkpoint(model, [0, 2], "")
            with self.assertRaisesRegex(ShapePreviewError, "Missing Anima DiT blocks") as miss_ctx:
                _anima_config(model)
            self.assertEqual(miss_ctx.exception.code, "shapePreviewAnimaCheckpointMissingBlocks")
            self.assertEqual(miss_ctx.exception.params["path"], str(model))

    def test_shape_preview_route_preserves_unknown_exception_message(self):
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch

        app = FastAPI()
        app.include_router(training_router, prefix="/api")
        with ThreadPoolExecutor(max_workers=1) as pool, TestClient(app) as client:
            with patch("backend.training.shape_preview.preview_pool", return_value=pool), patch(
                "backend.training.shape_preview.inspect_network", side_effect=RuntimeError("boom in adapter")
            ):
                resp = client.post("/api/training/shape-preview", json={"model_train_type": "anima-lora"}).json()
        self.assertEqual(resp["status"], "fail")
        self.assertIn("boom in adapter", resp["message"])
        self.assertIsNone(resp.get("data"))

    def test_shape_preview_error_is_picklable_and_coded(self):
        err = ShapePreviewError("shapePreviewUnsupportedModule", "Unsupported / 不支持: q_proj", module="q_proj")
        restored = pickle.loads(pickle.dumps(err))
        self.assertIsInstance(restored, ShapePreviewError)
        self.assertIsInstance(restored, ValueError)
        self.assertEqual(restored.code, "shapePreviewUnsupportedModule")
        self.assertEqual(restored.params, {"module": "q_proj"})
        self.assertEqual(str(restored), "Unsupported / 不支持: q_proj")

        with self.assertRaises(ShapePreviewError) as ctx:
            inspect_network({"model_train_type": "unknown-profile"})
        self.assertEqual(ctx.exception.code, "shapePreviewUnsupportedProfile")
