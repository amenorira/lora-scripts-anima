import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.user_defaults import ensure_user_defaults


ROOT = Path(__file__).resolve().parents[2]


class UserDefaultsTests(unittest.TestCase):
    def test_missing_defaults_are_seeded_and_existing_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            defaults = root / "tools/defaults"
            defaults.mkdir(parents=True)
            for name in ("sample_prompts.txt", "accelerate.yaml"):
                (defaults / name).write_bytes((ROOT / "tools/defaults" / name).read_bytes())
            with patch.dict(os.environ, {"HF_HOME": str(root / "external-cache")}):
                ensure_user_defaults(root)
                sample = root / "config/sample_prompts.txt"
                accelerate = root / "external-cache/accelerate/default_config.yaml"
                self.assertEqual(sample.read_bytes(), (defaults / "sample_prompts.txt").read_bytes())
                self.assertEqual(accelerate.read_bytes(), (defaults / "accelerate.yaml").read_bytes())
                for path in (sample, accelerate):
                    path.write_bytes(b"personal settings\r\n\x00")
                ensure_user_defaults(root)
                for path in (sample, accelerate):
                    self.assertEqual(path.read_bytes(), b"personal settings\r\n\x00")


if __name__ == "__main__":
    unittest.main()
