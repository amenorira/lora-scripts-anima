// Run with: node --test tools/test_lr_preview.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/js/training-lr-preview.js'), 'utf8'), context);
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
test('base rate preview discloses excluded LoRA+ and per-layer rates', () => {
  const { data, rate } = preview({ loraplus_lr_ratio: 16, network_args_custom: 'network_reg_lrs=blocks.0=0.001' });
  assert.equal(rate(0), 1e-4);
  assert.ok(data.notes.includes('lrPreview.baseGroupNote'));
  for (const locale of ['en-US', 'zh-CN']) {
    const translations = JSON.parse(fs.readFileSync(path.join(__dirname, `../frontend/i18n/${locale}.json`), 'utf8'));
    assert.ok(translations.lrPreview.baseGroupNote.includes('LoRA+'));
    assert.ok(translations.lrPreview.baseGroupNote.includes('lora_up'));
  }
});
test('fractional warmup truncates to complete steps and long warmup stays a ramp', () => {
  assert.equal(preview({ lr_warmup_steps: 0.15 }, 11).data.params.warmupFraction, 1 / 11);
  assert.equal(preview({ lr_warmup_steps: 20000 }).rate(1), 5e-5);
});
test('invalid constant warmup and internal optimizers do not render a chart', () => {
  for (const config of [{ lr_scheduler: 'constant', lr_warmup_steps: 10 },
    { optimizer_type: 'AdamWScheduleFree' }, { optimizer_type: 'AdaFactor' },
    { lr_scheduler: 'polynomial', learning_rate: 1e-8 }]) {
    const { ui, data } = preview(config);
    assert.ok(data.unavailable);
    assert.equal(ui._buildLrChartHtml(data), '');
    assert.equal(data.warmupVisible, false);
  }
});
test('restart boundaries reset immediately and are sampled on both sides', () => {
  const { data, rate } = preview({ lr_scheduler: 'cosine_with_restarts', lr_scheduler_num_cycles: 2 });
  assert.ok(rate(0.5 - 1e-8) < 1e-12);
  assert.equal(rate(0.5), 1e-4);
  assert.equal(rate(1), 0);
  assert.ok(data.currentLinePath.includes('50.00000,100.00000 L 50.00000,7.40741'));
});
test('hover uses the selected step instead of a 160-point lookup', () => {
  const { ui, data } = preview();
  const elements = Object.fromEntries(['.lr-hover-x', '.lr-hover-value', '.lr-hover-multiplier', '.lr-inspect-value', '.lr-hover-indicator']
    .map(key => [key, { style: {}, classList: { add() {} } }]));
  const chart = { getBoundingClientRect: () => ({ left: 0, right: 10000, top: 0, bottom: 100, width: 10000 }),
    querySelector: key => elements[key] };
  ui.onLrChartHover({ clientX: 1234, clientY: 50,
    currentTarget: { dataset: {}, querySelector: key => key === '.lr-preview-chart' ? chart : elements[key] } }, data);
  assert.equal(elements['.lr-hover-x'].textContent, '1,234 / 10,000');
  assert.equal(elements['.lr-hover-indicator'].style.left, '12.34%');
  assert.equal(elements['.lr-hover-value'].textContent, '8.766e-5');
  assert.equal(elements['.lr-hover-multiplier'].textContent, '0.88×');
  ui.onLrChartLeave({ currentTarget: { querySelector: key => elements[key] } });
  assert.equal(elements['.lr-hover-indicator'].style.display, 'none');
  assert.equal(elements['.lr-hover-value'].textContent, '8.766e-5');
});
