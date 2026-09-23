import unittest
from unittest import mock

import torch

from vendor.lora_muon.lora_muon import LoRAMuon


class _ScalarLoRAMuon(LoRAMuon):
    """Reference optimizer retaining the pre-batching per-pair root path."""

    @torch.no_grad()
    def step(self, closure=None):
        loss = None
        if closure is not None:
            with torch.enable_grad():
                loss = closure()

        for group in self.param_groups:
            if group["gauge_rebalance"]:
                raise AssertionError(
                    "scalar reference only supports gauge_rebalance=False"
                )
            params = group["params"]
            for down_idx, up_idx in group["pair_indices"]:
                self._step_pair(params[down_idx], params[up_idx], group)
            group["step"] = int(group.get("step", 0)) + 1
        return loss

class LoRAMuonNumericalTests(unittest.TestCase):
    def _make_pair(self, dtype=torch.float32):
        torch.manual_seed(7)
        down = torch.randn(2, 4, dtype=dtype, requires_grad=True)
        up = torch.zeros(3, 2, dtype=dtype, requires_grad=True)
        return down, up

    def test_zero_up_cold_start_is_finite_for_supported_dtypes(self):
        target_dtypes = [torch.float32]
        if torch.float16 in (torch.float16,):
            target_dtypes.append(torch.float16)
        if hasattr(torch, "bfloat16"):
            target_dtypes.append(torch.bfloat16)

        for dtype in target_dtypes:
            with self.subTest(dtype=dtype):
                down, up = self._make_pair(dtype)
                target = torch.randn(3, 4, dtype=dtype)
                optimizer = LoRAMuon(
                    [down, up],
                    lr=2.0e-5,
                    gauge_rebalance=False,
                )
                for _ in range(3):
                    loss = ((up @ down - target) ** 2).mean()
                    loss.backward()
                    optimizer.step()
                    optimizer.zero_grad()
                self.assertTrue(torch.isfinite(down).all())
                self.assertTrue(torch.isfinite(up).all())
                self.assertGreater(float(up.detach().abs().max()), 0.0)

    def test_batched_step_matches_scalar_reference_across_pairs_and_groups(self):
        torch.manual_seed(37)
        params = [
            torch.nn.Parameter(torch.randn(2, 4)),
            torch.nn.Parameter(torch.zeros(3, 2)),
            torch.nn.Parameter(torch.randn(2, 3, 3, 3)),
            torch.nn.Parameter(torch.randn(5, 2, 1, 1)),
            torch.nn.Parameter(torch.randn(3, 5)),
            torch.nn.Parameter(torch.randn(4, 3)),
            torch.nn.Parameter(torch.randn(3, 2)),
            torch.nn.Parameter(torch.randn(6, 3)),
        ]
        reference_params = [
            torch.nn.Parameter(parameter.detach().clone()) for parameter in params
        ]

        def groups(values):
            return [
                {
                    "params": values[:4],
                    "lr": 0.03,
                    "momentum": 0.7,
                    "weight_decay": 0.02,
                    "ns_steps": 6,
                    "inv_sqrt_steps": 5,
                    "inv_sqrt_eps": 1.0e-5,
                    "inv_sqrt_gamma": 1.001,
                },
                {
                    "params": values[4:],
                    "lr": 0.02,
                    "momentum": 0.8,
                    "weight_decay": 0.01,
                    "ns_steps": 7,
                    "inv_sqrt_steps": 7,
                    "inv_sqrt_eps": 1.0e-4,
                    "inv_sqrt_gamma": 1.01,
                },
            ]

        optimizer = LoRAMuon(groups(params), gauge_rebalance=False)
        reference = _ScalarLoRAMuon(
            groups(reference_params), gauge_rebalance=False
        )

        for step in range(2):
            torch.manual_seed(100 + step)
            for parameter, reference_parameter in zip(params, reference_params):
                gradient = torch.randn_like(parameter)
                parameter.grad = gradient
                reference_parameter.grad = gradient.clone()

            optimizer.step()
            reference.step()

        for parameter, reference_parameter in zip(params, reference_params):
            torch.testing.assert_close(
                parameter, reference_parameter, rtol=5.0e-5, atol=5.0e-6
            )
            torch.testing.assert_close(
                optimizer.state[parameter]["momentum_buffer"],
                reference.state[reference_parameter]["momentum_buffer"],
                rtol=5.0e-5,
                atol=5.0e-6,
            )

        self.assertEqual([group["step"] for group in optimizer.param_groups], [2, 2])
        self.assertEqual(
            [group["inv_sqrt_steps"] for group in optimizer.param_groups], [5, 7]
        )

    def test_failed_later_group_does_not_leave_partial_step(self):
        torch.manual_seed(71)
        params = [
            torch.nn.Parameter(torch.randn(2, 4)),
            torch.nn.Parameter(torch.randn(3, 2)),
            torch.nn.Parameter(torch.randn(2, 5)),
            torch.nn.Parameter(torch.randn(3, 2)),
        ]
        optimizer = LoRAMuon(
            [
                {"params": params[:2], "lr": 0.03},
                {"params": params[2:], "lr": 0.02},
            ],
            gauge_rebalance=False,
        )
        before = [parameter.detach().clone() for parameter in params]
        for parameter in params:
            parameter.grad = torch.randn_like(parameter)

        original_apply = optimizer._apply_batched_pair_steps
        call_count = 0

        def fail_on_second_group(contexts, group):
            nonlocal call_count
            call_count += 1
            result = original_apply(contexts, group)
            if call_count == 2:
                raise FloatingPointError("synthetic later-group failure")
            return result

        with mock.patch.object(
            optimizer, "_apply_batched_pair_steps", side_effect=fail_on_second_group
        ), self.assertRaisesRegex(FloatingPointError, "later-group"):
            optimizer.step()

        self.assertEqual(call_count, 2)
        for parameter, expected in zip(params, before):
            self.assertTrue(torch.equal(parameter, expected))
            self.assertNotIn(parameter, optimizer.state)
        self.assertEqual([group.get("step", 0) for group in optimizer.param_groups], [0, 0])


if __name__ == "__main__":
    unittest.main()
