import json
from pathlib import Path
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from PIL import Image

from backend.training.fields.field_registry import FIELDS
from backend.training.config.moss_image import DEFAULTS, GROUP, PROFILE_ID


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


class MossImageLaunchTests(unittest.IsolatedAsyncioTestCase):
    async def test_cached_launch_keeps_external_prompts_after_source_changes(self):
        import tomllib
        from backend import constants
        from backend.server.routes import training as routes
        from backend.tasks import TaskManager

        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            subset = root / "train/1_demo"
            subset.mkdir(parents=True)
            Image.new("RGB", (64, 64)).save(subset / "image.png")
            (subset / "image.txt").write_text("caption")
            model = root / "model.safetensors"
            model.touch()
            source = root / "manual.TXT"
            form = moss_config(pretrained_model_name_or_path=str(model), text_encoder=str(model), vae=str(model),
                               train_data_dir=str(subset.parent), output_dir=str(root / "artifacts"),
                               enable_preview=True, sample_at_first=True, positive_prompts="", prompt_file=str(source),
                               cache_text_encoder_outputs=True)
            stack.enter_context(patch.object(routes, "tm", TaskManager()))
            stack.enter_context(patch.object(constants, "OUTPUT_DIR", root / "runs"))
            stack.enter_context(patch.object(constants, "AUTOSAVE_DIR", root / "autosave"))
            launch = stack.enter_context(patch.object(routes, "run_train", return_value={"status": "success", "data": {}}))
            source.write_text("reserved --s 0")
            result = await routes._prepare_training(routes.launch.prepare_run, dict(form))
            self.assertEqual(result.data["errorCode"], "previewConfigInvalid", result)
            launch.assert_not_called()
            structured = source.with_suffix(".json")
            structured.write_text('["cat", {"prompt":"dog","width":"1024"}]')
            result = await routes._prepare_training(routes.launch.prepare_run, form | {"prompt_file": str(structured)})
            self.assertEqual(result.data["errorCode"], "previewConfigInvalid", result)
            self.assertIn("prompt #2, width", result.message)
            launch.assert_not_called()
            structured.write_text('["cat --ss ddim","reserved --s 0",{"prompt":"dog","flow_shift":" 5e0 "}]')
            result = await routes._prepare_training(routes.launch.prepare_run, form | {"prompt_file": str(structured)})
            self.assertEqual(result["status"], "success", result)
            native = tomllib.loads(Path(launch.call_args.args[0]).read_text(encoding="utf-8"))
            self.assertNotIn("prompt_file", native)
            structured.write_text('["updated"]')
            self.assertEqual(json.loads(Path(native["sample_prompts"]).read_text()),
                             ["cat --ss ddim", "reserved --s 0", {"prompt": "dog", "flow_shift": 5.0}])

    def test_scheduled_and_manual_only_prompt_sources(self):
        from backend.training.config.option_contracts import validate_sd_option_dependencies
        from backend.training.preview.prompt_file import read_prompt_entries, require_scheduled_prompt

        form = moss_config(enable_preview=True, sample_interval_mode="none", sample_at_first=False,
                           positive_prompts="", reserved_prompts="manual")
        for options, invalid in (({}, False), ({"sample_at_first": True}, True),
                                 ({"sample_interval_mode": "steps", "sample_every_n_steps": 5}, True)):
            errors = validate_sd_option_dependencies(form | options)
            self.assertEqual(any("positive_prompts" in msg for msg in errors), invalid)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prompts.TOML"
            path.write_text('[prompt]\nwidth=512\n[[prompt.subset]]\nprompt="manual"\nsample_steps=0')
            entries = read_prompt_entries(path)
            self.assertEqual(entries, [{"width": 512, "prompt": "manual", "sample_steps": 0}])
            with self.assertRaises(ValueError):
                require_scheduled_prompt(entries)
            path.write_text('[prompt]\nwidth="512"\n[[prompt.subset]]\nprompt="test"')
            with self.assertRaisesRegex(ValueError, "prompt #1, width"):
                read_prompt_entries(path)
            path.write_text('[prompt]\nflow_shift="-1.25"\n[[prompt.subset]]\nprompt="test"')
            self.assertEqual(read_prompt_entries(path, moss=True)[0]["flow_shift"], -1.25)
            with self.assertRaisesRegex(ValueError, "prompt #1, flow_shift"):
                read_prompt_entries(path)
            for invalid in ("bad", "nan", "1e999"):
                path.write_text(f'[prompt]\nflow_shift="{invalid}"\n[[prompt.subset]]\nprompt="test"')
                with self.assertRaisesRegex(ValueError, "prompt #1, flow_shift"):
                    read_prompt_entries(path, moss=True)
            path = path.with_suffix(".JSON")
            path.write_text('[{"prompt":"cat","negative_prompt":null,"seed":null}]')
            self.assertEqual(read_prompt_entries(path), [{"prompt": "cat", "seed": None}])
            path.write_text('["first --s 0 --s 4", {"prompt":"manual","sample_steps":0}]')
            require_scheduled_prompt(read_prompt_entries(path))
            for suffix, content in ((".JSON", "{}"), (".toml", "x=1"), (".csv", "cat")):
                invalid = path.with_suffix(suffix)
                invalid.write_text(content)
                with self.assertRaises(ValueError):
                    read_prompt_entries(invalid)

    async def test_preparation_writes_native_config_dataset_and_structured_prompts(self):
        import tomllib
        from backend import constants
        from backend.server.routes import training as routes
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
            form["preview_loras"] = [{"path": paths["pretrained_model_name_or_path"], "multiplier": 0.8},
                                     {"path": paths["pretrained_model_name_or_path"], "multiplier": -0.2}]
            with ExitStack() as stack:
                stack.enter_context(patch.object(routes, "tm", TaskManager()))
                for name, value in (("OUTPUT_DIR", root / "runs"),
                                    ("AUTOSAVE_DIR", root / "autosave")):
                    stack.enter_context(patch.object(constants, name, value))
                launch = stack.enter_context(patch.object(routes, "run_train", return_value={"status": "success"}))
                result = await routes._prepare_training(routes.launch.prepare_run, dict(form))
            self.assertEqual(result["status"], "success", result)
            self.assertIn("moss_image_train_network.py", launch.call_args.args[1])
            self.assertEqual(launch.call_args.kwargs["engine_id"], "sd_scripts")
            native = tomllib.loads(Path(launch.call_args.args[0]).read_text(encoding="utf-8"))
            self.assertEqual(native["bucket_reso_steps"], 16)
            self.assertEqual(native["sample_uncond_skip_layers"], "")
            self.assertNotIn("engine_id", native)
            self.assertNotIn("preview_loras", native)
            preview_path = Path(launch.call_args.kwargs["extra_env"]["ANIMA_PREVIEW_LORAS_CONFIG"])
            self.assertEqual(json.loads(preview_path.read_text(encoding="utf-8"))["loras"], form["preview_loras"])
            self.assertNotIn("subset_timestep_offsets", native)
            prompts_path = Path(native["sample_prompts"])
            self.assertEqual(prompts_path.suffix, ".json")
            self.assertEqual(json.loads(prompts_path.read_text(encoding="utf-8"))[0]["prompt"], "title\nsecond line")
            dataset_path = Path(launch.call_args.kwargs["extra_args"][1])
            dataset = tomllib.loads(dataset_path.read_text(encoding="utf-8"))
            self.assertEqual(dataset["datasets"][0]["subsets"][0]["custom_attributes"]["timestep_sampling"]["offset"], 0.25)
            self.assertEqual(launch.call_args.kwargs["run_metadata"]["profile_id"], PROFILE_ID)
