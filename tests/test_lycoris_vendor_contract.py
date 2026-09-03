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


if __name__ == "__main__":
    unittest.main()