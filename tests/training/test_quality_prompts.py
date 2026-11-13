import json
import unittest

from backend.training.execution.launch_sd_scripts import get_sample_prompts
from backend.training.preview.config import compose_preview_prompts


class QualityPromptTests(unittest.TestCase):
    def test_each_group_joins_at_one_comma_and_keeps_blank_lines_and_comments(self):
        form = {"enable_quality_prompts": True, "quality_prompts": " , masterpiece, best quality,， "}
        prompts = " , portrait\r\n\r\n# ignored\r\n， full body --n bad --w 768\r\n"
        expected = "masterpiece, best quality, portrait\n\n# ignored\nmasterpiece, best quality, full body --n bad --w 768\n"
        self.assertEqual(compose_preview_prompts(form, prompts), expected)
        for prefix in ("", " ,， "):
            self.assertEqual(compose_preview_prompts({**form, "quality_prompts": prefix}, prompts), prompts)
        self.assertEqual(compose_preview_prompts({**form, "enable_quality_prompts": False}, prompts), prompts)
        self.assertEqual(compose_preview_prompts(form, "\n\n"), "\n\n")

    def test_generated_sd_samples_prepend_each_group_and_moss_keeps_its_paragraph(self):
        form = {"enable_quality_prompts": True, "quality_prompts": "masterpiece, ",
                "positive_prompts": "portrait\nfull body", "negative_prompts": "bad"}
        generated = get_sample_prompts(form).splitlines()
        self.assertEqual(len(generated), 2)
        self.assertTrue(generated[0].startswith("masterpiece, portrait --n bad "))
        self.assertTrue(generated[1].startswith("masterpiece, full body --n bad "))
        moss = json.loads(get_sample_prompts({**form, "model_train_type": "moss-image-lora"}))
        self.assertEqual(len(moss), 1)
        self.assertEqual(moss[0]["prompt"], "masterpiece, portrait\nfull body")
        self.assertEqual(form["positive_prompts"], "portrait\nfull body")
