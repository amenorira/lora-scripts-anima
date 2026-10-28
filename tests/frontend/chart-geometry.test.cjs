const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(profile = 'anima-lora', values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-timestep-model', 'training-field-relations', 'training-core', 'training-lr-preview', 'monitor-render'], {
    window: {}, document: { getElementById: () => null },
  });
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingLrPreviewMixin, w.monitorRenderMixin, {
    t: (key, fallback) => fallback || key,
    stepEstimate: { total_steps: 1000, gpu_processes: 1, subsets: [] },
    monitorLossSeries: [],
  });
  app.form = { ...app._buildFormDefaults(profile), model_train_type: profile,
    optimizer_type: 'AdamW', learning_rate: 0.001, ...values };
  return app;
}

const pathPoints = path => path.replace(/^M\s*/, '').split(/\s+L\s*/).map(point => point.split(',').map(Number));
function assertPoints(points, { clipped = false } = {}) {
  assert.ok(points.length >= 2);
  points.forEach(([x, y], index) => {
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
    assert.ok(x >= 0 && x <= 100);
    if (!clipped) assert.ok(y >= 0 && y <= 100);
    if (index) assert.ok(x >= points[index - 1][0]);
  });
  assert.equal(points[0][0], 0);
  assert.equal(points.at(-1)[0], 100);
}

test('timestep curves reach both bounds and preserve finite, normalized bin densities', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'krea2-lora']) {
    const samplers = profile === 'krea2-lora'
      ? ['uniform', 'sigmoid', 'shift', 'krea2_shift', 'logsnr', 'sigma']
      : ['uniform', 'sigmoid', 'shift', 'flux_shift', 'sigma', 'truncated_logit_normal'];
    for (const timestep_sampling of samplers) {
      for (const weighting_scheme of ['uniform', 'logit_normal', 'mode', 'cosmap', 'sigma_sqrt']) {
        const app = application(profile, { timestep_sampling, weighting_scheme, logit_mean: 0, logit_std: 1 });
        const data = app._buildTimestepPreview(null, 'base');
        assertPoints(pathPoints(data.currentLinePath));
        assertPoints(pathPoints(data.baselineLinePath));
        assert.ok(data.densities.every(value => Number.isFinite(value) && value >= -1e-12));
        assert.ok(Math.abs(data.densities.reduce((a, b) => a + b, 0) * 1000 / data.densities.length - 1) < 1e-9);
        assert.ok(Math.abs(data.lowPercent + data.midPercent + data.highPercent - 100) < 1e-9);
        assert.ok(data.median >= 0 && data.median <= 1000);
        assertPoints(data.weightPoints.split(' ').map(point => point.split(',').map(Number)), { clipped: true });
      }
    }
  }
});

test('truncated distribution has no artificial flat edge and retains the verified statistics', () => {
  const app = application('anima-lora', { timestep_sampling: 'truncated_logit_normal',
    logit_mean: 0, logit_std: 1, timestep_cutoff: 0.95, timestep_uniform_ratio: 0.1 });
  const data = app._buildTimestepPreview(null, 'base');
  const [a, b, c] = pathPoints(data.currentLinePath);
  assert.notEqual(a[1], b[1]);
  assert.ok(Math.abs((b[1] - a[1]) / (b[0] - a[0]) - (c[1] - b[1]) / (c[0] - b[0])) < 0.06);
  assert.equal(data.median, 525);
  assert.equal(data.highPercent.toFixed(1), '29.6');
  assert.equal(data.midPercent.toFixed(1), '47.2');
  assert.equal(data.lowPercent.toFixed(1), '23.2');
  app.form.timestep_sampling = 'uniform';
  const uniform = pathPoints(app._buildTimestepPreview(null, 'base').currentLinePath);
  assert.ok(uniform.every(point => point[1] === uniform[0][1]));
});

test('loss-weight boundaries follow their formulas and the divergent limit exits the chart', () => {
  const app = application('anima-lora', { timestep_sampling: 'sigmoid', weighting_scheme: 'cosmap' });
  let points = app._buildTimestepPreview(null, 'base').weightPoints.split(' ').map(point => point.split(',').map(Number));
  assert.equal(points[0][1], points.at(-1)[1]);
  assert.ok(points[0][1] > points[1][1]);
  app.form.weighting_scheme = 'sigma_sqrt';
  points = app._buildTimestepPreview(null, 'base').weightPoints.split(' ').map(point => point.split(',').map(Number));
  assert.ok(points.at(-1)[1] < 0);
  assert.ok(points.at(-1)[1] < points.at(-2)[1]);
});

test('learning-rate plots span training and keep step changes vertical', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'krea2-lora']) {
    for (const lr_scheduler of ['constant', 'constant_with_warmup', 'linear', 'cosine',
      'cosine_with_restarts', 'polynomial', 'inverse_sqrt', 'cosine_with_min_lr', 'warmup_stable_decay', 'piecewise_constant',
      ...(profile === 'krea2-lora' ? ['rex'] : [])]) {
      const app = application(profile, { lr_scheduler, lr_warmup_steps: ['constant', 'piecewise_constant'].includes(lr_scheduler) ? 0 : 0.1,
        lr_decay_steps: 0.3, lr_scheduler_num_cycles: 3, lr_scheduler_power: 2,
        lr_scheduler_timescale: 40, step_rules: '1:250,0.5:750,0.1',
        krea_training_duration_mode: 'steps', max_train_steps: 1000 });
      const data = app._buildLrPreview();
      assert.equal(data.unavailable, '', `${profile}: ${lr_scheduler}`);
      const points = pathPoints(data.currentLinePath);
      assertPoints(points);
      if (lr_scheduler === 'piecewise_constant') {
        points.slice(1).forEach((point, index) => {
          if (point[1] !== points[index][1]) assert.equal(point[0], points[index][0]);
        });
      }
    }
  }
});

test('monitor trend plots handle empty, single, constant and cleaned observations', () => {
  const app = application();
  for (const raw of [[], [{ step: 1, value: 0.1 }],
    Array.from({ length: 50 }, (_, step) => ({ step, value: 0.2 })),
    [{ step: 2, value: 0.4 }, { step: 1, value: 0.6 }, { step: 2, value: 0.3 },
      { step: 3, value: NaN }, { step: 4, value: null }, { step: 5, value: 0.1 }]]) {
    const frame = app._rollingSparklineFrame(raw);
    assert.doesNotMatch(frame.path, /NaN|Infinity/);
    assert.ok(frame.coords.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.y >= 0 && point.y <= 34));
    if (frame.coords.length) assert.equal(frame.coords.at(-1).x, 116);
    app.monitorLossSeries = [{ tag: 'loss/current', points: raw }];
    const trend = app._diagnosticLossTrend(2);
    assert.doesNotMatch(trend.path, /NaN|Infinity/);
    if (trend.coords.length) {
      assert.equal(Number(trend.coords[0].x), 4);
      assert.equal(Number(trend.coords.at(-1).x), 116);
    }
  }
});

test('TensorBoard histogram covers both edge bins and keeps zoom domains valid', async () => {
  const { barPath, countScale, zoomDomain } = await import('../../frontend/tensorboard/timesteps.mjs');
  const counts = Array(1000).fill(0);
  counts[0] = 2;
  counts[999] = 4;
  const path = barPath(counts, [0, 1000], countScale(4).maximum);
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.equal((path.match(/Z/g) || []).length, 2);
  assert.match(path, /M62,354/);
  for (const anchor of [0, 500, 1000]) {
    for (const factor of [0.01, 0.8, 1.25, 100]) {
      const [low, high] = zoomDomain([0, 1000], anchor, factor);
      assert.ok(low >= 0 && high <= 1000 && high - low >= 2);
    }
  }
});
