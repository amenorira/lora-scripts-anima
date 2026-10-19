"""Exercise MOSS native LoHa/LoKr through the UI config and real training factories."""
import importlib
import unittest

import torch

from backend.training.adapter import adapt_config
from backend.training.step_estimator import _sd_dataset_helpers
from backend.training.validation import validate_training_config
from tests.training.test_moss_image import moss_config


class MossNativeAdapterTests(unittest.TestCase):
    def test_bf16_updates_with_optional_text_layers_and_loraplus(self):
        _sd_dataset_helpers()
        from library.moss_image_models import MossImage
        from library.optimizer import get_optimizer
        from moss_image_train_network import setup_parser

        for module, rank in (("networks.loha", 4), ("networks.lokr", 2), ("networks.lokr", 32)):
            for train_text, optimizer_type in ((False, "AdamW"), (True, "Muon")):
                with self.subTest(module=module, rank=rank, train_text=train_text, optimizer=optimizer_type):
                    config = moss_config(network_module=module, network_dim=rank, network_alpha=1,
                                         lokr_factor=4, train_text_embedder=train_text,
                                         optimizer_type=optimizer_type, enable_loraplus=True,
                                         loraplus_lr_ratio=2, weight_decay=0)
                    self.assertEqual(validate_training_config(config), [])
                    adapted, _ = adapt_config(config)
                    args = setup_parser().parse_args([])
                    vars(args).update(adapted)
                    kwargs = dict(item.split("=", 1) for item in args.network_args)
                    torch.manual_seed(73)
                    model = MossImage(dim=32, ffn_dim=48, num_heads=2, num_layers=1,
                                      text_dim=16, freq_dim=8, latent_channels=4,
                                      attn_mode="torch", split_attn=False)
                    model.requires_grad_(False)
                    network = importlib.import_module(module).create_network(
                        1.0, args.network_dim, args.network_alpha, None, [], model, **kwargs)
                    network.apply_to([], model, apply_text_encoder=False, apply_unet=True)
                    groups, _ = network.prepare_optimizer_params_with_multiple_te_lrs(None, None, args.learning_rate)
                    _, _, optimizer = get_optimizer(args, groups)
                    self.assertEqual(len(optimizer.param_groups), 2)
                    self.assertEqual(optimizer.param_groups[1]["lr"], args.learning_rate * 2)
                    params = dict(network.named_parameters())
                    self.assertTrue(all(p.ndim == 2 for p in params.values()))
                    self.assertEqual(any("text_embedder" in name for name in params), train_text)
                    self.assertEqual(len(network.unet_loras), 17 if train_text else 6)
                    if module == "networks.lokr":
                        self.assertEqual("lokr_w2" in network.unet_loras[0].state_dict(), rank == 32)
                    initial = {name: p.detach().clone() for name, p in params.items()}
                    base = {name: p.detach().clone() for name, p in model.named_parameters()}
                    x, context = torch.randn(1, 4, 2, 2), torch.randn(1, 3, 16)
                    timesteps, target = torch.tensor([500.0]), torch.randn_like(x)
                    for _ in range(2):
                        with torch.autocast("cpu", dtype=torch.bfloat16):
                            loss = (model(x, timesteps, context).float() - target).square().mean()
                        self.assertTrue(torch.isfinite(loss))
                        loss.backward()
                        for parameter in params.values():
                            self.assertIsNotNone(parameter.grad)
                            self.assertTrue(torch.isfinite(parameter.grad).all())
                        optimizer.step()
                        optimizer.zero_grad(set_to_none=True)
                    for component in ("layers", "text_embedder") if train_text else ("layers",):
                        self.assertTrue(any(not torch.equal(p, initial[name]) for name, p in params.items()
                                            if component in name), component)
                    for name, parameter in model.named_parameters():
                        torch.testing.assert_close(parameter, base[name], rtol=0, atol=0)
                        self.assertIsNone(parameter.grad)
