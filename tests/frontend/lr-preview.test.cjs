// Run from the repository root: node --test tests/frontend/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/training-lr-preview.js'), 'utf8'), context);
function preview(overrides = {}, steps = 10000) {
  const ui = Object.assign({}, context.window.trainingLrPreviewMixin, {
    stepEstimate: { total_steps: steps },
    t: (key, fallback) => fallback || key,
    _fieldOptionLabel: (key, value) => value,
  });
  const data = ui._buildLrPreview({ learning_rate: 1e-4, optimizer_type: 'AdamW',
    lr_scheduler: 'linear', ...overrides });
  return { ui, data, rate: p => ui._lrPreviewMultiplier(p, data.params) * data.chartRate };
}
test('polynomial keeps the Transformers end rate and component scaling', () => {
  const { rate } = preview({ lr_scheduler: 'polynomial', unet_lr: 2e-4 });
  assert.ok(Math.abs(rate(1) - 2e-7) < 1e-15);
  assert.ok(Math.abs(rate(0.5) - 0.0001001) < 1e-15);
});
test('fractional warmup truncates to complete steps and long warmup stays a ramp', () => {
  assert.equal(preview({ lr_warmup_steps: 0.15 }, 11).data.params.warmupFraction, 1 / 11);
  assert.equal(preview({ lr_warmup_steps: 20000 }).rate(1), 5e-5);
});
test('restart boundaries reset immediately and are sampled on both sides', () => {
  const { data, rate } = preview({ lr_scheduler: 'cosine_with_restarts', lr_scheduler_num_cycles: 2 });
  assert.ok(rate(0.5 - 1e-8) < 1e-12);
  assert.equal(rate(0.5), 1e-4);
  assert.equal(rate(1), 0);
  assert.ok(data.currentLinePath.includes('50.00000,100.00000 L 50.00000,7.40741'));
});

test('cosine minimum scales each component and preserves zero-based warmup', () => {
  const { data, rate } = preview({ lr_scheduler: 'cosine_with_min_lr', lr_scheduler_min_lr_ratio: 0.1,
    lr_warmup_steps: 100, unet_lr: 2e-4 }, 1000);
  assert.equal(data.unavailable, '');
  assert.equal(rate(0), 0);
  assert.ok(Math.abs(rate(0.55) - 1.1e-4) < 1e-15);
  assert.ok(Math.abs(rate(1) - 2e-5) < 1e-15);
});

test('inverse sqrt uses the actual step horizon, warmup and default timescale', () => {
  const { rate } = preview({ lr_scheduler: 'inverse_sqrt', lr_warmup_steps: 100 }, 1000);
  assert.equal(rate(0.1), 1e-4);
  assert.ok(Math.abs(rate(0.4) - 5e-5) < 1e-15);
  assert.equal(preview({ lr_scheduler: 'inverse_sqrt' }, 1000).data.params.timescale, 10000);
  assert.ok(preview({ lr_scheduler: 'inverse_sqrt' }, 0).data.unavailable);
});

test('WSD warms up from its minimum, holds steady and decays over the final interval', () => {
  const { data, rate } = preview({ lr_scheduler: 'warmup_stable_decay', lr_warmup_steps: 100,
    lr_decay_steps: 400, lr_scheduler_min_lr_ratio: 0.1 }, 2000);
  assert.equal(data.unavailable, '');
  for (const [p, expected] of [[0, 1e-5], [0.025, 5.5e-5], [0.05, 1e-4],
    [0.8, 1e-4], [0.9, 5.5e-5], [1, 1e-5]]) {
    assert.ok(Math.abs(rate(p) - expected) < 1e-15, `${p}: ${rate(p)}`);
  }
  assert.equal(preview({ lr_scheduler: 'warmup_stable_decay', lr_decay_steps: 0 }).rate(0.99), 1e-4);
  assert.equal(preview({ lr_scheduler: 'warmup_stable_decay', lr_decay_steps: 0 }).rate(1), 0);
  assert.equal(preview({ lr_scheduler: 'warmup_stable_decay', lr_decay_steps: 0.2 }, 11).data.params.decayFraction, 2 / 11);
});

test('new scheduler previews reject invalid settings and use sd-scripts process scaling', () => {
  for (const overrides of [
    { lr_scheduler: 'inverse_sqrt', lr_scheduler_timescale: 0 },
    { lr_scheduler: 'cosine_with_min_lr', lr_scheduler_min_lr_ratio: 1.1 },
    { lr_scheduler: 'warmup_stable_decay', lr_decay_steps: 1.5 },
    { lr_scheduler: 'warmup_stable_decay', lr_warmup_steps: 600, lr_decay_steps: 500 },
  ]) assert.ok(preview(overrides, 1000).data.unavailable, JSON.stringify(overrides));
  const { ui } = preview();
  ui.stepEstimate = { total_steps: 1000, gpu_processes: 2 };
  const data = ui._buildLrPreview({ learning_rate: 1e-4, optimizer_type: 'AdamW',
    lr_scheduler: 'inverse_sqrt', lr_warmup_steps: 100, lr_scheduler_timescale: 100 });
  assert.equal(data.params.totalSteps, 2000);
  assert.equal(data.params.warmupFraction, 0.05);
  assert.ok(Math.abs(ui._lrPreviewMultiplier(0.2, data.params) - 0.5) < 1e-15);
});
