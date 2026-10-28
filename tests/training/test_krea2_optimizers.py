import ast
from pathlib import Path
import tempfile
import unittest

from backend.training.config.config_import import import_native_training_form
from backend.training.config.krea2_optimizers import ARGUMENTS
from backend.training.config.musubi_krea2 import (
    KREA2_FIELDS, _build_krea2_optimizer_args, build_krea2_train_config, validate_krea2_config,
)
from backend.training.fields.optimizer_metadata import optimizer_entries, KREA2_PROFILE, SD_SCRIPTS_PROFILE
from tests.training.test_multi_core_krea2 import krea2_config


class Krea2OptimizerTests(unittest.TestCase):
    def test_removed_bnb_clipping_is_cleaned_from_old_configs(self):
        with tempfile.TemporaryDirectory() as directory:
            base = krea2_config(Path(directory))
            for optimizer in ('adamw8bit', 'bitsandbytes.optim.PagedAdamW8bit',
                              'bitsandbytes.optim.Lion8bit', 'bitsandbytes.optim.PagedLion8bit'):
                for value in (100, 99):
                    for legacy in ({'bnb_percentile_clipping': value},
                                   {'optimizer_args': [f'percentile_clipping={value}']},
                                   {'optimizer_args_custom': f'percentile_clipping={value}'}):
                        with self.subTest(optimizer=optimizer, legacy=legacy):
                            config = {**base, 'optimizer_type': optimizer, 'bnb_min_8bit_size': 128, **legacy}
                            self.assertEqual(validate_krea2_config(config), [])
                            capture = self.assertNoLogs if value == 100 else self.assertLogs
                            with capture('anima-trainer', level='WARNING'):
                                native = build_krea2_train_config(config, 'dataset.toml', 'output', 'log')
                                restored = import_native_training_form(config, profile_id='krea2-lora')
                            self.assertNotIn('bnb_percentile_clipping', native)
                            self.assertIn('min_8bit_size=128', native['optimizer_args'])
                            self.assertFalse(any('percentile_clipping' in arg for arg in native['optimizer_args']))
                            self.assertNotIn('bnb_percentile_clipping', restored)
                            self.assertNotIn('percentile_clipping', restored.get('optimizer_args_custom', ''))

    def test_all_shared_optimizers_and_controls_export_and_import(self):
        entries = optimizer_entries(KREA2_PROFILE)
        self.assertEqual([entry.label for entry in entries], [entry.label for entry in optimizer_entries(SD_SCRIPTS_PROFILE)])
        fields = {field['key']: field for field in KREA2_FIELDS}
        expected = set(ARGUMENTS)
        self.assertTrue(expected <= fields.keys(), expected - fields.keys())
        with tempfile.TemporaryDirectory() as directory:
            base = krea2_config(Path(directory))
            for entry in entries:
                with self.subTest(optimizer=entry.label):
                    form = dict(base)
                    form.update({key: field['default'] for key, field in fields.items() if key in ARGUMENTS})
                    form['optimizer_type'] = entry.selector
                    self.assertEqual(validate_krea2_config(form), [])
                    native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                    restored = import_native_training_form({'optimizer_type': entry.selector,
                        'optimizer_args': native.get('optimizer_args', [])}, profile_id='krea2-lora')
                    self.assertEqual(set(_build_krea2_optimizer_args(restored)), set(native.get('optimizer_args', [])))

    def test_nondefault_arguments_and_custom_literals_are_preserved(self):
        cases = [
            ('pytorch_optimizer.SOAP', {'max_precondition_dim': 128, 'shampoo_beta': 0.9,
                'normalize_gradient': True, 'precondition_frequency': 3}, {'max_precondition_dim': 128, 'shampoo_beta': 0.9}),
            ('pytorch_optimizer.CAME', {'came_eps1': '1e-20', 'came_eps2': '1e-10', 'came_ams_bound': True}, {'eps1': 1e-20, 'eps2': 1e-10, 'ams_bound': True}),
            ('bitsandbytes.optim.AdEMAMix8bit', {'ademamix_alpha': 3, 'ademamix_t_alpha': 0, 'ademamix_t_beta3': 500}, {'alpha': 3, 't_alpha': 0, 't_beta3': 500}),
            ('prodigyplus.ProdigyPlusScheduleFree', {'optimizer_args_custom': 'eps=None\nuse_adopt=True'}, {'eps': None, 'use_adopt': True}),
            ('prodigyplus.ProdigyPlusScheduleFree', {'krea_optimizer_eps': 'None', 'krea_prodigyplus_use_stableadamw': False}, {'eps': None, 'use_stableadamw': False}),
            ('AdamW', {'optimizer_args_custom': 'amsgrad=True\nforeach=False'}, {'amsgrad': True, 'foreach': False}),
        ]
        with tempfile.TemporaryDirectory() as directory:
            base = krea2_config(Path(directory))
            for optimizer, values, expected in cases:
                with self.subTest(optimizer=optimizer):
                    form = {**base, 'optimizer_type': optimizer, **values}
                    self.assertEqual(validate_krea2_config(form), [])
                    if expected.get('eps', 1e-8) is None:
                        self.assertEqual(form['max_grad_norm'], 0)
                    native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                    arguments = dict((key, ast.literal_eval(value)) for key, value in
                                     (item.split('=', 1) for item in native['optimizer_args']))
                    self.assertEqual({key: arguments[key] for key in expected}, expected)
                    restored = import_native_training_form({'optimizer_type': optimizer, 'optimizer_args': native['optimizer_args']}, profile_id='krea2-lora')
                    self.assertEqual(set(_build_krea2_optimizer_args(restored)), set(native['optimizer_args']))

    def test_invalid_combinations_and_ignored_arguments_are_rejected(self):
        cases = [
            ('pytorch_optimizer.SOAP', {'precondition_frequency': 0}, 'precondition_frequency'),
            ('pytorch_optimizer.StableAdamW', {'stableadamw_kahan_sum': 'yes'}, 'kahan_sum'),
            ('prodigyplus.ProdigyPlusScheduleFree', {'krea_prodigyplus_use_stableadamw': 'yes'}, 'use_stableadamw'),
            ('bitsandbytes.optim.AdEMAMix8bit', {'ademamix_t_alpha': 1.5}, 't_alpha'),
            ('vendor.lora_muon.LoRA_Muon', {'enable_loraplus': True}, 'enable_loraplus'),
            ('prodigyopt.Prodigy', {'enable_loraplus': True}, 'enable_loraplus'),
            ('prodigyplus.ProdigyPlusScheduleFree', {'enable_loraplus': True}, 'enable_loraplus'),
            ('pytorch_optimizer.LoRARite', {'network_module': 'lycoris.kohya', 'lycoris_algo': 'loha'}, 'LoRA-RITE'),
            ('pytorch_optimizer.LoRARite', {'network_module': 'lycoris.kohya', 'lycoris_algo': 'lora', 'use_scalar': True}, 'paired'),
            ('torch.optim.Muon', {'network_module': 'lycoris.kohya', 'use_scalar': True}, 'use_scalar'),
            ('vendor.emo_optimizer.emosens.EmoSens', {'gradient_accumulation_steps': 2}, 'gradient_accumulation_steps'),
            ('vendor.emo_optimizer.emosens.EmoSens', {'gpu_ids': [0, 1]}, 'one GPU'),
            ('vendor.automagic_optimizer.integration.Automagic3', {'automagic_fused': True, 'max_grad_norm': 1}, 'max_grad_norm'),
            ('vendor.automagic_optimizer.integration.Automagic3', {'automagic_min_lr': 0.5, 'automagic_max_lr': 0.1}, 'min_lr'),
            ('prodigyplus.ProdigyPlusScheduleFree', {'optimizer_args_custom': 'fused_back_pass=True'}, 'skip all'),
            ('AdamW', {'optimizer_args_custom': 'imaginary_flag=True'}, 'unsupported argument'),
        ]
        with tempfile.TemporaryDirectory() as directory:
            base = krea2_config(Path(directory))
            for optimizer, values, expected in cases:
                with self.subTest(optimizer=optimizer, values=values):
                    form = {**base, 'optimizer_type': optimizer, **values}
                    errors = validate_krea2_config(form)
                    self.assertTrue(any(expected in error for error in errors), errors)

    def test_locon_dropout_and_internal_schedule_use_effective_runtime_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            base = krea2_config(Path(directory))
            form = {**base, 'network_module': 'lycoris.kohya', 'lycoris_algo': 'lora', 'dropout': 0.2,
                    'enable_loraplus': True, 'loraplus_lr_ratio': 3}
            self.assertEqual(validate_krea2_config(form), [])
            self.assertTrue(form['bypass_mode'])
            native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
            self.assertNotIn('network_dropout', native)
            self.assertIn('dropout=0.2', native['network_args'])
            self.assertIn('bypass_mode=True', native['network_args'])
            self.assertIn('loraplus_lr_ratio=3.0', native['network_args'])
            restored = import_native_training_form({'network_module': 'lycoris.kohya', 'network_args': ['algo=lora'],
                'network_dropout': 0.2}, profile_id='krea2-lora')
            self.assertEqual(restored['dropout'], 0.2)
            for extra in ({}, {'network_dropout': 0.1}, {'dropout': 0.3}):
                with self.subTest(extra=extra):
                    restored = import_native_training_form({'network_module': 'lycoris.kohya',
                        'network_args': ['algo=lora', 'dropout=0.2'], **extra}, profile_id='krea2-lora')
                    self.assertEqual(restored['dropout'], extra.get('dropout', 0.2))
                    self.assertNotIn('network_dropout', restored)
            form['dora_wd'] = True
            self.assertTrue(any('dropout' in error for error in validate_krea2_config(form)))
            for optimizer in ('vendor.automagic_optimizer.integration.Automagic3', 'vendor.emo_optimizer.emosens.EmoSens'):
                form = {**base, 'optimizer_type': optimizer, 'lr_scheduler': 'cosine', 'lr_warmup_steps': 5}
                self.assertEqual(validate_krea2_config(form), [])
                self.assertEqual(form['lr_scheduler'], 'constant')
                self.assertEqual(form['lr_warmup_steps'], 0)
