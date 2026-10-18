"""Exercise Muon through the native MOSS LoRA network and optimizer factories."""
import io
import unittest

import torch

from backend.training.adapter import adapt_config
from backend.training.step_estimator import _sd_dataset_helpers
from backend.training.validation import validate_training_config
from tests.training.test_moss_image import moss_config


class MossMuonRuntimeTests(unittest.TestCase):
    device = "cpu"

    def test_bf16_training_loraplus_and_checkpoint_resume(self):
        _sd_dataset_helpers()
        from library.moss_image_models import MossImage
        from library.optimizer import get_optimizer, get_scheduler_fix
        from moss_image_train_network import setup_parser
        from networks.lora_generic import create_network

        for train_text_embedder, loraplus in ((False, False), (True, False), (True, True)):
            with self.subTest(train_text_embedder=train_text_embedder, loraplus=loraplus):
                config = moss_config(optimizer_type="Muon", train_text_embedder=train_text_embedder,
                                     enable_loraplus=loraplus, loraplus_lr_ratio=2,
                                     network_dim=4, network_alpha=1, weight_decay=0,
                                     lr_scheduler="cosine", lr_warmup_steps=0, max_train_steps=8)
                self.assertEqual(validate_training_config(config), [])
                adapted, _ = adapt_config(config)
                args = setup_parser().parse_args([])
                vars(args).update(adapted)
                kwargs = dict(item.split("=", 1) for item in args.network_args)

                def create_training_objects():
                    torch.manual_seed(73)
                    dit = MossImage(dim=32, ffn_dim=48, num_heads=2, num_layers=1,
                                    text_dim=16, freq_dim=8, latent_channels=4,
                                    attn_mode="torch", split_attn=False).to(self.device)
                    dit.requires_grad_(False)
                    network = create_network(1.0, args.network_dim, args.network_alpha,
                                             None, [], dit, **kwargs)
                    network.apply_to([], dit, apply_text_encoder=False, apply_unet=True)
                    network.to(self.device)
                    groups, _ = network.prepare_optimizer_params_with_multiple_te_lrs(
                        None, None, args.learning_rate)
                    _, _, optimizer = get_optimizer(args, groups)
                    scheduler = get_scheduler_fix(args, optimizer, num_processes=1)
                    return dit, network, optimizer, scheduler

                dit, network, optimizer, scheduler = create_training_objects()
                self.assertIsInstance(optimizer, torch.optim.Muon)
                self.assertEqual(len(optimizer.param_groups), 2 if loraplus else 1)
                if loraplus:
                    self.assertEqual(optimizer.param_groups[1]["lr"], args.learning_rate * 2)
                params = dict(network.named_parameters())
                self.assertTrue(params)
                self.assertTrue(all(p.ndim == 2 for p in params.values()))
                self.assertEqual(any("text_embedder" in name for name in params), train_text_embedder)
                self.assertEqual({id(p) for p in params.values()},
                                 {id(p) for group in optimizer.param_groups for p in group["params"]})
                initial = {name: p.detach().clone() for name, p in params.items()}
                base = {name: p.detach().clone() for name, p in dit.named_parameters()}
                x = torch.randn(1, 4, 2, 2, device=self.device)
                context = torch.randn(1, 3, 16, device=self.device)
                timesteps = torch.tensor([500.0], device=self.device)
                target = torch.randn_like(x)

                def step(model, lora, opt, schedule):
                    with torch.autocast(self.device, dtype=torch.bfloat16):
                        prediction = model(x, timesteps, context)
                        loss = (prediction.float() - target).square().mean()
                    self.assertTrue(torch.isfinite(loss))
                    loss.backward()
                    for parameter in lora.parameters():
                        self.assertIsNotNone(parameter.grad)
                        self.assertTrue(torch.isfinite(parameter.grad).all())
                    opt.step()
                    schedule.step()
                    opt.zero_grad(set_to_none=True)

                for _ in range(2):
                    step(dit, network, optimizer, scheduler)
                for component in ("layers", "text_embedder") if train_text_embedder else ("layers",):
                    for factor in ("lora_down", "lora_up"):
                        self.assertTrue(any(not torch.equal(p, initial[name]) for name, p in params.items()
                                            if component in name and factor in name), (component, factor))
                for name, parameter in dit.named_parameters():
                    torch.testing.assert_close(parameter, base[name], rtol=0, atol=0)
                    self.assertIsNone(parameter.grad)

                checkpoint = io.BytesIO()
                torch.save({"network": network.state_dict(), "optimizer": optimizer.state_dict(),
                            "scheduler": scheduler.state_dict()}, checkpoint)
                checkpoint.seek(0)
                saved = torch.load(checkpoint, weights_only=True)
                resumed_dit, resumed_network, resumed_optimizer, resumed_scheduler = create_training_objects()
                resumed_network.load_state_dict(saved["network"])
                resumed_optimizer.load_state_dict(saved["optimizer"])
                resumed_scheduler.load_state_dict(saved["scheduler"])
                step(dit, network, optimizer, scheduler)
                step(resumed_dit, resumed_network, resumed_optimizer, resumed_scheduler)
                for parameter, resumed in zip(network.parameters(), resumed_network.parameters()):
                    self.assertTrue(torch.isfinite(parameter).all())
                    torch.testing.assert_close(parameter, resumed, rtol=0, atol=0)
                self.assertEqual(scheduler.get_last_lr(), resumed_scheduler.get_last_lr())


@unittest.skipUnless(torch.cuda.is_available() and torch.cuda.is_bf16_supported(), "requires CUDA BF16")
class MossMuonCudaRuntimeTests(MossMuonRuntimeTests):
    device = "cuda"


if __name__ == "__main__":
    unittest.main()
