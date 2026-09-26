import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backend.training.adapter import adapt_config
from backend.training.attention_config import normalize_attention_config
from backend.training.field_registry import get_all_fields
from backend.training.supervisor import detect_attention_backend
from backend.training.training_config import build_training_config, extract_training_form


class RetiredFlashTests(unittest.TestCase):
    def test_retired_options_are_not_offered(self):
        for field in get_all_fields():
            if field["key"] in ("attn_mode", "krea_attention_backend"):
                self.assertFalse({"flash", "flash_attn"} & {item["v"] for item in field["options"]})

    def test_legacy_choices_migrate_idempotently(self):
        config = {"attn_mode": "flash", "krea_attention_backend": "flash_attn", "split_attn": True}
        normalize_attention_config(config)
        normalize_attention_config(config)
        self.assertEqual(config, {"attn_mode": "torch", "krea_attention_backend": "sdpa", "split_attn": True})

    def test_old_sdpa_alias_and_other_backends(self):
        config = {"attn_mode": "sdpa", "krea_attention_backend": "xformers"}
        normalize_attention_config(config)
        self.assertEqual(config, {"attn_mode": "torch", "krea_attention_backend": "xformers"})

    def test_legacy_document_load_and_save(self):
        form = extract_training_form({"schema_version": 1, "form": {
            "model_train_type": "anima-lora", "attn_mode": "flash"}})
        self.assertEqual(form["attn_mode"], "torch")
        document = build_training_config({"attn_mode": "flash"}, profile_id="anima-lora")
        self.assertEqual(extract_training_form(document)["attn_mode"], "torch")

    def test_adapter_does_not_pass_old_flash_to_vendor(self):
        result, _ = adapt_config({"model_train_type": "anima-lora", "attn_mode": "flash"})
        self.assertEqual(result["attn_mode"], "torch")

    def test_native_and_legacy_choices_do_not_probe_extensions(self):
        with patch("backend.training.supervisor._detect_available_attn") as probe:
            for choice in ("torch", "sdpa", "flash"):
                self.assertEqual(detect_attention_backend(choice), ("torch", ""))
        probe.assert_not_called()

    def test_broken_package_is_never_executed_in_training_processes(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "flash_attn"
            package.mkdir()
            package_file = package / "__init__.py"
            source = "raise OSError('old incompatible DLL must never load')\n"
            package_file.write_text(source, encoding="utf-8")
            env = os.environ.copy()
            env["PYTHONPATH"] = os.pathsep.join([
                str(root / "tools/python_startup"), str(root), directory,
                str(root / "vendor/sd-scripts"), str(root / "vendor/musubi-tuner/src"),
            ])
            script = (
                "import importlib.util; assert importlib.util.find_spec('flash_attn') is None; "
                "from library import attention as sd; "
                "from musubi_tuner.modules import attention as mu; "
                "assert sd.flash_attn is None and mu.flash_attn is None; print('SDPA ready')"
            )
            for _ in range(2):
                result = subprocess.run([sys.executable, "-X", "utf8", "-c", script],
                    cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=40)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("SDPA ready", result.stdout)
                self.assertNotIn("flash-attn", result.stderr)
                self.assertNotIn("old incompatible DLL", result.stderr)
            self.assertEqual(package_file.read_text(encoding="utf-8"), source)
