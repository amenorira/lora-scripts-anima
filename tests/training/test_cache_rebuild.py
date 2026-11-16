from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from backend.training.cache.krea2_cache import krea2_cache_files
from backend.training.cache.rebuild import clear_cache_files, prepare_cache_choice, sd_scripts_cache_files


class CacheRebuildTest(unittest.IsolatedAsyncioTestCase):
    async def test_sd_scripts_choice_limits_deletion_to_confirmed_cache_paths(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            train, reg, ignored = (root / name for name in ("train/1_subject", "reg/1_class", "train/0_disabled"))
            for directory in (train, reg, ignored):
                directory.mkdir(parents=True)
            latent = train / "old_0512x0768_anima.npz"
            text = reg / "example_anima_te.npz"
            protected = [
                train / "photo.png", train / "photo.txt", train / "photo_moss_te.npz",
                train / "other_anima.npz", ignored / "example_anima_te.npz",
            ]
            for path in [latent, text, *protected]:
                path.touch()
            config = {"train_data_dir": str(train.parent), "reg_data_dir": str(reg.parent)}
            arguments = sd_scripts_cache_files, config, "anima-lora"
            files, prompt = await prepare_cache_choice(None, *arguments)
            self.assertFalse(files)
            self.assertEqual((prompt["data"]["latents"], prompt["data"]["text"]), (1, 1))
            self.assertTrue(latent.exists())
            self.assertTrue(text.exists())
            self.assertEqual(await prepare_cache_choice("keep", *arguments), (set(), None))

            new_cache = train / "new_anima_te.npz"
            new_cache.touch()
            files, changed = await prepare_cache_choice(prompt["data"]["scope"], *arguments)
            self.assertFalse(files)
            self.assertEqual(changed["data"]["text"], 2)
            files, error = await prepare_cache_choice(changed["data"]["scope"], *arguments)
            self.assertIsNone(error)
            self.assertIsNone(await clear_cache_files(files))
            self.assertFalse(any(path.exists() for path in (latent, text, new_cache)))
            self.assertTrue(all(path.exists() for path in protected))

    async def test_krea2_scans_active_cache_namespace_and_reports_delete_failure(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source, cache = root / "source", root / "cache"
            source.mkdir()
            cache.mkdir()
            (source / "sample.png").touch()
            (source / "sample.txt").touch()
            latent, text = cache / "sample_0512x0512_kr2.safetensors", cache / "sample_kr2_te.safetensors"
            for path in (latent, text, cache / "weights.safetensors"):
                path.touch()
            config = {"train_data_dir": str(source), "dataset_cache_dir": str(cache)}
            self.assertEqual(krea2_cache_files(config), ({latent}, {text}))
            with patch.object(type(latent), "unlink", side_effect=PermissionError("locked")):
                error = await clear_cache_files({latent, text})
            self.assertEqual(error["data"]["errorCode"], "trainingCacheDeleteFailed")
            self.assertEqual(len(error["data"]["errorDetails"]), 2)
