"""backend.training.toml_writer 的契约测试。

背景：第三方 toml 0.10.2 的编码器在字符串含 "\\x"（反斜杠 + 字母 x）时
会把所有反斜杠坍缩成单杠，产出非法 TOML。本模块是自研替代写入器。
所有用例都要求输出同时被标准库 tomllib 和第三方 toml（sd-scripts 的
实际读取器）解析，且解析结果与源数据一致。
"""

import tomllib
import unittest

import toml

from backend.training import toml_writer


def _round_trip(obj):
    text = toml_writer.dumps(obj)
    return text, tomllib.loads(text), toml.loads(text)


class TomlWriterPathTests(unittest.TestCase):
    def test_backslash_x_path_round_trip(self):
        """\\x 回归：x 开头目录名的 Windows 路径不再产出非法 TOML。"""
        cfg = {
            "train_data_dir": r"D:\datasets\xyz人物",
            "pretrained_model_name_or_path": r"C:\models\xl\base.safetensors",
            "output_dir": r"C:\Users\lou\output\xylophone_20260831",
        }
        text, via_stdlib, via_third_party = _round_trip(cfg)
        self.assertEqual(via_stdlib, cfg)
        self.assertEqual(via_third_party, cfg)
        self.assertIn(r'D:\datasets\xyz人物'.replace("\\", "\\\\"), text)

    def test_path_variants_round_trip(self):
        cfg = {
            "forward_slash": "D:/lora训练/测试用",
            "backslash": r"D:\lora训练\测试用",
            "trailing_backslash": "D:\\data\\",
            "relative": "./models/anima-base-v1.0.safetensors",
            "unc": r"\\nas\share\x63",
            "ends_with_x_segment": "D:\\data\\x",
        }
        _, via_stdlib, via_third_party = _round_trip(cfg)
        self.assertEqual(via_stdlib, cfg)
        self.assertEqual(via_third_party, cfg)

    def test_string_escapes_round_trip(self):
        cfg = {
            "quote": 'say "hi"',
            "newline": "a\nb",
            "tab": "a\tb",
            "control": "a\x01b",
            "backslash_quote": '\\"',
        }
        _, via_stdlib, via_third_party = _round_trip(cfg)
        self.assertEqual(via_stdlib, cfg)
        self.assertEqual(via_third_party, cfg)


class TomlWriterSemanticsTests(unittest.TestCase):
    def test_none_values_are_skipped(self):
        _, via_stdlib, _ = _round_trip({"a": None, "b": 1})
        self.assertEqual(via_stdlib, {"b": 1})

    def test_empty_list_and_empty_table(self):
        _, via_stdlib, via_third_party = _round_trip({"a": [], "t": {}})
        self.assertEqual(via_stdlib, {"a": [], "t": {}})
        self.assertEqual(via_third_party, {"a": [], "t": {}})

    def test_scalar_types(self):
        cfg = {
            "learning_rate": 2e-05,
            "big_float": 1000.0,
            "steps": 2000,
            "enable_bucket": True,
            "disabled": False,
            "network_args": ["algo=lokr", "conv_dim=32"],
        }
        _, via_stdlib, via_third_party = _round_trip(cfg)
        self.assertEqual(via_stdlib, cfg)
        self.assertEqual(via_third_party, cfg)

    def test_dataset_config_shape_round_trip(self):
        """sd-scripts dataset.toml 的真实形状：表数组 + 嵌套 custom_attributes。"""
        cfg = {
            "datasets": [
                {
                    "subsets": [
                        {
                            "image_dir": r"D:\datasets\xyz人物\10_cat",
                            "num_repeats": 10,
                            "is_reg": False,
                            "class_tokens": "cat",
                            "custom_attributes": {"timestep_sampling": {"offset": 0.5}},
                        }
                    ]
                }
            ],
            "general": {"resolution": [1024, 1024], "enable_bucket": True},
        }
        _, via_stdlib, via_third_party = _round_trip(cfg)
        self.assertEqual(via_stdlib, cfg)
        self.assertEqual(via_third_party, cfg)

    def test_equivalent_to_legacy_encoder_on_safe_input(self):
        """对不含 \\x 的输入，新写入器解析结果与旧 toml 库一致。"""
        cfg = {
            "model_train_type": "anima-lora",
            "train_data_dir": "D:/lora训练/测试用",
            "learning_rate": 2e-05,
            "max_train_epochs": 10,
            "shuffle_caption": True,
            "network_args": ["dim=32", "alpha=32"],
            "datasets": [{"subsets": [{"image_dir": "D:/data/10_cat", "num_repeats": 10}]}],
        }
        self.assertEqual(tomllib.loads(toml_writer.dumps(cfg)), tomllib.loads(toml.dumps(cfg)))

    def test_unsupported_type_raises(self):
        with self.assertRaises(TypeError):
            toml_writer.dumps({"bad": object()})

    def test_mixed_table_array_raises(self):
        with self.assertRaises(TypeError):
            toml_writer.dumps({"bad": [{"a": 1}, "scalar"]})

    def test_non_dict_root_raises(self):
        with self.assertRaises(TypeError):
            toml_writer.dumps(["not", "a", "dict"])


if __name__ == "__main__":
    unittest.main()
