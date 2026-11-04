import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.execution.launch_krea2 import _krea2_error
from backend.training.execution.preparation import training_error
from backend.training.execution.sd_scripts_preflight import check_input_files


class TrainingErrorLocalizationTests(unittest.TestCase):
    def test_error_contract_retains_legacy_message_and_original_diagnostics(self):
        original = {"outputPath": "output"}
        result = training_error("legacy message", original, code="outputDirectoryUnavailable",
                                params={"path": "output"}, details="Permission denied")
        self.assertEqual(original, {"outputPath": "output"})
        self.assertEqual(result["message"], "legacy message")
        self.assertEqual(result["data"]["errorCode"], "outputDirectoryUnavailable")
        self.assertEqual(result["data"]["errorParams"], {"path": "output"})
        self.assertEqual(result["data"]["errorDetails"], "Permission denied")

    def test_regularization_preflight_reports_path_for_each_failure(self):
        with tempfile.TemporaryDirectory() as root:
            config = {"train_data_dir": root, "reg_data_dir": str(Path(root) / "missing")}
            with patch("backend.training.execution.sd_scripts_preflight.train_utils.validate_data_dir", return_value=True):
                _, error = asyncio.run(check_input_files(config, "anima-lora"))
                self.assertEqual(error["data"]["errorCode"], "regDataDirNotFound")
                self.assertEqual(error["data"]["errorParams"], {"path": config["reg_data_dir"]})
                config["reg_data_dir"] = root
                _, error = asyncio.run(check_input_files(config, "anima-lora"))
                self.assertEqual(error["data"]["errorCode"], "regDataDirNoSubfolders")
                self.assertEqual(error["data"]["errorParams"], {"path": root})

    def test_krea_preflight_preserves_error_code_and_diagnostic_list(self):
        errors = ["dit: file not found", "vae: invalid weights"]
        result = _krea2_error(errors, "krea2CacheRequired")
        self.assertEqual(result["data"]["errorCode"], "krea2CacheRequired")
        self.assertEqual(result["data"]["errorDetails"], errors)
        self.assertEqual(result["data"]["errors"], errors)
