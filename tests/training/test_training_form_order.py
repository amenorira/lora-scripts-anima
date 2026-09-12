"""LoRA 训练表单字段渲染顺序回归测试。

回归背景：logit_mean / logit_std / mode_scale 的 show_if 数组同时含
weighting_scheme 与 timestep_sampling 两个条件，前端 _fieldLayoutParentKey
对 show_if 数组从尾部取父键，会取到 timestep_sampling，导致这三个子参数被
渲染到 weighting_scheme 之前、把它挤到时间步分组末尾（c679b066 引入）。

修复：三个字段显式声明 layout_parent=weighting_scheme（见 field_registry.py /
musubi_krea2.py 中的注释）。本测试用 node 执行真实的 _orderFieldsByDependencies，
断言 anima 与 krea2 两个 profile 训练分区的渲染顺序与注册表顺序一致。
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from backend.training.field_registry import _to_camel, get_all_fields

TRAIN_GROUP_MAP = {"sdxl-lora": "sdxl", "anima-lora": "anima", "krea2-lora": "krea2"}

_ORDERING_SCRIPT = r"""
global.window = {};
eval(require('fs').readFileSync('frontend/js/training-core.js', 'utf8'));
const mixin = window.trainingCoreMixin;
const app = {
  _fieldLayoutParentKey: mixin._fieldLayoutParentKey,
  _orderFieldsByDependencies: mixin._orderFieldsByDependencies,
};
const fields = __FIELDS__;
const ordered = app._orderFieldsByDependencies(fields);
process.stdout.write(JSON.stringify(ordered.map(f => f.key)));
"""


def visible_training_fields(train_type: str) -> list[dict]:
    """复刻前端 getVisibleSections 对训练分区字段的过滤结果（含 camelCase 转换）。"""
    target_group = TRAIN_GROUP_MAP.get(train_type, "all")
    fields = []
    for field in get_all_fields():
        if field["section"] != "training":
            continue
        if "profiles" in field:
            if train_type not in field["profiles"]:
                continue
        elif train_type == "krea2-lora":
            if field["key"] != "model_train_type":
                continue
        else:
            group = field.get("group")
            if group and group != "all":
                if isinstance(group, list):
                    if target_group not in group:
                        continue
                elif group != target_group:
                    continue
        fields.append(_to_camel(field))
    return [field for field in fields if not field.get("hidden")]


def rendered_training_order(train_type: str) -> list[str]:
    """用 node 执行前端真实的字段排序逻辑。"""
    fields = visible_training_fields(train_type)
    script = _ORDERING_SCRIPT.replace("__FIELDS__", json.dumps(fields, ensure_ascii=False))
    result = subprocess.run(
        ["node", "-e", script], cwd=Path.cwd(), check=True,
        capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


class TrainingFormOrderTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend order checks")
    def test_anima_training_fields_render_in_registry_order(self):
        registry_order = [field["key"] for field in visible_training_fields("anima-lora")]
        self.assertEqual(
            rendered_training_order("anima-lora"),
            registry_order,
            "训练分区渲染顺序偏离注册表顺序（weighting_scheme 会被挤到分组末尾）",
        )
        self.assertEqual(
            registry_order,
            ["max_train_epochs", "train_batch_size", "gradient_accumulation_steps",
             "gradient_checkpointing", "seed", "mixed_precision", "full_bf16",
             "timestep_sampling", "sigmoid_scale", "discrete_flow_shift",
             "weighting_scheme", "logit_mean", "logit_std", "mode_scale"],
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for frontend order checks")
    def test_krea2_training_fields_render_in_registry_order(self):
        registry_order = [field["key"] for field in visible_training_fields("krea2-lora")]
        self.assertEqual(
            rendered_training_order("krea2-lora"),
            registry_order,
            "Krea 2 训练分区渲染顺序偏离注册表顺序（weighting_scheme 会被挤到分组末尾）",
        )
        self.assertEqual(
            registry_order,
            ["krea_training_duration_mode", "max_train_epochs", "max_train_steps",
             "train_batch_size", "gradient_accumulation_steps", "gradient_checkpointing",
             "gradient_checkpointing_cpu_offload", "seed", "mixed_precision",
             "timestep_sampling", "discrete_flow_shift", "sigmoid_scale",
             "weighting_scheme", "logit_mean", "logit_std", "mode_scale"],
        )
