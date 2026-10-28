import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.training.execution import run_files


class RunDirectoryTests(unittest.TestCase):
    def test_existing_internal_directory_is_preserved_after_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts, internal = root / "artifacts", root / "internal"
            internal.mkdir()
            marker = internal / "config.toml"
            marker.write_text("existing configuration", encoding="utf-8")

            with self.assertRaises(FileExistsError):
                run_files.prepare_run_directories(artifacts, internal)

            self.assertFalse(artifacts.exists())
            self.assertEqual(marker.read_text(encoding="utf-8"), "existing configuration")

    def test_write_probe_failure_only_removes_new_empty_directories(self):
        for resume in (False, True):
            with self.subTest(resume=resume), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                artifacts, internal = root / "artifacts", root / "internal"
                model = artifacts / "existing.safetensors"
                if resume:
                    artifacts.mkdir()
                    model.write_bytes(b"existing weights")

                with patch.object(run_files.tempfile, "mkstemp", side_effect=PermissionError("read-only")):
                    with self.assertRaises(PermissionError):
                        run_files.prepare_run_directories(artifacts, internal, resume=resume)

                self.assertFalse(internal.exists())
                if resume:
                    self.assertEqual(model.read_bytes(), b"existing weights")
                    self.assertEqual(list(artifacts.iterdir()), [model])
                else:
                    self.assertFalse(artifacts.exists())

    def test_shared_artifact_and_internal_directory_is_claimed_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory) / "run"
            owned = []
            run_files.prepare_run_directories(run, run, owned=owned)
            self.assertTrue(run.is_dir())
            self.assertEqual(owned, [run])
            self.assertEqual(list(run.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
