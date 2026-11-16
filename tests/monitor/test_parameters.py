import unittest

from backend.monitor.training import extract_train_params


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


if __name__ == "__main__":
    unittest.main()
