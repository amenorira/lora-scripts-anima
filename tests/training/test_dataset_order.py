"""Regularization discovery and real sd-scripts batches must agree across launch paths."""
from dataclasses import asdict
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.training.datasets.sd_dataset_config import build_sd_scripts_dataset_config
from backend.training.datasets import step_estimator


class DreamBoothOrderTests(unittest.TestCase):
    def test_native_and_offset_launches_match_estimator_for_order_sensitive_regularization(self):
        step_estimator._sd_dataset_helpers()
        from PIL import Image
        from library.config_util import (
            DreamBoothDatasetParams, DreamBoothSubsetParams,
            generate_dreambooth_subsets_config_by_subdirs,
        )
        from library.dreambooth_dataset import DreamBoothDataset
        from library.subset import DreamBoothSubset

        for bucketed, wide_repeats in ((True, 1), (False, 3)):
            with self.subTest(bucketed=bucketed), tempfile.TemporaryDirectory() as directory:
                train, reg = Path(directory) / 'train', Path(directory) / 'reg'
                wide_name = f'{wide_repeats}_a'
                for parent, name, size in ((train, '1_train', (128, 128)),
                                           (reg, '1_Z', (128, 128)),
                                           (reg, wide_name, (256, 64))):
                    subset = parent / name
                    subset.mkdir(parents=True)
                    Image.new('RGB', size).save(subset / 'image.png')
                    (subset / 'image.caption').write_text('test image')

                real_iterdir = Path.iterdir

                def raw_order(path):
                    return iter([reg / wide_name, reg / '1_Z']) if path == reg else real_iterdir(path)

                config = dict(model_train_type='anima-lora', train_data_dir=str(train),
                              enable_reg_data=True, reg_data_dir=str(reg), resolution='128,128',
                              enable_bucket=bucketed, bucket_reso_steps=64, min_bucket_reso=64,
                              max_bucket_reso=256, train_batch_size=2, max_train_epochs=1)
                params = asdict(DreamBoothDatasetParams(resolution=(128, 128), batch_size=2,
                                enable_bucket=bucketed, min_bucket_reso=64, max_bucket_reso=256,
                                bucket_reso_steps=64))

                def make_dataset(subset_configs):
                    subsets = [DreamBoothSubset(**asdict(DreamBoothSubsetParams(**value)))
                               for value in subset_configs]
                    dataset = DreamBoothDataset(subsets=subsets, is_training_dataset=True, **params)
                    dataset.make_buckets()
                    return dataset

                with patch.object(Path, 'iterdir', raw_order):
                    estimate = step_estimator.estimate_training_steps(config)
                    native_config = generate_dreambooth_subsets_config_by_subdirs(str(train), str(reg))
                    offset_config = build_sd_scripts_dataset_config(config, {'1_train': 0.1})
                    self.assertEqual([s['image_dir'] for s in offset_config['datasets'][0]['subsets']],
                                     [s['image_dir'] for s in native_config])
                    native = make_dataset(native_config)
                    with_offsets = make_dataset(offset_config['datasets'][0]['subsets'])

                self.assertEqual(estimate['batches_per_epoch'], 2)
                self.assertEqual(estimate['batches_per_epoch'], len(native))
                self.assertEqual(len(with_offsets), len(native))
                self.assertEqual([s['name'] for s in estimate['subsets'] if s['is_reg'] and s['image_count']],
                                 [wide_name])
                self.assertEqual(estimate['repeated_samples'], 1 + wide_repeats)
