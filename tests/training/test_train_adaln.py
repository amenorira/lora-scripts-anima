"""AdaLN 调制层开关（train_adaln）的 adapter 契约测试。

回归背景：上游 sd-scripts 对 Anima 默认排除 _modulation 层（lora_anima.py:254；
loha/lokr 经 network_base.py 的 Anima ArchConfig 继承同一排除）。train_adaln 是
UI-only 开关，开启时由 adapter 把三条调制分支的 include_patterns 注入 network_args。

关键约束：sd-scripts 端 network_args 解析为 net_kwargs 字典，同 key 后者覆盖，
故用户在 network_args_custom 手写的 include_patterns 必须与本开关并集合并成单条，
否则一边会被静默丢弃。
"""

import ast
import unittest

import toml

from backend.training import toml_writer
from backend.training.adapter import adapt_config
from backend.training.field_registry import ADALN_INCLUDE_MODULES, ADALN_INCLUDE_PATTERN


def _include_patterns_of(network_args: list[str]) -> list[str]:
    entries = [item for item in network_args if item.split("=", 1)[0].strip() == "include_patterns"]
    assert len(entries) == 1, f"include_patterns 必须只有一条: {network_args}"
    return ast.literal_eval(entries[0].split("=", 1)[1])


class TrainAdalnAdapterTests(unittest.TestCase):
    def test_supported_modules_inject_include_patterns(self):
        for module in ADALN_INCLUDE_MODULES:
            with self.subTest(module=module):
                adapted, _ = adapt_config({
                    "model_train_type": "anima-lora",
                    "network_module": module,
                    "train_adaln": True,
                })
                self.assertIn("network_args", adapted)
                patterns = _include_patterns_of(adapted["network_args"])
                self.assertIn(ADALN_INCLUDE_PATTERN, patterns)

    def test_user_custom_include_patterns_are_union_merged(self):
        adapted, _ = adapt_config({
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "train_adaln": True,
            "network_args_custom": "include_patterns=['.*final_layer.*']\nverbose=True",
        })
        network_args = adapted["network_args"]
        patterns = _include_patterns_of(network_args)
        self.assertEqual(patterns, [".*final_layer.*", ADALN_INCLUDE_PATTERN])
        # 其他自定义参数不受影响
        self.assertIn("verbose=True", network_args)

    def test_unsupported_module_strips_field_without_injection(self):
        for module in ("lycoris.kohya", "networks.lora"):
            with self.subTest(module=module):
                adapted, _ = adapt_config({
                    "model_train_type": "anima-lora",
                    "network_module": module,
                    "train_adaln": True,
                })
                self.assertNotIn("train_adaln", adapted)
                network_args = adapted.get("network_args") or []
                self.assertFalse(any("include_patterns" in item for item in network_args))

    def test_emitted_value_survives_toml_round_trip(self):
        adapted, _ = adapt_config({
            "model_train_type": "anima-lora",
            "network_module": "networks.lora_anima",
            "train_adaln": True,
            "network_args_custom": "include_patterns=['.*final_layer.*']",
        })
        parsed = toml.loads(toml_writer.dumps(adapted))
        self.assertEqual(parsed["network_args"], adapted["network_args"])
        # 与 sd-scripts 的 ast.literal_eval 解析保持一致
        self.assertEqual(
            _include_patterns_of(parsed["network_args"]),
            [".*final_layer.*", ADALN_INCLUDE_PATTERN],
        )


if __name__ == "__main__":
    unittest.main()
