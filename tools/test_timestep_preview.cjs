// Run with: node --test tools/test_timestep_preview.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/js/training-core.js'), 'utf8'), context);
function preview(config, overrides = {}, scope) {
  const ui = Object.assign({}, context.window.trainingCoreMixin, {
    t: (key, fallback) => fallback || key,
    _fieldOptionLabel: (key, value) => value,
    timestepOffsetSubsets: () => [],
  }, overrides);
  const data = ui._buildTimestepPreview({ model_train_type: 'anima-lora', resolution: 1024, ...config }, scope);
  return { ui, data };
}

test('mode density is normalized and matches the trainer transform across shifts', () => {
  for (const scale of [0, 1, 1.29, 1.75]) {
    for (const shift of [0.5, 1, 3]) {
      const { data } = preview({ timestep_sampling: 'sigma', weighting_scheme: 'mode', mode_scale: scale, discrete_flow_shift: shift });
      assert.ok(Math.abs(data.densities.reduce((a, b) => a + b, 0) * 1000 / 120 - 1) < 1e-10);
      const counts = [0, 0, 0];
      const samples = 200000;
      for (let i = 0; i < samples; i++) {
        const r = (i + 0.5) / samples;
        const u = 1 - r - scale * (Math.cos(Math.PI * r / 2) ** 2 - 1 + r);
        const sigma = 1 - Math.floor(u * 1000) / 1000;
        const shifted = sigma * shift / (1 + (shift - 1) * sigma);
        counts[Math.min(2, Math.floor(shifted * 3))]++;
      }
      [data.lowPercent, data.midPercent, data.highPercent].forEach((pct, i) => {
        assert.ok(Math.abs(pct - counts[i] * 100 / samples) < 0.03, `scale=${scale}, shift=${shift}, zone=${i}: ${pct} vs ${counts[i] * 100 / samples}`);
      });
      assert.ok(!/NaN|Infinity/.test(data.currentLinePath));
    }
  }
});

test('mode curve has no scheduler binning teeth at scale zero or around its central peak', () => {
  const { data: uniform } = preview({ timestep_sampling: 'sigma', weighting_scheme: 'mode', mode_scale: 0 });
  for (const density of uniform.densities) {
    assert.ok(Math.abs(density - 0.001) < 0.000001, `uniform density: ${density}`);
  }
  for (const scale of [1, 1.29]) {
    const { data } = preview({ timestep_sampling: 'sigma', weighting_scheme: 'mode', mode_scale: scale });
    const densities = data.densities;
    for (let i = 0; i < densities.length / 2; i++) {
      assert.ok(Math.abs(densities[i] - densities[densities.length - 1 - i]) < 1e-10);
      if (i > 0) assert.ok(densities[i] >= densities[i - 1], `scale=${scale}, unexpected tooth at bin ${i}`);
    }
    // Statistics still use the trainer's discrete scheduler, including its rounding.
    assert.equal(data.median, 500);
  }
});

test('zero-scale distributions show a fixed timestep and exact zone probabilities', () => {
  const cases = [
    [{ timestep_sampling: 'sigmoid', sigmoid_scale: 0 }, 500, 'midPercent'],
    [{ timestep_sampling: 'shift', sigmoid_scale: 0, discrete_flow_shift: 3 }, 750, 'highPercent'],
    [{ timestep_sampling: 'flux_shift', sigmoid_scale: 0 }, 760, 'highPercent'],
    [{ model_train_type: 'krea2-lora', timestep_sampling: 'krea2_shift', sigmoid_scale: 0 }, 712, 'highPercent'],
    [{ timestep_sampling: 'sigma', weighting_scheme: 'logit_normal', logit_std: 0 }, 500, 'midPercent'],
    [{ timestep_sampling: 'sigma', weighting_scheme: 'logit_normal', logit_std: 0, logit_mean: 2 }, 120, 'lowPercent'],
    [{ model_train_type: 'krea2-lora', timestep_sampling: 'logsnr', logit_std: 0, logit_mean: 2 }, 269, 'lowPercent'],
  ];
  for (const [config, timestep, zone] of cases) {
    const { ui, data } = preview(config);
    assert.equal(data.fixedTimestep, timestep);
    assert.equal(data.median, timestep);
    assert.equal(data[zone], 100);
    assert.equal(data.lowPercent + data.midPercent + data.highPercent, 100);
    assert.equal(data.currentLinePath, '');
    assert.equal(data.yTicks.length, 0);
    const html = ui._buildTimestepChartHtml(data);
    assert.ok(!/NaN|Infinity/.test(html));
    assert.ok(html.includes('fixedDistribution'));
  }
});

test('narrow continuous distributions retain their probability mass and correct median', () => {
  for (const scale of [0.001, 0.01, 1]) {
    for (const [config, median] of [
      [{ timestep_sampling: 'sigmoid', sigmoid_scale: scale }, 500],
      [{ timestep_sampling: 'shift', sigmoid_scale: scale, discrete_flow_shift: 3 }, 750],
      [{ timestep_sampling: 'logsnr', logit_std: scale, logit_mean: 2 }, 269],
      [{ timestep_sampling: 'sigma', weighting_scheme: 'logit_normal', logit_std: scale, logit_mean: 2 }, 120],
    ]) {
      const { data } = preview(config);
      const mass = data.densities.reduce((a, b) => a + b, 0) * 1000 / data.densities.length;
      assert.ok(Math.abs(mass - 1) < 1e-10, JSON.stringify(config));
      assert.ok(data.densities.every(value => Number.isFinite(value) && value >= 0));
      assert.equal(data.median, median, JSON.stringify(config));
      assert.ok(Math.abs(data.lowPercent + data.midPercent + data.highPercent - 100) < 1e-10);
    }
  }
});

test('mode curve matches continuous sampling even when the transform folds', () => {
  for (const scale of [1, 1.75]) {
    const { data } = preview({ timestep_sampling: 'sigma', weighting_scheme: 'mode', mode_scale: scale, discrete_flow_shift: 3 });
    const bins = Array(120).fill(0);
    const count = 200000;
    for (let i = 0; i < count; i++) {
      const r = (i + 0.5) / count;
      const u = 1 - r - scale * (Math.cos(Math.PI * r / 2) ** 2 - 1 + r);
      const s = 1 - u;
      const shifted = 3 * s / (1 + 2 * s);
      bins[119 - Math.min(119, Math.floor(shifted * 120))]++;
    }
    data.densities.forEach((density, i) => {
      assert.ok(Math.abs(density - bins[i] / count * 120 / 1000) < 0.000002, `scale=${scale}, bin=${i}`);
    });
    assert.equal(data.median, 750);
  }
});

test('sigma statistics use scheduler steps rather than plotting bins', () => {
  const { data } = preview({ timestep_sampling: 'sigma', weighting_scheme: 'mode', mode_scale: 0, discrete_flow_shift: 3 });
  // Uniform scheduler indices: 142 entries below 1/3 and 601 at or above 2/3.
  assert.ok(Math.abs(data.lowPercent - 14.2) < 1e-9);
  assert.ok(Math.abs(data.highPercent - 60.1) < 1e-9);
  assert.equal(data.median, 750);
});

test('overall CDF respects subset sample weights and offsets', () => {
  const overrides = {
    timestepOffsetSubsets: () => [{ name: 'a', sample_count: 2 }, { name: 'b', sample_count: 0 }],
    subsetTimestepOffsetValue: name => name === 'a' ? 2 : -2,
  };
  const config = { timestep_sampling: 'sigmoid', sigmoid_scale: 1 };
  const { data: overall } = preview(config, overrides, 'overall');
  const { data: selected } = preview(config, overrides, 'a');
  assert.deepEqual(overall.densities, selected.densities);
  assert.equal(overall.median, 881);
  assert.equal(overall.median, selected.median);
  assert.equal(overall.lowPercent, selected.lowPercent);
});
