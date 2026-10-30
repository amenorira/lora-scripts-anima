const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins } = require('./helpers.cjs');

test('sampling shares remain readable in the chart for base and comparison distributions', () => {
  const { window } = loadFrontend(['training/timestep-preview']);
  const app = composeMixins(window.trainingTimestepPreview, { t: () => '' });
  const data = {
    yTicks: [], weighting: 'uniform', median: 500, medianPercent: 50,
    currentLinePath: '', currentAreaPath: '',
    highPercent: 20, midPercent: 50, lowPercent: 30,
    baselineHighPercent: 24.4, baselineMidPercent: 51.2, baselineLowPercent: 24.4,
  };
  const base = app._buildTimestepChartHtml({ ...data, compare: false });
  assert.match(base, /aria-label="Sampling share"/);
  assert.match(base, /aria-describedby="timestep-zones-help"/);
  assert.match(base, /aria-describedby="timestep-density-help"/);
  assert.match(base, /High noise<\/span><b>20\.0%/);
  assert.doesNotMatch(base, /timestep-preview-summary/);
  const comparison = app._buildTimestepChartHtml({ ...data, compare: true });
  assert.match(comparison, /24\.4% → 20\.0%/);
  assert.match(comparison, /51\.2% → 50\.0%/);
  assert.match(comparison, /24\.4% → 30\.0%/);
});

test('uniform weighting moves to help while configuration warnings stay visible', () => {
  const { window } = loadFrontend(['training/timestep-preview']);
  window.TrainingTimestepPreview = { build: () => ({
    sampling: 'sigmoid', weighting: 'uniform', warning: true,
    noteKeys: ['timestepPreview.shiftIgnored', 'timestepPreview.uniformWeightNote'],
  }) };
  const app = composeMixins(window.trainingTimestepPreview, {
    form: {}, t: key => key, _fieldOptionLabel: (field, value) => value,
  });
  const result = app._buildTimestepPreview({}, 'base');
  assert.equal(result.uniformWeightHelp, true);
  assert.deepEqual(Array.from(result.notes), ['timestepPreview.shiftIgnored']);
  assert.equal(result.warning, true);
});

test('sampling percentiles follow continuous, discrete and fixed distributions', () => {
  const { window } = loadFrontend(['training/timestep-model']);
  const build = window.TrainingTimestepPreview.build;
  const check = (source, expected) => {
    const { percentile10, median, percentile90 } = build(source);
    assert.deepEqual([percentile10, median, percentile90], expected);
  };
  check({ timestep_sampling: 'uniform' }, [100, 500, 900]);
  check({ timestep_sampling: 'sigma', weighting_scheme: 'uniform' }, [100, 500, 900]);
  check({ timestep_sampling: 'truncated_logit_normal', timestep_cutoff: 1, timestep_uniform_ratio: 1 }, [100, 500, 900]);
  check({ timestep_sampling: 'sigmoid', sigmoid_scale: 0 }, [500, 500, 500]);
  check({ model_train_type: 'krea2-lora', timestep_sampling: 'uniform', min_timestep: 100, max_timestep: 900 }, [180, 500, 820]);
  const source = { model_train_type: 'anima-lora', timestep_sampling: 'sigmoid' };
  const options = { scope: 'overall', subsets: [{ name: 'test', sample_count: 1 }], subsetOffsets: { test: 0.5 } };
  const base = build(source);
  const shifted = build(source, options);
  assert.ok(shifted.percentile10 > base.percentile10 && shifted.percentile90 > base.percentile90);
});
