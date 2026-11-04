"""AdamW fused controls survive native export/import without changing Auto defaults."""
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


class AdamWFusedTests(unittest.TestCase):
    def test_choices_round_trip_across_trainers(self):
        with tempfile.TemporaryDirectory() as directory:
            krea = krea2_config(Path(directory))
            for profile in ('anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora'):
                key = 'krea_adamw_fused' if profile == 'krea2-lora' else 'adamw_fused'
                for choice, expected in (('auto', None), ('true', True), ('false', False)):
                    with self.subTest(profile=profile, choice=choice):
                        if profile == 'krea2-lora':
                            form = {**krea, 'optimizer_type': 'AdamW', key: choice}
                            self.assertEqual(validate_krea2_config(form), [])
                            native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
                        else:
                            form = valid_training_config(profile, optimizer_type='AdamW', **{key: choice})
                            if profile == 'moss-image-lora':
                                form.update(network_module='networks.lora_generic', text_encoder='models/text.safetensors')
                            self.assertEqual(validate_training_config(form), [])
                            native, _ = adapt_config(form)
                        args, errors = parse_optimizer_args(native)
                        self.assertEqual(errors, [])
                        if choice == 'auto':
                            self.assertNotIn('fused', args)
                        else:
                            self.assertIs(args['fused'], expected)
                        self.assertNotIn(key, native)
                        restored = import_native_training_form(native, profile_id=profile)
                        self.assertEqual(restored.get(key, 'auto'), choice)

    def test_custom_precedence_and_unsupported_optimizer(self):
        for choice, expected in (('auto', True), ('true', True), ('false', False)):
            form = valid_training_config(optimizer_type='AdamW', adamw_fused=choice,
                                         optimizer_args_custom='fused=True')
            native, _ = adapt_config(form)
            self.assertIs(parse_optimizer_args(native)[0]['fused'], expected)
        form = valid_training_config(optimizer_type='AdamW8bit', adamw_fused='true')
        native, _ = adapt_config(form)
        self.assertNotIn('fused', parse_optimizer_args(native)[0])

    def test_invalid_choice_and_foreach_conflict(self):
        for changes in ({'adamw_fused': 'yes'}, {'adamw_fused': 'true', 'foreach': 'true'},
                        {'adamw_fused': 'true', 'optimizer_args_custom': 'differentiable=True'}):
            form = valid_training_config(optimizer_type='AdamW', **changes)
            self.assertTrue(any('fused' in error for error in validate_training_config(form)))
        with tempfile.TemporaryDirectory() as directory:
            form = {**krea2_config(Path(directory)), 'optimizer_type': 'AdamW',
                    'krea_adamw_fused': 'true', 'optimizer_args_custom': 'differentiable=True'}
            self.assertTrue(any('differentiable' in error and 'fused' in error
                                for error in validate_krea2_config(form)))

    def test_native_args_populate_the_control(self):
        for value, choice in (('True', 'true'), ('False', 'false'), ('None', 'auto')):
            restored = import_native_training_form(
                {'optimizer_type': 'AdamW', 'optimizer_args': [f'fused={value}']},
                profile_id='anima-lora',
            )
            self.assertEqual(restored['adamw_fused'], choice)
            self.assertNotIn('fused=', restored.get('optimizer_args_custom', ''))
