import asyncio
import json
import tempfile
import time
import tomllib
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.server.routes import training as training_routes
from backend.tasks import TaskManager, TaskStatus
from backend.training.sd_dataset_config import build_sd_scripts_dataset_config
from backend.training.training_config import extract_training_form, load_training_config


class _BodyRequest:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    async def body(self):
        return self._body


class SubsetTimestepDatasetConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.train = self.root / "train"
        self.reg = self.root / "reg"
        (self.train / "10_face_detail").mkdir(parents=True)
        (self.train / "3_full_body").mkdir()
        (self.reg / "1_person").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()


    def test_rejects_offsets_for_stale_subset_names(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            build_sd_scripts_dataset_config(
                {"train_data_dir": str(self.train)},
                {"missing": 0.1},
            )

    def test_anima_run_writes_dataset_toml_and_passes_dataset_config(self):
        model = self.root / "model.safetensors"
        vae = self.root / "vae.safetensors"
        qwen3 = self.root / "qwen3.safetensors"
        for path in (model, vae, qwen3):
            path.write_bytes(b"test")

        payload = {
            "model_train_type": "anima-lora",
            "train_data_dir": str(self.train),
            "pretrained_model_name_or_path": str(model),
            "vae": str(vae),
            "qwen3": str(qwen3),
            "output_name": "offset-test",
            "output_dir": str(self.root / "artifacts"),
            "subset_timestep_offsets": {"10_face_detail": -0.25},
        }

        def _adapt_config(value, gpu_ids=None):
            return dict(value), []

        with ExitStack() as stack:
            stack.enter_context(patch.object(training_routes, "tm", TaskManager()))
            stack.enter_context(patch.object(training_routes, "OUTPUT_DIR", self.root / "runs"))
            stack.enter_context(patch("backend.training.validate_training_config", return_value=[]))
            stack.enter_context(patch("backend.training.adapt_config", side_effect=_adapt_config))
            stack.enter_context(patch.object(training_routes.train_utils, "fix_config_types"))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_data_dir", return_value=True))
            stack.enter_context(patch.object(training_routes.train_utils, "count_images", return_value=1))
            stack.enter_context(patch.object(training_routes.train_utils, "validate_model", return_value=(True, "")))
            stack.enter_context(patch.object(training_routes, "estimate_training_steps", return_value={}))
            stack.enter_context(patch.object(training_routes, "get_sample_prompts", return_value=(None, "")))
            stack.enter_context(patch.object(training_routes.os, "getcwd", return_value=str(self.root)))
            stack.enter_context(patch.object(training_routes, "AUTOSAVE_DIR", self.root / "config" / "autosave"))
            def completed_launch(*_args, **kwargs):
                task = kwargs["reserved_task"]
                with task.lock:
                    task.status = TaskStatus.FINISHED
                    task.finished_at = time.time()
                return {"status": "success", "data": {"task_id": task.task_id}}

            run_train = stack.enter_context(
                patch.object(
                    training_routes,
                    "run_train",
                    side_effect=completed_launch,
                )
            )
            result = asyncio.run(training_routes.create_toml_file(_BodyRequest(payload)))

        self.assertEqual(result["status"], "success")
        extra_args = run_train.call_args.kwargs["extra_args"]
        self.assertEqual(extra_args[0], "--dataset_config")
        dataset_path = Path(extra_args[1])
        self.assertTrue(dataset_path.is_file())
        dataset = tomllib.loads(dataset_path.read_text(encoding="utf-8"))
        subset = dataset["datasets"][0]["subsets"][0]
        self.assertEqual(subset["custom_attributes"]["timestep_sampling"]["offset"], -0.25)
        training_config = tomllib.loads((dataset_path.parent / "config.toml").read_text(encoding="utf-8"))
        self.assertNotIn("subset_timestep_offsets", training_config)
        app_config = load_training_config(dataset_path.parent / "training.yaml")
        self.assertEqual(
            extract_training_form(app_config)["subset_timestep_offsets"],
            {"10_face_detail": -0.25},
        )


if __name__ == "__main__":
    unittest.main()
