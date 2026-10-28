import json
from pathlib import Path
import tempfile
import unittest
from functools import partial
from contextlib import ExitStack
from unittest.mock import patch

from PIL import Image

from backend.training.fields.field_registry import FIELDS
from backend.training.config.moss_image import DEFAULTS, GROUP, PROFILE_ID
from backend.training.config.network_config import extract_network_form
from backend.training.cache.te_cache_check import check_te_cache, delete_te_cache

extract_form = partial(extract_network_form, model_train_type=PROFILE_ID)


def moss_config(**overrides):
    config = {}
    for field in FIELDS:
        group = field.get("group")
        if group and group != "all" and GROUP not in (group if isinstance(group, list) else [group]):
            continue
        if "default" in field:
            config[field["key"]] = field.get("default_by_group", {}).get(GROUP, field["default"])
    config.update(DEFAULTS)
    config.update(model_train_type=PROFILE_ID, pretrained_model_name_or_path="dit.safetensors",
                  text_encoder="te.safetensors", vae="vae.safetensors", train_data_dir="train",
                  output_dir="output", output_name="moss_test")
    config.update(overrides)
    return config


class MossImageConfigTests(unittest.TestCase):


    def test_moss_te_cache_is_checked_and_deleted_without_touching_latents(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "image_moss_te.npz"
            latent = root / "image_1024x1024_moss.npz"
            np.savez(cache, caption_dropout_rate=np.float32(0.1))
            np.savez(latent, latents=np.zeros((1,)))
            warnings = check_te_cache(moss_config(train_data_dir=directory,
                                                   cache_text_encoder_outputs_to_disk=True), PROFILE_ID)
            self.assertTrue(any(warning["code"] == "rateMismatch" for warning in warnings))
            self.assertEqual(delete_te_cache([directory]), (1, []))
            self.assertTrue(latent.exists())


class MossImageLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_writes_native_config_dataset_and_structured_prompts(self):
        import tomllib
        from backend.server.routes import training as routes
        from backend.training.execution import launch_sd_scripts
        from backend.tasks import TaskManager

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subset = root / "train" / "1_character"
            subset.mkdir(parents=True)
            Image.new("RGB", (64, 64)).save(subset / "image.png")
            (subset / "image.txt").write_text("caption\nsecond line", encoding="utf-8")
            paths = {}
            for key in ("pretrained_model_name_or_path", "text_encoder", "vae"):
                path = root / f"{key}.safetensors"
                path.touch()
                paths[key] = str(path)
            form = moss_config(**paths, train_data_dir=str(subset.parent), output_dir=str(root / "artifacts"),
                               timestep_sampling="shift", subset_timestep_offsets={"1_character": 0.25},
                               enable_preview=True, positive_prompts="title\nsecond line",
                               sample_uncond_skip_layers="", log_timestep_count=True)
            with ExitStack() as stack:
                stack.enter_context(patch.object(routes, "tm", TaskManager()))
                for name, value in (("OUTPUT_DIR", root / "runs"),
                                    ("AUTOSAVE_DIR", root / "autosave")):
                    stack.enter_context(patch.object(launch_sd_scripts, name, value))
                launch = stack.enter_context(patch.object(routes, "run_train", return_value={"status": "success"}))
                result = await routes._prepare_training(routes.launch.prepare_run, dict(form))
            self.assertEqual(result["status"], "success", result)
            self.assertIn("moss_image_train_network.py", launch.call_args.args[1])
            self.assertEqual(launch.call_args.kwargs["engine_id"], "sd_scripts")
            native = tomllib.loads(Path(launch.call_args.args[0]).read_text(encoding="utf-8"))
            self.assertEqual(native["sample_uncond_skip_layers"], "")
            self.assertNotIn("engine_id", native)
            self.assertNotIn("subset_timestep_offsets", native)
            prompts_path = Path(native["sample_prompts"])
            self.assertEqual(prompts_path.suffix, ".json")
            self.assertEqual(json.loads(prompts_path.read_text(encoding="utf-8"))[0]["prompt"], "title\nsecond line")
            dataset_path = Path(launch.call_args.kwargs["extra_args"][1])
            dataset = tomllib.loads(dataset_path.read_text(encoding="utf-8"))
            self.assertEqual(dataset["datasets"][0]["subsets"][0]["custom_attributes"]["timestep_sampling"]["offset"], 0.25)
            self.assertEqual(launch.call_args.kwargs["run_metadata"]["profile_id"], PROFILE_ID)
