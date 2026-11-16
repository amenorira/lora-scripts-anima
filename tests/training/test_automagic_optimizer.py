"""Fused optimizer conflicts must be rejected before a training update."""
import unittest

from backend.training.config.adapter import adapt_config
from backend.training.config.optimizer_contracts import (
    AUTOMAGIC_OPTIMIZER_TYPE, AUTOMAGIC4_OPTIMIZER_TYPE, parse_optimizer_args,
)
from backend.training.config.validation import validate_training_config
from tests.helpers import valid_training_config


OPTIMIZERS = (AUTOMAGIC_OPTIMIZER_TYPE, AUTOMAGIC4_OPTIMIZER_TYPE)


class AutomagicConfigTests(unittest.TestCase):
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
