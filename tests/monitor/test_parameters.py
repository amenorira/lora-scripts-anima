import unittest
from pathlib import PurePosixPath

from backend.monitor.training import extract_train_params
from backend.server.routes.docs import _render_markdown
from backend.training.fields.field_registry import get_fields_json


class TrainingParameterTests(unittest.TestCase):
    def test_saved_learning_rates_keep_their_numeric_precision(self):
        config = {
            "learning_rate": 0.0000123456789,
            "unet_lr": 0.0000987654321,
            "text_encoder_lr": 0,
        }
        params = {param["key"]: param["value"] for param in extract_train_params(config, "sdxl-lora")}
        for key, value in config.items():
            self.assertEqual(float(params[key]), value)

    def test_native_arguments_and_boolean_states_remain_available(self):
        config = {
            "dit": "models/krea.safetensors",
            "network_module": "lycoris.kohya",
            "network_args": ["algo=lokr", "factor=8"],
            "optimizer_args": ["weight_decay=0.01", "fused=false"],
            "gradient_checkpointing": False,
            "max_train_steps": 1200,
        }
        params = {param["key"]: param for param in extract_train_params(config, "krea2-lora")}
        self.assertEqual(params["dit"]["desc_key"], "field.krea_dit")
        self.assertEqual(params["network_args.factor"]["value"], "8")
        self.assertEqual(params["optimizer_args.fused"]["value"], "false")
        self.assertEqual(params["gradient_checkpointing"]["value"], "false")
        self.assertEqual(params["max_train_steps"]["value"], "1200")

    def test_native_scheduler_and_optimizer_strings_keep_the_literal_and_decoded_value(self):
        config = {
            "lr_scheduler": "piecewise_constant",
            "lr_scheduler_args": ["step_rules='1:100,0.5'"],
            "optimizer_args": ["adjust_lr_fn='match_rms_adamw'", "foreach=None", "eps='broken"],
            "network_args": ["preset='literal-quotes'"],
        }
        params = {param["key"]: param for param in extract_train_params(config, "anima-lora")}
        self.assertNotIn("lr_scheduler_args", params)
        self.assertEqual(params["lr_scheduler_args.step_rules"]["value"], "'1:100,0.5'")
        self.assertEqual(params["lr_scheduler_args.step_rules"]["string_value"], "1:100,0.5")
        self.assertEqual(params["optimizer_args.adjust_lr_fn"]["string_value"], "match_rms_adamw")
        self.assertNotIn("string_value", params["optimizer_args.foreach"])
        self.assertNotIn("string_value", params["optimizer_args.eps"])
        self.assertNotIn("string_value", params["network_args.preset"])

    def test_krea2_schema_preserves_dedicated_labels_and_doc_anchors(self):
        sections = get_fields_json()["sections"]
        krea_fields = {
            field["key"]: field
            for section in sections
            for field in section["fields"]
            if "krea2-lora" in (field.get("profiles") or [])
        }
        self.assertEqual(krea_fields["logit_mean"]["descKey"], "field.krea_logit_mean")
        self.assertEqual(krea_fields["logit_std"]["descKey"], "field.krea_logit_std")
        self.assertEqual(krea_fields["weighting_scheme"]["descKey"], "field.krea_weighting_scheme")
        self.assertEqual(krea_fields["min_timestep"]["docAnchor"], "krea-range")
        self.assertEqual(krea_fields["max_timestep"]["docAnchor"], "krea-range")
        self.assertEqual(krea_fields["blocks_to_swap"]["docAnchor"], "block-swap")
        self.assertEqual(krea_fields["krea_schedulefree_warmup_steps"]["docAnchor"], "schedulefree-warmup")
        prodigy_opt = next(
            option
            for group in krea_fields["optimizer_type"]["groups"]
            for option in group["options"]
            if option["v"] == "prodigyopt.Prodigy"
        )
        self.assertEqual(prodigy_opt["dKey"], "opt.optimizer_type_Prodigy")

    def test_docs_markdown_slugify_preserves_explicit_anchors_and_unicode_headings(self):
        html, toc = _render_markdown(
            '<a name="explicit-id"></a>\n## 显式章节\n\n'
            '<!-- doc-anchor: legacy-id -->\n### 旧版章节\n\n'
            '### 怎么选\n\n### 1. 第一步\n\n### 123\n',
            PurePosixPath("parameters/network-parameters.zh-CN.md"),
        )
        self.assertIn('<h2 id="explicit-id">显式章节</h2>', html)
        self.assertIn('href="#explicit-id"', toc)
        self.assertNotIn('name="explicit-id"', html)
        self.assertIn('<h3 id="legacy-id">旧版章节</h3>', html)
        self.assertIn('id="怎么选"', html)
        self.assertIn('id="1-第一步"', html)
        self.assertIn('id="section-123"', html)


if __name__ == "__main__":
    unittest.main()
