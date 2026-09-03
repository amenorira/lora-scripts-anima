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


if __name__ == "__main__":
    unittest.main()