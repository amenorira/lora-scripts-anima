"""Selected-model inspection reads metadata without loading model weights."""
import json
from pathlib import Path
import tempfile
import unittest

from backend.training.execution.krea2_preflight import inspect_krea2_checkpoint_format


def checkpoint_header(dtype, convrot=False):
    tensors = {"blocks.0.attn.wq.weight": {"dtype": dtype, "shape": [2, 2], "data_offsets": [0, 8]}}
    if convrot:
        tensors["blocks.0.attn.wq.comfy_quant"] = {"dtype": "U8", "shape": [2], "data_offsets": [8, 10]}
    return json.dumps(tensors).encode()


class Krea2ModelFormatTests(unittest.TestCase):

    def test_format_follows_tensor_metadata_instead_of_filename(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "int8_convrot.safetensors"
            for dtype, convrot, expected in (("BF16", False, "unquantized"),
                                             ("I8", True, "convrot_int8"),
                                             ("I8", False, "unknown"), ("F8_E4M3", False, "fp8")):
                with self.subTest(dtype=dtype, convrot=convrot):
                    header = checkpoint_header(dtype, convrot)
                    path.write_bytes(len(header).to_bytes(8, "little") + header)
                    self.assertEqual(inspect_krea2_checkpoint_format(path), {"format": expected})
            self.assertEqual(inspect_krea2_checkpoint_format(Path(temp) / "missing.safetensors"), {"format": "unknown"})
