"""Selected-model inspection reads metadata without loading model weights."""
import asyncio
import io
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.training.krea2_preflight import inspect_krea2_checkpoint_format


def checkpoint_header(dtype, convrot=False):
    tensors = {"blocks.0.attn.wq.weight": {"dtype": dtype, "shape": [2, 2], "data_offsets": [0, 8]}}
    if convrot:
        tensors["blocks.0.attn.wq.comfy_quant"] = {"dtype": "U8", "shape": [2], "data_offsets": [8, 10]}
    return json.dumps(tensors).encode()


class Krea2ModelFormatTests(unittest.TestCase):
    def test_model_inspection_import_does_not_load_codec_or_field_catalog(self):
        from tools.runtime_paths import ROOT

        script = """
import sys
from backend.training.krea2_preflight import inspect_krea2_checkpoint_format
for name in ('backend.training.musubi_krea2', 'backend.training.krea2_fields', 'torch', 'fastapi'):
    assert name not in sys.modules, name
"""
        result = subprocess.run([sys.executable, "-B", "-c", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_inspection_never_reads_the_tensor_payload_and_bounds_header_size(self):
        header = checkpoint_header("I8", True)

        class HeaderOnlyStream(io.BytesIO):
            def __init__(self):
                super().__init__(len(header).to_bytes(8, "little") + header + b"tensor-payload")
                self.reads = []

            def read(self, size=-1):
                self.reads.append(size)
                if size < 0 or self.tell() + size > 8 + len(header):
                    raise AssertionError("Tensor payload must not be read")
                return super().read(size)

        stream = HeaderOnlyStream()
        with patch.object(Path, "open", return_value=stream):
            self.assertEqual(inspect_krea2_checkpoint_format(Path("renamed.safetensors")), {"format": "convrot_int8"})
        self.assertEqual(stream.reads, [8, len(header)])
        with patch.object(Path, "open", return_value=io.BytesIO((16 * 1024 * 1024 + 1).to_bytes(8, "little"))):
            self.assertEqual(inspect_krea2_checkpoint_format(Path("oversized.safetensors")), {"format": "unknown"})

    def test_selected_model_route_handles_valid_and_incomplete_paths(self):
        from backend.server.routes.training import krea2_model_format
        from tests.helpers import json_request

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "renamed.safetensors"
            header = checkpoint_header("I8", True)
            path.write_bytes(len(header).to_bytes(8, "little") + header)
            result = asyncio.run(krea2_model_format(json_request({"path": str(path)}))).model_dump()
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["data"], {"format": "convrot_int8"})
            path.unlink()
            result = asyncio.run(krea2_model_format(json_request({"path": str(path)}))).model_dump()
            self.assertEqual(result["data"], {"format": "unknown"})
        for payload in ({}, {"path": []}):
            self.assertEqual(asyncio.run(krea2_model_format(json_request(payload))).status, "fail")
