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
  assert.doesNotMatch(base, /timestep-zones-help/);
  assert.match(base, /aria-describedby="timestep-density-help"/);
  assert.match(base, /High noise<\/span><b>20\.0%/);
  assert.doesNotMatch(base, /timestep-preview-summary/);
  const comparison = app._buildTimestepChartHtml({ ...data, compare: true });
  assert.match(comparison, /24\.4% → 20\.0%/);
  assert.match(comparison, /51\.2% → 50\.0%/);
  assert.match(comparison, /24\.4% → 30\.0%/);
});

test('preview notes keep configuration warnings without repeating the uniform weighting label', () => {
  const { window } = loadFrontend(['training/timestep-model', 'training/timestep-preview']);
  const app = composeMixins(window.trainingTimestepPreview, {
    form: {}, t: key => key, _fieldOptionLabel: (field, value) => value,
  });
  const preview = source => app._buildTimestepPreview(source, 'base');
  const uniform = preview({});
  assert.equal(uniform.weightingLabel, 'timestepPreview.uniformWeighting');
  assert.deepEqual(Array.from(uniform.notes), []);
  for (const timestep_sampling of ['flux_shift', 'krea2_shift']) {
    assert.deepEqual(Array.from(preview({ timestep_sampling }).notes), ['timestepPreview.resolutionShiftNote']);
  }
  const warned = preview({ model_train_type: 'krea2-lora', timestep_sampling: 'uniform', weighting_scheme: 'mode',
    discrete_flow_shift: 1.3, min_timestep: 100, max_timestep: 900 });
  assert.deepEqual(Array.from(warned.notes), [
    'timestepPreview.kreaRangeNote', 'timestepPreview.shiftIgnored', 'timestepPreview.densityIgnored',
  ]);
  assert.equal(warned.warning, true);
});

test('sampling range follows the descending axis and collapses at fixed timesteps', () => {
  const { window } = loadFrontend(['training/timestep-model', 'training/timestep-preview']);
  const app = composeMixins(window.trainingTimestepPreview, { t: () => '' });
  const uniform = window.TrainingTimestepPreview.build({ timestep_sampling: 'uniform' });
  const range = app._buildTimestepChartHtml({ ...uniform, percentile10: 218, percentile90: 858 });
  assert.match(range, /class="timestep-range-guide" x1="14\.2" y1="0" x2="14\.2" y2="100"/);
  assert.match(range, /class="timestep-range-guide" x1="78\.2" y1="0" x2="78\.2" y2="100"/);
  assert.match(range, /class="timestep-range-dim" style="left:0;width:14\.2%"/);
  assert.match(range, /class="timestep-range-dim" style="left:78\.2%;right:0"/);
  assert.match(range, /class="timestep-range-values" style="left:14\.2%;width:64%"/);
  assert.match(range, /left:0%;transform:translateX\(-50%\)">858/);
  assert.match(range, /left:100%;transform:translateX\(-50%\)">218/);
  assert.doesNotMatch(range, /timestep-range-highlight|timestep-range-bracket|timestep-range-rail|timestep-range-band|legend-range/);
  const comparison = app._buildTimestepChartHtml({ ...uniform, compare: true });
  assert.match(comparison, /class="timestep-range-dim" style="left:0;width:10%"/);
  assert.match(comparison, /class="timestep-range-dim" style="left:90%;right:0"/);
  for (const [value, position] of [[0, 100], [500, 50], [1000, 0]]) {
    const fixed = app._buildTimestepChartHtml({ ...uniform, fixedTimestep: value, percentile10: value, percentile90: value });
    assert.ok(fixed.includes(`class="timestep-range-dim" style="left:0;width:${position}%"`));
    assert.ok(fixed.includes(`class="timestep-range-dim" style="left:${position}%;right:0"`));
    assert.equal((fixed.match(/class="timestep-range-guide"/g) || []).length, 1);
    assert.doesNotMatch(fixed, /timestep-density-help/);
    assert.doesNotMatch(fixed, /NaN|Infinity/);
  }
  const narrow = app._buildTimestepChartHtml({ ...uniform, percentile10: 499, percentile90: 501 });
  assert.match(narrow, /left:50%;transform:translateX\(-50%\)">499–501/);
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
