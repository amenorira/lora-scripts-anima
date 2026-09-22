"""用训练端和标准库两种解析器验证 TOML 路径、转义与数据集结构。"""
import tomllib
import unittest

import toml

from backend.training import toml_writer


class TomlWriterTests(unittest.TestCase):
    def test_round_trip(self):
        cases = {
            "paths": {
                "train": r"D:\datasets\xyz人物", "model": r"C:\models\xl\base.safetensors",
                "forward": "D:/lora训练/测试用", "trailing": "D:\\data\\",
                "relative": "./models/anima.safetensors", "unc": r"\\nas\share\x63",
                "ends_with_x": "D:\\data\\x",
            },
            "escapes": {"quote": 'say "hi"', "newline": "a\nb", "tab": "a\tb",
                        "control": "a\x01b", "backslash_quote": '\\"'},
            "scalars": {"lr": 2e-5, "big_float": 1000.0, "steps": 2000,
                        "enabled": True, "disabled": False, "args": ["algo=lokr", "conv_dim=32"]},
            "empty": {"array": [], "table": {}},
            "dataset": {
                "general": {"resolution": [1024, 1024], "enable_bucket": True},
                "datasets": [{"subsets": [{
                    "image_dir": r"D:\datasets\xyz人物\10_cat", "num_repeats": 10,
                    "is_reg": False, "class_tokens": "cat",
                    "custom_attributes": {"timestep_sampling": {"offset": 0.5}},
                }]}],
            },
        }
        for name, config in cases.items():
            for parser in (tomllib, toml):
                with self.subTest(case=name, parser=parser.__name__):
                    self.assertEqual(parser.loads(toml_writer.dumps(config)), config)

    def test_none_is_omitted_and_invalid_types_are_rejected(self):
        self.assertEqual(tomllib.loads(toml_writer.dumps({"a": None, "b": 1})), {"b": 1})
        for config in ({"bad": object()}, {"bad": [{"a": 1}, "scalar"]}, ["not", "a", "dict"]):
            with self.subTest(config=config), self.assertRaises(TypeError):
                toml_writer.dumps(config)
