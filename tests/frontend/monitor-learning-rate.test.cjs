const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend } = require('./helpers.cjs');

loadGlobalFrontend(['monitor/metrics', 'monitor/summary']);

test('live dashboard prefers native effective LR including zero and ignores old backbone aliases', () => {
  const app = Object.assign({}, window.monitorMetricsMixin, {
    lossSeries: [], monitorData: {}, lossDataVersion: 0, selectedRunDir: '', currentRoute: '',
  });
  app.handleRealtimeTaskMetrics({ points: {
    'lr/backbone': [{ step: 1, value: 0.1 }],
    'lr/d*eff_lr/unet': [{ step: 1, value: 0 }],
    'lr/unet': [{ step: 1, value: 1 }],
  } });
  assert.equal(Number(app.monitorData.lr), 0);
  app.handleRealtimeTaskMetrics({ points: { 'lr/unet': [{ step: 2, value: 0.5 }] } });
  assert.equal(Number(app.monitorData.lr), 0);
  app.handleRealtimeTaskMetrics({ points: { 'lr/d*eff_lr/unet': [{ step: 2, value: 0.00002 }] } });
  assert.equal(Number(app.monitorData.lr), 0.00002);
});

test('native adaptive tags supply the dashboard readout before the configured multiplier', () => {
  const app = Object.assign({}, window.monitorMetricsMixin, { lossSeries: [], monitorData: {}, lossDataVersion: 0 });
  app.handleRealtimeTaskMetrics({ points: {
    'lr/unet': [{ step: 1, value: 1 }],
    'lr/d*lr/unet': [{ step: 1, value: 0.00002 }],
  } });
  assert.equal(Number(app.monitorData.lr), 0.00002);
  app.handleRealtimeTaskMetrics({ points: {
    'lr/d*eff_lr/unet': [{ step: 1, value: 0.00003 }],
  } });
  assert.equal(Number(app.monitorData.lr), 0.00003);
});

function renderSummary(series, isHistory = false) {
  const lrElement = {};
  const root = { dataset: {}, querySelector: selector => selector === '[data-summary-field="lr"]' ? lrElement : null };
  const app = Object.assign({}, window.monitorSummaryMixin, {
    monitorLossSeries: series, trainParams: [], lossDataVersion: 1,
    _summaryStatus: () => ({}), _summaryLossSeries: () => null,
    _monitorConnectionMeta: () => null, _cleanLossPoints: () => [], _summaryLossChange: () => null,
    _patchMonitorNumber: (element, value) => { element.textContent = value; },
    _formatLearningRate: (value, fallback) => value == null ? fallback : String(value),
    _patchSummaryTime() {}, _patchSummaryTelemetry() {}, _patchTrainingDiagnostics() {},
  });
  app._patchOverviewStatus(root, { lr: 1 }, key => key, isHistory);
  return lrElement.textContent;
}

test('summary and history share LR priority and missing measurements do not become a configured history LR', () => {
  const series = [
    { tag: 'lr/unet', latest: 1, points: [] },
    { tag: 'lr/d*eff_lr/unet', latest: 0, points: [] },
    { tag: 'lr/backbone', latest: 0.1, points: [] },
  ];
  assert.equal(renderSummary(series), '0');
  assert.equal(renderSummary(series, true), '0');
  assert.equal(renderSummary(series.slice(0, 2), true), '0');
  assert.equal(renderSummary([{ tag: 'lr/unet', latest: 1, points: [] },
    { tag: 'lr/d*lr/unet', latest: 0.00002, points: [] }], true), '0.00002');
  assert.equal(renderSummary([], true), '—');
});

test('live and history read native block, LoRA+ and unnamed groups without selecting the text encoder', () => {
  const cases = [
    [['lr/textencoder 1', 0.9], ['lr/unet_block0', 0.0001], ['lr/unet_block0 plus', 0.0008]],
    [['lr/unet plus', 0.0008], ['lr/unet', 0.0001]],
    [['lr/textencoder 1', 0.9], ['lr/group0', 1], ['lr/d*eff_lr/group0', 0.0001]],
  ];
  for (const entries of cases) {
    const app = Object.assign({}, window.monitorMetricsMixin, { lossSeries: [], monitorData: {}, lossDataVersion: 0 });
    app.handleRealtimeTaskMetrics({ points: Object.fromEntries(entries.map(([tag, value]) => [tag, [{ step: 1, value }]])) });
    assert.equal(Number(app.monitorData.lr), 0.0001);
    assert.equal(renderSummary(app.lossSeries, true), '0.0001');
  }
  assert.equal(renderSummary([{ tag: 'lr/textencoder 1', latest: 0.9, points: [] }], true), '—');
});

function renderSchedulerMeta(params, isHistory = false, locale = 'zh-CN') {
  const meta = {};
  const root = { dataset: {}, querySelector: selector => selector === '[data-summary-field="lr-meta"]' ? meta : null };
  const app = Object.assign({}, window.monitorSummaryMixin, {
    monitorLossSeries: [], trainParams: Object.entries(params).map(([key, value]) => ({ key, value })), lossDataVersion: 1,
    _summaryStatus: () => ({ running: !isHistory, terminal: isHistory }), _summaryLossSeries: () => null,
    _monitorConnectionMeta: () => null, _cleanLossPoints: () => [], _summaryLossChange: () => null,
    _patchSummaryTime() {}, _patchSummaryTelemetry() {}, _patchTrainingDiagnostics() {},
  });
  const messages = require(`../../frontend/i18n/${locale}.json`).monitor;
  app._patchOverviewStatus(root, { total_steps: 1000 }, key => messages[key] || key, isHistory);
  return meta.textContent;
}

test('live and history describe optimizer-managed learning rates as automatic', () => {
  const optimizers = [
    'vendor.automagic_optimizer.integration.Automagic3', 'vendor.automagic_optimizer.integration.Automagic4',
    'vendor.emo_optimizer.emosens.EmoSens', 'prodigyplus.ProdigyPlusScheduleFree', 'AdaFactor',
  ];
  for (const optimizer_type of optimizers) {
    for (const isHistory of [false, true]) {
      assert.equal(renderSchedulerMeta({ optimizer_type, lr_scheduler: 'constant', lr_warmup_steps: '0' }, isHistory), '自动学习率');
    }
  }
  assert.equal(renderSchedulerMeta({ optimizer_type: optimizers[0] }, false, 'en-US'), 'Automatic learning rate');
  assert.equal(renderSchedulerMeta({ optimizer_type: optimizers[0] }, true, 'ja-JP'), '学習率を自動調整');
});

test('AdaFactor relative step follows the actual optimizer arguments', () => {
  const params = { optimizer_type: 'AdaFactor', lr_scheduler: 'constant', lr_warmup_steps: '0' };
  assert.equal(renderSchedulerMeta({ ...params, 'optimizer_args.relative_step': 'False', adafactor_relative_step: 'true' }),
    '按参数缩放 · 外部调度：恒定');
  assert.equal(renderSchedulerMeta({ ...params, krea_adafactor_relative_step: 'false', 'optimizer_args.scale_parameter': 'False' }, true),
    '恒定学习率 · 无预热');
  assert.equal(renderSchedulerMeta({ ...params, 'optimizer_args.relative_step': 'False', 'optimizer_args.scale_parameter': 'False', adafactor_scale_parameter: 'true' }),
    '恒定学习率 · 无预热');
  assert.equal(renderSchedulerMeta({ ...params, 'optimizer_args.relative_step': 'True' }), '自动学习率');
  assert.equal(renderSchedulerMeta({ ...params, 'optimizer_args.relative_step': 'False', 'optimizer_args.warmup_init': 'True' }), '自动学习率');
});

test('Prodigy reports its external schedule without calling the adaptive rate constant', () => {
  const params = { optimizer_type: 'prodigyopt.Prodigy', lr_scheduler: 'constant', lr_warmup_steps: '0' };
  assert.equal(renderSchedulerMeta(params), '自动学习率 · 外部调度：恒定');
  assert.equal(renderSchedulerMeta({ ...params, lr_scheduler: 'cosine', lr_warmup_steps: '0.1' }, true),
    '自动学习率 · 外部调度：余弦衰减 · 预热 100 步');
  assert.equal(renderSchedulerMeta(params, false, 'en-US'), 'Automatic learning rate · External schedule: Constant');
  assert.equal(renderSchedulerMeta(params, true, 'ja-JP'), '学習率を自動調整 · 外部スケジュール：一定');
  assert.equal(renderSchedulerMeta({ optimizer_type: 'DAdaptAdam' }), '自动学习率');
});

test('Schedule-Free uses its internal warmup and ordinary optimizers keep their existing description', () => {
  const params = { optimizer_type: 'schedulefree.AdamWScheduleFree', lr_scheduler: 'constant', lr_warmup_steps: '0' };
  assert.equal(renderSchedulerMeta(params), 'Schedule-Free · 无预热');
  assert.equal(renderSchedulerMeta({ ...params, 'optimizer_args.warmup_steps': '250' }, true), 'Schedule-Free · 预热 250 步');
  assert.equal(renderSchedulerMeta({ ...params, optimizer_type: 'RAdamScheduleFree' }), 'Schedule-Free');
  assert.equal(renderSchedulerMeta({ ...params, optimizer_type: 'AdamW', lr_scheduler: 'linear', lr_warmup_steps: '100' }),
    '线性衰减 · 预热 100 步');
});
