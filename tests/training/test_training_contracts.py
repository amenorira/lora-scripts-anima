import unittest


from backend.training.config.validation import validate_training_config
from tests.helpers import valid_training_config as valid_anima_config


class TrainingValidationTests(unittest.TestCase):


    def test_text_cache_caption_contracts_are_profile_specific(self):
        anima = valid_anima_config()
        anima["caption_dropout_rate"] = 0.1
        self.assertEqual(validate_training_config(anima), [])

        for key, value in (("shuffle_caption", True), ("caption_tag_dropout_rate", 0.1)):
            with self.subTest(train_type="anima-lora", key=key):
                errors = validate_training_config(dict(valid_anima_config(), **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)

        sdxl = dict(
            valid_anima_config(),
            model_train_type="sdxl-lora",
            network_module="networks.lora",
            resolution="1024,1024",
        )
        for key, value in (
            ("caption_dropout_rate", 0.1),
            ("shuffle_caption", True),
            ("caption_tag_dropout_rate", 0.1),
        ):
            with self.subTest(train_type="sdxl-lora", key=key):
                errors = validate_training_config(dict(sdxl, **{key: value}))
                self.assertTrue(any("cache_text_encoder_outputs" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
