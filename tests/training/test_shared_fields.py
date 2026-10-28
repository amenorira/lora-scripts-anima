"""Shared metadata must not allow one training profile to mutate another."""
import unittest

from backend.training.fields.shared_fields import shared_training_field


class SharedTrainingFieldTests(unittest.TestCase):
    def test_profiles_own_nested_options_and_conditions(self):
        sd = shared_training_field("compile_mode", default="default", target="toml")
        krea = shared_training_field("compile_mode", default="default", profiles=["krea2-lora"])
        sd["options"][0]["dk"] = "modified"
        sd["show_if"]["eq"] = False
        self.assertEqual(krea["options"][0]["dk"], "opt.compile_mode_default")
        self.assertTrue(krea["show_if"]["eq"])
        self.assertNotIn("target", krea)
        self.assertNotIn("profiles", sd)

        override = {"key": "another_flag", "eq": False}
        customized = shared_training_field("compile_mode", show_if=override)
        override["eq"] = True
        self.assertFalse(customized["show_if"]["eq"])
        self.assertTrue(shared_training_field("compile_mode")["show_if"]["eq"])
