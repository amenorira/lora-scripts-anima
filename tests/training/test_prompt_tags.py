from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.training.datasets.prompt_tags import inspect_prompt_tags


class PromptTagsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        def glob_images(directory, pattern):
            return sorted(str(path) for path in Path(directory).iterdir()
                          if path.suffix.lower() in {".png", ".jpg", ".webp"})
        self.helper = patch("backend.training.datasets.step_estimator._sd_dataset_helpers",
                            return_value=(None, glob_images, None))
        self.helper.start()
        self.addCleanup(self.helper.stop)

    def caption(self, subset, name, text, extension=".txt"):
        folder = self.root / subset
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (name + ".png")).touch()
        (folder / (name + extension)).write_text(text, encoding="utf-8")

    def inspect(self, **values):
        return inspect_prompt_tags(dict(train_data_dir=str(self.root), model_train_type="anima-lora", **values))

    def test_counts_images_once_without_training_repeats_and_merges_subsets(self):
        self.caption("99_a", "one", "\ufefftrigger, blue hair, trigger, blue hair")
        self.caption("2_b", "two", "trigger, smile")
        self.caption("ignored", "three", "must not appear")
        self.caption(".", "root", "must not appear")
        result = self.inspect()
        self.assertEqual(result["image_count"], 2)
        self.assertEqual(result["caption_count"], 2)
        self.assertEqual(result["tags"], [dict(tag="trigger", count=2), dict(tag="smile", count=1), dict(tag="blue hair", count=1)])
        self.assertEqual({item["id"] for item in result["subsets"]}, {"99_a", "2_b"})

    def test_frequency_ties_follow_first_caption_occurrence_in_stable_file_order(self):
        self.caption("1_subject", "b", "blue hair, z trigger, white hair")
        self.caption("1_subject", "a", "z trigger, white hair, blue hair")
        self.caption("2_other", "a", "blue hair, white hair, z trigger")
        result = self.inspect()
        self.assertEqual(result["tags"], [dict(tag=tag, count=3) for tag in ["z trigger", "white hair", "blue hair"]])
        self.assertEqual(result["subsets"][0]["tags"], [dict(tag=tag, count=2) for tag in ["z trigger", "white hair", "blue hair"]])
        self.assertEqual(result["subsets"][1]["tags"], [dict(tag=tag, count=1) for tag in ["blue hair", "white hair", "z trigger"]])
        self.assertEqual(result["subsets"][0]["leading_tags"], [dict(tag="z trigger", count=1), dict(tag="blue hair", count=1)])
        self.assertEqual(result["leading_tags"], [dict(tag="blue hair", count=2), dict(tag="z trigger", count=1)])
        self.assertEqual(self.inspect(), result)

    def test_caption_extension_and_skipped_counts_are_explicit(self):
        self.caption("1_a", "ok", "my_tag", ".caption")
        self.caption("1_a", "empty", "", ".caption")
        self.caption("1_a", "json", '{"description":"some, text"}', ".caption")
        self.caption("1_a", "bad", "", ".caption")
        (self.root / "1_a/bad.caption").write_bytes(b"\xff\xfe\xff")
        (self.root / "1_a/missing.png").touch()
        result = self.inspect(caption_extension=".caption")
        self.assertEqual(result["tags"], [dict(tag="my_tag", count=1)])
        self.assertEqual((result["missing_count"], result["unreadable_count"], result["structured_count"]), (1, 1, 1))
        self.assertEqual(result["caption_count"], 1)

    def test_regularization_is_not_included(self):
        self.caption("1_subject", "a", "subject")
        self.caption("reg/1_reg", "b", "regularization")
        result = self.inspect(reg_data_dir=str(self.root / "reg"), enable_reg_data=True)
        self.assertEqual(result["tags"], [dict(tag="subject", count=1)])

    def test_refresh_invalidates_caption_cache(self):
        self.caption("1_a", "one", "old")
        self.assertEqual(self.inspect()["tags"][0]["tag"], "old")
        (self.root / "1_a/one.txt").write_text("new, another", encoding="utf-8")
        self.assertEqual({row["tag"] for row in self.inspect()["tags"]}, {"new", "another"})

    def test_krea_uses_recursive_captioned_images_and_excludes_cache(self):
        self.caption("nested/a", "one", "shared")
        self.caption("nested/b", "two", "shared, other")
        self.caption("cache", "generated", "not_training")
        result = inspect_prompt_tags(dict(train_data_dir=str(self.root), model_train_type="krea2-lora", dataset_cache_dir=str(self.root / "cache")))
        self.assertEqual(result["image_count"], 2)
        self.assertEqual(result["tags"][0], dict(tag="shared", count=2))
        self.assertEqual({row["id"] for row in result["subsets"]}, {"nested/a", "nested/b"})

    def test_invalid_directory_or_extension_is_rejected(self):
        with self.assertRaises(ValueError):
            inspect_prompt_tags({})
        for extension in ["txt", ".", "../bad"]:
            with self.subTest(extension=extension):
                with self.assertRaises(ValueError):
                    self.inspect(caption_extension=extension)
