"""LR display reads optimizer-owned values without instrumenting updates."""
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import torch

from tools.python_startup.lr_logging import (
    EffectiveLrNoOpScheduler, _patch_network_trainer_module, _patch_optimizer_module,
    append_backbone_learning_rate, read_learning_rates,
)


def trainer():
    class NetworkTrainer:
        def generate_step_logs(self, args, loss, average, lr_scheduler, descriptions, optimizer=None):
            rates = lr_scheduler.get_last_lr()
            return {f'lr/{name}': rate for name, rate in zip(descriptions or ['unet'], rates)}

    _patch_network_trainer_module(SimpleNamespace(NetworkTrainer=NetworkTrainer))
    return NetworkTrainer()


def optimizer_methods(optimizer):
    names = ('step', 'get_dlr', 'update_params', '_get_lr', 'get_stable_adamw_rms')
    return {name: getattr(getattr(optimizer, name), '__func__', getattr(optimizer, name))
            for name in names if hasattr(optimizer, name)}


class LearningRateDisplayTests(unittest.TestCase):
    def assert_unmodified(self, optimizer, methods):
        self.assertEqual(optimizer_methods(optimizer), methods)
        self.assertEqual(optimizer._optimizer_step_pre_hooks, {})
        self.assertEqual(optimizer._optimizer_step_post_hooks, {})
        self.assertFalse(hasattr(optimizer, '_anima_step_lr_tracker'))

    def test_adamw_keeps_native_scheduler_and_both_logging_paths(self):
        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = torch.optim.AdamW([parameter], lr=0.01)
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: 1 / (step + 1))
        methods = optimizer_methods(optimizer)

        def native_append(logs, scheduler, optimizer_type, names):
            for name, rate in zip(names, scheduler.get_last_lr()):
                logs[f'lr/{name}'] = rate

        module = SimpleNamespace(get_scheduler_fix=Mock(return_value=scheduler),
                                 append_lr_to_logs_with_names=Mock(side_effect=native_append))
        original_append = module.append_lr_to_logs_with_names
        _patch_optimizer_module(module)
        self.assertIs(module.get_scheduler_fix(None, optimizer, 1), scheduler)
        module.get_scheduler_fix.__wrapped__.assert_called_once_with(None, optimizer, 1)
        parameter.sum().backward()
        optimizer.step()
        scheduler.step()
        expected = scheduler.get_last_lr()[0]
        with patch('tools.python_startup.lr_logging.read_learning_rates', side_effect=AssertionError('extra LR read')):
            logs = trainer().generate_step_logs(None, 1, 1, scheduler, ['unet'], optimizer)
            self.assertEqual(logs, {'lr/unet': expected, 'lr/backbone': expected})
            logs = {}
            module.append_lr_to_logs_with_names(logs, scheduler, 'AdamW', ['unet'])
            self.assertEqual(logs, {'lr/unet': expected, 'lr/backbone': expected})
        original_append.assert_called_once()
        self.assert_unmodified(optimizer, methods)

    def test_native_logging_does_not_inspect_gradients_or_count_parameters(self):
        class Guard:
            @property
            def grad(self):
                raise AssertionError('logging must not inspect gradients')

            def numel(self):
                raise AssertionError('logging must not count parameters')

        optimizer = SimpleNamespace(param_groups=[{'lr': 0.001, 'params': [Guard()]}])
        scheduler = SimpleNamespace(optimizer=optimizer, get_last_lr=lambda: [0.001])
        logs = trainer().generate_step_logs(None, 1, 1, scheduler, ['unet'], optimizer)
        self.assertEqual(logs['lr/backbone'], 0.001)

    def test_krea_adamw_passes_the_native_scheduler_without_custom_lr_reads(self):
        root = Path(__file__).resolve().parents[2]
        with patch.object(sys, 'path', [str(root / 'vendor/musubi-tuner/src'), str(root / 'vendor'), *sys.path]):
            from backend.training.execution.krea2_train import Krea2Trainer

        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = torch.optim.AdamW([parameter], lr=0.01)
        methods = optimizer_methods(optimizer)
        scheduler = SimpleNamespace(optimizer=optimizer, get_last_lr=lambda: [0.007])
        with patch('tools.python_startup.lr_logging.read_learning_rates', side_effect=AssertionError('extra LR read')):
            logs = Krea2Trainer().generate_step_logs(SimpleNamespace(optimizer_type='AdamW'),
                                                     1.0, 1.0, scheduler, ['unet'], optimizer)
        self.assertEqual(logs['lr/unet'], 0.007)
        self.assertEqual(logs['lr/backbone'], 0.007)
        self.assert_unmodified(optimizer, methods)

    def test_emosens_reads_emo_pulse_directly_and_leaves_updates_untouched(self):
        from vendor.emo_optimizer.emosens import EmoSens

        parameter = torch.nn.Parameter(torch.ones(4, 4, dtype=torch.float64))
        optimizer = EmoSens([parameter], lr=0.1, weight_decay=0, notify=False)
        methods = optimizer_methods(optimizer)
        module = SimpleNamespace(get_scheduler_fix=Mock())
        _patch_optimizer_module(module)
        scheduler = module.get_scheduler_fix(None, optimizer, 1)
        self.assertIsInstance(scheduler, EffectiveLrNoOpScheduler)
        module.get_scheduler_fix.__wrapped__.assert_not_called()
        for loss in (1.0, 0.5, 0.2):
            parameter.grad = torch.ones_like(parameter)
            optimizer._manual_loss = loss
            before = parameter.detach().clone()
            optimizer.step()
            state = optimizer.state[parameter]
            direction = state['exp_avg'] / (state['exp_avg_sq'].sqrt() + optimizer.param_groups[0]['eps'])
            inferred = float(((before - parameter.detach()) / direction).mean())
            native = optimizer.param_groups[0]['lr']
            self.assertAlmostEqual(native, inferred, places=12)
            self.assertEqual(read_learning_rates(optimizer), [native])
            logs = trainer().generate_step_logs(None, 1, 1, scheduler, ['unet'], optimizer)
            self.assertEqual(logs['lr/backbone'], native)
        self.assert_unmodified(optimizer, methods)

    def test_automagic_uses_public_lr_reader_once_per_log_in_normal_and_fused_modes(self):
        from vendor.automagic_optimizer.integration import Automagic3, Automagic4

        for cls in (Automagic3, Automagic4):
            for fused in (False, True):
                with self.subTest(optimizer=cls.__name__, fused=fused):
                    parameter = torch.nn.Parameter(torch.ones(8, 8))
                    optimizer = cls([parameter], lr=1e-4, max_lr=0.5, polarity_history=2,
                                    fused=fused, fused_guard=fused)
                    methods = optimizer_methods(optimizer)
                    scheduler = EffectiveLrNoOpScheduler(optimizer)
                    logger = trainer()
                    for _ in range(3):
                        parameter.sum().backward()
                        optimizer.step()
                        optimizer.zero_grad(set_to_none=True)
                        expected = optimizer.get_learning_rates()[0]
                        with patch.object(optimizer, 'get_learning_rates', wraps=optimizer.get_learning_rates) as reader:
                            logs = logger.generate_step_logs(None, 1, 1, scheduler, ['unet'], optimizer)
                            reader.assert_called_once_with()
                        self.assertEqual(logs['lr/backbone'], expected)
                    self.assert_unmodified(optimizer, methods)

    def test_ppsf_reads_existing_effective_lr_with_shared_d_and_optional_bias_correction(self):
        from prodigyplus import ProdigyPlusScheduleFree

        for bias in (False, True):
            parameters = [torch.nn.Parameter(torch.ones(4, 4)) for _ in range(2)]
            optimizer = ProdigyPlusScheduleFree([
                {'params': [parameters[0]], 'lr': 1.0}, {'params': [parameters[1]], 'lr': 0.5},
            ], split_groups=True, split_groups_mean=True, use_bias_correction=bias)
            optimizer.train()
            methods = optimizer_methods(optimizer)
            logger = trainer()
            scheduler = EffectiveLrNoOpScheduler(optimizer)
            for step in range(6):
                for index, parameter in enumerate(parameters):
                    parameter.grad = torch.full_like(parameter, 1 + index)
                optimizer.step()
                expected = []
                for group in optimizer.param_groups:
                    value = optimizer.get_dlr(group) * group['effective_lr'] / group['lr']
                    if bias:
                        value = optimizer.get_bias_correction(value, group['betas'][1], group['k'] - 1)[0]
                    expected.append(value)
                self.assertEqual(read_learning_rates(optimizer), expected)
                logs = logger.generate_step_logs(None, 1, 1, scheduler, ['unet', 'unet plus'], optimizer)
                self.assertEqual(logs['lr/backbone'], expected[0])
                self.assertEqual(logs['lr/d*eff_lr/unet'], expected[0])
                if bias and step < 4:
                    self.assertEqual(expected, [0.0, 0.0])
            self.assert_unmodified(optimizer, methods)

    def test_prodigy_reads_adaptive_lr_without_wrapping_optimizer_methods(self):
        from prodigyopt import Prodigy

        parameter = torch.nn.Parameter(torch.ones(4, 4))
        optimizer = Prodigy([parameter], lr=1.0, use_bias_correction=True)
        methods = optimizer_methods(optimizer)
        scheduler = SimpleNamespace(optimizer=optimizer, get_last_lr=lambda: [1.0])
        for _ in range(3):
            parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            group = optimizer.param_groups[0]
            beta1, beta2 = group['betas']
            expected = group['d'] * group['lr'] * math.sqrt(1 - beta2 ** group['k']) / (1 - beta1 ** group['k'])
            logs = trainer().generate_step_logs(None, 1, 1, scheduler, ['unet'], optimizer)
            self.assertAlmostEqual(logs['lr/backbone'], expected, places=14)
        self.assert_unmodified(optimizer, methods)

    def test_schedulefree_reads_native_scheduled_lr_without_extra_update_scaling(self):
        from schedulefree import AdamWScheduleFree

        parameter = torch.nn.Parameter(torch.ones(2))
        optimizer = AdamWScheduleFree([parameter], lr=0.001, warmup_steps=2, foreach=False)
        optimizer.train()
        methods = optimizer_methods(optimizer)
        for expected in (0.0005, 0.001):
            parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            self.assertEqual(read_learning_rates(optimizer), [expected])
        self.assert_unmodified(optimizer, methods)

    def test_backbone_display_copies_the_native_main_group_without_weighting(self):
        logs = {'lr/textencoder 1': 0.9, 'lr/d*eff_lr/unet': 0.4, 'lr/unet plus': 0.2, 'lr/unet': 0.1}
        append_backbone_learning_rate(logs)
        self.assertEqual(logs['lr/backbone'], 0.1)
        logs = {'lr/textencoder 1': 0.9, 'lr/unet_block0': 0.2, 'lr/unet_block1': 0.5}
        append_backbone_learning_rate(logs)
        self.assertEqual(logs['lr/backbone'], 0.2)
        logs = {'lr/textencoder 1': 0.9}
        append_backbone_learning_rate(logs)
        self.assertNotIn('lr/backbone', logs)
