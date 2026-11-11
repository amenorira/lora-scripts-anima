"""Real optimizer step sizes, scheduler timing and one backbone dashboard LR."""
import math
from types import SimpleNamespace
import unittest

import torch

from tools.python_startup.lr_logging import (
    EffectiveLrNoOpScheduler, _patch_network_trainer_module, _patch_optimizer_module,
    append_backbone_learning_rate, install_learning_rate_tracking,
    read_learning_rates,
)


class StepLearningRateTests(unittest.TestCase):
    def test_accumulation_before_first_real_step_does_not_log_configured_or_resumed_lr(self):
        from prodigyplus import ProdigyPlusScheduleFree

        parameter = torch.nn.Parameter(torch.ones(4, 4))
        optimizer = ProdigyPlusScheduleFree([parameter], lr=1.0, use_bias_correction=True)
        optimizer.train()
        install_learning_rate_tracking(optimizer)
        parameter.sum().backward()  # First microbatch; optimizer.step has not run.
        self.assertEqual(read_learning_rates(optimizer), [])
        scheduler = EffectiveLrNoOpScheduler(optimizer)
        self.assertEqual(scheduler.get_last_lr(), [])

        class NetworkTrainer:
            def generate_step_logs(self, *args, **kwargs):
                return {'loss/current': 1.0, 'lr/unet': 1.0, 'lr/d*eff_lr/unet': 1e-6}

        _patch_network_trainer_module(SimpleNamespace(NetworkTrainer=NetworkTrainer))
        trainer = NetworkTrainer()
        logs = trainer.generate_step_logs(None, 1.0, 1.0, scheduler, ['unet'], optimizer)
        self.assertEqual(logs, {'loss/current': 1.0})
        optimizer.step()
        logs = trainer.generate_step_logs(None, 1.0, 1.0, scheduler, ['unet'], optimizer)
        self.assertEqual(logs['lr/backbone'], 0.0)
        self.assertEqual(logs['lr/d*eff_lr/unet'], 0.0)

    def test_ppsf_adopt_initialisation_only_step_reports_zero(self):
        from prodigyplus import ProdigyPlusScheduleFree

        for schedulefree in (False, True):
            parameter = torch.nn.Parameter(torch.ones(4, 4))
            optimizer = ProdigyPlusScheduleFree([parameter], lr=1.0, use_adopt=True,
                                               use_schedulefree=schedulefree)
            optimizer.train()
            install_learning_rate_tracking(optimizer)
            before = parameter.detach().clone()
            parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            torch.testing.assert_close(parameter, before, rtol=0, atol=0)
            self.assertEqual(read_learning_rates(optimizer), [0.0])
            logs = {}
            append_backbone_learning_rate(logs, optimizer, ['unet'])
            self.assertEqual(logs['lr/backbone'], 0.0)
            parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            self.assertGreater(read_learning_rates(optimizer)[0], 0.0)

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA required for fused AMP skip')
    def test_fused_amp_overflow_preserves_last_completed_step_measurement(self):
        parameter = torch.nn.Parameter(torch.ones(4, 4, device='cuda'))
        optimizer = torch.optim.AdamW([parameter], lr=0.01, fused=True, weight_decay=0)
        scaler = torch.amp.GradScaler('cuda', init_scale=128)
        install_learning_rate_tracking(optimizer)
        scaler.scale(parameter.square().mean()).backward()
        scaler.step(optimizer)
        scaler.update()
        self.assertEqual(read_learning_rates(optimizer), [0.01])
        optimizer.zero_grad(set_to_none=True)
        optimizer.param_groups[0]['lr'] = 0.5
        before = parameter.detach().clone()
        scaler.scale(parameter.square().mean() * float('inf')).backward()
        scaler.step(optimizer)
        scaler.update()
        torch.testing.assert_close(parameter, before, rtol=0, atol=0)
        self.assertEqual(read_learning_rates(optimizer), [0.01])
        logs = {}
        append_backbone_learning_rate(logs, optimizer, ['unet'])
        self.assertEqual(logs['lr/backbone'], 0.01)

    def test_emosens_reports_coefficient_inferred_from_actual_weight_change(self):
        from vendor.emo_optimizer.emosens import EmoSens

        parameter = torch.nn.Parameter(torch.ones(4, 4, dtype=torch.float64))
        optimizer = EmoSens([parameter], lr=0.1, weight_decay=0, notify=False)
        install_learning_rate_tracking(optimizer)
        logs = {}
        append_backbone_learning_rate(logs, optimizer, ['unet'])
        self.assertNotIn('lr/backbone', logs)
        for loss in (1.0, 0.5, 0.2):
            parameter.grad = torch.ones_like(parameter)
            optimizer._manual_loss = loss
            before = parameter.detach().clone()
            optimizer.step()
            state = optimizer.state[parameter]
            direction = state['exp_avg'] / (state['exp_avg_sq'].sqrt() + optimizer.param_groups[0]['eps'])
            inferred = float(((before - parameter.detach()) / direction).mean())
            self.assertAlmostEqual(read_learning_rates(optimizer)[0], inferred, places=12)

    def test_external_scheduler_reports_completed_step_including_final_nonzero_lr(self):
        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = torch.optim.SGD([parameter], lr=0.1)
        install_learning_rate_tracking(optimizer)
        install_learning_rate_tracking(optimizer)
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: max(0, 1 - step / 2))
        for expected in (0.1, 0.05):
            parameter.grad = torch.ones_like(parameter)
            before = parameter.detach().clone()
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            actual = float((before - parameter.detach()).mean())
            self.assertAlmostEqual(read_learning_rates(optimizer, scheduler)[0], actual, places=6)
            self.assertEqual(read_learning_rates(optimizer)[0], expected)
        self.assertEqual(optimizer.param_groups[0]['lr'], 0)

    def test_closure_gradients_and_empty_steps_do_not_publish_configured_rates(self):
        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = torch.optim.SGD([parameter], lr=0.1)
        install_learning_rate_tracking(optimizer)

        def closure():
            loss = parameter.sum()
            loss.backward()
            return loss

        optimizer.step(closure=closure)
        self.assertEqual(read_learning_rates(optimizer), [0.1])
        optimizer.zero_grad(set_to_none=True)
        optimizer.step()
        logs = {}
        append_backbone_learning_rate(logs, optimizer, ['unet'])
        self.assertNotIn('lr/backbone', logs)

    def test_automagic_3_and_4_normal_and_fused_report_lr_used_before_group_vote(self):
        from vendor.automagic_optimizer.integration import Automagic3, Automagic4

        for cls in (Automagic3, Automagic4):
            for fused in (False, True):
                with self.subTest(optimizer=cls.__name__, fused=fused):
                    parameter = torch.nn.Parameter(torch.ones(8, 8))
                    optimizer = cls([parameter], lr=1e-4, max_lr=0.5, polarity_history=2,
                                    fused=fused, fused_guard=fused)
                    observed = []
                    original = optimizer._update_param

                    def observe(p, group):
                        lr = optimizer.state.get(p, {}).get('lr', group['lr'])
                        observed.append(float(lr))
                        return original(p, group)

                    optimizer._update_param = observe
                    install_learning_rate_tracking(optimizer)
                    changed = False
                    for _ in range(5):
                        observed.clear()
                        parameter.sum().backward()
                        optimizer.step()
                        optimizer.zero_grad(set_to_none=True)
                        logged = read_learning_rates(optimizer)[0]
                        self.assertAlmostEqual(logged, observed[0], places=10)
                        changed |= not math.isclose(logged, optimizer.get_learning_rates()[0], rel_tol=1e-5)
                    self.assertTrue(changed)
                    self.assertNotIn('_anima_step_lr_tracker', optimizer.state_dict())

    def test_prodigy_preserves_d_and_bias_correction_used_before_step(self):
        from prodigyopt import Prodigy

        for bias in (False, True):
            parameter = torch.nn.Parameter(torch.ones(8, 8))
            optimizer = Prodigy([parameter], lr=1.0, use_bias_correction=bias)
            install_learning_rate_tracking(optimizer)
            changed = False
            for _ in range(8):
                group = optimizer.param_groups[0]
                expected = group['d'] * group['lr']
                if bias:
                    beta1, beta2 = group['betas']
                    step = group['k'] + 1
                    expected *= math.sqrt(1 - beta2 ** step) / (1 - beta1 ** step)
                parameter.grad = torch.ones_like(parameter)
                optimizer.step()
                self.assertAlmostEqual(read_learning_rates(optimizer)[0], expected, places=14)
                changed |= group['d'] != expected
            self.assertTrue(changed)

    def test_ppsf_reports_actual_effective_coefficient_for_each_supported_mode(self):
        from prodigyplus import ProdigyPlusScheduleFree

        for bias in (False, True):
            for schedulefree in (False, True):
                for shared in (False, True):
                    with self.subTest(bias=bias, schedulefree=schedulefree, shared=shared):
                        parameters = [torch.nn.Parameter(torch.ones(4, 4)), torch.nn.Parameter(torch.ones(4, 8))]
                        optimizer = ProdigyPlusScheduleFree([
                            {'params': [parameters[0]], 'lr': 1.0},
                            {'params': [parameters[1]], 'lr': 0.5},
                        ], use_bias_correction=bias, use_schedulefree=schedulefree,
                            split_groups=True, split_groups_mean=shared, schedulefree_c=2)
                        optimizer.train()
                        observed = {}
                        original = optimizer.update_params

                        def observe(y, z, update, group, dlr):
                            result = original(y, z, update, group, dlr)
                            observed[id(group)] = dlr * group['effective_lr'] / group['lr']
                            return result

                        optimizer.update_params = observe
                        install_learning_rate_tracking(optimizer)
                        for step in range(8):
                            expected = []
                            for group in optimizer.param_groups:
                                value = optimizer.get_dlr(group)
                                if bias:
                                    value = optimizer.get_bias_correction(value, group['betas'][1], group['k'])[0]
                                expected.append(value)
                            for index, parameter in enumerate(parameters):
                                parameter.grad = torch.full_like(parameter, 1 + index)
                            optimizer.step()
                            if schedulefree:
                                expected = [observed[id(group)] for group in optimizer.param_groups]
                            for actual, value in zip(read_learning_rates(optimizer), expected):
                                self.assertAlmostEqual(actual, value, places=14)
                            if bias and step < 4:
                                self.assertEqual(read_learning_rates(optimizer), [0.0, 0.0])

    def test_schedulefree_includes_warmup_and_training_weight_coefficient(self):
        from schedulefree import AdamWScheduleFree

        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = AdamWScheduleFree([parameter], lr=0.001, warmup_steps=2, foreach=False)
        optimizer.train()
        install_learning_rate_tracking(optimizer)
        for expected in (0.0005, 0.001 * (1 - 0.9 * (1 - 0.8))):
            parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            self.assertAlmostEqual(read_learning_rates(optimizer)[0], expected)

    def test_adafactor_uses_weighted_actual_tensor_rates_and_ignores_inactive_tensor(self):
        from transformers.optimization import Adafactor

        parameters = [torch.nn.Parameter(torch.full((2, 2), 1.0)),
                      torch.nn.Parameter(torch.full((4, 4), 10.0)),
                      torch.nn.Parameter(torch.full((8, 8), 100.0))]
        optimizer = Adafactor(parameters, relative_step=True, scale_parameter=True)
        observed = []
        original = optimizer._get_lr

        def observe(group, state):
            value = original(group, state)
            observed.append(float(value))
            return value

        optimizer._get_lr = observe
        install_learning_rate_tracking(optimizer)
        for parameter in parameters[:2]:
            parameter.grad = torch.ones_like(parameter)
        optimizer.step()
        expected = (observed[0] * 4 + observed[1] * 16) / 20
        self.assertAlmostEqual(read_learning_rates(optimizer)[0], expected)
        self.assertNotEqual(observed[0], observed[1])

    def test_stable_adamw_reuses_tensor_update_clipping_in_both_paths(self):
        from pytorch_optimizer import StableAdamW

        for foreach in (False, True):
            parameter = torch.nn.Parameter(torch.ones(4, 4))
            optimizer = StableAdamW([parameter], lr=0.001, foreach=foreach)
            original = optimizer.get_stable_adamw_rms
            observed = []

            def observe(*args, **kwargs):
                value = original(*args, **kwargs)
                observed.append(float(value))
                return value

            optimizer.get_stable_adamw_rms = observe
            install_learning_rate_tracking(optimizer)
            for scale in (0.01, 100.0):
                parameter.grad = torch.full_like(parameter, scale)
                optimizer.step()
                self.assertAlmostEqual(read_learning_rates(optimizer)[0], 0.001 / observed[-1])
            self.assertGreater(observed[-1], 1)

    def test_muon_reports_shape_adjusted_step_size(self):
        parameter = torch.nn.Parameter(torch.ones(4, 16))
        optimizer = torch.optim.Muon([parameter], lr=0.01, adjust_lr_fn='match_rms_adamw')
        install_learning_rate_tracking(optimizer)
        parameter.grad = torch.ones_like(parameter)
        optimizer.step()
        self.assertAlmostEqual(read_learning_rates(optimizer)[0], 0.008)

    def test_backbone_excludes_text_encoder_and_weights_only_updated_parameters(self):
        parameters = [torch.nn.Parameter(torch.ones(size)) for size in (10, 2, 6, 100)]
        optimizer = torch.optim.SGD([
            {'params': [p], 'lr': rate} for p, rate in zip(parameters, (1.0, 0.1, 0.3, 10.0))
        ])
        install_learning_rate_tracking(optimizer)
        for parameter in parameters[:3]:
            parameter.grad = torch.ones_like(parameter)
        optimizer.step()
        logs = {}
        append_backbone_learning_rate(logs, SimpleNamespace(optimizer=optimizer),
                                      ['textencoder 1', 'unet_block0', 'unet plus', 'unet_block2'])
        self.assertAlmostEqual(logs['lr/backbone'], 0.25)

    def test_sd_scripts_scheduler_and_logging_hooks_install_capture_and_emit_same_main_lr(self):
        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = torch.optim.SGD([parameter], lr=0.1)
        module = SimpleNamespace(get_scheduler_fix=lambda args, opt, processes: SimpleNamespace(
            optimizer=opt, get_last_lr=lambda: [1.0]))
        _patch_optimizer_module(module)
        scheduler = module.get_scheduler_fix(None, optimizer, 1)

        class NetworkTrainer:
            def generate_step_logs(self, args, loss, average, lr_scheduler, names, optimizer=None):
                return {'lr/unet': lr_scheduler.get_last_lr()[0]}

        _patch_network_trainer_module(SimpleNamespace(NetworkTrainer=NetworkTrainer))
        parameter.grad = torch.ones_like(parameter)
        optimizer.step()
        optimizer.param_groups[0]['lr'] = 0.5
        logs = NetworkTrainer().generate_step_logs(None, 1.0, 1.0, scheduler, ['unet'], optimizer)
        self.assertEqual(logs, {'lr/unet': 0.1, 'lr/backbone': 0.1})

    def test_colliding_upstream_unet_keys_still_aggregate_every_backbone_group(self):
        parameters = [torch.nn.Parameter(torch.ones(size)) for size in (2, 6)]
        optimizer = torch.optim.SGD([{'params': [p], 'lr': lr}
                                    for p, lr in zip(parameters, (0.1, 0.3))])
        install_learning_rate_tracking(optimizer)
        for parameter in parameters:
            parameter.grad = torch.ones_like(parameter)
        optimizer.step()

        class NetworkTrainer:
            def generate_step_logs(self, args, loss, average, lr_scheduler, names, optimizer=None):
                return {'lr/unet': 1.0}

        _patch_network_trainer_module(SimpleNamespace(NetworkTrainer=NetworkTrainer))
        scheduler = SimpleNamespace(optimizer=optimizer)
        logs = NetworkTrainer().generate_step_logs(SimpleNamespace(network_train_unet_only=True),
                                                   1.0, 1.0, scheduler, None, optimizer)
        self.assertAlmostEqual(logs['lr/backbone'], 0.25)
        self.assertEqual(logs['lr/unet'], 0.3)
