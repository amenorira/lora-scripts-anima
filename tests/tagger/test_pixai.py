import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from backend.tagger import workspace


class PixAITests(unittest.TestCase):
    def test_pytorch_single_image_reserves_training_resource(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "image.png"
            Image.new("RGB", (2, 2)).save(path)
            source = workspace.scan_source(str(path), False)
            with patch.object(workspace, "training_active", return_value=False), patch.object(
                workspace.tm, "claim_external", return_value=False
            ) as claim:
                with self.assertRaisesRegex(RuntimeError, "task is active"):
                    workspace.create_task({"model_id": "pixai-tagger-v1.0",
                                           "source_token": source["source_token"], "write_captions": False})
            claim.assert_called_once()
