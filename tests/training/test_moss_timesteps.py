"""Compare the browser's distribution with the real, weight-free MOSS sampler."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch


@unittest.skipUnless(shutil.which("node"), "Node is needed to compare the browser preview")
class MossTimestepPreviewTests(unittest.TestCase):
    def test_preview_matches_native_sampling_and_subset_offsets(self):
        from backend.training.step_estimator import _sd_dataset_helpers
        _sd_dataset_helpers()
        import torch
        from library import flux_train_utils, flux2_vae
        from moss_image_train_network import MossImageNetworkTrainer, setup_parser

        cases = []
        for sampling in ("sigma", "uniform", "sigmoid", "shift", "flux_shift"):
            for weighting in ("uniform", "sigma_sqrt", "logit_normal", "mode", "cosmap"):
                cases.append(dict(timestep_sampling=sampling, weighting_scheme=weighting))
        for sampling in ("sigma", "uniform", "sigmoid", "shift", "flux_shift"):
            for offset in (-0.5, 0.5):
                cases.append(dict(timestep_sampling=sampling, offset=offset, discrete_flow_shift=3,
                                  sigmoid_scale=1.5))
        for resolution in ("512,512", "1536,768"):
            cases.append(dict(timestep_sampling="flux_shift", resolution=resolution))
        cases.append(dict(timestep_sampling="sigma", logit_mean=0.7, logit_std=0.4))
        defaults = dict(model_train_type="moss-image-lora", timestep_sampling="sigma",
                        weighting_scheme="logit_normal", logit_mean=-1.09, logit_std=0.95,
                        mode_scale=1.29, sigmoid_scale=1, discrete_flow_shift=1, resolution="1024,1024")
        cases = [dict(defaults, **case) for case in cases]
        script = r"""
const fs = require('node:fs');
const {loadFrontend} = require('./tests/frontend/helpers.cjs');
const {window} = loadFrontend(['constants', 'utils', 'config', 'training-core'], {window: {}});
const app = Object.assign({}, window.utilsMixin, window.trainingCoreMixin, {t: key => key});
const results = JSON.parse(fs.readFileSync(0, 'utf8')).map(config => {
  app.form = config;
  app.timestepOffsetSubsets = () => [{name: 'subset', sample_count: 1}];
  app.subsetTimestepOffsetValue = () => config.offset || 0;
  const p = app._buildTimestepPreview(config, config.offset ? 'subset' : 'base');
  return {median: p.median, low: p.lowPercent, high: p.highPercent};
});
process.stdout.write(JSON.stringify(results));
"""
        result = subprocess.run([shutil.which("node"), "-e", script], input=json.dumps(cases),
                                text=True, capture_output=True, check=True, timeout=30,
                                cwd=Path(__file__).resolve().parents[2])
        previews = json.loads(result.stdout)
        count = 2048
        # Evenly spaced quantiles remove random test variance without replacing
        # any of the upstream sampling, scheduler or latent packing calculations.
        uniform = (torch.arange(count, dtype=torch.float32) + 0.5) / count
        normal = torch.distributions.Normal(0, 1).icdf(uniform)
        old_threads = torch.get_num_threads()
        torch.set_num_threads(1)
        try:
            for config, preview in zip(cases, previews):
                with self.subTest(config=config):
                    args = setup_parser().parse_args([])
                    vars(args).update(config)
                    width, height = map(int, config["resolution"].split(","))
                    # Only spatial shape affects sampling; one raw channel is sufficient.
                    raw = torch.zeros(1, 1, height // 8, width // 8)
                    packed = flux2_vae.patchify_latents(raw)
                    latents = packed[:, :1].expand(count, -1, -1, -1)
                    scheduler = MossImageNetworkTrainer().get_noise_scheduler(args, "cpu")
                    offset = torch.full((count,), config.get("offset", 0.0))
                    with patch.object(torch, "rand", return_value=uniform), \
                         patch.object(torch, "randn", return_value=normal), \
                         patch.object(torch, "normal", return_value=normal * args.logit_std + args.logit_mean):
                        _, timesteps, _ = flux_train_utils.get_noisy_model_input_and_timesteps(
                            args, scheduler, latents, latents, "cpu", torch.float32,
                            timestep_sampling_offset=offset)
                    self.assertAlmostEqual(preview["median"], timesteps.median().item(), delta=2)
                    self.assertAlmostEqual(preview["low"], (timesteps < 1000 / 3).float().mean().item() * 100, delta=0.15)
                    self.assertAlmostEqual(preview["high"], (timesteps >= 2000 / 3).float().mean().item() * 100, delta=0.15)
        finally:
            torch.set_num_threads(old_threads)
