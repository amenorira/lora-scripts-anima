import asyncio
import json
import subprocess
import tempfile
import tomllib
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from backend.server.routes import training as training_routes
from backend.training.sd_dataset_config import (
    build_sd_scripts_dataset_config,
    normalize_subset_timestep_offsets,
)
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

    def test_normalizes_nonzero_finite_offsets(self):
        self.assertEqual(
            normalize_subset_timestep_offsets({"10_face_detail": "-0.25", "3_full_body": 0}),
            {"10_face_detail": -0.25},
        )
        with self.assertRaises(ValueError):
            normalize_subset_timestep_offsets({"10_face_detail": "nan"})

    def test_builds_dreambooth_subsets_with_training_offsets_only(self):
        result = build_sd_scripts_dataset_config(
            {"train_data_dir": str(self.train), "reg_data_dir": str(self.reg)},
            {"10_face_detail": -0.25, "3_full_body": 0.15},
        )
        subsets = result["datasets"][0]["subsets"]
        by_name = {Path(item["image_dir"]).name: item for item in subsets}

        self.assertEqual(by_name["10_face_detail"]["num_repeats"], 10)
        self.assertEqual(by_name["10_face_detail"]["class_tokens"], "face_detail")
        self.assertEqual(
            by_name["10_face_detail"]["custom_attributes"],
            {"timestep_sampling": {"offset": -0.25}},
        )
        self.assertTrue(by_name["1_person"]["is_reg"])
        self.assertNotIn("custom_attributes", by_name["1_person"])

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
            run_train = stack.enter_context(
                patch.object(
                    training_routes,
                    "run_train",
                    return_value={"status": "success", "data": {"task_id": "test-task"}},
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


class SubsetTimestepFrontendTests(unittest.TestCase):
    def test_editor_is_rendered_after_weighting_parameters(self):
        repo = Path(__file__).resolve().parents[1]
        source = (repo / "frontend" / "js" / "training-core.js").read_text(encoding="utf-8")

        self.assertIn("if (f.key === 'mode_scale') html += this.renderSubsetTimestepOffsets();", source)
        self.assertNotIn("if (f.key === 'discrete_flow_shift') html += this.renderSubsetTimestepOffsets();", source)

    def test_editor_links_to_subset_offset_documentation(self):
        repo = Path(__file__).resolve().parents[1]
        source = (repo / "frontend" / "js" / "training-core.js").read_text(encoding="utf-8")
        docs = (repo / "docs" / "parameters" / "timesteps.zh-CN.md").read_text(encoding="utf-8")

        self.assertIn("openParameterDoc('timesteps','subset-offsets')", source)
        self.assertIn("<!-- doc-anchor: subset-offsets -->", docs)
        self.assertIn("sigma` 路径不会读取 `subset_timestep_offsets", docs)

    def test_preview_applies_offset_and_editor_uses_existing_stepper(self):
        repo = Path(__file__).resolve().parents[1]
        core_path = repo / "frontend" / "js" / "training-core.js"
        script = f"""
global.window = {{ t: key => key }};
require({json.dumps(str(core_path))});
const app = Object.assign({{}}, window.trainingCoreMixin, {{
  form: {{
    model_train_type: 'anima-lora', timestep_sampling: 'shift', sigmoid_scale: 1,
    discrete_flow_shift: 3, weighting_scheme: 'uniform', resolution: '1024,1024',
    subset_timestep_offsets: {{ '10_face': -0.25, '2_body': 0.25 }}
  }},
  stepEstimate: {{ subsets: [
    {{ name: '10_face', image_count: 10, repeats: 10, sample_count: 100, is_reg: false }},
    {{ name: '2_body', image_count: 10, repeats: 2, sample_count: 20, is_reg: false }}
  ] }},
  t: key => key,
  esc: value => String(value)
}});
const low = app._buildTimestepPreview(app.form, '10_face');
const high = app._buildTimestepPreview(app.form, '2_body');
if (!(low.median < low.baselineMedian && high.median > high.baselineMedian)) process.exit(2);
const html = app.renderSubsetTimestepOffsets();
if (!html.includes('subset-timestep-stepper') || html.includes('type=\\"range\\"')) process.exit(3);
"""
        completed = subprocess.run(["node", "-e", script], cwd=repo, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)


if __name__ == "__main__":
    unittest.main()
