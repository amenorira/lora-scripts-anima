"""Vendor contract tests for vendored LyCORIS (vendor/lycoris/).

Locks the training-relevant parts of the vendored LyCORIS subtree so future
vendor syncs cannot silently regress the pieces our UI and adapter depend on:
the algo dispatch table (algo -> module), built-in presets, the algo registry,
and the kohya-style create_network signature that sd-scripts invokes
positionally.
"""
import inspect
import sys
import unittest
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parents[1] / "vendor"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from lycoris.config import PRESET  # noqa: E402
from lycoris.config_sdk import ALGO_REGISTRY  # noqa: E402
from lycoris.kohya import create_network  # noqa: E402
from lycoris.wrapper import deprecated_arg_dict, network_module_dict  # noqa: E402

from backend.training.adapter import adapt_config  # noqa: E402
from backend.training.field_registry import get_fields_json  # noqa: E402


def _field(key: str) -> dict:
    for section in get_fields_json()["sections"]:
        for field in section["fields"]:
            if field["key"] == key:
                return field
    raise AssertionError(f"field {key} not found")


class LycorisVendorContractTests(unittest.TestCase):
    def test_algo_dispatch_table_registers_all_ui_algorithms(self):
        """Every algo offered by the UI must exist in the training dispatch
        table. ia3 was missing once (upstream commit a72bb1b) and crashed
        training with KeyError at network creation."""
        expected = {
            "lora", "locon", "loha", "lokr", "dylora", "glora",
            "full", "diag-oft", "boft", "ia3", "tlora",
        }
        self.assertEqual(set(network_module_dict), expected)

    def test_builtin_presets_match_ui_options(self):
        self.assertEqual(
            set(PRESET),
            {
                "full", "full-lin", "attn-mlp", "attn-only",
                "unet-only", "unet-transformer-only",
                "unet-convblock-only", "ia3",
            },
        )

    def test_algo_registry_covers_every_algo(self):
        self.assertEqual(
            set(ALGO_REGISTRY),
            set(network_module_dict) | {"ia3"},
        )

    def test_create_network_positional_signature_stable(self):
        """sd-scripts calls create_network(positional *6, **net_kwargs);
        any change to the first six parameter names/order breaks training."""
        params = list(inspect.signature(create_network).parameters)
        self.assertEqual(
            params[:6],
            ["multiplier", "network_dim", "network_alpha", "vae", "text_encoder", "unet"],
        )
        self.assertIn("**kwargs", [str(p) for p in inspect.signature(create_network).parameters.values()])

    def test_deprecated_arg_aliases_stable(self):
        self.assertEqual(
            deprecated_arg_dict,
            {
                "disable_conv_cp": "use_tucker",
                "use_cp": "use_tucker",
                "use_conv_cp": "use_tucker",
                "constrain": "constraint",
            },
        )

    def test_shared_fields_keep_native_module_conditions(self):
        """弹窗字段必须在主表单保留原生模块（networks.lora/loha/lokr）的显示
        条件——只允许追加"非 lycoris.kohya"排除，不能把条件改成 lycoris 专属。"""
        native_modules = {"networks.lora", "networks.loha", "networks.lokr"}
        shared = {
            "conv_dim": "basic",
            "conv_alpha": "basic",
            "rank_dropout": "regularization",
            "module_dropout": "regularization",
            "lokr_factor": "algorithm",
            "use_tucker": "advanced",
        }
        for key, group in shared.items():
            field = _field(key)
            self.assertEqual(field.get("lycorisGroup"), group, key)
            conditions = field.get("showIfAny") or (
                field["showIf"] if isinstance(field.get("showIf"), list) else [field.get("showIf")]
            )
            groups = conditions if isinstance(conditions, list) and conditions and isinstance(conditions[0], list) else [conditions]
            referenced = {
                cond.get("eq")
                for group_ in groups
                for cond in (group_ if isinstance(group_, list) else [group_])
                if cond and cond.get("key") == "network_module"
            }
            self.assertTrue(
                referenced & native_modules,
                f"{key} 的条件必须覆盖原生模块，实际只引用 {referenced - native_modules}",
            )

    def test_split_hints_have_panel_and_native_variants(self):
        """conv_dim/conv_alpha/use_tucker 在主表单与 LyCORIS 弹窗使用不同提示，
        弹窗提示键（hintKeyPanel）必须与主表单提示键（hintKey）同时存在。"""
        for key in ("conv_dim", "conv_alpha", "use_tucker"):
            field = _field(key)
            self.assertIn("hintKey", field, key)
            self.assertIn("hintKeyPanel", field, key)
            self.assertNotEqual(field["hintKey"], field["hintKeyPanel"], key)

    def test_lycoris_group_fields_cover_panel_layout(self):
        """LyCORIS 弹窗分组元数据：_LYCORIS_PANEL_LAYOUT 中的字段都应带
        lycorisGroup/lycorisOrder，且弹窗分组名合法。"""
        valid_groups = {"basic", "regularization", "algorithm", "advanced"}
        for section in get_fields_json()["sections"]:
            for field in section["fields"]:
                if field.get("lycorisGroup"):
                    self.assertIn(field["lycorisGroup"], valid_groups, field["key"])
                    self.assertIsInstance(field.get("lycorisOrder"), int, field["key"])

    def test_kernel_backend_field_registered(self):
        """内核后端选项进弹窗 basic 组：取值固定为上游 5 个后端。进程级环境
        变量不落 TOML 由 test_kernel_backend_not_leaked_to_toml 端到端保证。"""
        field = _field("lycoris_kernel_backend")
        self.assertEqual(field["lycorisGroup"], "basic")
        self.assertEqual(field["type"], "select")
        self.assertEqual(
            {option["v"] for option in field["options"]},
            {"auto", "triton", "tilelang", "compile", "torch"},
        )
        self.assertEqual(field["default"], "auto")
        self.assertEqual(field["hintKey"], "field.lycoris_kernel_backendHint")

    def test_kernel_backend_not_leaked_to_toml(self):
        """适配器必须把字段当 UI-only 吸收：不进 TOML 顶层，也不进 network_args。"""
        config = {
            "model_train_type": "anima-lora",
            "network_module": "lycoris.kohya",
            "lycoris_algo": "lora",
            "lycoris_preset": "full",
            "lycoris_kernel_backend": "torch",
        }
        adapted, _warnings = adapt_config(config)
        self.assertNotIn("lycoris_kernel_backend", adapted)
        for item in adapted.get("network_args", []):
            self.assertFalse(item.startswith("lycoris_kernel_backend="), item)

    def test_ia3_preset_normalization(self):
        """algo=ia3 强制 ia3 预设；preset=ia3 但算法非 ia3 时回落 full（防目标层窄化）。"""
        adapted, warnings = adapt_config({
            "model_train_type": "sdxl-lora",
            "network_module": "lycoris.kohya",
            "lycoris_algo": "ia3",
            "lycoris_preset": "full",
        })
        self.assertIn("preset=ia3", adapted["network_args"])
        self.assertTrue(
            any("IA^3 algorithm" in w or "IA³" in w for w in warnings), warnings
        )

        adapted2, warnings2 = adapt_config({
            "model_train_type": "sdxl-lora",
            "network_module": "lycoris.kohya",
            "lycoris_algo": "dylora",
            "lycoris_preset": "ia3",
        })
        self.assertIn("preset=full", adapted2["network_args"])
        self.assertTrue(
            any("reset to full" in w or "回落 full" in w for w in warnings2), warnings2
        )

    def test_dead_upstream_args_not_registered(self):
        """kohya.py create_network 不转发未知 kwargs，这些上游死参数绝不能进 UI 字段集。"""
        keys = {
            field["key"]
            for section in get_fields_json()["sections"]
            for field in section["fields"]
        }
        for dead in ("rank_dropout_scale", "train_on_input", "train_t5xxl"):
            self.assertNotIn(dead, keys, dead)

    def test_loraplus_conditions_restricted_to_lycoris_locon(self):
        """LoRA+ 比率字段对 lycoris.kohya 只允许 LoCon（algo=lora）组合。"""
        for key in ("loraplus_lr_ratio", "loraplus_unet_lr_ratio", "loraplus_text_encoder_lr_ratio"):
            field = _field(key)
            lycoris_groups = [
                group for group in field["showIfAny"]
                if any(cond.get("key") == "network_module" and cond.get("eq") == "lycoris.kohya" for cond in group)
            ]
            self.assertTrue(
                all(
                    any(cond.get("key") == "lycoris_algo" and cond.get("eq") == "lora" for cond in group)
                    for group in lycoris_groups
                ),
                f"{key} 的 lycoris 条件必须限定 LoCon，实际: {lycoris_groups}",
            )


if __name__ == "__main__":
    unittest.main()