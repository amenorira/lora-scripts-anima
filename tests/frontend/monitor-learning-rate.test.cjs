const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend } = require('./helpers.cjs');

loadGlobalFrontend(['monitor/metrics', 'monitor/summary']);

test('live dashboard prefers measured backbone LR including zero over component and multiplier tags', () => {
  const app = Object.assign({}, window.monitorMetricsMixin, {
    lossSeries: [], monitorData: {}, lossDataVersion: 0, selectedRunDir: '', currentRoute: '',
  });
  app.handleRealtimeTaskMetrics({ points: {
    'lr/backbone': [{ step: 1, value: 0 }],
    'lr/d*eff_lr/unet': [{ step: 1, value: 0.00001 }],
    'lr/unet': [{ step: 1, value: 1 }],
  } });
  assert.equal(Number(app.monitorData.lr), 0);
  app.handleRealtimeTaskMetrics({ points: { 'lr/unet': [{ step: 2, value: 0.5 }] } });
  assert.equal(Number(app.monitorData.lr), 0);
  app.handleRealtimeTaskMetrics({ points: { 'lr/backbone': [{ step: 2, value: 0.00002 }] } });
  assert.equal(Number(app.monitorData.lr), 0.00002);
});

test('existing PPSF event files use d*eff_lr for the single dashboard readout', () => {
  const app = Object.assign({}, window.monitorMetricsMixin, { lossSeries: [], monitorData: {}, lossDataVersion: 0 });
  app.handleRealtimeTaskMetrics({ points: {
    'lr/unet': [{ step: 1, value: 1 }],
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
    { tag: 'lr/d*eff_lr/unet', latest: 0.00003, points: [] },
    { tag: 'lr/backbone', latest: 0, points: [] },
  ];
  assert.equal(renderSummary(series), '0');
  assert.equal(renderSummary(series, true), '0');
  assert.equal(renderSummary(series.slice(0, 2), true), '0.00003');
  assert.equal(renderSummary([], true), '—');
});
