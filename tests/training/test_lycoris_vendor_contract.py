"""LyCORIS 集成边界：嵌套层排除规则及运行内核参数不泄漏到 TOML。"""
import sys
import unittest
from pathlib import Path

import torch.nn as nn

VENDOR_ROOT = Path(__file__).resolve().parents[2] / "vendor"
if str(VENDOR_ROOT) not in sys.path:
    sys.path.insert(0, str(VENDOR_ROOT))

from lycoris import LycorisNetwork, create_lycoris  # noqa: E402
from lycoris.kohya import LycorisNetworkKohya

from backend.training.adapter import adapt_config  # noqa: E402


class _AnimaLikeBlock(nn.Module):
    """Small block containing attention/MLP beside AdaLN and norm layers."""

    def __init__(self, dim: int):
        super().__init__()
        self.attn_qkv = nn.Linear(dim, dim * 3)
        self.attn_out = nn.Linear(dim, dim)
        self.mlp_fc1 = nn.Linear(dim, dim * 2)
        self.mlp_fc2 = nn.Linear(dim * 2, dim)
        self.adaln_modulation = nn.Sequential(nn.SiLU(), nn.Linear(dim, dim * 6))
        self.norm = nn.Linear(dim, dim)


class _AnimaLikeModel(nn.Module):
    def __init__(self, dim: int = 16, depth: int = 2):
        super().__init__()
        self.blocks = nn.ModuleList([_AnimaLikeBlock(dim) for _ in range(depth)])


class LycorisVendorContractTests(unittest.TestCase):
    def test_exclude_name_applies_inside_matched_blocks(self):
        """The upstream #288 fix must exclude nested Anima paths in both APIs."""
        exclude = ["*adaln_modulation*", "*norm*"]
        kohya_attrs = ("ENABLE_CONV", "UNET_TARGET_REPLACE_MODULE", "UNET_TARGET_REPLACE_NAME",
                       "TEXT_ENCODER_TARGET_REPLACE_MODULE", "TEXT_ENCODER_TARGET_REPLACE_NAME",
                       "USE_FNMATCH", "TARGET_EXCLUDE_NAME")
        wrapper_attrs = ("ENABLE_CONV", "TARGET_REPLACE_MODULE", "TARGET_REPLACE_NAME",
                         "USE_FNMATCH", "TARGET_EXCLUDE_NAME")
        kohya_state = {name: getattr(LycorisNetworkKohya, name) for name in kohya_attrs}
        wrapper_state = {name: getattr(LycorisNetwork, name) for name in wrapper_attrs}
        preset = {
            "enable_conv": False,
            "unet_target_module": ["_AnimaLikeBlock"],
            "unet_target_name": [],
            "text_encoder_target_module": [],
            "text_encoder_target_name": [],
            "use_fnmatch": True,
            "exclude_name": exclude,
        }
        try:
            LycorisNetworkKohya.apply_preset(preset)
            kohya = LycorisNetworkKohya(
                None,
                _AnimaLikeModel(),
                1.0,
                lora_dim=4,
                alpha=4,
                network_module="locon",
                warn_on_unmatched=False,
            )
            kohya_names = [lora.lora_name for lora in kohya.unet_loras]
            self.assertEqual(len(kohya_names), 8)
            self.assertFalse(any("adaln" in name or "norm" in name for name in kohya_names))

            LycorisNetwork.apply_preset({
                "enable_conv": False,
                "target_module": ["_AnimaLikeBlock"],
                "target_name": [],
                "use_fnmatch": True,
                "exclude_name": exclude,
            })
            wrapper = create_lycoris(
                _AnimaLikeModel(), 1.0, linear_dim=4, linear_alpha=4, algo="lora"
            )
            wrapper_names = [lora.lora_name for lora in wrapper.loras]
            self.assertEqual(len(wrapper_names), 8)
            self.assertFalse(any("adaln" in name or "norm" in name for name in wrapper_names))
        finally:
            for name, value in kohya_state.items():
                setattr(LycorisNetworkKohya, name, value)
            for name, value in wrapper_state.items():
                setattr(LycorisNetwork, name, value)

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


if __name__ == "__main__":
    unittest.main()
