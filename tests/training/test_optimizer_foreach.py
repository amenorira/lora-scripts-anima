"""Foreach choices must reach native trainers and survive configuration imports."""
from pathlib import Path
import tempfile
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.config_import import import_native_training_form
from backend.training.config.musubi_krea2 import build_krea2_train_config, validate_krea2_config
from backend.training.config.optimizer_contracts import parse_optimizer_args
from backend.training.config.validation import validate_training_config
from tests.helpers import valid_training_config
from tests.training.test_multi_core_krea2 import krea2_config


class ForeachConfigTests(unittest.TestCase):
    def test_tristate_round_trip_reaches_both_native_trainers(self):
        optimizers = ('AdamW', 'pytorch_optimizer.StableAdamW', 'pytorch_optimizer.CAME',
                      'pytorch_optimizer.Adan', 'AdamWScheduleFree')
        with tempfile.TemporaryDirectory() as directory:
            krea = krea2_config(Path(directory))
            for profile in ('anima-lora', 'sdxl-lora', 'moss-image-lora', 'krea2-lora'):
                selectors = (*optimizers, 'pytorch_optimizer.Lion') if profile == 'krea2-lora' else optimizers
                for optimizer in selectors:
                    if profile == 'krea2-lora' and optimizer == 'AdamWScheduleFree':
                        optimizer = 'schedulefree.AdamWScheduleFree'
                    for choice, expected in (('auto', None), ('true', True), ('false', False)):
                        with self.subTest(profile=profile, optimizer=optimizer, choice=choice):
                            if profile == 'krea2-lora':
                                form = {**krea, 'optimizer_type': optimizer, 'foreach': choice}
                                self.assertEqual(validate_krea2_config(form), [])
                                native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                            else:
                                form = valid_training_config(profile, optimizer_type=optimizer, foreach=choice)
                                if profile == 'moss-image-lora':
                                    form.update(network_module='networks.lora_generic', text_encoder='models/text.safetensors')
                                self.assertEqual(validate_training_config(form), [])
                                native, _ = adapt_config(form)
                            args, errors = parse_optimizer_args(native)
                            self.assertEqual(errors, [])
                            if optimizer in ('AdamWScheduleFree', 'schedulefree.AdamWScheduleFree') and choice == 'auto':
                                self.assertNotIn('foreach', args)
                            else:
                                self.assertIs(args['foreach'], expected)
                            self.assertNotIn('foreach', native)
                            restored = import_native_training_form(native, profile_id=profile)
                            self.assertEqual(restored.get('foreach', 'auto'), choice)

    def test_schedulefree_explicit_none_survives_import_and_auto_keeps_custom_values(self):
        with tempfile.TemporaryDirectory() as directory:
            for profile in ('anima-lora', 'krea2-lora'):
                optimizer = 'schedulefree.AdamWScheduleFree' if profile == 'krea2-lora' else 'AdamWScheduleFree'
                native = {'optimizer_type': optimizer, 'optimizer_args': ['foreach=None']}
                restored = import_native_training_form(native, profile_id=profile)
                self.assertEqual(restored['foreach'], 'auto')
                self.assertIn('foreach=None', restored['optimizer_args_custom'])
                if profile == 'krea2-lora':
                    form = {**krea2_config(Path(directory)), **restored}
                    exported = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                else:
                    form = {**valid_training_config(profile), **restored}
                    exported, _ = adapt_config(form)
                self.assertIsNone(parse_optimizer_args(exported)[0]['foreach'])
                form['foreach'] = 'true'
                if profile == 'krea2-lora':
                    exported = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                else:
                    exported, _ = adapt_config(form)
                self.assertIs(parse_optimizer_args(exported)[0]['foreach'], True)

    def test_custom_overrides_and_unsupported_optimizers_remain_safe(self):
        for choice, expected in (('auto', False), ('true', True), ('false', False)):
            form = valid_training_config(optimizer_type='pytorch_optimizer.CAME', foreach=choice,
                                         optimizer_args_custom='foreach=False')
            native, _ = adapt_config(form)
            args, _ = parse_optimizer_args(native)
            self.assertIs(args['foreach'], expected)
        for optimizer in ('AdamW8bit', 'Lion', 'pytorch_optimizer.SOAP'):
            form = valid_training_config(optimizer_type=optimizer, foreach='true')
            native, _ = adapt_config(form)
            self.assertNotIn('foreach', parse_optimizer_args(native)[0])
            form['optimizer_args_custom'] = 'foreach=True'
            self.assertTrue(any('foreach' in error for error in validate_training_config(form)))

    def test_invalid_choice_and_adamw_fused_conflict_are_rejected_before_launch(self):
        for changes in ({'foreach': 'yes'}, {'foreach': 'true', 'optimizer_args_custom': 'fused=True'}):
            form = valid_training_config(optimizer_type='AdamW', **changes)
            self.assertTrue(any('foreach' in error for error in validate_training_config(form)))
        with tempfile.TemporaryDirectory() as directory:
            form = {**krea2_config(Path(directory)), 'optimizer_type': 'AdamW',
                    'foreach': 'true', 'krea_adamw_fused': 'true'}
            self.assertTrue(any('foreach' in error and 'fused' in error for error in validate_krea2_config(form)))
