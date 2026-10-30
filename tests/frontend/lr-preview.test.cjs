const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins } = require('./helpers.cjs');

function createApp() {
  const { window } = loadFrontend(['training/lr-preview']);
  return composeMixins(window.trainingLrPreviewMixin, {
    t: (key, fallback) => fallback || key,
    _fieldOptionLabel: (field, value) => value,
    stepEstimate: { total_steps: 10000, gpu_processes: 1 },
  });
}

test('milestones reflect the selected learning-rate curve, including warmup', () => {
  const app = createApp();
  const values = { learning_rate: '2e-5', unet_lr: '4e-5', text_encoder_lr: '1e-5',
    optimizer_type: 'AdamW8bit', lr_scheduler: 'cosine', lr_warmup_steps: 1000 };
  let result = app._buildLrPreview(values);
  assert.deepEqual(Array.from(result.milestoneRates), ['0', '2.347e-5', '0']);
  assert.equal(result.components.length, 2);
  app.lrPreviewComponent = 'text';
  result = app._buildLrPreview(values);
  assert.deepEqual(Array.from(result.milestoneRates), ['0', '5.868e-6', '0']);
  assert.equal(result.component, 'text');
});

test('zero warmup is visible and unavailable curves have no milestone values', () => {
  const app = createApp();
  const values = { learning_rate: '2e-5', network_train_unet_only: true,
    optimizer_type: 'AdamW8bit', lr_scheduler: 'cosine', lr_warmup_steps: 0 };
  const result = app._buildLrPreview(values);
  assert.equal(result.components.length, 1);
  assert.equal(result.warmupVisible, true);
  assert.equal(result.warmupLabel, '0 steps');
  assert.deepEqual(Array.from(result.milestoneRates), ['2e-5', '1e-5', '0']);
  const unavailable = app._buildLrPreview({ ...values, optimizer_type: 'AdamWScheduleFree' });
  assert.ok(unavailable.unavailable);
  assert.deepEqual(Array.from(unavailable.milestoneRates), []);
});

test('Krea 2 LoRA+ milestones use the selected parameter group', () => {
  const app = createApp();
  const values = { model_train_type: 'krea2-lora', network_module: 'networks.lora_krea2',
    enable_loraplus: true, loraplus_lr_ratio: 4, learning_rate: '2e-5',
    optimizer_type: 'AdamW8bit', lr_scheduler: 'cosine', lr_warmup_steps: 0 };
  assert.equal(app._buildLrPreview(values).components.length, 2);
  app.lrPreviewComponent = 'unet_plus';
  const result = app._buildLrPreview(values);
  assert.equal(result.effectiveRateText, '8e-5');
  assert.deepEqual(Array.from(result.milestoneRates), ['8e-5', '4e-5', '0']);
});

test('halfway milestone agrees with hover at the nearest step across process counts', () => {
  for (const processes of [1, 2]) {
    const app = createApp();
    app.stepEstimate = { total_steps: 9, gpu_processes: processes };
    app._parseStepRules = () => ({ boundaries: [{ endStep: 5 * processes, multiplier: 1 }], finalMultiplier: 0.1 });
    const result = app._buildLrPreview({ learning_rate: '2e-5', optimizer_type: 'AdamW8bit',
      lr_scheduler: 'piecewise_constant', step_rules: `1:${5 * processes},0.1` });
    assert.equal(result.milestoneRates[1], '2e-6');
  }
});
