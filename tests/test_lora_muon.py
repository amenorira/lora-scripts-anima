import unittest
from unittest import mock

import torch

import vendor.lora_muon.lora_muon as lora_muon_module
from vendor.lora_muon.lora_muon import (
    INV_SQRT_COEFFICIENTS,
    LoRAMuon,
    _inverse_sqrt_newton_schulz_batched,
    _matrix_sign_newton_schulz_batched,
    inverse_sqrt_newton_schulz,
    matrix_sign_newton_schulz,
)


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
    def test_inverse_root_coefficients_match_paper_table(self):
        self.assertEqual(INV_SQRT_COEFFICIENTS[4][2], 0.37505152463617264)

    def _make_pair(self, dtype=torch.float32):
        torch.manual_seed(7)
        down = torch.randn(2, 4, dtype=dtype, requires_grad=True)
        up = torch.zeros(3, 2, dtype=dtype, requires_grad=True)
        return down, up

    def test_zero_gram_inverse_root_is_finite_and_bounded(self):
        result = inverse_sqrt_newton_schulz(torch.zeros(8, 8))
        self.assertTrue(torch.isfinite(result).all())
        self.assertLessEqual(float(result.abs().max()), 1.0)
        self.assertTrue(torch.allclose(result, torch.eye(8)))
        self.assertTrue(torch.allclose(result, result.T))

    def test_near_singular_gram_inverse_root_is_finite(self):
        matrix = torch.diag(torch.tensor([1.0e-12, 1.0e-4, 1.0]))
        result = inverse_sqrt_newton_schulz(matrix)
        self.assertTrue(torch.isfinite(result).all())
        self.assertTrue(torch.allclose(result, result.T))

    def test_batched_inverse_root_matches_scalar_for_mixed_grams(self):
        torch.manual_seed(23)
        source = torch.randn(3, 3)
        regular = source.T @ source + 0.25 * torch.eye(3)
        near_singular = torch.diag(torch.tensor([1.0e-12, 1.0e-4, 1.0]))
        cold = torch.zeros(3, 3)
        grams = torch.stack((regular, cold, near_singular), dim=0)

        actual = _inverse_sqrt_newton_schulz_batched(grams)
        expected = torch.stack(
            [inverse_sqrt_newton_schulz(matrix) for matrix in grams], dim=0
        )

        torch.testing.assert_close(actual, expected, rtol=2.0e-5, atol=2.0e-6)
        self.assertTrue(torch.equal(actual[1], torch.eye(3)))
        self.assertTrue(torch.isfinite(actual).all())
        torch.testing.assert_close(actual, actual.transpose(-1, -2))

    def test_batched_inverse_root_rejects_invalid_inputs(self):
        with self.assertRaisesRegex(ValueError, "square"):
            _inverse_sqrt_newton_schulz_batched(torch.zeros(2, 3, 2))
        with self.assertRaisesRegex(FloatingPointError, "non-finite"):
            invalid = torch.eye(2).repeat(2, 1, 1)
            invalid[1, 0, 0] = torch.nan
            _inverse_sqrt_newton_schulz_batched(invalid)
        with self.assertRaisesRegex(FloatingPointError, "positive semidefinite"):
            indefinite = torch.stack((torch.eye(2), -torch.eye(2)), dim=0)
            _inverse_sqrt_newton_schulz_batched(indefinite)

        for kwargs in ({"steps": 0}, {"eps": -1.0}, {"gamma": 0.0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                _inverse_sqrt_newton_schulz_batched(
                    torch.eye(2).unsqueeze(0), **kwargs
                )

    def test_batched_matrix_sign_matches_scalar_for_common_orientations(self):
        for dtype in (torch.float32, torch.float64):
            for rows, cols in ((7, 3), (3, 7), (4, 4)):
                with self.subTest(dtype=dtype, shape=(rows, cols)):
                    torch.manual_seed(rows * 10 + cols)
                    matrices = torch.randn(4, rows, cols, dtype=dtype)
                    matrices[0].zero_()
                    actual = _matrix_sign_newton_schulz_batched(matrices)
                    expected = torch.stack(
                        [matrix_sign_newton_schulz(matrix) for matrix in matrices]
                    )
                    torch.testing.assert_close(
                        actual, expected, rtol=2.0e-5, atol=2.0e-6
                    )
                    self.assertTrue(torch.isfinite(actual).all())

    def test_batched_matrix_sign_rejects_invalid_inputs(self):
        with self.assertRaisesRegex(ValueError, "batch"):
            _matrix_sign_newton_schulz_batched(torch.zeros(3, 2))
        for kwargs in ({"steps": 0}, {"steps": 9}, {"eps": -1.0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                _matrix_sign_newton_schulz_batched(
                    torch.zeros(2, 3, 2), **kwargs
                )

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

    def test_zero_norm_gauge_rebalance_is_skipped(self):
        down, up = self._make_pair()
        moment_down = torch.randn(4, 2)
        moment_up = torch.randn(3, 2)
        down_before = down.detach().clone()
        up_before = up.detach().clone()
        optimizer = LoRAMuon([down, up], lr=2.0e-5, gauge_rebalance=False)
        optimizer._gauge_rebalance_pair(
            down,
            up,
            moment_down,
            moment_up,
            alpha=1.0,
            power_steps=2,
        )
        self.assertTrue(torch.equal(down, down_before))
        self.assertTrue(torch.equal(up, up_before))
        self.assertTrue(torch.isfinite(moment_down).all())
        self.assertTrue(torch.isfinite(moment_up).all())

    def test_nonzero_gauge_rebalance_preserves_product(self):
        torch.manual_seed(11)
        down = torch.randn(2, 4, requires_grad=True)
        up = torch.randn(3, 2, requires_grad=True)
        moment_down = torch.randn(4, 2)
        moment_up = torch.randn(3, 2)
        before = up.detach() @ down.detach()
        optimizer = LoRAMuon([down, up], lr=2.0e-5, gauge_rebalance=False)
        optimizer._gauge_rebalance_pair(
            down,
            up,
            moment_down,
            moment_up,
            alpha=1.0,
            power_steps=2,
        )
        after = up.detach() @ down.detach()
        self.assertTrue(torch.allclose(before, after, rtol=1.0e-5, atol=1.0e-6))

    def test_gauge_rebalance_transports_momenta_with_factor_scales(self):
        torch.manual_seed(19)
        down = torch.randn(2, 4, requires_grad=True)
        up = torch.randn(3, 2, requires_grad=True)
        moment_down = torch.randn(4, 2)
        moment_up = torch.randn(3, 2)
        before_down = moment_down.clone()
        before_up = moment_up.clone()
        norm_a = torch.linalg.matrix_norm(up.detach())
        norm_b = torch.linalg.matrix_norm(down.detach().T)
        optimizer = LoRAMuon([down, up], lr=2.0e-5, gauge_rebalance=False)
        optimizer._gauge_rebalance_pair(
            down,
            up,
            moment_down,
            moment_up,
            alpha=1.0,
            power_steps=20,
        )
        # Power iteration is approximate; verify direction and scale within a
        # modest tolerance while checking the exact inverse relationship.
        actual_c = torch.linalg.matrix_norm(up.detach()) / norm_a
        self.assertGreater(float(actual_c), 0.0)
        # The factors scale as A*=cA, B*=B/c, while their gradients and EMA
        # states transform oppositely: mA*=mA/c and mB*=c*mB.
        self.assertTrue(torch.allclose(moment_up, before_up / actual_c, rtol=2e-2, atol=2e-5))
        self.assertTrue(torch.allclose(moment_down, before_down * actual_c, rtol=2e-2, atol=2e-5))

    def test_zero_up_is_bounded_with_paper_learning_rate(self):
        down, up = self._make_pair(torch.float32)
        target = torch.randn(3, 4)
        optimizer = LoRAMuon([down, up], lr=0.1, gauge_rebalance=False)
        loss = ((up @ down - target) ** 2).mean()
        loss.backward()
        optimizer.step()
        self.assertTrue(torch.isfinite(down).all())
        self.assertTrue(torch.isfinite(up).all())
        self.assertLess(float(up.detach().abs().max()), 1.0)

    def test_parameter_group_overrides_are_validated(self):
        down, up = self._make_pair()
        with self.assertRaises(ValueError):
            LoRAMuon([{"params": [down, up], "momentum": 1.5}])
        with self.assertRaises(ValueError):
            LoRAMuon([{"params": [down, up], "ns_steps": 9}])

    def test_transposed_pair_api_is_rejected_explicitly(self):
        a = torch.randn(3, 2, requires_grad=True)
        b = torch.randn(4, 2, requires_grad=True)
        with self.assertRaisesRegex(TypeError, "transposed"):
            LoRAMuon([(a, b)])

    def test_conv2d_pair_is_flattened_for_paper_space_and_restored(self):
        torch.manual_seed(17)
        down = torch.randn(2, 3, 3, 3, requires_grad=True)
        up = torch.randn(5, 2, 1, 1, requires_grad=True)
        optimizer = LoRAMuon([down, up], lr=1.0e-4, gauge_rebalance=False)
        self.assertEqual(tuple(optimizer.lora_pairs[0].A.shape), (5, 2))
        self.assertEqual(tuple(optimizer.lora_pairs[0].B.shape), (27, 2))
        down.grad = torch.randn_like(down)
        up.grad = torch.randn_like(up)
        optimizer.step()
        self.assertEqual(tuple(down.shape), (2, 3, 3, 3))
        self.assertEqual(tuple(up.shape), (5, 2, 1, 1))
        self.assertTrue(torch.isfinite(down).all())
        self.assertTrue(torch.isfinite(up).all())

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

    def test_repeated_shapes_use_batched_sign_and_match_scalar_reference(self):
        torch.manual_seed(41)
        params = []
        for _ in range(3):
            params.extend(
                (
                    torch.nn.Parameter(torch.randn(2, 4)),
                    torch.nn.Parameter(torch.randn(3, 2)),
                )
            )
        for _ in range(2):
            params.extend(
                (
                    torch.nn.Parameter(torch.randn(2, 3, 3, 3)),
                    torch.nn.Parameter(torch.randn(5, 2, 1, 1)),
                )
            )
        reference_params = [
            torch.nn.Parameter(parameter.detach().clone()) for parameter in params
        ]

        def groups(values):
            return [
                {
                    "params": values[:6],
                    "lr": 0.03,
                    "momentum": 0.7,
                    "weight_decay": 0.02,
                    "ns_steps": 6,
                    "inv_sqrt_steps": 5,
                },
                {
                    "params": values[6:],
                    "lr": 0.02,
                    "momentum": 0.8,
                    "weight_decay": 0.01,
                    "ns_steps": 7,
                    "inv_sqrt_steps": 6,
                },
            ]

        optimizer = LoRAMuon(groups(params), gauge_rebalance=False)
        reference = _ScalarLoRAMuon(
            groups(reference_params), gauge_rebalance=False
        )

        with mock.patch.object(
            lora_muon_module,
            "_matrix_sign_newton_schulz_batched",
            wraps=_matrix_sign_newton_schulz_batched,
        ) as batched_sign:
            for step in range(2):
                torch.manual_seed(200 + step)
                for parameter, reference_parameter in zip(
                    params, reference_params
                ):
                    gradient = torch.randn_like(parameter)
                    parameter.grad = gradient
                    reference_parameter.grad = gradient.clone()
                optimizer.step()
                reference.step()

        self.assertGreaterEqual(batched_sign.call_count, 4)
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

    def test_nonfinite_gradient_is_rejected_before_factor_updates(self):
        torch.manual_seed(51)
        params = []
        for _ in range(2):
            params.extend(
                (
                    torch.nn.Parameter(torch.randn(2, 4)),
                    torch.nn.Parameter(torch.randn(3, 2)),
                )
            )
        optimizer = LoRAMuon(params, gauge_rebalance=False)
        before = [parameter.detach().clone() for parameter in params]
        for parameter in params:
            parameter.grad = torch.randn_like(parameter)
        params[-1].grad[0, 0] = torch.nan

        with self.assertRaisesRegex(FloatingPointError, "non-finite gA"):
            optimizer.step()

        for parameter, expected in zip(params, before):
            self.assertTrue(torch.equal(parameter, expected))
            self.assertNotIn(parameter, optimizer.state)

        for parameter in params:
            parameter.grad = torch.randn_like(parameter)
        optimizer.step()
        for parameter in params:
            self.assertTrue(torch.isfinite(parameter).all())
            self.assertTrue(
                torch.isfinite(optimizer.state[parameter]["momentum_buffer"]).all()
            )

    def test_matrix_sign_chunking_is_numerically_equivalent(self):
        torch.manual_seed(61)
        params = []
        for _ in range(4):
            params.extend(
                (
                    torch.nn.Parameter(torch.randn(3, 7)),
                    torch.nn.Parameter(torch.randn(5, 3)),
                )
            )
        chunked_params = [
            torch.nn.Parameter(parameter.detach().clone()) for parameter in params
        ]
        optimizer = LoRAMuon(params, lr=0.03, gauge_rebalance=False)
        chunked = LoRAMuon(chunked_params, lr=0.03, gauge_rebalance=False)
        for parameter, chunked_parameter in zip(params, chunked_params):
            gradient = torch.randn_like(parameter)
            parameter.grad = gradient
            chunked_parameter.grad = gradient.clone()

        with mock.patch.object(
            lora_muon_module, "_MSIGN_BATCH_WORKSPACE_BYTES", 2**30
        ):
            optimizer.step()
        with mock.patch.object(
            lora_muon_module, "_MSIGN_BATCH_WORKSPACE_BYTES", 1
        ):
            chunked.step()

        for parameter, chunked_parameter in zip(params, chunked_params):
            torch.testing.assert_close(
                parameter, chunked_parameter, rtol=5.0e-5, atol=5.0e-6
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

    def test_mixed_linear_and_conv_pair_is_rejected(self):
        down = torch.randn(2, 4, requires_grad=True)
        up = torch.randn(3, 2, 1, 1, requires_grad=True)
        with self.assertRaisesRegex(ValueError, "supports either 2-D Linear or Anima Conv2d"):
            LoRAMuon([down, up])

    def test_conv_up_kernel_must_be_1x1(self):
        down = torch.randn(2, 3, 3, 3, requires_grad=True)
        up = torch.randn(5, 2, 3, 3, requires_grad=True)
        with self.assertRaisesRegex(ValueError, "supports either 2-D Linear or Anima Conv2d"):
            LoRAMuon([down, up])


if __name__ == "__main__":
    unittest.main()
