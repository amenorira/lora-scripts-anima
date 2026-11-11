"""Automagic product contracts and small real optimizer execution regressions."""
import copy
from pathlib import Path
import tempfile
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.config.musubi_krea2 import build_krea2_train_config, validate_krea2_config
from backend.training.config.optimizer_contracts import (
    AUTOMAGIC_OPTIMIZER_TYPE, AUTOMAGIC4_OPTIMIZER_TYPE, parse_optimizer_args,
)
from backend.training.config.validation import validate_training_config
from tests.helpers import valid_training_config
from tests.training.test_multi_core_krea2 import krea2_config


OPTIMIZERS = (AUTOMAGIC_OPTIMIZER_TYPE, AUTOMAGIC4_OPTIMIZER_TYPE)
COMMON_FIELDS = {
    'automagic_min_lr': 1e-7, 'automagic_max_lr': 0.4,
    'automagic_beta2': 0.98, 'eps': 1e-20,
    'automagic_clip_threshold': 0.7, 'weight_decay': 0.015,
    'automagic_polarity_history': 4, 'automagic_fused': True,
}
COMMON_ARGS = {
    'min_lr': 1e-7, 'max_lr': 0.4, 'beta2': 0.98, 'eps': 1e-20,
    'clip_threshold': 0.7, 'weight_decay': 0.015, 'polarity_history': 4, 'fused': True,
}
V4_FIELDS = {'automagic_sensitivity_quantile': 0.85, 'automagic_step_target': 0.2}
V4_ARGS = {'sensitivity_quantile': 0.85, 'step_target': 0.2}


class AutomagicConfigTests(unittest.TestCase):
    def test_project_defaults_preserve_explicit_legacy_rates(self):
        for optimizer in OPTIMIZERS:
            with self.subTest(optimizer=optimizer):
                form = valid_training_config(optimizer_type=optimizer, learning_rate='2e-5')
                self.assertEqual(validate_training_config(form.copy()), [])
                native, _ = adapt_config(form)
                self.assertEqual(float(native['learning_rate']), 2e-5)
                self.assertEqual(parse_optimizer_args(native)[0]['max_lr'], 1e-4)
                form.pop('learning_rate')
                self.assertEqual(adapt_config(form)[0]['learning_rate'], 2e-5)
                form.update(learning_rate='1e-4', automagic_max_lr='1e3')
                native, _ = adapt_config(form)
                self.assertEqual(float(native['learning_rate']), 1e-4)
                self.assertEqual(parse_optimizer_args(native)[0]['max_lr'], 1e3)

    def test_complete_arguments_round_trip_across_training_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            krea = krea2_config(Path(directory))
            for profile in ('anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora'):
                for optimizer in OPTIMIZERS:
                    with self.subTest(profile=profile, optimizer=optimizer):
                        fields = {**COMMON_FIELDS, **V4_FIELDS}
                        if profile == 'krea2-lora':
                            form = {**krea, **fields, 'optimizer_type': optimizer,
                                    'learning_rate': 2e-4, 'max_grad_norm': 0,
                                    'gradient_accumulation_steps': 1, 'mixed_precision': 'bf16'}
                            form['krea_optimizer_eps'] = fields['eps']
                            form['krea_optimizer_weight_decay'] = fields['weight_decay']
                            validate = validate_krea2_config
                            export = lambda values: build_krea2_train_config(values, 'dataset.toml', 'output', 'log')
                        else:
                            form = valid_training_config(profile, optimizer_type=optimizer,
                                learning_rate=2e-4, max_grad_norm=0,
                                gradient_accumulation_steps=1, mixed_precision='bf16', **fields)
                            if profile == 'moss-image-lora':
                                form.update(network_module='networks.lora_generic', text_encoder='text.safetensors')
                            validate = validate_training_config
                            export = lambda values: adapt_config(values)[0]
                        self.assertEqual(validate(form.copy()), [])
                        native = export(form)
                        self.assertEqual(float(native['learning_rate']), 2e-4)
                        self.assertEqual(native['optimizer_type'], optimizer)
                        args, errors = parse_optimizer_args(native)
                        self.assertEqual(errors, [])
                        self.assertNotIn('lr', args)
                        expected = {**COMMON_ARGS, **(V4_ARGS if optimizer == AUTOMAGIC4_OPTIMIZER_TYPE else {})}
                        for key, value in expected.items():
                            self.assertEqual(args.get(key), value, key)
                        if optimizer == AUTOMAGIC_OPTIMIZER_TYPE:
                            self.assertFalse(set(V4_ARGS) & args.keys())
                        restored = import_native_training_form(native, profile_id=profile)
                        self.assertNotIn('fused_guard', restored.get('optimizer_args_custom', ''))
                        restored = {**form, **restored}
                        self.assertEqual(validate(restored.copy()), [])
                        self.assertEqual(parse_optimizer_args(export(restored))[0], args)

    def test_custom_values_override_unchanged_defaults_but_explicit_controls_win(self):
        for optimizer in OPTIMIZERS:
            for explicit, expected in ((False, 0.97), (True, 0.96)):
                with self.subTest(optimizer=optimizer, explicit=explicit):
                    form = valid_training_config(optimizer_type=optimizer,
                        optimizer_args_custom='beta2=0.97\nmax_lr=0.3')
                    if explicit:
                        form['automagic_beta2'] = 0.96
                    self.assertEqual(validate_training_config(form.copy()), [])
                    args = parse_optimizer_args(adapt_config(form)[0])[0]
                    self.assertEqual(args['beta2'], expected)
                    self.assertEqual(args['max_lr'], 0.3)
        form = valid_training_config(optimizer_type=AUTOMAGIC4_OPTIMIZER_TYPE,
            optimizer_args_custom='sensitivity_quantile=0.8\nstep_target=0.2')
        args = parse_optimizer_args(adapt_config(form)[0])[0]
        self.assertEqual(args['sensitivity_quantile'], 0.8)
        self.assertEqual(args['step_target'], 0.2)
        form.update(automagic_sensitivity_quantile=0.75, automagic_step_target=0.15)
        args = parse_optimizer_args(adapt_config(form)[0])[0]
        self.assertEqual(args['sensitivity_quantile'], 0.75)
        self.assertEqual(args['step_target'], 0.15)

    def test_full_precision_flags_are_removed_through_validation_and_adapter(self):
        for optimizer in OPTIMIZERS:
            for flag, precision in (('full_fp16', 'fp16'), ('full_bf16', 'bf16')):
                with self.subTest(optimizer=optimizer, flag=flag):
                    form = valid_training_config('sdxl-lora', optimizer_type=optimizer,
                        mixed_precision=precision, **{flag: True})
                    self.assertEqual(validate_training_config(form), [])
                    native, warnings = adapt_config(form)
                    self.assertFalse(native.get('full_fp16', False))
                    self.assertFalse(native.get('full_bf16', False))
                    self.assertTrue(any(flag in warning for warning in warnings), warnings)

    def test_fused_requires_single_gpu_no_accumulation_no_clipping_and_no_scaler(self):
        for optimizer in OPTIMIZERS:
            base = valid_training_config(optimizer_type=optimizer, automagic_fused=True,
                gradient_accumulation_steps=1, max_grad_norm=0, mixed_precision='bf16')
            self.assertEqual(validate_training_config(base.copy(), gpu_ids=[0]), [])
            args = parse_optimizer_args(adapt_config(base, gpu_ids=[0])[0])[0]
            self.assertIs(args['fused'], True)
            self.assertIs(args['fused_guard'], True)
            for changes, gpu_ids, expected in (
                ({'gradient_accumulation_steps': 2}, [0], 'gradient_accumulation_steps'),
                ({'max_grad_norm': 1}, [0], 'max_grad_norm'),
                ({'mixed_precision': 'fp16'}, [0], 'mixed_precision'),
                ({}, [0, 1], 'one GPU'),
            ):
                with self.subTest(optimizer=optimizer, changes=changes, gpu_ids=gpu_ids):
                    form = {**base, **changes}
                    errors = validate_training_config(form.copy(), gpu_ids=gpu_ids)
                    self.assertTrue(any(expected in error for error in errors), errors)
                    native, _ = adapt_config(form, gpu_ids=gpu_ids)
                    args = parse_optimizer_args(native)[0]
                    self.assertIs(args['fused'], False)
                    self.assertNotIn('fused_guard', args)

    def test_v4_parameter_domains_reject_booleans_nonfinite_values_and_edges(self):
        for field, valid_values, invalid_values in (
            ('automagic_sensitivity_quantile', (1e-10, 0.01, 0.9, 1), (0, -0.1, 1.01, True, float('inf'), float('nan'))),
            ('automagic_step_target', (1e-10, 0.001, 0.1, 1.99, 1.9999999), (0, -0.1, 2, True, float('inf'), float('nan'))),
        ):
            for value in valid_values:
                with self.subTest(field=field, valid=value):
                    form = valid_training_config(optimizer_type=AUTOMAGIC4_OPTIMIZER_TYPE, **{field: value})
                    self.assertEqual(validate_training_config(form), [])
            for value in invalid_values:
                with self.subTest(field=field, invalid=value):
                    form = valid_training_config(optimizer_type=AUTOMAGIC4_OPTIMIZER_TYPE, **{field: value})
                    self.assertTrue(any(field in error or field.removeprefix('automagic_') in error
                                        for error in validate_training_config(form)))

    def test_krea_v4_bounds_and_fused_conflicts_use_shared_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            base = {**krea2_config(Path(directory)), 'optimizer_type': AUTOMAGIC4_OPTIMIZER_TYPE}
            for changes, expected in (
                ({'automagic_step_target': 2}, 'step_target'),
                ({'automagic_sensitivity_quantile': 0}, 'sensitivity_quantile'),
                ({'automagic_fused': True, 'max_grad_norm': 0, 'gpu_ids': [0, 1]}, 'one GPU'),
                ({'automagic_fused': True, 'max_grad_norm': 0, 'mixed_precision': 'fp16'}, 'mixed_precision'),
            ):
                with self.subTest(changes=changes):
                    errors = validate_krea2_config({**base, **changes})
                    self.assertTrue(any(expected in error for error in errors), errors)


class AutomagicExecutionTests(unittest.TestCase):
    @staticmethod
    def optimizer_classes():
        from vendor.automagic_optimizer.integration import Automagic3, Automagic4

        return Automagic3, Automagic4

    def test_wrappers_reject_low_precision_parameters_and_unguarded_fused_updates(self):
        import torch

        for optimizer in self.optimizer_classes():
            with self.subTest(optimizer=optimizer.__name__):
                low_precision = torch.nn.Parameter(torch.ones(2, dtype=torch.bfloat16))
                with self.assertRaisesRegex(ValueError, 'FP32'):
                    optimizer([low_precision])
                parameter = torch.nn.Parameter(torch.ones(2))
                with self.assertRaisesRegex(ValueError, 'fused_guard'):
                    optimizer([parameter], fused=True)

    def test_v4_direct_constructor_validates_new_parameters(self):
        import torch

        _, optimizer = self.optimizer_classes()
        for argument, invalid in (
            ('sensitivity_quantile', (0, -0.1, 1.1, True, float('inf'), float('nan'))),
            ('step_target', (0, -0.1, 2, True, float('inf'), float('nan'))),
        ):
            for value in invalid:
                with self.subTest(argument=argument, value=value):
                    parameter = torch.nn.Parameter(torch.ones(2))
                    with self.assertRaisesRegex(ValueError, argument):
                        optimizer([parameter], **{argument: value})

    def test_v4_first_step_measures_then_updates_for_normal_and_fused_modes(self):
        import torch

        _, optimizer = self.optimizer_classes()
        for fused in (False, True):
            with self.subTest(fused=fused):
                parameter = torch.nn.Parameter(torch.tensor([[1., 2.], [3., 4.]]))
                initial = parameter.detach().clone()
                instance = optimizer([parameter], lr=1e-3, max_lr=0.1, polarity_history=2,
                                     fused=fused, fused_guard=fused)
                parameter.square().sum().backward()
                instance.step()
                torch.testing.assert_close(parameter, initial, rtol=0, atol=0)
                self.assertIsNone(parameter.grad)
                self.assertEqual(instance.state[parameter]['step'], 1)
                reference = instance.state[parameter]['sens_ref']
                self.assertTrue(torch.isfinite(reference).all())
                self.assertTrue((reference > 0).all())
                parameter.square().sum().backward()
                instance.step()
                self.assertFalse(torch.equal(parameter, initial))
                self.assertTrue(torch.isfinite(parameter).all())

    def test_normal_and_fused_checkpoints_continue_with_matching_state(self):
        import torch
        from tools.python_startup.lr_logging import (
            EffectiveLrNoOpScheduler, optimizer_owns_schedule, read_learning_rates,
        )

        for optimizer in self.optimizer_classes():
            for fused in (False, True):
                with self.subTest(optimizer=optimizer.__name__, fused=fused):
                    parameter = torch.nn.Parameter(torch.tensor([[1., -2.], [0.5, 3.]]))
                    kwargs = {'lr': 1e-3, 'max_lr': 0.1, 'polarity_history': 2,
                              'fused': fused, 'fused_guard': fused}
                    instance = optimizer([parameter], **kwargs)
                    for _ in range(5):
                        parameter.square().sum().backward()
                        instance.step()
                    adaptive_rates = instance.get_learning_rates()
                    self.assertNotEqual(adaptive_rates, [group['lr'] for group in instance.param_groups])
                    self.assertTrue(optimizer_owns_schedule(instance))
                    self.assertEqual(read_learning_rates(instance), adaptive_rates)
                    self.assertEqual(EffectiveLrNoOpScheduler(instance).get_last_lr(), adaptive_rates)
                    checkpoint = copy.deepcopy(instance.state_dict())
                    restored_parameter = torch.nn.Parameter(parameter.detach().clone())
                    restored = optimizer([restored_parameter], **kwargs)
                    restored.load_state_dict(checkpoint)
                    torch.testing.assert_close(torch.tensor(restored.get_learning_rates()),
                                               torch.tensor(instance.get_learning_rates()), rtol=1e-6, atol=0)
                    if optimizer.__name__ == 'Automagic4':
                        saved = next(iter(checkpoint['state'].values()))['sens_ref']
                        torch.testing.assert_close(restored.state[restored_parameter]['sens_ref'], saved)
                    for tensor, current in ((parameter, instance), (restored_parameter, restored)):
                        tensor.square().sum().backward()
                        current.step()
                    torch.testing.assert_close(restored_parameter, parameter)
                    self.assertEqual(restored.state[restored_parameter]['step'], instance.state[parameter]['step'])
                    torch.testing.assert_close(torch.tensor(restored.get_learning_rates()),
                                               torch.tensor(instance.get_learning_rates()), rtol=1e-6, atol=0)
                    if optimizer.__name__ == 'Automagic4':
                        torch.testing.assert_close(restored.state[restored_parameter]['sens_ref'],
                                                   instance.state[parameter]['sens_ref'])


if __name__ == '__main__':
    unittest.main()
