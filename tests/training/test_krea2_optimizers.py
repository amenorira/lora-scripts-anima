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
